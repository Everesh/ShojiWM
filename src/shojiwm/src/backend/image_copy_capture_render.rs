//! Render path for `ext-image-copy-capture-v1` frames.
//!
//! `Frame` objects arrive via [`ImageCopyCaptureHandler::frame`] but rendering
//! has to happen inside the backend's render loop where the `GlesRenderer` is
//! accessible. The handler therefore parks each request in
//! [`ShojiWM::image_copy_capture_pending`] alongside enough context to route
//! it to the right output (or, in Phase 5b-iii, the right toplevel). The
//! backend drains its share of the queue once per render pass.

use std::ptr;
use std::time::Duration;

use smithay::backend::allocator::Fourcc;
use smithay::backend::renderer::element::surface::WaylandSurfaceRenderElement;
use smithay::backend::renderer::element::utils::{Relocate, RelocateRenderElement};
use smithay::backend::renderer::element::{AsRenderElements, RenderElement};
use smithay::backend::renderer::gles::{GlesRenderer, GlesTarget, GlesTexture};
use smithay::backend::renderer::sync::SyncPoint;
use smithay::backend::renderer::{Bind, Color32F, ExportMem, Frame as _, Offscreen, Renderer};
use smithay::desktop::{Space, Window};
use smithay::output::{Output, WeakOutput};
use smithay::reexports::wayland_server::protocol::wl_shm;
use smithay::utils::{Physical, Rectangle, Scale, Size, Transform};
use smithay::wayland::foreign_toplevel_list::{ForeignToplevelHandle, ForeignToplevelWeakHandle};
use smithay::wayland::image_copy_capture::{CaptureFailureReason, Frame};
use smithay::wayland::shm;

use crate::backend::tty::TtyRenderElements;

/// A pending image-copy-capture frame held in the global queue. Drained by
/// whichever backend code path can satisfy it (outputs in 5b-ii, toplevels in
/// 5b-iii).
pub struct PendingCapture {
    pub frame: Frame,
    pub target: CaptureTarget,
    /// Whether the session asked for cursor (`paint_cursors` option = OBS
    /// "Show cursor" checkbox). When false, render functions skip the cursor
    /// elements before drawing the frame.
    pub draw_cursor: bool,
}

pub enum CaptureTarget {
    Output(WeakOutput),
    /// Reserved for Phase 5b-iii. Held in the queue but currently failed
    /// immediately by the render path.
    Toplevel(ForeignToplevelWeakHandle),
}

/// Render any queued image-copy-capture frames whose target is `output`.
///
/// Consumes those entries from `pending`. Each handled frame either calls
/// `Frame::success` (rendered + presented_time) or `Frame::fail` (validation
/// or render failure).
pub fn process_image_copy_capture_for_output(
    pending: &mut Vec<PendingCapture>,
    renderer: &mut GlesRenderer,
    output: &Output,
    content_elements: &[TtyRenderElements],
    cursor_elements: &[TtyRenderElements],
    presented: Duration,
) {
    let mut i = 0;
    while i < pending.len() {
        let matches = match &pending[i].target {
            CaptureTarget::Output(weak) => weak.upgrade().is_some_and(|o| &o == output),
            CaptureTarget::Toplevel(_) => false,
        };
        if !matches {
            i += 1;
            continue;
        }
        let entry = pending.remove(i);
        let PendingCapture {
            frame, draw_cursor, ..
        } = entry;
        // Compose cursor only when the session asked for it (paint_cursors).
        // Reference slices to avoid cloning non-Clone TtyRenderElements.
        let composed_refs: Vec<&TtyRenderElements> = if draw_cursor {
            cursor_elements
                .iter()
                .chain(content_elements.iter())
                .collect()
        } else {
            content_elements.iter().collect()
        };
        match render_frame_for_output(renderer, output, &composed_refs, &frame) {
            Ok(()) => {
                frame.success(output.current_transform(), None, presented);
            }
            Err(err) => {
                tracing::warn!(output = %output.name(), "image-copy-capture render failed: {err}");
                frame.fail(CaptureFailureReason::Unknown);
            }
        }
    }
}

/// Render queued image-copy-capture frames whose target is a toplevel.
///
/// Looks up each toplevel's [`Window`] from `space`, then renders that
/// window's content (its surface tree + popups) into the frame's wl_buffer
/// at the window's geometry size. SHM Xrgb8888 only — same format the
/// constraints advertise.
pub fn process_image_copy_capture_for_toplevels(
    pending: &mut Vec<PendingCapture>,
    space: &Space<Window>,
    renderer: &mut GlesRenderer,
    cursor_elements: &[TtyRenderElements],
    presented: Duration,
) {
    let mut i = 0;
    while i < pending.len() {
        if !matches!(pending[i].target, CaptureTarget::Toplevel(_)) {
            i += 1;
            continue;
        }
        let entry = pending.remove(i);
        let PendingCapture {
            frame,
            target,
            draw_cursor,
        } = entry;
        let CaptureTarget::Toplevel(weak) = target else {
            continue;
        };
        let Some(handle) = weak.upgrade() else {
            frame.fail(CaptureFailureReason::Unknown);
            continue;
        };
        match render_frame_for_toplevel(
            renderer,
            space,
            &handle,
            &frame,
            if draw_cursor { cursor_elements } else { &[] },
        ) {
            Ok(()) => {
                frame.success(Transform::Normal, None, presented);
            }
            Err(err) => {
                tracing::warn!("toplevel image-copy-capture render failed: {err}");
                frame.fail(CaptureFailureReason::Unknown);
            }
        }
    }
}

fn render_frame_for_toplevel(
    renderer: &mut GlesRenderer,
    space: &Space<Window>,
    handle: &ForeignToplevelHandle,
    frame: &Frame,
    _cursor_elements: &[TtyRenderElements],
) -> Result<(), Box<dyn std::error::Error>> {
    // Cursor compositing for per-window captures is intentionally not done
    // here: the cursor element stack uses workspace-physical coordinates and
    // would need wrapping in RelocateRenderElement<TtyRenderElements> to
    // land in the window's local frame. TtyRenderElements doesn't include
    // that variant today. Until we add it, toplevel capture is always
    // cursor-less regardless of the session's paint_cursors option.
    let window = space
        .elements()
        .find(|w| {
            w.user_data()
                .get::<ForeignToplevelHandle>()
                .is_some_and(|h| h.matches(handle))
        })
        .cloned()
        .ok_or("toplevel handle not bound to any mapped window")?;
    let geom = window.geometry();
    if geom.size.w <= 0 || geom.size.h <= 0 {
        return Err("window has zero geometry".into());
    }
    let size: Size<i32, Physical> = (geom.size.w, geom.size.h).into();
    let scale: Scale<f64> = (1.0_f64).into();

    let location: smithay::utils::Point<i32, Physical> = (-geom.loc.x, -geom.loc.y).into();
    let elements: Vec<WaylandSurfaceRenderElement<GlesRenderer>> =
        window.render_elements(renderer, location, scale, 1.0);

    let buffer = frame.buffer();
    render_to_shm(
        renderer,
        &buffer,
        size,
        scale,
        Transform::Normal,
        elements.iter().rev(),
    )
}

fn render_frame_for_output(
    renderer: &mut GlesRenderer,
    output: &Output,
    elements: &[&TtyRenderElements],
    frame: &Frame,
) -> Result<(), Box<dyn std::error::Error>> {
    let mode = output.current_mode().ok_or("output has no current mode")?;
    let transform = output.current_transform();
    let size = transform.transform_size(mode.size);
    let scale: Scale<f64> = output.current_scale().fractional_scale().into();

    // No region offset: ext-image-copy-capture captures the whole source.
    let relocated_elements: Vec<_> = elements
        .iter()
        .map(|element| RelocateRenderElement::from_element(*element, (0, 0), Relocate::Relative))
        .collect();
    let element_iter = relocated_elements.iter().rev();

    let buffer = frame.buffer();
    render_to_shm(renderer, &buffer, size, scale, transform, element_iter)
}

fn render_to_shm(
    renderer: &mut GlesRenderer,
    buffer: &smithay::reexports::wayland_server::protocol::wl_buffer::WlBuffer,
    size: Size<i32, Physical>,
    scale: Scale<f64>,
    transform: Transform,
    elements: impl Iterator<Item = impl RenderElement<GlesRenderer>>,
) -> Result<(), Box<dyn std::error::Error>> {
    shm::with_buffer_contents_mut(buffer, |shm_buffer, shm_len, buffer_data| {
        if !(buffer_data.format == wl_shm::Format::Xrgb8888
            && buffer_data.width == size.w
            && buffer_data.height == size.h
            && buffer_data.stride == size.w * 4
            && shm_len == buffer_data.stride as usize * buffer_data.height as usize)
        {
            return Err::<(), Box<dyn std::error::Error>>("invalid shm buffer format/size".into());
        }
        let mapping =
            render_and_download(renderer, size, scale, transform, Fourcc::Xrgb8888, elements)?;
        let bytes = renderer.map_texture(&mapping)?;
        unsafe {
            ptr::copy_nonoverlapping(bytes.as_ptr(), shm_buffer.cast(), shm_len);
        }
        Ok(())
    })??;
    Ok(())
}

fn render_and_download(
    renderer: &mut GlesRenderer,
    size: Size<i32, Physical>,
    scale: Scale<f64>,
    transform: Transform,
    fourcc: Fourcc,
    elements: impl Iterator<Item = impl RenderElement<GlesRenderer>>,
) -> Result<smithay::backend::renderer::gles::GlesMapping, Box<dyn std::error::Error>> {
    let buffer_size = size.to_logical(1).to_buffer(1, Transform::Normal);
    let mut texture: GlesTexture = renderer.create_buffer(fourcc, buffer_size)?;
    {
        let mut target = renderer.bind(&mut texture)?;
        let _ = render_elements_to_target(renderer, &mut target, size, scale, transform, elements)?;
    }
    let target = renderer.bind(&mut texture)?;
    let mapping = renderer.copy_framebuffer(&target, Rectangle::from_size(buffer_size), fourcc)?;
    Ok(mapping)
}

fn render_elements_to_target(
    renderer: &mut GlesRenderer,
    target: &mut GlesTarget,
    size: Size<i32, Physical>,
    scale: Scale<f64>,
    transform: Transform,
    elements: impl Iterator<Item = impl RenderElement<GlesRenderer>>,
) -> Result<SyncPoint, Box<dyn std::error::Error>> {
    let transform = transform.invert();
    let output_rect = Rectangle::from_size(transform.transform_size(size));

    let mut gles_frame = renderer.render(target, size, transform)?;
    gles_frame.clear(Color32F::new(0.0, 0.0, 0.0, 1.0), &[output_rect])?;

    for element in elements {
        let src = element.src();
        let dst = element.geometry(scale);
        if let Some(mut damage) = output_rect.intersection(dst) {
            damage.loc -= dst.loc;
            element.draw(&mut gles_frame, src, dst, &[damage], &[], None)?;
        }
    }
    Ok(gles_frame.finish()?)
}

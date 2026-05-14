//! wlr-screencopy-unstable-v1 client.
//!
//! Runs in a dedicated thread. Connects to the compositor's Wayland socket,
//! binds `zwlr_screencopy_manager_v1`, picks the wl_output by name, then
//! loops:
//!
//!   capture_output → wait Ready → copy SHM to FrameCache → repeat
//!
//! A single SHM buffer (memfd-backed) is reused across frames. The
//! compositor writes into it via wl_shm_pool; we mmap the same fd read-only
//! to copy out into the FrameCache when "ready" arrives.
//!
//! Phase 4b is SHM-only — no DMA-BUF, no damage tracking. The next iteration
//! will switch to dmabuf for zero-copy.

use std::os::fd::{AsFd, OwnedFd};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use rustix::mm::{MapFlags, ProtFlags};
use wayland_client::protocol::{wl_buffer, wl_output, wl_registry, wl_shm, wl_shm_pool};
use wayland_client::{Connection, Dispatch, EventQueue, QueueHandle, WEnum};
use wayland_protocols_wlr::screencopy::v1::client::{
    zwlr_screencopy_frame_v1::{self, ZwlrScreencopyFrameV1},
    zwlr_screencopy_manager_v1::ZwlrScreencopyManagerV1,
};

/// Shared latest-frame buffer between the wayland thread (writer) and the
/// PipeWire on_process callback (reader).
pub struct FrameCache {
    inner: Mutex<FrameCacheInner>,
}

struct FrameCacheInner {
    /// Raw pixel bytes, BGRx / XRGB8888 byte order (B G R x).
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    stride: u32,
    /// y_invert from wlr-screencopy: if true, row 0 of `bytes` is the bottom row.
    y_invert: bool,
    /// Set to true on every successful frame; reader doesn't reset it (we
    /// always re-copy the latest known frame each on_process tick).
    has_frame: bool,
}

impl FrameCache {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(FrameCacheInner {
                bytes: Vec::new(),
                width: 0,
                height: 0,
                stride: 0,
                y_invert: false,
                has_frame: false,
            }),
        }
    }

    /// Snapshot the latest frame into `dst` (BGRx, width/height matching what
    /// the consumer expected). Returns false if there's no frame yet or dims
    /// differ from what the consumer set up.
    pub fn copy_into(&self, dst: &mut [u8], dst_width: u32, dst_height: u32, dst_stride: u32) -> bool {
        let inner = self.inner.lock().unwrap();
        if !inner.has_frame
            || inner.width != dst_width
            || inner.height != dst_height
            || inner.stride != dst_stride
        {
            return false;
        }
        if inner.y_invert {
            let row = dst_stride as usize;
            for y in 0..dst_height as usize {
                let src_row = (dst_height as usize - 1 - y) * row;
                let dst_row = y * row;
                dst[dst_row..dst_row + row].copy_from_slice(&inner.bytes[src_row..src_row + row]);
            }
        } else {
            let n = (dst_stride * dst_height) as usize;
            dst[..n].copy_from_slice(&inner.bytes[..n]);
        }
        true
    }
}

/// Owns the screencopy thread. Drop it to request teardown.
pub struct ScreencopyHandle {
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl Drop for ScreencopyHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// Spawn the screencopy thread. `cache` is shared with the PipeWire stream.
pub fn start(output_name: String, cache: Arc<FrameCache>) -> ScreencopyHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = stop.clone();
    let join = thread::Builder::new()
        .name("portal-screencopy".into())
        .spawn(move || {
            if let Err(e) = run(&output_name, cache, stop_for_thread) {
                tracing::error!("screencopy thread exited: {e}");
            }
        })
        .expect("spawn screencopy thread");
    ScreencopyHandle {
        stop,
        join: Some(join),
    }
}

struct AppState {
    cache: Arc<FrameCache>,
    stop: Arc<AtomicBool>,
    target_output_name: String,

    // Wayland globals (filled during registry roundtrip)
    target_output: Option<wl_output::WlOutput>,
    target_output_pending_name: Option<String>,
    target_output_candidate: Option<wl_output::WlOutput>,
    shm: Option<wl_shm::WlShm>,
    manager: Option<ZwlrScreencopyManagerV1>,

    // SHM buffer state
    shm_fd: Option<OwnedFd>,
    shm_pool: Option<wl_shm_pool::WlShmPool>,
    shm_buffer: Option<wl_buffer::WlBuffer>,
    shm_ptr: Option<NonNull<u8>>,
    shm_size: usize,
    advertised_width: u32,
    advertised_height: u32,
    advertised_stride: u32,
    advertised_format: Option<wl_shm::Format>,

    // Per-frame state
    current_frame: Option<ZwlrScreencopyFrameV1>,
    frame_ready: bool,
    frame_failed: bool,
    frame_y_invert: bool,
}

// SAFETY: shm_ptr is a mmap region we own; AppState is only ever owned by one thread.
unsafe impl Send for AppState {}

fn run(
    output_name: &str,
    cache: Arc<FrameCache>,
    stop: Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error>> {
    let conn = Connection::connect_to_env()?;
    let mut event_queue: EventQueue<AppState> = conn.new_event_queue();
    let qh = event_queue.handle();
    let _ = conn.display().get_registry(&qh, ());

    let mut state = AppState {
        cache,
        stop,
        target_output_name: output_name.to_string(),
        target_output: None,
        target_output_pending_name: None,
        target_output_candidate: None,
        shm: None,
        manager: None,
        shm_fd: None,
        shm_pool: None,
        shm_buffer: None,
        shm_ptr: None,
        shm_size: 0,
        advertised_width: 0,
        advertised_height: 0,
        advertised_stride: 0,
        advertised_format: None,
        current_frame: None,
        frame_ready: false,
        frame_failed: false,
        frame_y_invert: false,
    };

    // Roundtrip to receive globals.
    event_queue.roundtrip(&mut state)?;
    // Roundtrip again to receive per-output wl_output::name events.
    event_queue.roundtrip(&mut state)?;

    let manager = state
        .manager
        .clone()
        .ok_or("compositor doesn't advertise zwlr_screencopy_manager_v1")?;
    let _shm = state
        .shm
        .clone()
        .ok_or("compositor doesn't advertise wl_shm")?;
    let output = state
        .target_output
        .clone()
        .ok_or_else(|| format!("output {output_name:?} not found"))?;

    tracing::info!(
        output = output_name,
        "screencopy: globals bound, entering capture loop"
    );

    while !state.stop.load(Ordering::SeqCst) {
        // Kick off a fresh capture.
        let frame = manager.capture_output(0, &output, &qh, ());
        state.current_frame = Some(frame);
        state.frame_ready = false;
        state.frame_failed = false;
        state.frame_y_invert = false;

        // Drive the queue until this frame resolves or stop is signalled.
        while state.current_frame.is_some()
            && !state.frame_ready
            && !state.frame_failed
            && !state.stop.load(Ordering::SeqCst)
        {
            event_queue.blocking_dispatch(&mut state)?;
        }

        if state.stop.load(Ordering::SeqCst) {
            break;
        }

        if state.frame_failed {
            tracing::warn!("screencopy: frame failed; backing off");
            thread::sleep(Duration::from_millis(50));
        }

        if let Some(frame) = state.current_frame.take() {
            frame.destroy();
        }
    }

    teardown_shm(&mut state);
    tracing::info!("screencopy thread exiting cleanly");
    Ok(())
}

fn teardown_shm(state: &mut AppState) {
    if let Some(b) = state.shm_buffer.take() {
        b.destroy();
    }
    if let Some(p) = state.shm_pool.take() {
        p.destroy();
    }
    if let (Some(ptr), size) = (state.shm_ptr.take(), state.shm_size) {
        if size > 0 {
            unsafe {
                let _ = rustix::mm::munmap(ptr.as_ptr().cast(), size);
            }
        }
    }
    state.shm_fd.take();
}

/// (Re)allocate the shared SHM buffer to match advertised dims. Returns the
/// wl_buffer to hand to the next frame.copy() call.
fn ensure_shm_buffer(state: &mut AppState, qh: &QueueHandle<AppState>) -> Option<wl_buffer::WlBuffer> {
    let need_size = (state.advertised_stride * state.advertised_height) as usize;
    if need_size == 0 {
        return None;
    }

    let dims_changed = state.shm_size != need_size;
    if dims_changed {
        teardown_shm(state);
        let memfd = match rustix::fs::memfd_create(
            "shojiwm-portal-screencopy",
            rustix::fs::MemfdFlags::CLOEXEC,
        ) {
            Ok(fd) => fd,
            Err(e) => {
                tracing::error!("memfd_create failed: {e}");
                return None;
            }
        };
        if let Err(e) = rustix::fs::ftruncate(&memfd, need_size as u64) {
            tracing::error!("ftruncate failed: {e}");
            return None;
        }
        let ptr = unsafe {
            rustix::mm::mmap(
                std::ptr::null_mut(),
                need_size,
                ProtFlags::READ,
                MapFlags::SHARED,
                memfd.as_fd(),
                0,
            )
        };
        let ptr = match ptr {
            Ok(p) => match NonNull::new(p.cast()) {
                Some(nn) => nn,
                None => {
                    tracing::error!("mmap returned null");
                    return None;
                }
            },
            Err(e) => {
                tracing::error!("mmap failed: {e}");
                return None;
            }
        };

        let shm = state.shm.as_ref().unwrap();
        let pool = shm.create_pool(memfd.as_fd(), need_size as i32, qh, ());

        state.shm_fd = Some(memfd);
        state.shm_pool = Some(pool);
        state.shm_ptr = Some(ptr);
        state.shm_size = need_size;
    }

    let pool = state.shm_pool.as_ref().unwrap();
    let format = state.advertised_format.unwrap_or(wl_shm::Format::Xrgb8888);
    let buffer = pool.create_buffer(
        0,
        state.advertised_width as i32,
        state.advertised_height as i32,
        state.advertised_stride as i32,
        format,
        qh,
        (),
    );
    // Remember the active buffer so we can destroy it later. wlr-screencopy
    // doesn't take ownership; we manage its lifetime.
    if let Some(prev) = state.shm_buffer.replace(buffer.clone()) {
        prev.destroy();
    }
    Some(buffer)
}

// ---- Wayland dispatch impls ---------------------------------------------

impl Dispatch<wl_registry::WlRegistry, ()> for AppState {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        else {
            return;
        };
        match interface.as_str() {
            "wl_output" => {
                // Bind every output we see; we filter by name later.
                let output = registry.bind::<wl_output::WlOutput, _, _>(
                    name,
                    version.min(4),
                    qh,
                    OutputId(name),
                );
                // Track this as a candidate until we get its name event.
                state.target_output_candidate = Some(output);
            }
            "wl_shm" => {
                state.shm =
                    Some(registry.bind::<wl_shm::WlShm, _, _>(name, version.min(1), qh, ()));
            }
            "zwlr_screencopy_manager_v1" => {
                state.manager = Some(registry.bind::<ZwlrScreencopyManagerV1, _, _>(
                    name,
                    version.min(3),
                    qh,
                    (),
                ));
            }
            _ => {}
        }
    }
}

struct OutputId(u32);

impl Dispatch<wl_output::WlOutput, OutputId> for AppState {
    fn event(
        state: &mut Self,
        output: &wl_output::WlOutput,
        event: wl_output::Event,
        _: &OutputId,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_output::Event::Name { name } = event {
            if name == state.target_output_name {
                state.target_output = Some(output.clone());
                tracing::info!(output = name, "screencopy: matched target output");
            }
            state.target_output_pending_name = Some(name);
        }
    }
}

impl Dispatch<wl_shm::WlShm, ()> for AppState {
    fn event(
        _state: &mut Self,
        _: &wl_shm::WlShm,
        _event: wl_shm::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_shm_pool::WlShmPool, ()> for AppState {
    fn event(
        _state: &mut Self,
        _: &wl_shm_pool::WlShmPool,
        _event: wl_shm_pool::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_buffer::WlBuffer, ()> for AppState {
    fn event(
        _state: &mut Self,
        _: &wl_buffer::WlBuffer,
        _event: wl_buffer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ZwlrScreencopyManagerV1, ()> for AppState {
    fn event(
        _state: &mut Self,
        _: &ZwlrScreencopyManagerV1,
        _event: <ZwlrScreencopyManagerV1 as wayland_client::Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ZwlrScreencopyFrameV1, ()> for AppState {
    fn event(
        state: &mut Self,
        frame: &ZwlrScreencopyFrameV1,
        event: zwlr_screencopy_frame_v1::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            zwlr_screencopy_frame_v1::Event::Buffer {
                format,
                width,
                height,
                stride,
            } => {
                if let WEnum::Value(fmt) = format {
                    state.advertised_format = Some(fmt);
                }
                state.advertised_width = width;
                state.advertised_height = height;
                state.advertised_stride = stride;
            }
            zwlr_screencopy_frame_v1::Event::LinuxDmabuf { .. } => {
                // SHM-only for now; ignore dmabuf advert.
            }
            zwlr_screencopy_frame_v1::Event::BufferDone => {
                let Some(buffer) = ensure_shm_buffer(state, qh) else {
                    state.frame_failed = true;
                    return;
                };
                frame.copy(&buffer);
            }
            zwlr_screencopy_frame_v1::Event::Flags { flags } => {
                if let WEnum::Value(f) = flags {
                    state.frame_y_invert =
                        f.contains(zwlr_screencopy_frame_v1::Flags::YInvert);
                }
            }
            zwlr_screencopy_frame_v1::Event::Damage { .. } => {}
            zwlr_screencopy_frame_v1::Event::Ready { .. } => {
                // Copy SHM contents → cache.
                if let (Some(ptr), size) = (state.shm_ptr, state.shm_size)
                    && size > 0
                {
                    // SAFETY: ptr maps `size` bytes of the same memfd the
                    // compositor wrote into. The Ready event signals the
                    // write is complete.
                    let src: &[u8] =
                        unsafe { std::slice::from_raw_parts(ptr.as_ptr(), size) };
                    let mut inner = state.cache.inner.lock().unwrap();
                    inner.width = state.advertised_width;
                    inner.height = state.advertised_height;
                    inner.stride = state.advertised_stride;
                    inner.y_invert = state.frame_y_invert;
                    inner.bytes.resize(size, 0);
                    inner.bytes.copy_from_slice(src);
                    inner.has_frame = true;
                }
                state.frame_ready = true;
            }
            zwlr_screencopy_frame_v1::Event::Failed => {
                state.frame_failed = true;
            }
            _ => {}
        }
    }
}

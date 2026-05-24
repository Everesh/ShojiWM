use bumpalo::Bump;
use hashbrown::{DefaultHashBuilder, HashMap as BumpHashMap};
use smithay::{
    backend::renderer::element::solid::SolidColorBuffer,
    desktop::Window,
    utils::{Logical, Point, Rectangle, Size},
};
use std::time::{Duration, Instant};
use tracing::{debug, info, trace, warn};

use crate::backend::rounded::RoundedElementState;
use crate::backend::visual::RectSnapMode;
use crate::backend::visual::{inverse_transform_point, transformed_root_rect};
use crate::backend::{
    icon::{CachedDecorationIcon, IconSpec},
    shader_effect::CachedShaderEffect,
    text::{CachedDecorationLabel, LabelSpec},
    visual::PreciseLogicalRect,
};
use crate::state::ShojiWM;

use super::{
    ComputedDecorationTree, DecorationCachedEvaluationResult, DecorationEvaluationError,
    DecorationEvaluationResult, DecorationEvaluator, DecorationHandlerInvocation,
    DecorationHitTestResult, DecorationSchedulerTick, DecorationTree, LayerEffectEvaluationResult,
    LogicalPoint, LogicalRect, StaticDecorationEvaluator, WaylandLayerSnapshot,
    WaylandWindowSnapshot, WindowPositionSnapshot, WindowTransform, reapply_tree_preserving_layout,
    window_model::ManagedWindowRectSnapshot,
};

type BumpSharedEdgeGeometryMap<'a> =
    BumpHashMap<&'a str, SharedEdgeNodeGeometry, DefaultHashBuilder, &'a Bump>;

trait SharedEdgeGeometryLookup {
    fn shared_edge_geometry(&self, stable_id: &str) -> Option<SharedEdgeNodeGeometry>;
}

impl SharedEdgeGeometryLookup for std::collections::HashMap<String, SharedEdgeNodeGeometry> {
    fn shared_edge_geometry(&self, stable_id: &str) -> Option<SharedEdgeNodeGeometry> {
        self.get(stable_id).copied()
    }
}

impl SharedEdgeGeometryLookup for BumpSharedEdgeGeometryMap<'_> {
    fn shared_edge_geometry(&self, stable_id: &str) -> Option<SharedEdgeNodeGeometry> {
        self.get(stable_id).copied()
    }
}

fn clip_debug_enabled() -> bool {
    use std::sync::OnceLock;

    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("SHOJI_CLIP_DEBUG").is_some())
}

fn handler_debug_enabled() -> bool {
    use std::sync::OnceLock;

    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os("SHOJI_SSD_HANDLER_DEBUG")
            .is_some_and(|value| value != "0" && !value.is_empty())
    })
}

fn animation_timing_debug_enabled() -> bool {
    use std::sync::OnceLock;

    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os("SHOJI_ANIMATION_TIMING_DEBUG")
            .is_some_and(|value| value != "0" && !value.is_empty())
    })
}

fn managed_rect_debug_enabled() -> bool {
    use std::sync::OnceLock;

    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os("SHOJI_MANAGED_RECT_DEBUG")
            .is_some_and(|value| value != "0" && !value.is_empty())
    })
}

fn managed_rect_path_debug_enabled() -> bool {
    use std::sync::OnceLock;

    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os("SHOJI_MANAGED_RECT_PATH_DEBUG")
            .is_some_and(|value| value != "0" && !value.is_empty())
    })
}

#[derive(Default)]
struct ManagedRectPathStats {
    last_log: Option<Instant>,
    full_rebuild: usize,
    refresh_position_translate: usize,
    refresh_size_relayout: usize,
    runtime_dirty: usize,
    runtime_managed_only: usize,
    apply_noop: usize,
    apply_position_fast: usize,
    apply_size_fast: usize,
    apply_position: usize,
    apply_size: usize,
    apply_configure_only: usize,
}

enum ManagedRectPathEvent {
    FullRebuild,
    RefreshPositionTranslate,
    RefreshSizeRelayout,
    RuntimeDirty,
    RuntimeManagedOnly,
    ApplyNoop,
    ApplyPositionFast,
    ApplySizeFast,
    ApplyPosition,
    ApplySize,
    ApplyConfigureOnly,
}

fn record_managed_rect_path_event(event: ManagedRectPathEvent) {
    if !managed_rect_path_debug_enabled() {
        return;
    }

    use std::sync::{Mutex, OnceLock};

    static STATS: OnceLock<Mutex<ManagedRectPathStats>> = OnceLock::new();
    let stats = STATS.get_or_init(|| Mutex::new(ManagedRectPathStats::default()));
    let Ok(mut stats) = stats.lock() else {
        return;
    };

    match event {
        ManagedRectPathEvent::FullRebuild => stats.full_rebuild += 1,
        ManagedRectPathEvent::RefreshPositionTranslate => stats.refresh_position_translate += 1,
        ManagedRectPathEvent::RefreshSizeRelayout => stats.refresh_size_relayout += 1,
        ManagedRectPathEvent::RuntimeDirty => stats.runtime_dirty += 1,
        ManagedRectPathEvent::RuntimeManagedOnly => stats.runtime_managed_only += 1,
        ManagedRectPathEvent::ApplyNoop => stats.apply_noop += 1,
        ManagedRectPathEvent::ApplyPositionFast => stats.apply_position_fast += 1,
        ManagedRectPathEvent::ApplySizeFast => stats.apply_size_fast += 1,
        ManagedRectPathEvent::ApplyPosition => stats.apply_position += 1,
        ManagedRectPathEvent::ApplySize => stats.apply_size += 1,
        ManagedRectPathEvent::ApplyConfigureOnly => stats.apply_configure_only += 1,
    }

    let now = Instant::now();
    let last_log = *stats.last_log.get_or_insert(now);
    if now.duration_since(last_log) < Duration::from_secs(1) {
        return;
    }

    info!(
        full_rebuild = stats.full_rebuild,
        refresh_position_translate = stats.refresh_position_translate,
        refresh_size_relayout = stats.refresh_size_relayout,
        runtime_dirty = stats.runtime_dirty,
        runtime_managed_only = stats.runtime_managed_only,
        apply_noop = stats.apply_noop,
        apply_position_fast = stats.apply_position_fast,
        apply_size_fast = stats.apply_size_fast,
        apply_position = stats.apply_position,
        apply_size = stats.apply_size,
        apply_configure_only = stats.apply_configure_only,
        "managed rect path stats"
    );

    *stats = ManagedRectPathStats {
        last_log: Some(now),
        ..ManagedRectPathStats::default()
    };
}

fn animation_spike_threshold_ms() -> f64 {
    use std::sync::OnceLock;

    static THRESHOLD_MS: OnceLock<f64> = OnceLock::new();
    *THRESHOLD_MS.get_or_init(|| {
        std::env::var("SHOJI_ANIMATION_SPIKE_THRESHOLD_MS")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| *value > 0.0)
            .unwrap_or(12.0)
    })
}

fn animation_gap_debug_enabled() -> bool {
    use std::sync::OnceLock;

    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os("SHOJI_ANIMATION_GAP_DEBUG")
            .is_some_and(|value| value != "0" && !value.is_empty())
    })
}

fn log_animation_output_activity(
    output_name: &str,
    closing_active_count: usize,
    animation_active_for_target: bool,
) {
    if !animation_gap_debug_enabled() {
        return;
    }

    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    static STATE: OnceLock<Mutex<HashMap<String, (bool, usize)>>> = OnceLock::new();
    let state = STATE.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut guard) = state.lock() else {
        return;
    };
    let previous = guard.insert(
        output_name.to_string(),
        (animation_active_for_target, closing_active_count),
    );
    if previous != Some((animation_active_for_target, closing_active_count)) {
        info!(
            output_name,
            previous_animation_active = previous.map(|value| value.0),
            animation_active_for_target,
            previous_closing_active_count = previous.map(|value| value.1),
            closing_active_count,
            "animation gap: output activity transition"
        );
    }
}

fn log_animation_window_refresh_timing(
    phase: &'static str,
    snapshot: &WaylandWindowSnapshot,
    elapsed_ms: f64,
    evaluate_ms: f64,
    layout_ms: f64,
    clip_ms: f64,
    order_ms: f64,
    buffers_ms: f64,
    shader_ms: f64,
    text_ms: f64,
    icon_ms: f64,
    finalize_ms: f64,
    dirty_node_count: usize,
    tree_changed: Option<bool>,
    layout_equivalent: Option<bool>,
) {
    if !animation_timing_debug_enabled() || elapsed_ms < animation_spike_threshold_ms() {
        return;
    }

    warn!(
        phase,
        window_id = snapshot.id,
        title = snapshot.title,
        app_id = snapshot.app_id,
        elapsed_ms,
        evaluate_ms,
        layout_ms,
        clip_ms,
        order_ms,
        buffers_ms,
        shader_ms,
        text_ms,
        icon_ms,
        finalize_ms,
        dirty_node_count,
        tree_changed,
        layout_equivalent,
        "animation timing: decoration window spike"
    );
}

#[derive(Debug, Clone)]
pub struct WindowDecorationState {
    pub snapshot: WaylandWindowSnapshot,
    pub tree: DecorationTree,
    pub layout: ComputedDecorationTree,
    pub layout_scale: f64,
    pub client_rect: LogicalRect,
    /// `client_rect` is the materialised result of
    /// `managed_client_rect_for_state(tree, managed_window, _, layout_scale)`.
    /// It's coherent with the cached state immediately after rebuild/relayout,
    /// but the `runtime_dirty` branch can swap `tree`/`managed_window`/
    /// `layout_scale` *without* rerunning the probe loop, so the materialised
    /// rect lags by one tick. This flag records that lag so the per-refresh
    /// diff check can skip the probe loop entirely while the cache is
    /// coherent — which is the steady-state hot path (~25% CPU during
    /// ufo-test).
    pub client_rect_potentially_stale: bool,
    pub visual_transform: WindowTransform,
    pub managed_window: super::ManagedWindowState,
    pub window_effects: Option<super::WindowEffectConfig>,
    pub content_clip: Option<ContentClip>,
    pub buffers: Vec<CachedDecorationBuffer>,
    pub shader_buffers: Vec<CachedShaderEffect>,
    pub text_buffers: Vec<CachedDecorationLabel>,
    pub icon_buffers: Vec<CachedDecorationIcon>,
    pub rounded_cache: std::collections::HashMap<String, RoundedElementState>,
    pub shader_cache:
        std::collections::HashMap<String, crate::backend::shader_effect::ShaderEffectElementState>,
    pub backdrop_cache:
        std::collections::HashMap<String, crate::backend::shader_effect::CachedBackdropTexture>,
    pub window_effect_cache:
        std::collections::HashMap<String, crate::backend::shader_effect::WindowEffectElementState>,
}

#[derive(Debug, Clone, Copy)]
pub struct ContentClip {
    // Reserved client slot geometry. This controls where the client is placed.
    pub rect: Rectangle<i32, Logical>,
    pub rect_precise: PreciseLogicalRect,
    // Ancestor clip mask geometry. This controls how the client is clipped.
    pub mask_rect: Rectangle<i32, Logical>,
    pub mask_rect_precise: PreciseLogicalRect,
    pub radius: i32,
    pub radius_precise: f32,
    pub corner_radii: [i32; 4],
    pub corner_radii_precise: [f32; 4],
    pub snap_mode: RectSnapMode,
}

impl WindowDecorationState {
    pub fn hit_test(&self, point: Point<f64, Logical>) -> DecorationHitTestResult {
        let logical = LogicalPoint::new(point.x.floor() as i32, point.y.floor() as i32);
        self.layout.hit_test(logical)
    }

    pub fn managed_window_allows_render(&self) -> bool {
        !self.managed_window.managed || (self.managed_window.visible && !self.managed_window.idle)
    }

    pub fn managed_window_allows_render_on_output(&self, output_name: &str) -> bool {
        self.managed_window_allows_render()
            && self
                .managed_window
                .visible_outputs
                .as_ref()
                .is_none_or(|outputs| outputs.iter().any(|output| output == output_name))
    }

    pub fn managed_window_allows_input(&self) -> bool {
        self.managed_window_allows_render() && self.managed_window.interactive
    }

    pub fn managed_window_allows_input_on_output(&self, output_name: &str) -> bool {
        self.managed_window_allows_render_on_output(output_name) && self.managed_window.interactive
    }
}

#[derive(Debug, Clone)]
pub enum DecorationRuntimeEvaluator {
    Static(super::StaticDecorationEvaluator),
    Node(super::NodeDecorationEvaluator),
}

#[derive(Debug, Clone)]
pub struct CachedDecorationBuffer {
    pub owner_node_id: Option<String>,
    pub stable_key: String,
    pub order: usize,
    pub rect: LogicalRect,
    pub rect_precise: Option<PreciseLogicalRect>,
    pub color: super::Color,
    pub buffer: SolidColorBuffer,
    pub radius: i32,
    pub radius_precise: Option<f32>,
    pub border_width: f32,
    pub hole_rect: Option<LogicalRect>,
    pub hole_rect_precise: Option<PreciseLogicalRect>,
    pub hole_radius: i32,
    pub hole_radius_precise: Option<f32>,
    pub shared_inner_hole: bool,
    pub clip_rect: Option<LogicalRect>,
    pub clip_radius: i32,
    pub clip_rect_precise: Option<PreciseLogicalRect>,
    pub clip_radius_precise: Option<f32>,
    pub source_kind: &'static str,
}

impl Default for DecorationRuntimeEvaluator {
    fn default() -> Self {
        Self::Static(super::StaticDecorationEvaluator)
    }
}

impl DecorationEvaluator for DecorationRuntimeEvaluator {
    fn evaluate_window(
        &self,
        window: &WaylandWindowSnapshot,
        now_ms: u64,
    ) -> Result<DecorationEvaluationResult, DecorationEvaluationError> {
        match self {
            Self::Static(evaluator) => evaluator.evaluate_window(window, now_ms),
            Self::Node(evaluator) => evaluator.evaluate_window(window, now_ms),
        }
    }

    fn evaluate_window_preview(
        &self,
        window: &WaylandWindowSnapshot,
        now_ms: u64,
    ) -> Result<DecorationEvaluationResult, DecorationEvaluationError> {
        match self {
            Self::Static(evaluator) => evaluator.evaluate_window_preview(window, now_ms),
            Self::Node(evaluator) => evaluator.evaluate_window_preview(window, now_ms),
        }
    }

    fn scheduler_tick(
        &self,
        now_ms: u64,
    ) -> Result<DecorationSchedulerTick, DecorationEvaluationError> {
        match self {
            Self::Static(_) => Ok(DecorationSchedulerTick::default()),
            Self::Node(evaluator) => evaluator.scheduler_tick(now_ms),
        }
    }

    fn evaluate_cached_window(
        &self,
        window_id: &str,
        now_ms: u64,
    ) -> Result<DecorationCachedEvaluationResult, DecorationEvaluationError> {
        match self {
            Self::Static(_) => Err(DecorationEvaluationError::RuntimeProtocol(
                "cached window evaluation unsupported for static evaluator".into(),
            )),
            Self::Node(evaluator) => evaluator.evaluate_cached_window(window_id, now_ms),
        }
    }

    fn window_closed(&self, window_id: &str) -> Result<(), DecorationEvaluationError> {
        match self {
            Self::Static(_) => Ok(()),
            Self::Node(evaluator) => evaluator.window_closed(window_id),
        }
    }

    fn invoke_handler(
        &self,
        window_id: &str,
        handler_id: &str,
        now_ms: u64,
    ) -> Result<super::DecorationHandlerInvocation, DecorationEvaluationError> {
        match self {
            Self::Static(_) => Ok(super::DecorationHandlerInvocation::default()),
            Self::Node(evaluator) => evaluator.invoke_handler(window_id, handler_id, now_ms),
        }
    }

    fn invoke_key_binding(
        &self,
        binding_id: &str,
        now_ms: u64,
    ) -> Result<super::DecorationKeyBindingInvocation, DecorationEvaluationError> {
        match self {
            Self::Static(_) => Ok(super::DecorationKeyBindingInvocation::default()),
            Self::Node(evaluator) => evaluator.invoke_key_binding(binding_id, now_ms),
        }
    }

    fn window_resize(
        &self,
        window_id: &str,
        event: &super::WindowResizeEventSnapshot,
        now_ms: u64,
    ) -> Result<super::DecorationWindowResizeInvocation, DecorationEvaluationError> {
        match self {
            Self::Static(_) => Ok(super::DecorationWindowResizeInvocation::default()),
            Self::Node(evaluator) => evaluator.window_resize(window_id, event, now_ms),
        }
    }

    fn window_move(
        &self,
        window_id: &str,
        event: &super::WindowMoveEventSnapshot,
        now_ms: u64,
    ) -> Result<super::DecorationWindowMoveInvocation, DecorationEvaluationError> {
        match self {
            Self::Static(_) => Ok(super::DecorationWindowMoveInvocation::default()),
            Self::Node(evaluator) => evaluator.window_move(window_id, event, now_ms),
        }
    }

    fn window_maximize_request(
        &self,
        snapshot: &WaylandWindowSnapshot,
        event: &super::WindowMaximizeRequestEventSnapshot,
        now_ms: u64,
    ) -> Result<super::DecorationWindowStateRequestInvocation, DecorationEvaluationError> {
        match self {
            Self::Static(_) => Ok(super::DecorationWindowStateRequestInvocation::default()),
            Self::Node(evaluator) => evaluator.window_maximize_request(snapshot, event, now_ms),
        }
    }

    fn window_minimize_request(
        &self,
        snapshot: &WaylandWindowSnapshot,
        event: &super::WindowMinimizeRequestEventSnapshot,
        now_ms: u64,
    ) -> Result<super::DecorationWindowStateRequestInvocation, DecorationEvaluationError> {
        match self {
            Self::Static(_) => Ok(super::DecorationWindowStateRequestInvocation::default()),
            Self::Node(evaluator) => evaluator.window_minimize_request(snapshot, event, now_ms),
        }
    }

    fn window_activate_request(
        &self,
        snapshot: &WaylandWindowSnapshot,
        event: &super::WindowActivateRequestEventSnapshot,
        now_ms: u64,
    ) -> Result<super::DecorationWindowStateRequestInvocation, DecorationEvaluationError> {
        match self {
            Self::Static(_) => Ok(super::DecorationWindowStateRequestInvocation::default()),
            Self::Node(evaluator) => evaluator.window_activate_request(snapshot, event, now_ms),
        }
    }

    fn pointer_move_async(&self, event: super::PointerMoveEventSnapshot, now_ms: u64) {
        if let Self::Node(evaluator) = self {
            evaluator.pointer_move_async(event, now_ms);
        }
    }

    fn start_close(
        &self,
        window_id: &str,
        now_ms: u64,
    ) -> Result<super::DecorationHandlerInvocation, DecorationEvaluationError> {
        match self {
            Self::Static(_) => Ok(super::DecorationHandlerInvocation::default()),
            Self::Node(evaluator) => evaluator.start_close(window_id, now_ms),
        }
    }

    fn evaluate_layer_effects(
        &self,
        output_name: &str,
        layers: &[WaylandLayerSnapshot],
        now_ms: u64,
    ) -> Result<LayerEffectEvaluationResult, DecorationEvaluationError> {
        match self {
            Self::Static(_) => Ok(LayerEffectEvaluationResult::default()),
            Self::Node(evaluator) => evaluator.evaluate_layer_effects(output_name, layers, now_ms),
        }
    }
}

impl DecorationRuntimeEvaluator {
    pub fn sync_display_state(
        &self,
        display_state: std::collections::BTreeMap<String, super::WaylandOutputSnapshot>,
    ) {
        if let Self::Node(evaluator) = self {
            evaluator.set_display_state(display_state);
        }
    }

    pub fn set_async_event_sender(
        &self,
        sender: smithay::reexports::calloop::channel::Sender<
            super::DecorationPointerMoveAsyncInvocation,
        >,
    ) {
        if let Self::Node(evaluator) = self {
            evaluator.set_async_event_sender(sender);
        }
    }
}

impl ShojiWM {
    fn decoration_layout_scale_for_window(&self, window: &Window) -> f64 {
        self.space
            .outputs_for_element(window)
            .into_iter()
            .map(|output| output.current_scale().fractional_scale())
            .fold(1.0f64, f64::max)
            .max(1.0)
    }

    fn decoration_layout_scale_for_rect(&self, rect: LogicalRect) -> f64 {
        let logical = smithay::utils::Rectangle::new(
            smithay::utils::Point::from((rect.x, rect.y)),
            (rect.width, rect.height).into(),
        );
        self.space
            .outputs()
            .filter_map(|output| {
                let geometry = self.space.output_geometry(output)?;
                logical
                    .intersection(geometry)
                    .map(|_| output.current_scale().fractional_scale())
            })
            .fold(1.0f64, f64::max)
            .max(1.0)
    }

    fn decoration_raster_scale_for_window(&self, window: &Window) -> i32 {
        self.space
            .outputs_for_element(window)
            .into_iter()
            .map(|output| output.current_scale().fractional_scale().ceil() as i32)
            .max()
            .unwrap_or(1)
            .max(1)
    }

    fn decoration_raster_scale_for_rect(&self, rect: LogicalRect) -> i32 {
        let logical = smithay::utils::Rectangle::new(
            smithay::utils::Point::from((rect.x, rect.y)),
            (rect.width, rect.height).into(),
        );
        self.space
            .outputs()
            .filter_map(|output| {
                let geometry = self.space.output_geometry(output)?;
                logical
                    .intersection(geometry)
                    .map(|_| output.current_scale().fractional_scale().ceil() as i32)
            })
            .max()
            .unwrap_or(1)
            .max(1)
    }

    pub fn apply_runtime_handler_invocation(
        &mut self,
        window: &Window,
        invocation: &DecorationHandlerInvocation,
    ) {
        let raster_scale = self.decoration_raster_scale_for_window(window);
        let Some(decoration) = self.window_decorations.get_mut(window) else {
            return;
        };

        let previous_root =
            transformed_root_rect(decoration.layout.root.rect, decoration.visual_transform);
        let previous_text_buffers = decoration.text_buffers.clone();

        if let Some(node) = invocation.node.clone() {
            decoration.tree = crate::ssd::DecorationTree::new(node);
            if let Ok(layout) = decoration
                .tree
                .layout_for_client_with_scale(decoration.client_rect, decoration.layout_scale)
            {
                decoration.layout = layout;
                let shared_edges = build_shared_edge_geometry_map(&decoration.layout);
                decoration.content_clip =
                    content_clip_for_layout(&decoration.tree, &decoration.layout, &shared_edges);
                let order_map = build_render_order_map(&decoration.layout);
                decoration.buffers = build_cached_buffers(&decoration.layout, &order_map);
                decoration.shader_buffers = build_shader_buffers(&decoration.layout, &order_map);
                decoration.text_buffers = build_text_buffers_with_fallback(
                    &decoration.layout,
                    &order_map,
                    raster_scale,
                    &mut self.text_rasterizer,
                    &previous_text_buffers,
                );
                decoration.icon_buffers = build_icon_buffers(
                    &decoration.layout,
                    &order_map,
                    raster_scale,
                    &decoration.snapshot,
                    &mut self.icon_rasterizer,
                );
                self.suggested_window_offset = suggested_window_offset(&decoration.layout);
                if handler_debug_enabled() {
                    log_decoration_refresh(
                        "runtime-handler",
                        &decoration.snapshot,
                        decoration.client_rect,
                        &decoration.layout,
                        &decoration.buffers,
                    );
                }
            } else if handler_debug_enabled() {
                warn!(
                    window_id = decoration.snapshot.id,
                    title = decoration.snapshot.title,
                    client_rect = %format_rect(decoration.client_rect),
                    layout_scale = decoration.layout_scale,
                    "runtime handler decoration relayout failed"
                );
            }
        }

        if let Some(transform) = invocation.transform {
            decoration.visual_transform = transform;
        }
        if let Some(managed_window) = &invocation.managed_window {
            decoration.managed_window = managed_window.clone();
        }

        let next_root =
            transformed_root_rect(decoration.layout.root.rect, decoration.visual_transform);
        push_damage_pair(
            &mut self.pending_decoration_damage,
            Some(previous_root),
            next_root,
        );
        self.schedule_redraw();
    }

    pub fn invoke_window_resize_event(
        &mut self,
        window_id: &str,
        event: &super::WindowResizeEventSnapshot,
        now_ms: u64,
    ) -> bool {
        self.sync_runtime_display_state();
        let invocation = match self
            .decoration_evaluator
            .window_resize(window_id, event, now_ms)
        {
            Ok(invocation) => invocation,
            Err(error) => {
                warn!(window_id, ?error, "runtime window resize event failed");
                return false;
            }
        };

        self.consume_runtime_display_config(invocation.display_config);
        self.consume_runtime_key_binding_config(invocation.key_binding_config);
        self.consume_runtime_pointer_config(invocation.pointer_config);
        self.consume_runtime_event_config(invocation.event_config);
        self.consume_runtime_process_config(invocation.process_config);
        if !invocation.process_actions.is_empty() {
            self.apply_runtime_process_actions(invocation.process_actions);
        }

        if invocation.dirty {
            self.runtime_poll_dirty = true;
            self.mark_runtime_dirty_windows(
                invocation.dirty_window_ids,
                invocation.dirty_managed_window_ids,
            );
            self.request_tty_maintenance("runtime-window-resize-dirty");
            self.schedule_redraw();
        }
        if !invocation.actions.is_empty() {
            self.request_tty_maintenance("runtime-window-resize-actions");
            self.apply_runtime_window_actions(invocation.actions);
            self.schedule_redraw();
        }
        self.runtime_scheduler_enabled = invocation.next_poll_in_ms.is_some();
        if invocation.next_poll_in_ms == Some(0) {
            self.request_tty_maintenance("runtime-window-resize-animation");
            self.schedule_redraw();
        }

        invocation.invoked
    }

    pub fn invoke_window_move_event(
        &mut self,
        window_id: &str,
        event: &super::WindowMoveEventSnapshot,
        now_ms: u64,
    ) -> bool {
        self.sync_runtime_display_state();
        let invocation = match self
            .decoration_evaluator
            .window_move(window_id, event, now_ms)
        {
            Ok(invocation) => invocation,
            Err(error) => {
                warn!(window_id, ?error, "runtime window move event failed");
                return false;
            }
        };

        self.consume_runtime_display_config(invocation.display_config);
        self.consume_runtime_key_binding_config(invocation.key_binding_config);
        self.consume_runtime_pointer_config(invocation.pointer_config);
        self.consume_runtime_event_config(invocation.event_config);
        self.consume_runtime_process_config(invocation.process_config);
        if !invocation.process_actions.is_empty() {
            self.apply_runtime_process_actions(invocation.process_actions);
        }

        if invocation.dirty {
            self.runtime_poll_dirty = true;
            self.mark_runtime_dirty_windows(
                invocation.dirty_window_ids,
                invocation.dirty_managed_window_ids,
            );
            self.request_tty_maintenance("runtime-window-move-dirty");
            self.schedule_redraw();
        }
        if !invocation.actions.is_empty() {
            self.request_tty_maintenance("runtime-window-move-actions");
            self.apply_runtime_window_actions(invocation.actions);
            self.schedule_redraw();
        }
        self.runtime_scheduler_enabled = invocation.next_poll_in_ms.is_some();
        if invocation.next_poll_in_ms == Some(0) {
            self.request_tty_maintenance("runtime-window-move-animation");
            self.schedule_redraw();
        }

        invocation.invoked
    }

    pub fn invoke_window_maximize_request_event(
        &mut self,
        snapshot: &WaylandWindowSnapshot,
        event: &super::WindowMaximizeRequestEventSnapshot,
        now_ms: u64,
    ) -> bool {
        self.sync_runtime_display_state();
        let invocation = match self
            .decoration_evaluator
            .window_maximize_request(snapshot, event, now_ms)
        {
            Ok(invocation) => invocation,
            Err(error) => {
                warn!(
                    window_id = %snapshot.id,
                    ?error,
                    "runtime window maximize request event failed"
                );
                return false;
            }
        };
        self.handle_window_state_request_invocation("runtime-window-maximize-request", invocation)
    }

    pub fn invoke_window_minimize_request_event(
        &mut self,
        snapshot: &WaylandWindowSnapshot,
        event: &super::WindowMinimizeRequestEventSnapshot,
        now_ms: u64,
    ) -> bool {
        self.sync_runtime_display_state();
        let invocation = match self
            .decoration_evaluator
            .window_minimize_request(snapshot, event, now_ms)
        {
            Ok(invocation) => invocation,
            Err(error) => {
                warn!(
                    window_id = %snapshot.id,
                    ?error,
                    "runtime window minimize request event failed"
                );
                return false;
            }
        };
        self.handle_window_state_request_invocation("runtime-window-minimize-request", invocation)
    }

    pub fn invoke_window_activate_request_event(
        &mut self,
        snapshot: &WaylandWindowSnapshot,
        event: &super::WindowActivateRequestEventSnapshot,
        now_ms: u64,
    ) -> bool {
        self.sync_runtime_display_state();
        let invocation = match self
            .decoration_evaluator
            .window_activate_request(snapshot, event, now_ms)
        {
            Ok(invocation) => invocation,
            Err(error) => {
                warn!(
                    window_id = %snapshot.id,
                    ?error,
                    "runtime window activate request event failed"
                );
                return false;
            }
        };
        self.handle_window_state_request_invocation("runtime-window-activate-request", invocation)
    }

    fn handle_window_state_request_invocation(
        &mut self,
        reason: &'static str,
        invocation: super::evaluator::DecorationWindowStateRequestInvocation,
    ) -> bool {
        self.consume_runtime_display_config(invocation.display_config);
        self.consume_runtime_key_binding_config(invocation.key_binding_config);
        self.consume_runtime_pointer_config(invocation.pointer_config);
        self.consume_runtime_event_config(invocation.event_config);
        self.consume_runtime_process_config(invocation.process_config);
        if !invocation.process_actions.is_empty() {
            self.apply_runtime_process_actions(invocation.process_actions);
        }

        if invocation.dirty {
            self.runtime_poll_dirty = true;
            self.mark_runtime_dirty_windows(
                invocation.dirty_window_ids,
                invocation.dirty_managed_window_ids,
            );
            self.request_tty_maintenance(reason);
            self.schedule_redraw();
        }
        if !invocation.actions.is_empty() {
            self.request_tty_maintenance(reason);
            self.apply_runtime_window_actions(invocation.actions);
            self.schedule_redraw();
        }
        self.runtime_scheduler_enabled = invocation.next_poll_in_ms.is_some();
        if invocation.next_poll_in_ms == Some(0) {
            self.request_tty_maintenance(reason);
            self.schedule_redraw();
        }

        invocation.invoked
    }

    pub fn managed_resize_initial_rect(
        &self,
        window: &Window,
        fallback: smithay::utils::Rectangle<i32, smithay::utils::Logical>,
    ) -> smithay::utils::Rectangle<i32, smithay::utils::Logical> {
        self.window_decorations
            .get(window)
            .filter(|decoration| decoration.managed_window.managed)
            .map(|decoration| decoration.layout.root.rect)
            .map(|rect| {
                smithay::utils::Rectangle::new(
                    (rect.x, rect.y).into(),
                    (rect.width, rect.height).into(),
                )
            })
            .unwrap_or(fallback)
    }

    pub fn promote_window_to_closing_snapshot(
        &mut self,
        window_id: &str,
        decoration: &WindowDecorationState,
        now_ms: u64,
    ) -> Result<bool, DecorationEvaluationError> {
        if self.closing_window_snapshots.contains_key(window_id) {
            return Ok(true);
        }

        // Always use the live (client-area) snapshot for the closing animation.
        // The complete_window_snapshot bakes decorations into the texture, so using it here
        // would cause decorations to appear twice (once in the texture, once from separate
        // decoration elements). Clean it up but don't use it.
        self.complete_window_snapshots.remove(window_id);
        let live_snapshot = self.live_window_snapshots.remove(window_id);
        let Some(live_snapshot) = live_snapshot else {
            return Ok(false);
        };

        self.sync_runtime_display_state();
        let invocation = self.decoration_evaluator.start_close(window_id, now_ms)?;
        self.consume_runtime_display_config(invocation.display_config.clone());
        self.consume_runtime_key_binding_config(invocation.key_binding_config.clone());
        self.consume_runtime_pointer_config(invocation.pointer_config.clone());
        self.consume_runtime_event_config(invocation.event_config.clone());
        self.consume_runtime_process_config(invocation.process_config.clone());
        if !invocation.process_actions.is_empty() {
            self.apply_runtime_process_actions(invocation.process_actions.clone());
        }
        if !invocation.invoked {
            self.live_window_snapshots
                .insert(window_id.to_string(), live_snapshot);
            return Ok(false);
        }

        self.closing_window_snapshots.insert(
            window_id.to_string(),
            crate::backend::snapshot::ClosingWindowSnapshot {
                window_id: window_id.to_string(),
                live: live_snapshot,
                decoration: decoration.clone(),
                transform: invocation.transform.unwrap_or(decoration.visual_transform),
            },
        );
        self.mark_runtime_dirty_windows(
            invocation.dirty_window_ids,
            invocation.dirty_managed_window_ids,
        );
        self.runtime_scheduler_enabled = invocation.next_poll_in_ms.is_some();
        self.apply_runtime_window_actions(invocation.actions);
        self.schedule_redraw();

        Ok(true)
    }

    pub fn suggested_window_location(
        &self,
        snapshot: &WaylandWindowSnapshot,
    ) -> Result<(i32, i32), DecorationEvaluationError> {
        let pointer_location = self
            .seat
            .get_pointer()
            .map(|pointer| pointer.current_location().to_i32_round());
        let preferred_output_geometry = pointer_location
            .and_then(|pointer_location| {
                self.space
                    .outputs()
                    .filter_map(|output| self.space.output_geometry(output))
                    .find(|geometry| geometry.contains(pointer_location))
            })
            .or_else(|| {
                self.space
                    .outputs()
                    .filter_map(|output| self.space.output_geometry(output))
                    .min_by_key(|geometry| (geometry.loc.x, geometry.loc.y))
            });

        if let Some((left_extent, top_extent)) = self.suggested_window_offset {
            let location = if let Some(output_geo) = preferred_output_geometry {
                (
                    output_geo.loc.x + left_extent,
                    output_geo.loc.y + top_extent,
                )
            } else {
                (left_extent, top_extent)
            };

            debug!(
                window_id = snapshot.id,
                title = snapshot.title,
                app_id = snapshot.app_id,
                suggested_x = location.0,
                suggested_y = location.1,
                "computed suggested client location from cached offsets"
            );

            return Ok(location);
        }

        let now_ms = Duration::from(self.clock.now()).as_millis() as u64;
        let evaluation = StaticDecorationEvaluator.evaluate_window(snapshot, now_ms)?;
        let tree = DecorationTree::new(evaluation.node);
        let layout = tree
            .layout_for_client(LogicalRect::new(0, 0, 0, 0))
            .map_err(super::DecorationEvaluationError::Layout)?;

        let root = layout.root.rect;
        let slot = layout
            .window_slot_rect()
            .ok_or(super::DecorationEvaluationError::Layout(
                super::DecorationLayoutError::MissingComputedWindowSlot,
            ))?;

        let left_extent = (slot.x - root.x).max(0);
        let top_extent = (slot.y - root.y).max(0);

        let location = if let Some(output_geo) = preferred_output_geometry {
            (
                output_geo.loc.x + left_extent,
                output_geo.loc.y + top_extent,
            )
        } else {
            (left_extent, top_extent)
        };

        debug!(
            window_id = snapshot.id,
            title = snapshot.title,
            app_id = snapshot.app_id,
            root_rect = %format_rect(root),
            slot_rect = %format_rect(slot),
            suggested_x = location.0,
            suggested_y = location.1,
            "computed suggested client location for new window"
        );
        Ok(location)
    }

    pub fn initial_managed_window_client_rect(
        &mut self,
        snapshot: &WaylandWindowSnapshot,
    ) -> Result<Option<LogicalRect>, DecorationEvaluationError> {
        self.sync_runtime_display_state();
        let now_ms = Duration::from(self.clock.now()).as_millis() as u64;
        // Initial configure needs the TS-managed rect before the window's first commit.
        // This uses a preconfigure runtime evaluation; the runtime keeps onOpen-created
        // window state but reanchors animations when the first real evaluation arrives.
        let evaluation = self
            .decoration_evaluator
            .evaluate_window_preview(snapshot, now_ms)?;

        self.consume_runtime_display_config(evaluation.display_config.clone());
        self.consume_runtime_key_binding_config(evaluation.key_binding_config.clone());
        self.consume_runtime_pointer_config(evaluation.pointer_config.clone());
        self.consume_runtime_event_config(evaluation.event_config.clone());
        self.consume_runtime_process_config(evaluation.process_config.clone());
        if !evaluation.process_actions.is_empty() {
            self.apply_runtime_process_actions(evaluation.process_actions.clone());
        }
        self.runtime_scheduler_enabled = evaluation.next_poll_in_ms.is_some();

        let managed = evaluation.managed_window;
        if !managed.managed {
            return Ok(None);
        }

        let Some(desired_root) = managed.rect else {
            return Ok(None);
        };
        let desired_root = managed_rect_snapshot_to_logical_rect(desired_root);
        if desired_root.width <= 0 || desired_root.height <= 0 {
            return Ok(None);
        }

        let tree = DecorationTree::new(evaluation.node);
        let layout_scale = self.decoration_layout_scale_for_rect(desired_root);
        managed_client_rect_for_root(&tree, desired_root, layout_scale).map(Some)
    }

    fn primary_output_name_for_window(&self, window: &Window) -> Option<String> {
        // Always use space.element_location (via window_client_rect) as the source of truth for
        // the window's current position. decoration.layout.root.rect lags behind because it is
        // only updated inside refresh_window_decorations_for_output — which itself calls this
        // function to decide whether to process the window at all. Using the stale decoration
        // rect here creates a chicken-and-egg deadlock: a window that moves from eDP-1 to DP-4
        // keeps reporting "eDP-1" as its primary output, so the DP-4 refresh pass skips it, and
        // its decoration coordinates never get updated.
        let center = if let Some(client_rect) = self.window_client_rect(window) {
            Point::from((
                client_rect.x + client_rect.width / 2,
                client_rect.y + client_rect.height / 2,
            ))
        } else {
            return self
                .space
                .outputs_for_element(window)
                .first()
                .map(|output| output.name());
        };

        self.space
            .outputs()
            .find(|output| {
                self.space
                    .output_geometry(output)
                    .is_some_and(|geometry| geometry.contains(center))
            })
            .map(|output| output.name())
            .or_else(|| {
                self.space
                    .outputs_for_element(window)
                    .first()
                    .map(|output| output.name())
            })
    }

    pub fn refresh_window_decorations(&mut self) -> Result<(), DecorationEvaluationError> {
        self.refresh_window_decorations_for_output(None)
    }

    pub fn refresh_layer_effects_for_output(
        &mut self,
        output_name: &str,
    ) -> Result<(), DecorationEvaluationError> {
        let refresh_started_at = Instant::now();
        let snapshot_started_at = Instant::now();
        let snapshots = self.snapshot_layers();
        let snapshot_elapsed_ms = snapshot_started_at.elapsed().as_secs_f64() * 1000.0;
        let output_layer_ids = snapshots
            .iter()
            .filter(|snapshot| snapshot.output_name == output_name)
            .map(|snapshot| snapshot.id.clone())
            .collect::<std::collections::HashSet<_>>();
        let now_ms = Duration::from(self.clock.now()).as_millis() as u64;
        let sync_started_at = Instant::now();
        self.sync_runtime_display_state();
        let sync_elapsed_ms = sync_started_at.elapsed().as_secs_f64() * 1000.0;
        let evaluate_started_at = Instant::now();
        let evaluation =
            self.decoration_evaluator
                .evaluate_layer_effects(output_name, &snapshots, now_ms)?;
        let evaluate_elapsed_ms = evaluate_started_at.elapsed().as_secs_f64() * 1000.0;
        let apply_started_at = Instant::now();
        self.consume_runtime_display_config(evaluation.display_config.clone());
        self.consume_runtime_key_binding_config(evaluation.key_binding_config.clone());
        self.consume_runtime_pointer_config(evaluation.pointer_config.clone());
        self.consume_runtime_event_config(evaluation.event_config.clone());
        self.consume_runtime_process_config(evaluation.process_config.clone());
        if !evaluation.process_actions.is_empty() {
            self.apply_runtime_process_actions(evaluation.process_actions.clone());
        }

        self.runtime_scheduler_enabled = evaluation.next_poll_in_ms.is_some();
        if evaluation.next_poll_in_ms == Some(0) {
            self.runtime_animation_outputs
                .insert(output_name.to_string());
        } else {
            self.runtime_animation_outputs.remove(output_name);
        }
        let output_layer_count = output_layer_ids.len();
        for layer_id in &output_layer_ids {
            self.configured_layer_effects.remove(layer_id);
        }
        let effect_count = evaluation.effects.len();
        let next_poll_in_ms = evaluation.next_poll_in_ms;
        for assignment in evaluation.effects {
            if let Some(effect) = assignment.effect {
                self.configured_layer_effects
                    .insert(assignment.layer_id, effect);
            }
        }
        let apply_elapsed_ms = apply_started_at.elapsed().as_secs_f64() * 1000.0;
        let elapsed_ms = refresh_started_at.elapsed().as_secs_f64() * 1000.0;

        if animation_timing_debug_enabled()
            && (elapsed_ms >= animation_spike_threshold_ms()
                || evaluate_elapsed_ms >= animation_spike_threshold_ms())
        {
            warn!(
                output_name,
                layer_snapshot_count = snapshots.len(),
                output_layer_count,
                effect_count,
                snapshot_elapsed_ms,
                sync_elapsed_ms,
                evaluate_elapsed_ms,
                apply_elapsed_ms,
                elapsed_ms,
                next_poll_in_ms,
                "animation timing: layer effects spike"
            );
        }

        Ok(())
    }

    pub fn refresh_window_decorations_for_output(
        &mut self,
        target_output_name: Option<&str>,
    ) -> Result<(), DecorationEvaluationError> {
        let refresh_started_at = Instant::now();
        let spike_threshold_ms = animation_spike_threshold_ms();
        let force_runtime_reevaluate =
            self.runtime_poll_dirty && self.runtime_dirty_window_ids.is_empty();
        let force_output_animation_reevaluate = target_output_name
            .is_some_and(|output_name| self.runtime_animation_outputs.contains(output_name));
        let force_async_asset_refresh = self.async_asset_dirty;
        let mut pending_window_actions = Vec::new();
        let mut pending_finalize_close_damage = Vec::new();
        let mut pending_display_config_updates = Vec::new();
        let mut pending_key_binding_config_updates = Vec::new();
        let mut pending_pointer_config_updates = Vec::new();
        let mut pending_event_config_updates = Vec::new();
        let mut pending_process_config_updates = Vec::new();
        let mut pending_process_actions = Vec::new();
        self.sync_runtime_display_state();
        let windows: Vec<Window> = self.space.elements().cloned().collect();
        let live_window_ids = windows
            .iter()
            .map(|window| self.snapshot_window(window).id)
            .collect::<std::collections::HashSet<_>>();
        let window_count = windows.len();
        let mut rebuilt = 0usize;
        let mut relayout = 0usize;
        let mut runtime_dirty_updates = 0usize;
        let mut promoted_closing = 0usize;
        let mut closing_runtime_updates = 0usize;
        let mut animation_active_for_target = false;
        let mut processed_runtime_dirty_window_ids = std::collections::HashSet::new();
        let mut managed_rect_apply_window_ids = std::collections::HashSet::new();
        let now_ms = Duration::from(self.clock.now()).as_millis() as u64;
        let closing_active_count = self.closing_window_snapshots.len();
        let removed_windows_started_at = Instant::now();
        let removed_windows = self
            .window_decorations
            .iter()
            .filter(|(window, _)| !windows.contains(window))
            .map(|(_, decoration)| {
                (
                    decoration.snapshot.id.clone(),
                    decoration.layout.root.rect,
                    decoration.visual_transform,
                    decoration.clone(),
                )
            })
            .collect::<Vec<_>>();
        for (window_id, root_rect, _previous_transform, decoration) in &removed_windows {
            if self.closing_window_snapshots.contains_key(window_id) {
                continue;
            }

            if !self.promote_window_to_closing_snapshot(window_id, decoration, now_ms)? {
                self.decoration_evaluator.window_closed(window_id)?;
                self.windows_ready_for_decoration.remove(window_id);
                self.runtime_dirty_window_ids.remove(window_id);
                self.runtime_managed_only_window_ids.remove(window_id);
                self.snapshot_dirty_window_ids.remove(window_id);
                self.pending_decoration_damage.push(*root_rect);
            } else {
                promoted_closing = promoted_closing.saturating_add(1);
            }
        }
        self.window_decorations
            .retain(|window, _| windows.contains(window));
        self.window_primary_output_names
            .retain(|window, _| windows.contains(window));
        let removed_windows_elapsed_ms =
            removed_windows_started_at.elapsed().as_secs_f64() * 1000.0;

        let windows_pass_started_at = Instant::now();
        for window in windows {
            let primary_output_name = self.primary_output_name_for_window(&window);
            let snapshot = self.snapshot_window(&window);
            let snapshot_id = snapshot.id.clone();
            let window_was_runtime_dirty = self.runtime_dirty_window_ids.contains(&snapshot_id);
            if !should_process_window_for_refresh(
                primary_output_name.as_deref(),
                target_output_name,
                force_async_asset_refresh,
                force_output_animation_reevaluate,
                force_runtime_reevaluate,
                window_was_runtime_dirty,
            ) {
                continue;
            }
            if let Some(primary_output_name) = primary_output_name {
                self.window_primary_output_names
                    .insert(window.clone(), primary_output_name);
            }
            let client_rect = match self.window_client_rect(&window) {
                Some(rect) => rect,
                None => continue,
            };
            let layout_scale = self.decoration_layout_scale_for_window(&window);
            let window_raster_scale = self.decoration_raster_scale_for_window(&window);
            let cached_effective_client_rect = self
                .window_decorations
                .get(&window)
                .map(|cached| {
                    // Fast path: when the cache is coherent
                    // (`client_rect_potentially_stale == false`),
                    // `managed_client_rect_for_state(cached.tree,
                    // cached.managed_window, _, cached.layout_scale)` is
                    // *by construction* equal to `cached.client_rect` — the
                    // function's result for managed windows depends only on
                    // `(tree, managed_window.rect, scale)`, all of which are
                    // exactly the inputs the cached rect was derived from,
                    // and for unmanaged windows the function returns the
                    // fallback (which `snapshot_changed` would have caught
                    // separately). Skipping it avoids the up-to-4-iteration
                    // probe-layout loop per window per redraw, which was
                    // the dominant CPU cost during heavy client commits
                    // (ufo-test at 4K@120Hz: ~25% of CPU in the SSD layout
                    // path).
                    if !cached.client_rect_potentially_stale
                        && cached.snapshot.position == snapshot.position
                    {
                        return Ok(cached.client_rect);
                    }
                    managed_client_rect_for_state(
                        &cached.tree,
                        &cached.managed_window,
                        client_rect,
                        cached.layout_scale,
                    )
                })
                .transpose()?
                .unwrap_or(client_rect);
            let had_cached_decoration = self.window_decorations.contains_key(&window);
            let runtime_state_changed = self
                .window_decorations
                .get(&window)
                .map(|cached| window_snapshot_requires_runtime_refresh(&cached.snapshot, &snapshot))
                .unwrap_or(false);
            let snapshot_changed = self
                .window_decorations
                .get(&window)
                .map(|cached| window_snapshot_requires_rebuild(&cached.snapshot, &snapshot))
                .unwrap_or(true);

            let runtime_dirty = force_runtime_reevaluate
                || force_output_animation_reevaluate
                || runtime_state_changed
                || window_was_runtime_dirty;
            if !had_cached_decoration || snapshot_changed {
                let started_at = Instant::now();
                let previous_root = self.window_decorations.get(&window).map(|cached| {
                    transformed_root_rect(cached.layout.root.rect, cached.visual_transform)
                });
                let evaluate_started_at = Instant::now();
                let evaluation = match self.decoration_evaluator.evaluate_window(&snapshot, now_ms)
                {
                    Ok(evaluation) => evaluation,
                    Err(error) => {
                        warn!(
                            window_id = snapshot.id,
                            title = snapshot.title,
                            app_id = snapshot.app_id,
                            ?error,
                            "decoration runtime evaluation failed, falling back to static decoration"
                        );
                        StaticDecorationEvaluator.evaluate_window(&snapshot, now_ms)?
                    }
                };
                let evaluate_ms = evaluate_started_at.elapsed().as_secs_f64() * 1000.0;
                pending_display_config_updates.push(evaluation.display_config.clone());
                pending_key_binding_config_updates.push(evaluation.key_binding_config.clone());
                pending_pointer_config_updates.push(evaluation.pointer_config.clone());
                pending_event_config_updates.push(evaluation.event_config.clone());
                pending_process_config_updates.push(evaluation.process_config.clone());
                pending_process_actions.extend(evaluation.process_actions.clone());
                let tree = DecorationTree::new(evaluation.node);
                let layout_client_rect = managed_client_rect_for_state(
                    &tree,
                    &evaluation.managed_window,
                    client_rect,
                    layout_scale,
                )?;
                let layout_started_at = Instant::now();
                let layout = tree
                    .layout_for_client_with_scale(layout_client_rect, layout_scale)
                    .map_err(super::DecorationEvaluationError::Layout)?;
                let layout_ms = layout_started_at.elapsed().as_secs_f64() * 1000.0;
                push_damage_pair(
                    &mut self.pending_decoration_damage,
                    previous_root,
                    transformed_root_rect(layout.root.rect, evaluation.transform),
                );
                let previous_text_buffers = self
                    .window_decorations
                    .get(&window)
                    .map(|cached| cached.text_buffers.clone())
                    .unwrap_or_default();
                let clip_started_at = Instant::now();
                let shared_edges = build_shared_edge_geometry_map(&layout);
                let content_clip = content_clip_for_layout(&tree, &layout, &shared_edges);
                let clip_ms = clip_started_at.elapsed().as_secs_f64() * 1000.0;
                let order_started_at = Instant::now();
                let order_map = build_render_order_map(&layout);
                let order_ms = order_started_at.elapsed().as_secs_f64() * 1000.0;
                let buffers_started_at = Instant::now();
                let buffers = build_cached_buffers(&layout, &order_map);
                let buffers_ms = buffers_started_at.elapsed().as_secs_f64() * 1000.0;
                let shader_started_at = Instant::now();
                let mut shader_buffers = build_shader_buffers(&layout, &order_map);
                let shader_ms = shader_started_at.elapsed().as_secs_f64() * 1000.0;
                let text_started_at = Instant::now();
                let text_buffers = build_text_buffers_with_fallback(
                    &layout,
                    &order_map,
                    window_raster_scale,
                    &mut self.text_rasterizer,
                    &previous_text_buffers,
                );
                let text_ms = text_started_at.elapsed().as_secs_f64() * 1000.0;
                let icon_started_at = Instant::now();
                let icon_buffers = build_icon_buffers(
                    &layout,
                    &order_map,
                    window_raster_scale,
                    &snapshot,
                    &mut self.icon_rasterizer,
                );
                let icon_ms = icon_started_at.elapsed().as_secs_f64() * 1000.0;
                let finalize_started_at = Instant::now();
                if let Some(previous) = self.window_decorations.get(&window) {
                    freeze_manual_shader_buffers(&previous.shader_buffers, &mut shader_buffers);
                }
                self.suggested_window_offset = suggested_window_offset(&layout);
                let finalize_ms = finalize_started_at.elapsed().as_secs_f64() * 1000.0;
                rebuilt += 1;
                record_managed_rect_path_event(ManagedRectPathEvent::FullRebuild);
                if evaluation.managed_window.managed && evaluation.managed_window.rect.is_some() {
                    managed_rect_apply_window_ids.insert(snapshot.id.clone());
                }
                let elapsed_ms = started_at.elapsed().as_secs_f64() * 1000.0;
                debug!(
                    window_id = snapshot.id,
                    title = snapshot.title,
                    text_buffer_count = text_buffers.len(),
                    elapsed_ms,
                    "rebuilt window decoration tree"
                );
                log_animation_window_refresh_timing(
                    "rebuild",
                    &snapshot,
                    elapsed_ms,
                    evaluate_ms,
                    layout_ms,
                    clip_ms,
                    order_ms,
                    buffers_ms,
                    shader_ms,
                    text_ms,
                    icon_ms,
                    finalize_ms,
                    0,
                    None,
                    None,
                );
                log_decoration_refresh("rebuild", &snapshot, layout_client_rect, &layout, &buffers);
                let caches = self
                    .window_decorations
                    .remove(&window)
                    .map(|cached| {
                        (
                            cached.rounded_cache,
                            cached.shader_cache,
                            cached.backdrop_cache,
                            cached.window_effect_cache,
                        )
                    })
                    .unwrap_or_default();
                let (rounded_cache, shader_cache, backdrop_cache, window_effect_cache) = caches;
                self.window_decorations.insert(
                    window,
                    WindowDecorationState {
                        snapshot,
                        tree,
                        layout,
                        layout_scale,
                        client_rect: layout_client_rect,
                        client_rect_potentially_stale: false,
                        visual_transform: evaluation.transform,
                        managed_window: evaluation.managed_window,
                        window_effects: evaluation.window_effects,
                        content_clip,
                        buffers,
                        shader_buffers,
                        text_buffers,
                        icon_buffers,
                        rounded_cache,
                        shader_cache,
                        backdrop_cache,
                        window_effect_cache,
                    },
                );
                self.schedule_redraw();
                self.runtime_scheduler_enabled = evaluation.next_poll_in_ms.is_some();
                animation_active_for_target |= evaluation.next_poll_in_ms == Some(0);
            } else if let Some(cached) = self.window_decorations.get_mut(&window) {
                if cached.client_rect != cached_effective_client_rect
                    && !runtime_dirty
                    && !force_async_asset_refresh
                    && cached.client_rect.width == cached_effective_client_rect.width
                    && cached.client_rect.height == cached_effective_client_rect.height
                {
                    let previous_root =
                        transformed_root_rect(cached.layout.root.rect, cached.visual_transform);
                    let dx = cached_effective_client_rect.x - cached.client_rect.x;
                    let dy = cached_effective_client_rect.y - cached.client_rect.y;
                    translate_cached_decoration_position(
                        cached,
                        dx,
                        dy,
                        cached_effective_client_rect,
                    );
                    cached.snapshot = snapshot;
                    let next_root =
                        transformed_root_rect(cached.layout.root.rect, cached.visual_transform);
                    push_damage_pair(
                        &mut self.pending_decoration_damage,
                        Some(previous_root),
                        next_root,
                    );
                    self.schedule_redraw();
                    record_managed_rect_path_event(ManagedRectPathEvent::RefreshPositionTranslate);
                } else if cached.client_rect != cached_effective_client_rect
                    && !runtime_dirty
                    && !force_async_asset_refresh
                {
                    let started_at = Instant::now();
                    let finalize_ms = 0.0;
                    let previous_root =
                        transformed_root_rect(cached.layout.root.rect, cached.visual_transform);
                    let layout_started_at = Instant::now();
                    cached.layout = cached
                        .tree
                        .layout_for_client_with_scale(cached_effective_client_rect, layout_scale)
                        .map_err(super::DecorationEvaluationError::Layout)?;
                    let layout_ms = layout_started_at.elapsed().as_secs_f64() * 1000.0;
                    cached.layout_scale = layout_scale;
                    push_damage_pair(
                        &mut self.pending_decoration_damage,
                        Some(previous_root),
                        transformed_root_rect(cached.layout.root.rect, cached.visual_transform),
                    );
                    cached.client_rect = cached_effective_client_rect;
                    cached.client_rect_potentially_stale = false;
                    cached.snapshot = snapshot;
                    let clip_started_at = Instant::now();
                    let shared_edges = build_shared_edge_geometry_map(&cached.layout);
                    cached.content_clip =
                        content_clip_for_layout(&cached.tree, &cached.layout, &shared_edges);
                    let clip_ms = clip_started_at.elapsed().as_secs_f64() * 1000.0;
                    let order_started_at = Instant::now();
                    let order_map = build_render_order_map(&cached.layout);
                    let order_ms = order_started_at.elapsed().as_secs_f64() * 1000.0;
                    let buffers_started_at = Instant::now();
                    cached.buffers = build_cached_buffers(&cached.layout, &order_map);
                    let buffers_ms = buffers_started_at.elapsed().as_secs_f64() * 1000.0;
                    let shader_started_at = Instant::now();
                    cached.shader_buffers = build_shader_buffers(&cached.layout, &order_map);
                    let shader_ms = shader_started_at.elapsed().as_secs_f64() * 1000.0;
                    let text_started_at = Instant::now();
                    let previous_text_buffers = cached.text_buffers.clone();
                    cached.text_buffers = build_text_buffers_with_fallback(
                        &cached.layout,
                        &order_map,
                        window_raster_scale,
                        &mut self.text_rasterizer,
                        &previous_text_buffers,
                    );
                    let text_ms = text_started_at.elapsed().as_secs_f64() * 1000.0;
                    let icon_started_at = Instant::now();
                    cached.icon_buffers = build_icon_buffers(
                        &cached.layout,
                        &order_map,
                        window_raster_scale,
                        &cached.snapshot,
                        &mut self.icon_rasterizer,
                    );
                    let icon_ms = icon_started_at.elapsed().as_secs_f64() * 1000.0;
                    self.suggested_window_offset = suggested_window_offset(&cached.layout);
                    relayout += 1;
                    let elapsed_ms = started_at.elapsed().as_secs_f64() * 1000.0;
                    debug!(
                        window_id = cached.snapshot.id,
                        title = cached.snapshot.title,
                        text_buffer_count = cached.text_buffers.len(),
                        elapsed_ms,
                        "recomputed window decoration layout"
                    );
                    log_animation_window_refresh_timing(
                        "relayout",
                        &cached.snapshot,
                        elapsed_ms,
                        0.0,
                        layout_ms,
                        clip_ms,
                        order_ms,
                        buffers_ms,
                        shader_ms,
                        text_ms,
                        icon_ms,
                        finalize_ms,
                        0,
                        None,
                        None,
                    );
                    log_decoration_refresh(
                        "relayout",
                        &cached.snapshot,
                        cached_effective_client_rect,
                        &cached.layout,
                        &cached.buffers,
                    );
                    self.schedule_redraw();
                    record_managed_rect_path_event(ManagedRectPathEvent::RefreshSizeRelayout);
                } else if runtime_dirty {
                    let started_at = Instant::now();
                    let previous_root =
                        transformed_root_rect(cached.layout.root.rect, cached.visual_transform);
                    let evaluate_started_at = Instant::now();
                    let evaluation = if runtime_state_changed {
                        match self.decoration_evaluator.evaluate_window(&snapshot, now_ms) {
                            Ok(evaluation) => evaluation.into(),
                            Err(error) => {
                                warn!(
                                    window_id = snapshot.id,
                                    title = snapshot.title,
                                    app_id = snapshot.app_id,
                                    ?error,
                                    "decoration runtime evaluation failed during runtime state update, falling back to static decoration"
                                );
                                StaticDecorationEvaluator
                                    .evaluate_window(&snapshot, now_ms)?
                                    .into()
                            }
                        }
                    } else {
                        match self
                            .decoration_evaluator
                            .evaluate_cached_window(&snapshot.id, now_ms)
                        {
                            Ok(evaluation) => evaluation,
                            Err(error) => {
                                warn!(
                                    window_id = snapshot.id,
                                    title = snapshot.title,
                                    app_id = snapshot.app_id,
                                    ?error,
                                    "cached decoration runtime evaluation failed during transform update, falling back to full evaluation"
                                );
                                match self.decoration_evaluator.evaluate_window(&snapshot, now_ms) {
                                    Ok(evaluation) => evaluation.into(),
                                    Err(error) => {
                                        warn!(
                                            window_id = snapshot.id,
                                            title = snapshot.title,
                                            app_id = snapshot.app_id,
                                            ?error,
                                            "decoration runtime evaluation failed during transform update, falling back to static decoration"
                                        );
                                        StaticDecorationEvaluator
                                            .evaluate_window(&snapshot, now_ms)?
                                            .into()
                                    }
                                }
                            }
                        }
                    };
                    let evaluate_ms = evaluate_started_at.elapsed().as_secs_f64() * 1000.0;
                    pending_display_config_updates.push(evaluation.display_config.clone());
                    pending_key_binding_config_updates.push(evaluation.key_binding_config.clone());
                    pending_pointer_config_updates.push(evaluation.pointer_config.clone());
                    pending_event_config_updates.push(evaluation.event_config.clone());
                    pending_process_config_updates.push(evaluation.process_config.clone());
                    pending_process_actions.extend(evaluation.process_actions.clone());
                    if evaluation.managed_window_only {
                        cached.snapshot = snapshot;
                        cached.managed_window = evaluation.managed_window;
                        cached.window_effects = evaluation.window_effects;
                        cached.visual_transform = evaluation.transform;
                        let next_root =
                            transformed_root_rect(cached.layout.root.rect, cached.visual_transform);
                        push_damage_pair(
                            &mut self.pending_decoration_damage,
                            Some(previous_root),
                            next_root,
                        );
                        let elapsed_ms = started_at.elapsed().as_secs_f64() * 1000.0;
                        log_animation_window_refresh_timing(
                            "managed-window-only",
                            &cached.snapshot,
                            elapsed_ms,
                            evaluate_ms,
                            0.0,
                            0.0,
                            0.0,
                            0.0,
                            0.0,
                            0.0,
                            0.0,
                            0.0,
                            0,
                            Some(false),
                            Some(true),
                        );
                        runtime_dirty_updates = runtime_dirty_updates.saturating_add(1);
                        record_managed_rect_path_event(ManagedRectPathEvent::RuntimeManagedOnly);
                        managed_rect_apply_window_ids.insert(snapshot_id.clone());
                        cached.client_rect_potentially_stale = false;
                        self.schedule_redraw();
                        self.runtime_scheduler_enabled = evaluation.next_poll_in_ms.is_some();
                        animation_active_for_target |= evaluation.next_poll_in_ms == Some(0);
                        processed_runtime_dirty_window_ids.insert(snapshot_id);
                        continue;
                    }
                    let previous_transform = cached.visual_transform;
                    let previous_layout = cached.layout.clone();
                    let previous_buffers = cached.buffers.clone();
                    let previous_shader_buffers = cached.shader_buffers.clone();
                    let previous_text_buffers = cached.text_buffers.clone();
                    let previous_icon_buffers = cached.icon_buffers.clone();
                    let rebuild_started_at = Instant::now();
                    let Some(evaluation_node) = evaluation.node else {
                        return Err(DecorationEvaluationError::RuntimeProtocol(
                            "cached evaluation returned no tree without managedWindowOnly".into(),
                        ));
                    };
                    let next_tree = DecorationTree::new(evaluation_node);
                    let next_transform = evaluation.transform;
                    let next_managed_window = evaluation.managed_window;
                    let next_window_effects = evaluation.window_effects;
                    let dirty_node_ids = evaluation.dirty_node_ids;
                    let tree_changed = next_tree != cached.tree;
                    let mut layout_equivalent_state = None;
                    cached.snapshot = snapshot;
                    cached.managed_window = next_managed_window;
                    cached.window_effects = next_window_effects;

                    if !tree_changed {
                        cached.visual_transform = next_transform;
                    } else {
                        let layout_equivalent = cached.tree.root.layout_equivalent(&next_tree.root);
                        layout_equivalent_state = Some(layout_equivalent);
                        cached.tree = next_tree;
                        if layout_equivalent {
                            reapply_tree_preserving_layout(
                                &mut cached.layout.root,
                                &cached.tree.root,
                                None,
                                cached.layout_scale,
                            );
                            cached.layout.root.sync_root_bounds(cached.layout_scale);
                            let shared_edges = build_shared_edge_geometry_map(&cached.layout);
                            cached.content_clip = content_clip_for_layout(
                                &cached.tree,
                                &cached.layout,
                                &shared_edges,
                            );
                            let order_map = build_render_order_map(&cached.layout);
                            if dirty_node_ids.is_empty() {
                                cached.buffers = build_cached_buffers(&cached.layout, &order_map);
                                cached.shader_buffers =
                                    build_shader_buffers(&cached.layout, &order_map);
                                freeze_manual_shader_buffers(
                                    &previous_shader_buffers,
                                    &mut cached.shader_buffers,
                                );
                                cached.text_buffers = build_text_buffers_with_fallback(
                                    &cached.layout,
                                    &order_map,
                                    window_raster_scale,
                                    &mut self.text_rasterizer,
                                    &previous_text_buffers,
                                );
                                cached.icon_buffers = build_icon_buffers(
                                    &cached.layout,
                                    &order_map,
                                    window_raster_scale,
                                    &cached.snapshot,
                                    &mut self.icon_rasterizer,
                                );
                            } else {
                                let (rebuilt_buffers, rebuilt_shader_buffers) =
                                    rebuild_partial_buffers(
                                        &cached.layout,
                                        &order_map,
                                        &dirty_node_ids,
                                    );
                                let mut merged_shader_buffers = merge_shader_buffers(
                                    &previous_shader_buffers,
                                    rebuilt_shader_buffers,
                                    &dirty_node_ids,
                                );
                                freeze_manual_shader_buffers(
                                    &previous_shader_buffers,
                                    &mut merged_shader_buffers,
                                );
                                cached.buffers = merge_cached_buffers(
                                    &previous_buffers,
                                    rebuilt_buffers,
                                    &dirty_node_ids,
                                );
                                cached.shader_buffers = merged_shader_buffers;
                                cached.text_buffers = merge_text_buffers(
                                    &previous_text_buffers,
                                    rebuild_partial_text_buffers_with_fallback(
                                        &cached.layout,
                                        &order_map,
                                        &dirty_node_ids,
                                        window_raster_scale,
                                        &mut self.text_rasterizer,
                                        &previous_text_buffers,
                                    ),
                                    &dirty_node_ids,
                                );
                                cached.icon_buffers = merge_icon_buffers(
                                    &previous_icon_buffers,
                                    rebuild_partial_icon_buffers(
                                        &cached.layout,
                                        &order_map,
                                        &dirty_node_ids,
                                        window_raster_scale,
                                        &cached.snapshot,
                                        &mut self.icon_rasterizer,
                                    ),
                                    &dirty_node_ids,
                                );
                            }
                        } else {
                            cached.layout = cached
                                .tree
                                .layout_for_client_with_scale(client_rect, layout_scale)
                                .map_err(super::DecorationEvaluationError::Layout)?;
                            cached.layout_scale = layout_scale;
                            let shared_edges = build_shared_edge_geometry_map(&cached.layout);
                            cached.content_clip = content_clip_for_layout(
                                &cached.tree,
                                &cached.layout,
                                &shared_edges,
                            );
                            let order_map = build_render_order_map(&cached.layout);
                            cached.buffers = build_cached_buffers(&cached.layout, &order_map);
                            cached.shader_buffers =
                                build_shader_buffers(&cached.layout, &order_map);
                            freeze_manual_shader_buffers(
                                &previous_shader_buffers,
                                &mut cached.shader_buffers,
                            );
                            cached.text_buffers = build_text_buffers_with_fallback(
                                &cached.layout,
                                &order_map,
                                window_raster_scale,
                                &mut self.text_rasterizer,
                                &previous_text_buffers,
                            );
                            cached.icon_buffers = build_icon_buffers(
                                &cached.layout,
                                &order_map,
                                window_raster_scale,
                                &cached.snapshot,
                                &mut self.icon_rasterizer,
                            );
                            self.suggested_window_offset = suggested_window_offset(&cached.layout);
                        }
                        cached.visual_transform = next_transform;
                    }
                    let rebuild_ms = rebuild_started_at.elapsed().as_secs_f64() * 1000.0;
                    let finalize_started_at = Instant::now();
                    let next_root =
                        transformed_root_rect(cached.layout.root.rect, cached.visual_transform);
                    if previous_transform != cached.visual_transform || previous_root != next_root {
                        push_damage_pair(
                            &mut self.pending_decoration_damage,
                            Some(previous_root),
                            next_root,
                        );
                    } else if !dirty_node_ids.is_empty() {
                        self.pending_decoration_damage
                            .extend(runtime_dirty_node_damage_rects(
                                &previous_layout,
                                previous_transform,
                                &cached.layout,
                                cached.visual_transform,
                                &dirty_node_ids,
                            ));
                    } else {
                        self.pending_decoration_damage
                            .extend(runtime_dirty_damage_rects(
                                &previous_buffers,
                                &cached.buffers,
                                &previous_shader_buffers,
                                &cached.shader_buffers,
                                &previous_text_buffers,
                                &cached.text_buffers,
                                &previous_icon_buffers,
                                &cached.icon_buffers,
                            ));
                    }
                    let finalize_ms = finalize_started_at.elapsed().as_secs_f64() * 1000.0;
                    let elapsed_ms = started_at.elapsed().as_secs_f64() * 1000.0;
                    debug!(
                        window_id = cached.snapshot.id,
                        title = cached.snapshot.title,
                        text_buffer_count = cached.text_buffers.len(),
                        elapsed_ms,
                        "recomputed window decoration tree from runtime dirty state"
                    );
                    record_managed_rect_path_event(ManagedRectPathEvent::RuntimeDirty);
                    managed_rect_apply_window_ids.insert(snapshot_id.clone());
                    log_animation_window_refresh_timing(
                        "runtime-dirty",
                        &cached.snapshot,
                        elapsed_ms,
                        evaluate_ms,
                        rebuild_ms,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        0.0,
                        finalize_ms,
                        dirty_node_ids.len(),
                        Some(tree_changed),
                        layout_equivalent_state,
                    );
                    if force_async_asset_refresh {
                        let order_map = build_render_order_map(&cached.layout);
                        let previous_text_buffers = cached.text_buffers.clone();
                        cached.text_buffers = build_text_buffers_with_fallback(
                            &cached.layout,
                            &order_map,
                            window_raster_scale,
                            &mut self.text_rasterizer,
                            &previous_text_buffers,
                        );
                        cached.icon_buffers = build_icon_buffers(
                            &cached.layout,
                            &order_map,
                            window_raster_scale,
                            &cached.snapshot,
                            &mut self.icon_rasterizer,
                        );
                    }
                    log_decoration_refresh(
                        "runtime-dirty",
                        &cached.snapshot,
                        client_rect,
                        &cached.layout,
                        &cached.buffers,
                    );
                    runtime_dirty_updates = runtime_dirty_updates.saturating_add(1);
                    // The runtime-dirty branch swaps `tree` / `managed_window`
                    // / `layout_scale` but leaves `client_rect` matching the
                    // *previous* probe-loop result, so the diff check on the
                    // next refresh has to recompute once to either confirm
                    // or detect the divergence.
                    cached.client_rect_potentially_stale = true;
                    self.schedule_redraw();
                    self.runtime_scheduler_enabled = evaluation.next_poll_in_ms.is_some();
                    animation_active_for_target |= evaluation.next_poll_in_ms == Some(0);
                } else if force_async_asset_refresh {
                    let order_map = build_render_order_map(&cached.layout);
                    let previous_text_buffers = cached.text_buffers.clone();
                    cached.text_buffers = build_text_buffers_with_fallback(
                        &cached.layout,
                        &order_map,
                        window_raster_scale,
                        &mut self.text_rasterizer,
                        &previous_text_buffers,
                    );
                    cached.icon_buffers = build_icon_buffers(
                        &cached.layout,
                        &order_map,
                        window_raster_scale,
                        &cached.snapshot,
                        &mut self.icon_rasterizer,
                    );
                }
            }
            if window_was_runtime_dirty {
                processed_runtime_dirty_window_ids.insert(snapshot_id);
            }
        }
        let windows_pass_elapsed_ms = windows_pass_started_at.elapsed().as_secs_f64() * 1000.0;
        self.apply_managed_window_rects(&managed_rect_apply_window_ids);

        let closing_pass_started_at = Instant::now();
        let closing_dirty_ids = self
            .closing_window_snapshots
            .keys()
            .filter(|window_id| {
                force_output_animation_reevaluate
                    || self.runtime_dirty_window_ids.contains(*window_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        for window_id in closing_dirty_ids {
            let closing_raster_scale = self
                .closing_window_snapshots
                .get(&window_id)
                .map(|closing| self.decoration_raster_scale_for_rect(closing.live.rect))
                .unwrap_or(1);
            if let Some(closing) = self.closing_window_snapshots.get_mut(&window_id) {
                let previous_root =
                    transformed_root_rect(closing.decoration.layout.root.rect, closing.transform);
                let previous_layout = closing.decoration.layout.clone();
                let previous_transform = closing.transform;
                let previous_buffers = closing.decoration.buffers.clone();
                let previous_shader_buffers = closing.decoration.shader_buffers.clone();
                let previous_text_buffers = closing.decoration.text_buffers.clone();
                let previous_icon_buffers = closing.decoration.icon_buffers.clone();
                let evaluation = self
                    .decoration_evaluator
                    .evaluate_cached_window(&window_id, now_ms)?;
                pending_display_config_updates.push(evaluation.display_config.clone());
                pending_process_config_updates.push(evaluation.process_config.clone());
                pending_process_actions.extend(evaluation.process_actions.clone());
                if evaluation.managed_window_only {
                    closing.decoration.managed_window = evaluation.managed_window;
                    closing.decoration.window_effects = evaluation.window_effects;
                    closing.decoration.visual_transform = evaluation.transform;
                    if closing.decoration.managed_window.managed
                        && let Some(desired_root) = closing.decoration.managed_window.rect
                    {
                        let desired_root = managed_rect_snapshot_to_logical_rect(desired_root);
                        if desired_root.width > 0 && desired_root.height > 0 {
                            let desired_client = managed_client_rect_for_root(
                                &closing.decoration.tree,
                                desired_root,
                                closing.decoration.layout_scale,
                            )?;
                            let position_changed = desired_client.x
                                != closing.decoration.client_rect.x
                                || desired_client.y != closing.decoration.client_rect.y;
                            let size_changed = desired_client.width
                                != closing.decoration.client_rect.width
                                || desired_client.height != closing.decoration.client_rect.height;
                            if size_changed {
                                let layout = closing
                                    .decoration
                                    .tree
                                    .layout_for_client_with_scale(
                                        desired_client,
                                        closing.decoration.layout_scale,
                                    )
                                    .map_err(super::DecorationEvaluationError::Layout)?;
                                let shared_edges = build_shared_edge_geometry_map(&layout);
                                let content_clip = content_clip_for_layout(
                                    &closing.decoration.tree,
                                    &layout,
                                    &shared_edges,
                                );
                                let order_map = build_render_order_map(&layout);
                                closing.decoration.layout = layout;
                                closing.decoration.content_clip = content_clip;
                                closing.decoration.client_rect = desired_client;
                                closing.decoration.snapshot.position = WindowPositionSnapshot {
                                    x: desired_client.x,
                                    y: desired_client.y,
                                    width: desired_client.width,
                                    height: desired_client.height,
                                };
                                closing.decoration.buffers =
                                    build_cached_buffers(&closing.decoration.layout, &order_map);
                                closing.decoration.shader_buffers =
                                    build_shader_buffers(&closing.decoration.layout, &order_map);
                                freeze_manual_shader_buffers(
                                    &previous_shader_buffers,
                                    &mut closing.decoration.shader_buffers,
                                );
                                closing.decoration.text_buffers = build_text_buffers_with_fallback(
                                    &closing.decoration.layout,
                                    &order_map,
                                    closing_raster_scale,
                                    &mut self.text_rasterizer,
                                    &previous_text_buffers,
                                );
                                closing.decoration.icon_buffers = build_icon_buffers(
                                    &closing.decoration.layout,
                                    &order_map,
                                    closing_raster_scale,
                                    &closing.decoration.snapshot,
                                    &mut self.icon_rasterizer,
                                );
                                closing.live.rect = desired_client;
                            } else if position_changed {
                                let dx = desired_client.x - closing.decoration.client_rect.x;
                                let dy = desired_client.y - closing.decoration.client_rect.y;
                                translate_cached_decoration_position(
                                    &mut closing.decoration,
                                    dx,
                                    dy,
                                    desired_client,
                                );
                                closing.live.rect = desired_client;
                            }
                        }
                    }
                    closing.transform = evaluation.transform;
                    let next_root = transformed_root_rect(
                        closing.decoration.layout.root.rect,
                        closing.transform,
                    );
                    push_damage_pair(
                        &mut self.pending_decoration_damage,
                        Some(previous_root),
                        next_root,
                    );
                    if evaluation.next_poll_in_ms.is_none() && closing.transform.opacity <= 0.001 {
                        pending_finalize_close_damage.push(next_root);
                        pending_window_actions.push(crate::ssd::RuntimeWindowAction {
                            window_id: window_id.clone(),
                            action: crate::ssd::WaylandWindowAction::FinalizeClose,
                        });
                    }
                    self.runtime_scheduler_enabled = evaluation.next_poll_in_ms.is_some();
                    self.schedule_redraw();
                    closing_runtime_updates = closing_runtime_updates.saturating_add(1);
                    animation_active_for_target |= evaluation.next_poll_in_ms == Some(0);
                    processed_runtime_dirty_window_ids.insert(window_id);
                    continue;
                }
                let Some(evaluation_node) = evaluation.node else {
                    return Err(DecorationEvaluationError::RuntimeProtocol(
                        "cached closing evaluation returned no tree without managedWindowOnly"
                            .into(),
                    ));
                };
                let next_tree = DecorationTree::new(evaluation_node);
                closing.decoration.managed_window = evaluation.managed_window;
                closing.decoration.window_effects = evaluation.window_effects;
                let dirty_node_ids = evaluation.dirty_node_ids;
                let tree_changed = next_tree != closing.decoration.tree;
                if !tree_changed {
                    closing.decoration.visual_transform = evaluation.transform;
                } else {
                    let layout_equivalent = closing
                        .decoration
                        .tree
                        .root
                        .layout_equivalent(&next_tree.root);
                    closing.decoration.tree = next_tree;
                    if layout_equivalent {
                        reapply_tree_preserving_layout(
                            &mut closing.decoration.layout.root,
                            &closing.decoration.tree.root,
                            None,
                            closing.decoration.layout_scale,
                        );
                        closing
                            .decoration
                            .layout
                            .root
                            .sync_root_bounds(closing.decoration.layout_scale);
                        let shared_edges =
                            build_shared_edge_geometry_map(&closing.decoration.layout);
                        closing.decoration.content_clip = content_clip_for_layout(
                            &closing.decoration.tree,
                            &closing.decoration.layout,
                            &shared_edges,
                        );
                        let order_map = build_render_order_map(&closing.decoration.layout);
                        if dirty_node_ids.is_empty() {
                            closing.decoration.buffers =
                                build_cached_buffers(&closing.decoration.layout, &order_map);
                            closing.decoration.shader_buffers =
                                build_shader_buffers(&closing.decoration.layout, &order_map);
                            closing.decoration.text_buffers = build_text_buffers_with_fallback(
                                &closing.decoration.layout,
                                &order_map,
                                closing_raster_scale,
                                &mut self.text_rasterizer,
                                &previous_text_buffers,
                            );
                            closing.decoration.icon_buffers = build_icon_buffers(
                                &closing.decoration.layout,
                                &order_map,
                                closing_raster_scale,
                                &closing.decoration.snapshot,
                                &mut self.icon_rasterizer,
                            );
                        } else {
                            let (rebuilt_buffers, rebuilt_shader_buffers) = rebuild_partial_buffers(
                                &closing.decoration.layout,
                                &order_map,
                                &dirty_node_ids,
                            );
                            let mut merged_shader_buffers = merge_shader_buffers(
                                &previous_shader_buffers,
                                rebuilt_shader_buffers,
                                &dirty_node_ids,
                            );
                            freeze_manual_shader_buffers(
                                &previous_shader_buffers,
                                &mut merged_shader_buffers,
                            );
                            closing.decoration.buffers = merge_cached_buffers(
                                &previous_buffers,
                                rebuilt_buffers,
                                &dirty_node_ids,
                            );
                            closing.decoration.shader_buffers = merged_shader_buffers;
                            closing.decoration.text_buffers = merge_text_buffers(
                                &previous_text_buffers,
                                rebuild_partial_text_buffers_with_fallback(
                                    &closing.decoration.layout,
                                    &order_map,
                                    &dirty_node_ids,
                                    closing_raster_scale,
                                    &mut self.text_rasterizer,
                                    &previous_text_buffers,
                                ),
                                &dirty_node_ids,
                            );
                            closing.decoration.icon_buffers = merge_icon_buffers(
                                &previous_icon_buffers,
                                rebuild_partial_icon_buffers(
                                    &closing.decoration.layout,
                                    &order_map,
                                    &dirty_node_ids,
                                    closing_raster_scale,
                                    &closing.decoration.snapshot,
                                    &mut self.icon_rasterizer,
                                ),
                                &dirty_node_ids,
                            );
                        }
                    } else {
                        let layout = closing
                            .decoration
                            .tree
                            .layout_for_client_with_scale(
                                closing.decoration.client_rect,
                                closing.decoration.layout_scale,
                            )
                            .map_err(super::DecorationEvaluationError::Layout)?;
                        let shared_edges = build_shared_edge_geometry_map(&layout);
                        let content_clip = content_clip_for_layout(
                            &closing.decoration.tree,
                            &layout,
                            &shared_edges,
                        );
                        let order_map = build_render_order_map(&layout);
                        let buffers = build_cached_buffers(&layout, &order_map);
                        let shader_buffers = build_shader_buffers(&layout, &order_map);
                        let text_buffers = build_text_buffers_with_fallback(
                            &layout,
                            &order_map,
                            closing_raster_scale,
                            &mut self.text_rasterizer,
                            &previous_text_buffers,
                        );
                        let icon_buffers = build_icon_buffers(
                            &layout,
                            &order_map,
                            closing_raster_scale,
                            &closing.decoration.snapshot,
                            &mut self.icon_rasterizer,
                        );
                        closing.decoration.layout = layout;
                        closing.decoration.content_clip = content_clip;
                        closing.decoration.buffers = buffers;
                        closing.decoration.shader_buffers = shader_buffers;
                        closing.decoration.text_buffers = text_buffers;
                        closing.decoration.icon_buffers = icon_buffers;
                        self.suggested_window_offset =
                            suggested_window_offset(&closing.decoration.layout);
                    }
                    closing.decoration.visual_transform = evaluation.transform;
                }
                if closing.decoration.managed_window.managed
                    && let Some(desired_root) = closing.decoration.managed_window.rect
                {
                    let desired_root = managed_rect_snapshot_to_logical_rect(desired_root);
                    if desired_root.width > 0 && desired_root.height > 0 {
                        let desired_client = managed_client_rect_for_root(
                            &closing.decoration.tree,
                            desired_root,
                            closing.decoration.layout_scale,
                        )?;
                        let position_changed = desired_client.x != closing.decoration.client_rect.x
                            || desired_client.y != closing.decoration.client_rect.y;
                        let size_changed = desired_client.width
                            != closing.decoration.client_rect.width
                            || desired_client.height != closing.decoration.client_rect.height;
                        if size_changed {
                            let layout = closing
                                .decoration
                                .tree
                                .layout_for_client_with_scale(
                                    desired_client,
                                    closing.decoration.layout_scale,
                                )
                                .map_err(super::DecorationEvaluationError::Layout)?;
                            let shared_edges = build_shared_edge_geometry_map(&layout);
                            let content_clip = content_clip_for_layout(
                                &closing.decoration.tree,
                                &layout,
                                &shared_edges,
                            );
                            let order_map = build_render_order_map(&layout);
                            closing.decoration.layout = layout;
                            closing.decoration.content_clip = content_clip;
                            closing.decoration.client_rect = desired_client;
                            closing.decoration.snapshot.position = WindowPositionSnapshot {
                                x: desired_client.x,
                                y: desired_client.y,
                                width: desired_client.width,
                                height: desired_client.height,
                            };
                            closing.decoration.buffers =
                                build_cached_buffers(&closing.decoration.layout, &order_map);
                            closing.decoration.shader_buffers =
                                build_shader_buffers(&closing.decoration.layout, &order_map);
                            freeze_manual_shader_buffers(
                                &previous_shader_buffers,
                                &mut closing.decoration.shader_buffers,
                            );
                            closing.decoration.text_buffers = build_text_buffers_with_fallback(
                                &closing.decoration.layout,
                                &order_map,
                                closing_raster_scale,
                                &mut self.text_rasterizer,
                                &previous_text_buffers,
                            );
                            closing.decoration.icon_buffers = build_icon_buffers(
                                &closing.decoration.layout,
                                &order_map,
                                closing_raster_scale,
                                &closing.decoration.snapshot,
                                &mut self.icon_rasterizer,
                            );
                            closing.live.rect = desired_client;
                        } else if position_changed {
                            let dx = desired_client.x - closing.decoration.client_rect.x;
                            let dy = desired_client.y - closing.decoration.client_rect.y;
                            translate_cached_decoration_position(
                                &mut closing.decoration,
                                dx,
                                dy,
                                desired_client,
                            );
                            closing.live.rect = desired_client;
                        }
                    }
                }
                closing.decoration.visual_transform = evaluation.transform;
                closing.transform = evaluation.transform;
                let next_root =
                    transformed_root_rect(closing.decoration.layout.root.rect, closing.transform);
                if previous_transform != closing.transform || previous_root != next_root {
                    push_damage_pair(
                        &mut self.pending_decoration_damage,
                        Some(previous_root),
                        next_root,
                    );
                } else if !dirty_node_ids.is_empty() {
                    self.pending_decoration_damage
                        .extend(runtime_dirty_node_damage_rects(
                            &previous_layout,
                            previous_transform,
                            &closing.decoration.layout,
                            closing.transform,
                            &dirty_node_ids,
                        ));
                } else {
                    self.pending_decoration_damage
                        .extend(runtime_dirty_damage_rects(
                            &previous_buffers,
                            &closing.decoration.buffers,
                            &previous_shader_buffers,
                            &closing.decoration.shader_buffers,
                            &previous_text_buffers,
                            &closing.decoration.text_buffers,
                            &previous_icon_buffers,
                            &closing.decoration.icon_buffers,
                        ));
                }
                if force_async_asset_refresh {
                    let order_map = build_render_order_map(&closing.decoration.layout);
                    let previous_text_buffers = closing.decoration.text_buffers.clone();
                    closing.decoration.text_buffers = build_text_buffers_with_fallback(
                        &closing.decoration.layout,
                        &order_map,
                        closing_raster_scale,
                        &mut self.text_rasterizer,
                        &previous_text_buffers,
                    );
                    closing.decoration.icon_buffers = build_icon_buffers(
                        &closing.decoration.layout,
                        &order_map,
                        closing_raster_scale,
                        &closing.decoration.snapshot,
                        &mut self.icon_rasterizer,
                    );
                }
                if evaluation.next_poll_in_ms.is_none() && closing.transform.opacity <= 0.001 {
                    pending_finalize_close_damage.push(next_root);
                    pending_window_actions.push(crate::ssd::RuntimeWindowAction {
                        window_id: window_id.clone(),
                        action: crate::ssd::WaylandWindowAction::FinalizeClose,
                    });
                }
                self.runtime_scheduler_enabled = evaluation.next_poll_in_ms.is_some();
                self.schedule_redraw();
                closing_runtime_updates = closing_runtime_updates.saturating_add(1);
                animation_active_for_target |= evaluation.next_poll_in_ms == Some(0);
                processed_runtime_dirty_window_ids.insert(window_id);
            }
        }
        let closing_pass_elapsed_ms = closing_pass_started_at.elapsed().as_secs_f64() * 1000.0;

        if let Some(output_name) = target_output_name {
            if animation_active_for_target {
                self.runtime_animation_outputs
                    .insert(output_name.to_string());
            } else {
                self.runtime_animation_outputs.remove(output_name);
            }
            log_animation_output_activity(
                output_name,
                closing_active_count,
                animation_active_for_target,
            );
        }

        if force_async_asset_refresh {
            let closing_scales = self
                .closing_window_snapshots
                .iter()
                .map(|(window_id, closing)| {
                    (
                        window_id.clone(),
                        self.decoration_raster_scale_for_rect(closing.live.rect),
                    )
                })
                .collect::<std::collections::HashMap<_, _>>();
            for (window_id, closing) in self.closing_window_snapshots.iter_mut() {
                let closing_raster_scale = *closing_scales.get(window_id).unwrap_or(&1);
                let order_map = build_render_order_map(&closing.decoration.layout);
                closing.decoration.buffers =
                    build_cached_buffers(&closing.decoration.layout, &order_map);
                closing.decoration.shader_buffers =
                    build_shader_buffers(&closing.decoration.layout, &order_map);
                let previous_text_buffers = closing.decoration.text_buffers.clone();
                closing.decoration.text_buffers = build_text_buffers_with_fallback(
                    &closing.decoration.layout,
                    &order_map,
                    closing_raster_scale,
                    &mut self.text_rasterizer,
                    &previous_text_buffers,
                );
                closing.decoration.icon_buffers = build_icon_buffers(
                    &closing.decoration.layout,
                    &order_map,
                    closing_raster_scale,
                    &closing.decoration.snapshot,
                    &mut self.icon_rasterizer,
                );
            }
        }

        let apply_updates_started_at = Instant::now();
        for update in pending_display_config_updates {
            self.consume_runtime_display_config(update);
        }
        for update in pending_key_binding_config_updates {
            self.consume_runtime_key_binding_config(update);
        }
        for update in pending_pointer_config_updates {
            self.consume_runtime_pointer_config(update);
        }
        for update in pending_event_config_updates {
            self.consume_runtime_event_config(update);
        }
        for update in pending_process_config_updates {
            self.consume_runtime_process_config(update);
        }
        if !pending_finalize_close_damage.is_empty() {
            self.pending_decoration_damage
                .extend(pending_finalize_close_damage);
        }
        if !pending_window_actions.is_empty() {
            self.apply_runtime_window_actions(pending_window_actions);
        }
        if !pending_process_actions.is_empty() {
            self.apply_runtime_process_actions(pending_process_actions);
        }
        let apply_updates_elapsed_ms = apply_updates_started_at.elapsed().as_secs_f64() * 1000.0;
        let refresh_elapsed_ms = refresh_started_at.elapsed().as_secs_f64() * 1000.0;

        if animation_timing_debug_enabled()
            && (animation_active_for_target
                || closing_active_count > 0
                || promoted_closing > 0
                || rebuilt > 0
                || relayout > 0
                || runtime_dirty_updates > 0
                || closing_runtime_updates > 0
                || refresh_elapsed_ms >= spike_threshold_ms)
        {
            let target_output = target_output_name.unwrap_or("<all>");
            if refresh_elapsed_ms >= spike_threshold_ms {
                warn!(
                    target_output,
                    window_count,
                    closing_active_count,
                    promoted_closing,
                    rebuilt,
                    relayout,
                    runtime_dirty_updates,
                    closing_runtime_updates,
                    animation_active_for_target,
                    force_runtime_reevaluate,
                    force_output_animation_reevaluate,
                    force_async_asset_refresh,
                    removed_windows_elapsed_ms,
                    windows_pass_elapsed_ms,
                    closing_pass_elapsed_ms,
                    apply_updates_elapsed_ms,
                    elapsed_ms = refresh_elapsed_ms,
                    spike_threshold_ms,
                    "animation timing: decoration refresh spike"
                );
            } else {
                info!(
                    target_output,
                    window_count,
                    closing_active_count,
                    promoted_closing,
                    rebuilt,
                    relayout,
                    runtime_dirty_updates,
                    closing_runtime_updates,
                    animation_active_for_target,
                    force_runtime_reevaluate,
                    force_output_animation_reevaluate,
                    force_async_asset_refresh,
                    removed_windows_elapsed_ms,
                    windows_pass_elapsed_ms,
                    closing_pass_elapsed_ms,
                    apply_updates_elapsed_ms,
                    elapsed_ms = refresh_elapsed_ms,
                    spike_threshold_ms,
                    "animation timing: decoration refresh"
                );
            }
        }

        trace!(
            window_count,
            rebuilt,
            relayout,
            elapsed_ms = refresh_elapsed_ms,
            "refresh_window_decorations finished"
        );
        for window_id in processed_runtime_dirty_window_ids {
            self.runtime_dirty_window_ids.remove(&window_id);
            self.runtime_managed_only_window_ids.remove(&window_id);
        }
        self.runtime_dirty_window_ids.retain(|window_id| {
            live_window_ids.contains(window_id)
                || self.closing_window_snapshots.contains_key(window_id)
        });
        self.runtime_managed_only_window_ids.retain(|window_id| {
            live_window_ids.contains(window_id)
                || self.closing_window_snapshots.contains_key(window_id)
        });
        self.pending_xdg_state_configure_window_ids
            .retain(|window_id| live_window_ids.contains(window_id));
        self.runtime_poll_dirty = !self.runtime_dirty_window_ids.is_empty();
        self.async_asset_dirty = false;

        Ok(())
    }

    pub fn decoration_under(
        &self,
        point: Point<f64, Logical>,
    ) -> Option<(Window, DecorationHitTestResult)> {
        let output_name = self.output_name_at_point(point);
        self.windows_top_to_bottom().into_iter().find_map(|window| {
            let decoration = self.window_decorations.get(window)?;
            if !output_name.as_deref().map_or_else(
                || decoration.managed_window_allows_input(),
                |output| decoration.managed_window_allows_input_on_output(output),
            ) {
                return None;
            }
            let logical_point = LogicalPoint::new(point.x.floor() as i32, point.y.floor() as i32);
            let transformed_root =
                transformed_root_rect(decoration.layout.root.rect, decoration.visual_transform);
            transformed_root.contains(logical_point).then(|| {
                let local_point = inverse_transform_point(
                    point,
                    decoration.layout.root.rect,
                    decoration.visual_transform,
                );
                (window.clone(), decoration.hit_test(local_point))
            })
        })
    }

    pub fn decoration_interaction_target_under(
        &self,
        point: Point<f64, Logical>,
    ) -> Option<(Window, super::DecorationInteractionTarget)> {
        let output_name = self.output_name_at_point(point);
        self.windows_top_to_bottom().into_iter().find_map(|window| {
            let decoration = self.window_decorations.get(window)?;
            if !output_name.as_deref().map_or_else(
                || decoration.managed_window_allows_input(),
                |output| decoration.managed_window_allows_input_on_output(output),
            ) {
                return None;
            }
            let logical_point = LogicalPoint::new(point.x.floor() as i32, point.y.floor() as i32);
            let transformed_root =
                transformed_root_rect(decoration.layout.root.rect, decoration.visual_transform);
            transformed_root.contains(logical_point).then(|| {
                let local_point = inverse_transform_point(
                    point,
                    decoration.layout.root.rect,
                    decoration.visual_transform,
                );
                let local_logical =
                    LogicalPoint::new(local_point.x.floor() as i32, local_point.y.floor() as i32);
                decoration
                    .layout
                    .interaction_target_at(local_logical)
                    .map(|target| (window.clone(), target))
            })?
        })
    }

    fn window_client_rect(&self, window: &Window) -> Option<LogicalRect> {
        let loc = self.space.element_location(window)?;
        let geometry = window.geometry();
        if geometry.size.w <= 0 || geometry.size.h <= 0 {
            return None;
        }
        Some(LogicalRect::new(
            loc.x + geometry.loc.x,
            loc.y + geometry.loc.y,
            geometry.size.w,
            geometry.size.h,
        ))
    }

    fn apply_managed_window_rects(&mut self, dirty_window_ids: &std::collections::HashSet<String>) {
        let mut applied_any_rect = false;
        let windows = self
            .window_decorations
            .iter()
            .filter_map(|(window, decoration)| {
                let managed = &decoration.managed_window;
                if !managed.managed {
                    return None;
                }
                if !dirty_window_ids.contains(&decoration.snapshot.id)
                    && !self
                        .pending_xdg_state_configure_window_ids
                        .contains(&decoration.snapshot.id)
                {
                    return None;
                }
                Some(window.clone())
            })
            .collect::<Vec<_>>();

        for window in windows {
            let Some((
                force_rect_size,
                needs_xdg_state_configure,
                desired_root_raw,
                desired_root,
                current_root,
                current_client,
                window_id,
            )) = ({
                let Some(decoration) = self.window_decorations.get(&window) else {
                    continue;
                };
                let managed = &decoration.managed_window;
                let Some(desired_root_raw) = managed.rect else {
                    continue;
                };
                let desired_root = managed_rect_snapshot_to_logical_rect(desired_root_raw);
                let current_root = decoration.layout.root.rect;
                let current_client = decoration.client_rect;
                let window_id = decoration.snapshot.id.clone();
                Some((
                    managed.force_rect_size,
                    self.pending_xdg_state_configure_window_ids
                        .contains(&window_id),
                    desired_root_raw,
                    desired_root,
                    current_root,
                    current_client,
                    window_id,
                ))
            })
            else {
                continue;
            };

            if desired_root == current_root && !needs_xdg_state_configure {
                record_managed_rect_path_event(ManagedRectPathEvent::ApplyNoop);
                continue;
            }

            let root_size_changed = desired_root.width != current_root.width
                || desired_root.height != current_root.height;
            let desired_client = if root_size_changed {
                record_managed_rect_path_event(ManagedRectPathEvent::ApplySizeFast);
                managed_client_rect_from_current_insets(current_root, current_client, desired_root)
            } else {
                let dx = desired_root.x - current_root.x;
                let dy = desired_root.y - current_root.y;
                if dx != 0 || dy != 0 {
                    record_managed_rect_path_event(ManagedRectPathEvent::ApplyPositionFast);
                }
                LogicalRect::new(
                    current_client.x + dx,
                    current_client.y + dy,
                    current_client.width,
                    current_client.height,
                )
            };

            if desired_client == current_client && !needs_xdg_state_configure {
                record_managed_rect_path_event(ManagedRectPathEvent::ApplyNoop);
                continue;
            }

            let position_changed =
                desired_client.x != current_client.x || desired_client.y != current_client.y;
            let size_changed = desired_client.width != current_client.width
                || desired_client.height != current_client.height;
            let dx = desired_client.x - current_client.x;
            let dy = desired_client.y - current_client.y;

            if size_changed {
                record_managed_rect_path_event(ManagedRectPathEvent::ApplySize);
            } else if position_changed {
                record_managed_rect_path_event(ManagedRectPathEvent::ApplyPosition);
            } else {
                record_managed_rect_path_event(ManagedRectPathEvent::ApplyConfigureOnly);
            }

            if managed_rect_debug_enabled() {
                info!(
                    window_id,
                    raw_desired_root_x = desired_root_raw.x,
                    raw_desired_root_y = desired_root_raw.y,
                    raw_desired_root_width = desired_root_raw.width,
                    raw_desired_root_height = desired_root_raw.height,
                    raw_desired_root_right = desired_root_raw.x + desired_root_raw.width,
                    raw_desired_root_bottom = desired_root_raw.y + desired_root_raw.height,
                    desired_root = %format_rect(desired_root),
                    desired_root_right = desired_root.x + desired_root.width,
                    desired_root_bottom = desired_root.y + desired_root.height,
                    current_root = %format_rect(current_root),
                    current_root_right = current_root.x + current_root.width,
                    current_root_bottom = current_root.y + current_root.height,
                    current_client = %format_rect(current_client),
                    current_client_right = current_client.x + current_client.width,
                    current_client_bottom = current_client.y + current_client.height,
                    desired_client = %format_rect(desired_client),
                    desired_client_right = desired_client.x + desired_client.width,
                    desired_client_bottom = desired_client.y + desired_client.height,
                    dx,
                    dy,
                    position_changed,
                    size_changed,
                    "managed rect debug: apply"
                );
            }

            let geometry = window.geometry();
            let next_location = Point::from((
                desired_client.x - geometry.loc.x,
                desired_client.y - geometry.loc.y,
            ));
            if self.space.element_location(&window) != Some(next_location) {
                self.space.relocate_element(&window, next_location);
            }

            if size_changed || needs_xdg_state_configure {
                if let Some(toplevel) = window.toplevel() {
                    toplevel.with_pending_state(|state| {
                        state.size =
                            Some(Size::from((desired_client.width, desired_client.height)));
                    });
                    toplevel.send_pending_configure();
                    self.pending_xdg_state_configure_window_ids
                        .remove(&window_id);
                } else if let Some(x11) = window.x11_surface() {
                    if size_changed {
                        let placed = Rectangle::<i32, Logical>::new(
                            Point::from((desired_client.x, desired_client.y)),
                            Size::from((desired_client.width, desired_client.height)),
                        );
                        if let Err(error) = x11.configure(Some(placed)) {
                            warn!(
                                ?error,
                                window_id, "failed to configure managed X11 window rect"
                            );
                        }
                    }
                    self.pending_xdg_state_configure_window_ids
                        .remove(&window_id);
                }
            }
            if size_changed {
                if force_rect_size
                    && let Some(decoration) = self.window_decorations.get_mut(&window)
                {
                    let previous_shader_buffers = decoration.shader_buffers.clone();
                    let previous_text_buffers = decoration.text_buffers.clone();
                    let layout = decoration
                        .tree
                        .layout_for_client_with_scale(desired_client, decoration.layout_scale)
                        .map_err(super::DecorationEvaluationError::Layout)
                        .ok();
                    if let Some(layout) = layout {
                        let (content_clip, buffers, shader_buffers, text_buffers, icon_buffers) = {
                            let arena = Bump::new();
                            let shared_edges = build_shared_edge_geometry_map_in(&layout, &arena);
                            let content_clip =
                                content_clip_for_layout(&decoration.tree, &layout, &shared_edges);
                            let order_map = build_render_order_map(&layout);
                            let (buffers, mut shader_buffers) = build_cached_buffers_and_shaders(
                                &layout,
                                &order_map,
                                None,
                                &shared_edges,
                            );
                            freeze_manual_shader_buffers(
                                &previous_shader_buffers,
                                &mut shader_buffers,
                            );
                            let text_buffers = retarget_text_buffers_with_shared_edges(
                                &layout,
                                &order_map,
                                &shared_edges,
                                &previous_text_buffers,
                            );
                            let icon_buffers = retarget_icon_buffers_with_shared_edges(
                                &layout,
                                &order_map,
                                &shared_edges,
                                &decoration.snapshot,
                                &decoration.icon_buffers,
                            );
                            (
                                content_clip,
                                buffers,
                                shader_buffers,
                                text_buffers,
                                icon_buffers,
                            )
                        };
                        decoration.layout = layout;
                        decoration.content_clip = content_clip;
                        decoration.client_rect = desired_client;
                        decoration.snapshot.position = WindowPositionSnapshot {
                            x: desired_client.x,
                            y: desired_client.y,
                            width: desired_client.width,
                            height: desired_client.height,
                        };
                        decoration.buffers = buffers;
                        decoration.shader_buffers = shader_buffers;
                        decoration.text_buffers = text_buffers;
                        decoration.icon_buffers = icon_buffers;
                    }
                }
            } else if position_changed {
                if let Some(decoration) = self.window_decorations.get_mut(&window) {
                    translate_cached_decoration_position(decoration, dx, dy, desired_client);
                }
            }

            self.pending_decoration_damage.push(current_root);
            self.pending_decoration_damage.push(LogicalRect::new(
                desired_root.x,
                desired_root.y,
                desired_root.width,
                desired_root.height,
            ));
            self.snapshot_dirty_window_ids.insert(window_id);
            self.window_scene_generation = self.window_scene_generation.wrapping_add(1);
            self.schedule_redraw();
            applied_any_rect = true;
        }

        if applied_any_rect {
            let now_msec = std::time::Duration::from(self.clock.now()).as_millis() as u32;
            self.refresh_pointer_focus(now_msec);
        }
    }
}

fn content_clip_for_layout(
    _tree: &DecorationTree,
    layout: &ComputedDecorationTree,
    shared_edges: &impl SharedEdgeGeometryLookup,
) -> Option<ContentClip> {
    slot_content_clip_for_node(&layout.root, None, None, shared_edges)
}

fn managed_rect_snapshot_to_logical_rect(rect: ManagedWindowRectSnapshot) -> LogicalRect {
    // Preserve shared/opposite edges when quantizing TS-provided floating rects.
    // Rounding x/y/width/height independently makes `round(x) + round(width)`
    // differ from `round(x + width)`, which shows up as a 1px wobble during
    // top/left anchored resizes and rect animations.
    let left = rect.x.round() as i32;
    let top = rect.y.round() as i32;
    let right = (rect.x + rect.width).round() as i32;
    let bottom = (rect.y + rect.height).round() as i32;

    LogicalRect::new(left, top, right - left, bottom - top)
}

fn managed_client_rect_for_state(
    tree: &DecorationTree,
    managed: &super::ManagedWindowState,
    fallback_client_rect: LogicalRect,
    scale: f64,
) -> Result<LogicalRect, DecorationEvaluationError> {
    if !(managed.managed && managed.force_rect_size) {
        return Ok(fallback_client_rect);
    }

    let Some(desired_root) = managed.rect else {
        return Ok(fallback_client_rect);
    };
    let desired_root = managed_rect_snapshot_to_logical_rect(desired_root);
    if desired_root.width <= 0 || desired_root.height <= 0 {
        return Ok(fallback_client_rect);
    }

    managed_client_rect_for_root(tree, desired_root, scale)
}

fn managed_client_rect_from_current_insets(
    current_root: LogicalRect,
    current_client: LogicalRect,
    desired_root: LogicalRect,
) -> LogicalRect {
    let left = current_client.x - current_root.x;
    let top = current_client.y - current_root.y;
    let right = (current_root.x + current_root.width) - (current_client.x + current_client.width);
    let bottom =
        (current_root.y + current_root.height) - (current_client.y + current_client.height);

    LogicalRect::new(
        desired_root.x + left,
        desired_root.y + top,
        (desired_root.width - left - right).max(1),
        (desired_root.height - top - bottom).max(1),
    )
}

fn managed_client_rect_for_root(
    tree: &DecorationTree,
    desired_root: LogicalRect,
    scale: f64,
) -> Result<LogicalRect, DecorationEvaluationError> {
    let mut client_width = desired_root.width.max(1);
    let mut client_height = desired_root.height.max(1);

    for _ in 0..4 {
        let probe_layout = tree
            .layout_for_client_with_scale(
                LogicalRect::new(0, 0, client_width, client_height),
                scale,
            )
            .map_err(super::DecorationEvaluationError::Layout)?;
        let shared_edges = build_shared_edge_geometry_map(&probe_layout);
        let Some(content_clip) = content_clip_for_layout(tree, &probe_layout, &shared_edges) else {
            return Ok(desired_root);
        };

        let left = content_clip.rect.loc.x - probe_layout.root.rect.x;
        let top = content_clip.rect.loc.y - probe_layout.root.rect.y;
        let right = (probe_layout.root.rect.x + probe_layout.root.rect.width)
            - (content_clip.rect.loc.x + content_clip.rect.size.w);
        let bottom = (probe_layout.root.rect.y + probe_layout.root.rect.height)
            - (content_clip.rect.loc.y + content_clip.rect.size.h);
        let next_width = (desired_root.width - left - right).max(1);
        let next_height = (desired_root.height - top - bottom).max(1);

        if next_width == client_width && next_height == client_height {
            return Ok(LogicalRect::new(
                desired_root.x + left,
                desired_root.y + top,
                client_width,
                client_height,
            ));
        }

        client_width = next_width;
        client_height = next_height;
    }

    let final_layout = tree
        .layout_for_client_with_scale(LogicalRect::new(0, 0, client_width, client_height), scale)
        .map_err(super::DecorationEvaluationError::Layout)?;
    let shared_edges = build_shared_edge_geometry_map(&final_layout);
    let Some(content_clip) = content_clip_for_layout(tree, &final_layout, &shared_edges) else {
        return Ok(desired_root);
    };
    let left = content_clip.rect.loc.x - final_layout.root.rect.x;
    let top = content_clip.rect.loc.y - final_layout.root.rect.y;

    Ok(LogicalRect::new(
        desired_root.x + left,
        desired_root.y + top,
        client_width,
        client_height,
    ))
}

fn fit_children_inner_clip_resolved(
    node: &super::ComputedDecorationNode,
) -> Option<crate::ssd::ResolvedDecorationClip> {
    if !matches!(
        node.style.effective_border_fit(&node.kind),
        super::BorderFit::FitChildren
    ) {
        return None;
    }
    node.style.border?;
    Some(
        node.resolved_effective_clip
            .unwrap_or(crate::ssd::ResolvedDecorationClip {
                rect: node.resolved_content_rect,
                radius: (node.resolved_border_radius - node.resolved_border_width)
                    .max(crate::ssd::ResolvedLayoutValue::ZERO),
            }),
    )
}

fn fit_children_inner_hole_rect(
    node: &super::ComputedDecorationNode,
    border_width: i32,
) -> LogicalRect {
    let fallback_inner_rect = node.rect.inset(super::Edges {
        top: border_width,
        right: border_width,
        bottom: border_width,
        left: border_width,
    });

    let inner_rect = fit_children_inner_clip_resolved(node)
        .map(|clip| clip.rect.round_to_logical_rect())
        .unwrap_or_else(|| node.resolved_content_rect.round_to_logical_rect());
    if inner_rect.width <= 0 || inner_rect.height <= 0 {
        fallback_inner_rect
    } else {
        inner_rect
    }
}

fn precise_rect_from_resolved(rect: crate::ssd::ResolvedLogicalRect) -> PreciseLogicalRect {
    PreciseLogicalRect {
        x: rect.x.to_f32(),
        y: rect.y.to_f32(),
        width: rect.width.to_f32(),
        height: rect.height.to_f32(),
    }
}

fn precise_rect_from_logical(rect: LogicalRect) -> PreciseLogicalRect {
    PreciseLogicalRect {
        x: rect.x as f32,
        y: rect.y as f32,
        width: rect.width as f32,
        height: rect.height as f32,
    }
}

fn fit_children_inner_clip_logical(
    node: &super::ComputedDecorationNode,
) -> Option<super::DecorationClip> {
    if !matches!(
        node.style.effective_border_fit(&node.kind),
        super::BorderFit::FitChildren
    ) {
        return None;
    }
    node.style.border?;
    let border_width = node.resolved_border_width.round_to_i32().max(0);
    let rect = fit_children_inner_hole_rect(node, border_width);
    if rect.width <= 0 || rect.height <= 0 {
        return None;
    }
    Some(super::DecorationClip {
        rect,
        radius: (node.resolved_border_radius - node.resolved_border_width)
            .round_to_i32()
            .max(0),
    })
}

fn normal_border_inner_rect(node: &super::ComputedDecorationNode) -> Option<LogicalRect> {
    node.style.border?;
    let border_width = node.resolved_border_width.round_to_i32().max(0);
    let rect = node.rect.inset(super::Edges::all(border_width));
    (rect.width > 0 && rect.height > 0).then_some(rect)
}

fn normal_border_inner_rect_precise(
    node: &super::ComputedDecorationNode,
) -> Option<PreciseLogicalRect> {
    node.style.border?;
    let border_width = node.resolved_border_width;
    let rect = node.resolved_rect.inset(super::ResolvedLayoutEdges {
        top: border_width,
        right: border_width,
        bottom: border_width,
        left: border_width,
    });
    (rect.width.raw() > 0 && rect.height.raw() > 0).then(|| precise_rect_from_resolved(rect))
}

fn node_child_rounded_mask_resolved(
    node: &super::ComputedDecorationNode,
) -> Option<crate::ssd::ResolvedDecorationClip> {
    fit_children_inner_clip_resolved(node)
        .or(node.resolved_effective_clip)
        .filter(|clip| clip.radius.raw() > 0)
}

fn slot_content_clip_for_node(
    node: &super::ComputedDecorationNode,
    nearest_border: Option<(i32, i32)>,
    nearest_rounded_mask: Option<crate::ssd::ResolvedDecorationClip>,
    shared_edges: &impl SharedEdgeGeometryLookup,
) -> Option<ContentClip> {
    let next_border = if matches!(node.kind, super::DecorationNodeKind::WindowBorder) {
        node.style
            .border
            .map(|border| {
                (
                    border.width.max(0),
                    node.style.border_radius.unwrap_or(0).max(0),
                )
            })
            .or(nearest_border)
    } else {
        nearest_border
    };
    let next_rounded_mask = node_child_rounded_mask_resolved(node).or(nearest_rounded_mask);

    if matches!(node.kind, super::DecorationNodeKind::WindowSlot) {
        let (_border_width, _border_radius) = next_border.unwrap_or((0, 0));
        let inherited_clip =
            node.resolved_effective_clip
                .unwrap_or(crate::ssd::ResolvedDecorationClip {
                    rect: node.resolved_rect,
                    radius: (node.resolved_border_radius - node.resolved_border_width)
                        .max(crate::ssd::ResolvedLayoutValue::ZERO),
                });
        let slot_rect = node.resolved_rect;
        let slot_rect_precise = precise_rect_from_resolved(slot_rect);
        let mask = next_rounded_mask.unwrap_or(inherited_clip);
        let mask_rect_precise = precise_rect_from_resolved(mask.rect);
        let corner_radii_precise = if mask.radius.raw() > 0 {
            [mask.radius.to_f32().max(0.0); 4]
        } else {
            [0.0; 4]
        };
        let corner_radii = corner_radii_precise.map(|radius| radius.round().max(0.0) as i32);
        return Some(ContentClip {
            rect: Rectangle::new(
                Point::from((slot_rect.x.round_to_i32(), slot_rect.y.round_to_i32())),
                (
                    slot_rect.width.round_to_i32(),
                    slot_rect.height.round_to_i32(),
                )
                    .into(),
            ),
            rect_precise: slot_rect_precise,
            mask_rect: Rectangle::new(
                Point::from((mask.rect.x.round_to_i32(), mask.rect.y.round_to_i32())),
                (
                    mask.rect.width.round_to_i32(),
                    mask.rect.height.round_to_i32(),
                )
                    .into(),
            ),
            mask_rect_precise,
            // Client surfaces should stay rectangular inside the reserved slot.
            // The surrounding WindowBorder descendants use the rounded mask;
            // the client content itself should not inherit that corner radius.
            radius: 0,
            radius_precise: 0.0,
            corner_radii,
            corner_radii_precise,
            snap_mode: RectSnapMode::SharedEdges,
        });
    }

    node.children.iter().find_map(|child| {
        slot_content_clip_for_node(child, next_border, next_rounded_mask, shared_edges)
    })
}

impl DecorationTree {
    /// Compute a layout where the `WindowSlot` matches the provided client rect.
    pub fn layout_for_client(
        &self,
        client_rect: LogicalRect,
    ) -> Result<ComputedDecorationTree, super::DecorationLayoutError> {
        self.layout_for_client_with_scale(client_rect, 1.0)
    }

    pub fn layout_for_client_with_scale(
        &self,
        client_rect: LogicalRect,
        scale: f64,
    ) -> Result<ComputedDecorationTree, super::DecorationLayoutError> {
        let initial = self.layout_with_window_slot_size(
            LogicalRect::new(0, 0, client_rect.width, client_rect.height),
            Some((client_rect.width, client_rect.height)),
            scale,
        )?;
        let slot = initial
            .window_slot_rect()
            .ok_or(super::DecorationLayoutError::MissingComputedWindowSlot)?;
        let initial_bounds = initial.root.rect;

        let extra_left = slot.x - initial_bounds.x;
        let extra_top = slot.y - initial_bounds.y;
        let extra_right = (initial_bounds.x + initial_bounds.width) - (slot.x + slot.width);
        let extra_bottom = (initial_bounds.y + initial_bounds.height) - (slot.y + slot.height);

        let desired = self.layout_with_window_slot_size(
            LogicalRect::new(
                0,
                0,
                client_rect.width + extra_left + extra_right,
                client_rect.height + extra_top + extra_bottom,
            ),
            Some((client_rect.width, client_rect.height)),
            scale,
        )?;

        let desired_slot = desired
            .window_slot_rect()
            .ok_or(super::DecorationLayoutError::MissingComputedWindowSlot)?;
        let translated = desired.translated(
            client_rect.x - desired_slot.x,
            client_rect.y - desired_slot.y,
        );
        Ok(translated)
    }

    fn layout_with_window_slot_size(
        &self,
        bounds: LogicalRect,
        window_slot_size: Option<(i32, i32)>,
        scale: f64,
    ) -> Result<ComputedDecorationTree, super::DecorationLayoutError> {
        self.validate()?;

        let mut root =
            super::layout_node_with_scale(&self.root, bounds, None, window_slot_size, scale)?;
        root.sync_root_bounds(scale);
        if root.window_slot_rect().is_none() {
            return Err(super::DecorationLayoutError::MissingComputedWindowSlot);
        }

        Ok(ComputedDecorationTree { root })
    }
}

impl ComputedDecorationTree {
    pub fn translated(&self, dx: i32, dy: i32) -> Self {
        Self {
            root: self.root.translated(dx, dy),
        }
    }
}

impl super::ComputedDecorationNode {
    fn translated(&self, dx: i32, dy: i32) -> Self {
        Self {
            stable_id: self.stable_id.clone(),
            interaction: self.interaction.clone(),
            kind: self.kind.clone(),
            style: self.style.clone(),
            rect: LogicalRect::new(
                self.rect.x + dx,
                self.rect.y + dy,
                self.rect.width,
                self.rect.height,
            ),
            resolved_rect: crate::ssd::ResolvedLogicalRect {
                x: self.resolved_rect.x + crate::ssd::ResolvedLayoutValue::from_i32(dx),
                y: self.resolved_rect.y + crate::ssd::ResolvedLayoutValue::from_i32(dy),
                width: self.resolved_rect.width,
                height: self.resolved_rect.height,
            },
            resolved_content_rect: crate::ssd::ResolvedLogicalRect {
                x: self.resolved_content_rect.x + crate::ssd::ResolvedLayoutValue::from_i32(dx),
                y: self.resolved_content_rect.y + crate::ssd::ResolvedLayoutValue::from_i32(dy),
                width: self.resolved_content_rect.width,
                height: self.resolved_content_rect.height,
            },
            resolved_border_width: self.resolved_border_width,
            resolved_border_radius: self.resolved_border_radius,
            effective_clip: self.effective_clip.map(|clip| super::DecorationClip {
                rect: LogicalRect::new(
                    clip.rect.x + dx,
                    clip.rect.y + dy,
                    clip.rect.width,
                    clip.rect.height,
                ),
                radius: clip.radius,
            }),
            resolved_effective_clip: self.resolved_effective_clip.map(|clip| {
                crate::ssd::ResolvedDecorationClip {
                    rect: crate::ssd::ResolvedLogicalRect {
                        x: clip.rect.x + crate::ssd::ResolvedLayoutValue::from_i32(dx),
                        y: clip.rect.y + crate::ssd::ResolvedLayoutValue::from_i32(dy),
                        width: clip.rect.width,
                        height: clip.rect.height,
                    },
                    radius: clip.radius,
                }
            }),
            children: self
                .children
                .iter()
                .map(|child| child.translated(dx, dy))
                .collect(),
        }
    }
}

fn translate_cached_decoration_position(
    decoration: &mut WindowDecorationState,
    dx: i32,
    dy: i32,
    client_rect: LogicalRect,
) {
    decoration.layout = decoration.layout.translated(dx, dy);
    decoration.client_rect = client_rect;
    decoration.snapshot.position = WindowPositionSnapshot {
        x: client_rect.x,
        y: client_rect.y,
        width: client_rect.width,
        height: client_rect.height,
    };
    decoration.content_clip = decoration
        .content_clip
        .map(|clip| translate_content_clip(clip, dx, dy));

    for buffer in &mut decoration.buffers {
        buffer.rect = translate_logical_rect(buffer.rect, dx, dy);
        buffer.rect_precise = buffer
            .rect_precise
            .map(|rect| translate_precise_rect(rect, dx, dy));
        buffer.hole_rect = buffer
            .hole_rect
            .map(|rect| translate_logical_rect(rect, dx, dy));
        buffer.hole_rect_precise = buffer
            .hole_rect_precise
            .map(|rect| translate_precise_rect(rect, dx, dy));
        buffer.clip_rect = buffer
            .clip_rect
            .map(|rect| translate_logical_rect(rect, dx, dy));
        buffer.clip_rect_precise = buffer
            .clip_rect_precise
            .map(|rect| translate_precise_rect(rect, dx, dy));
    }

    for buffer in &mut decoration.shader_buffers {
        buffer.rect = translate_logical_rect(buffer.rect, dx, dy);
        buffer.rect_precise = buffer
            .rect_precise
            .map(|rect| translate_precise_rect(rect, dx, dy));
        buffer.clip_rect = buffer
            .clip_rect
            .map(|rect| translate_logical_rect(rect, dx, dy));
        buffer.clip_rect_precise = buffer
            .clip_rect_precise
            .map(|rect| translate_precise_rect(rect, dx, dy));
    }

    for buffer in &mut decoration.text_buffers {
        buffer.rect = translate_logical_rect(buffer.rect, dx, dy);
        buffer.rect_precise = buffer
            .rect_precise
            .map(|rect| translate_precise_rect(rect, dx, dy));
        buffer.clip_rect = buffer
            .clip_rect
            .map(|rect| translate_logical_rect(rect, dx, dy));
        buffer.clip_rect_precise = buffer
            .clip_rect_precise
            .map(|rect| translate_precise_rect(rect, dx, dy));
    }

    for buffer in &mut decoration.icon_buffers {
        buffer.rect = translate_logical_rect(buffer.rect, dx, dy);
        buffer.rect_precise = buffer
            .rect_precise
            .map(|rect| translate_precise_rect(rect, dx, dy));
        buffer.clip_rect = buffer
            .clip_rect
            .map(|rect| translate_logical_rect(rect, dx, dy));
        buffer.clip_rect_precise = buffer
            .clip_rect_precise
            .map(|rect| translate_precise_rect(rect, dx, dy));
    }
}

fn translate_content_clip(clip: ContentClip, dx: i32, dy: i32) -> ContentClip {
    ContentClip {
        rect: translate_smithay_rect(clip.rect, dx, dy),
        rect_precise: translate_precise_rect(clip.rect_precise, dx, dy),
        mask_rect: translate_smithay_rect(clip.mask_rect, dx, dy),
        mask_rect_precise: translate_precise_rect(clip.mask_rect_precise, dx, dy),
        ..clip
    }
}

fn translate_smithay_rect(
    rect: Rectangle<i32, Logical>,
    dx: i32,
    dy: i32,
) -> Rectangle<i32, Logical> {
    Rectangle::new(Point::from((rect.loc.x + dx, rect.loc.y + dy)), rect.size)
}

fn translate_logical_rect(rect: LogicalRect, dx: i32, dy: i32) -> LogicalRect {
    LogicalRect::new(rect.x + dx, rect.y + dy, rect.width, rect.height)
}

fn translate_precise_rect(rect: PreciseLogicalRect, dx: i32, dy: i32) -> PreciseLogicalRect {
    PreciseLogicalRect {
        x: rect.x + dx as f32,
        y: rect.y + dy as f32,
        width: rect.width,
        height: rect.height,
    }
}

fn build_cached_buffers(
    layout: &ComputedDecorationTree,
    order_map: &std::collections::HashMap<String, usize>,
) -> Vec<CachedDecorationBuffer> {
    let shared_edges = build_shared_edge_geometry_map(layout);
    let (buffers, _) = build_cached_buffers_and_shaders(layout, order_map, None, &shared_edges);
    buffers
}

fn build_shader_buffers(
    layout: &ComputedDecorationTree,
    order_map: &std::collections::HashMap<String, usize>,
) -> Vec<CachedShaderEffect> {
    let shared_edges = build_shared_edge_geometry_map(layout);
    let (_, buffers) = build_cached_buffers_and_shaders(layout, order_map, None, &shared_edges);
    buffers
}

fn build_cached_buffers_and_shaders(
    layout: &ComputedDecorationTree,
    order_map: &std::collections::HashMap<String, usize>,
    dirty_node_ids: Option<&std::collections::HashSet<&str>>,
    shared_edges: &impl SharedEdgeGeometryLookup,
) -> (Vec<CachedDecorationBuffer>, Vec<CachedShaderEffect>) {
    let mut buffers = Vec::new();
    let mut shader_buffers = Vec::new();
    collect_cached_buffers(
        &layout.root,
        "root".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        order_map,
        dirty_node_ids,
        shared_edges,
        &mut buffers,
        &mut shader_buffers,
    );
    (buffers, shader_buffers)
}

fn suggested_window_offset(layout: &ComputedDecorationTree) -> Option<(i32, i32)> {
    let root = layout.root.rect;
    let slot = layout.window_slot_rect()?;
    Some(((slot.x - root.x).max(0), (slot.y - root.y).max(0)))
}

fn build_text_buffers_with_fallback(
    layout: &ComputedDecorationTree,
    order_map: &std::collections::HashMap<String, usize>,
    raster_scale: i32,
    rasterizer: &mut crate::backend::text::TextRasterizer,
    previous: &[CachedDecorationLabel],
) -> Vec<CachedDecorationLabel> {
    let shared_edges = build_shared_edge_geometry_map(layout);
    build_text_buffers_with_shared_edges(
        layout,
        order_map,
        &shared_edges,
        raster_scale,
        rasterizer,
        previous,
    )
}

fn build_text_buffers_with_shared_edges(
    layout: &ComputedDecorationTree,
    order_map: &std::collections::HashMap<String, usize>,
    shared_edges: &impl SharedEdgeGeometryLookup,
    raster_scale: i32,
    rasterizer: &mut crate::backend::text::TextRasterizer,
    previous: &[CachedDecorationLabel],
) -> Vec<CachedDecorationLabel> {
    let mut buffers = Vec::new();
    collect_text_buffers(
        &layout.root,
        "root".into(),
        order_map,
        None,
        shared_edges,
        raster_scale,
        rasterizer,
        previous,
        &mut buffers,
    );
    buffers
}

fn build_icon_buffers(
    layout: &ComputedDecorationTree,
    order_map: &std::collections::HashMap<String, usize>,
    raster_scale: i32,
    snapshot: &WaylandWindowSnapshot,
    rasterizer: &mut crate::backend::icon::IconRasterizer,
) -> Vec<CachedDecorationIcon> {
    let shared_edges = build_shared_edge_geometry_map(layout);
    build_icon_buffers_with_shared_edges(
        layout,
        order_map,
        &shared_edges,
        raster_scale,
        snapshot,
        rasterizer,
    )
}

fn build_icon_buffers_with_shared_edges(
    layout: &ComputedDecorationTree,
    order_map: &std::collections::HashMap<String, usize>,
    shared_edges: &impl SharedEdgeGeometryLookup,
    raster_scale: i32,
    snapshot: &WaylandWindowSnapshot,
    rasterizer: &mut crate::backend::icon::IconRasterizer,
) -> Vec<CachedDecorationIcon> {
    let mut buffers = Vec::new();
    collect_icon_buffers(
        &layout.root,
        "root".into(),
        order_map,
        None,
        shared_edges,
        raster_scale,
        snapshot,
        rasterizer,
        &mut buffers,
    );
    buffers
}

fn retarget_text_buffers_with_shared_edges(
    layout: &ComputedDecorationTree,
    order_map: &std::collections::HashMap<String, usize>,
    shared_edges: &impl SharedEdgeGeometryLookup,
    previous: &[CachedDecorationLabel],
) -> Vec<CachedDecorationLabel> {
    let mut buffers = Vec::new();
    collect_retargeted_text_buffers(
        &layout.root,
        "root".into(),
        order_map,
        shared_edges,
        previous,
        &mut buffers,
    );
    buffers
}

fn collect_retargeted_text_buffers(
    node: &super::ComputedDecorationNode,
    path: String,
    order_map: &std::collections::HashMap<String, usize>,
    shared_edges: &impl SharedEdgeGeometryLookup,
    previous: &[CachedDecorationLabel],
    buffers: &mut Vec<CachedDecorationLabel>,
) {
    if node.style.visible == Some(false) {
        return;
    }

    for_each_paint_ordered_child(node, |index, child| {
        collect_retargeted_text_buffers(
            child,
            format!("{path}/child-{index}"),
            order_map,
            shared_edges,
            previous,
            buffers,
        );
    });

    let super::DecorationNodeKind::Label(label) = &node.kind else {
        return;
    };

    let stable_key = format!("{path}:label");
    let Some(mut buffer) = fallback_text_buffer(previous, node.stable_id.as_deref(), &stable_key)
    else {
        return;
    };
    let shared_geometry = node
        .stable_id
        .as_deref()
        .and_then(|stable_id| shared_edges.shared_edge_geometry(stable_id));
    let rect_precise = shared_geometry
        .map(|geometry| geometry.rect_precise)
        .unwrap_or_else(|| precise_rect_from_resolved(node.resolved_rect));
    let clip_rect_precise = shared_geometry
        .and_then(|geometry| geometry.clip_rect_precise)
        .or_else(|| {
            node.resolved_effective_clip
                .map(|clip| precise_rect_from_resolved(clip.rect))
        });
    let clip_radius_precise = node
        .resolved_effective_clip
        .map(|clip| clip.radius.to_f32().max(0.0));

    buffer.owner_node_id = node.stable_id.clone();
    buffer.stable_key = stable_key.clone();
    buffer.order = *order_map.get(&stable_key).unwrap_or(&usize::MAX);
    buffer.rect = node.rect;
    buffer.rect_precise = Some(rect_precise);
    buffer.clip_rect = node.effective_clip.map(|clip| clip.rect);
    buffer.clip_radius = node.effective_clip.map(|clip| clip.radius).unwrap_or(0);
    buffer.clip_rect_precise = clip_rect_precise;
    buffer.clip_radius_precise = clip_radius_precise;
    buffer.text = label.text.clone();
    buffer.color = node
        .style
        .color
        .unwrap_or(super::Color::WHITE)
        .with_opacity(node.style.opacity);
    buffers.push(buffer);
}

fn retarget_icon_buffers_with_shared_edges(
    layout: &ComputedDecorationTree,
    order_map: &std::collections::HashMap<String, usize>,
    shared_edges: &impl SharedEdgeGeometryLookup,
    snapshot: &WaylandWindowSnapshot,
    previous: &[CachedDecorationIcon],
) -> Vec<CachedDecorationIcon> {
    let mut buffers = Vec::new();
    collect_retargeted_icon_buffers(
        &layout.root,
        "root".into(),
        order_map,
        shared_edges,
        snapshot,
        previous,
        &mut buffers,
    );
    buffers
}

fn collect_retargeted_icon_buffers(
    node: &super::ComputedDecorationNode,
    path: String,
    order_map: &std::collections::HashMap<String, usize>,
    shared_edges: &impl SharedEdgeGeometryLookup,
    snapshot: &WaylandWindowSnapshot,
    previous: &[CachedDecorationIcon],
    buffers: &mut Vec<CachedDecorationIcon>,
) {
    if node.style.visible == Some(false) {
        return;
    }

    for_each_paint_ordered_child(node, |index, child| {
        collect_retargeted_icon_buffers(
            child,
            format!("{path}/child-{index}"),
            order_map,
            shared_edges,
            snapshot,
            previous,
            buffers,
        );
    });

    if !matches!(
        node.kind,
        super::DecorationNodeKind::AppIcon | super::DecorationNodeKind::Image(_)
    ) {
        return;
    }

    let stable_key = format!("{path}:icon");
    let Some(mut buffer) = fallback_icon_buffer(previous, node.stable_id.as_deref(), &stable_key)
    else {
        return;
    };
    let shared_geometry = node
        .stable_id
        .as_deref()
        .and_then(|stable_id| shared_edges.shared_edge_geometry(stable_id));
    let rect_precise = shared_geometry
        .map(|geometry| geometry.rect_precise)
        .unwrap_or_else(|| precise_rect_from_resolved(node.resolved_rect));
    let clip_rect_precise = shared_geometry
        .and_then(|geometry| geometry.clip_rect_precise)
        .or_else(|| {
            node.resolved_effective_clip
                .map(|clip| precise_rect_from_resolved(clip.rect))
        });
    let clip_radius_precise = node
        .resolved_effective_clip
        .map(|clip| clip.radius.to_f32().max(0.0));

    buffer.owner_node_id = node.stable_id.clone();
    buffer.stable_key = stable_key.clone();
    buffer.order = *order_map.get(&stable_key).unwrap_or(&usize::MAX);
    buffer.rect = node.rect;
    buffer.rect_precise = Some(rect_precise);
    buffer.clip_rect = node.effective_clip.map(|clip| clip.rect);
    buffer.clip_radius = node.effective_clip.map(|clip| clip.radius).unwrap_or(0);
    buffer.clip_rect_precise = clip_rect_precise;
    buffer.clip_radius_precise = clip_radius_precise;

    if matches!(node.kind, super::DecorationNodeKind::AppIcon)
        && snapshot.icon.is_none()
        && snapshot.app_id.is_none()
    {
        return;
    }
    buffers.push(buffer);
}

fn fallback_icon_buffer(
    previous: &[CachedDecorationIcon],
    owner_node_id: Option<&str>,
    stable_key: &str,
) -> Option<CachedDecorationIcon> {
    if let Some(owner_node_id) = owner_node_id
        && let Some(buffer) = previous
            .iter()
            .find(|buffer| buffer.owner_node_id.as_deref() == Some(owner_node_id))
    {
        return Some(buffer.clone());
    }

    previous
        .iter()
        .find(|buffer| buffer.stable_key == stable_key)
        .cloned()
}

fn build_render_order_map(
    layout: &ComputedDecorationTree,
) -> std::collections::HashMap<String, usize> {
    let mut map = std::collections::HashMap::new();
    let mut order = 0usize;
    collect_render_orders(&layout.root, "root".into(), &mut order, &mut map);
    map
}

fn rebuild_partial_buffers(
    layout: &ComputedDecorationTree,
    order_map: &std::collections::HashMap<String, usize>,
    dirty_node_ids: &[String],
) -> (Vec<CachedDecorationBuffer>, Vec<CachedShaderEffect>) {
    let dirty_node_ids = dirty_node_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let shared_edges = build_shared_edge_geometry_map(layout);
    build_cached_buffers_and_shaders(layout, order_map, Some(&dirty_node_ids), &shared_edges)
}

fn rebuild_partial_text_buffers_with_fallback(
    layout: &ComputedDecorationTree,
    order_map: &std::collections::HashMap<String, usize>,
    dirty_node_ids: &[String],
    raster_scale: i32,
    rasterizer: &mut crate::backend::text::TextRasterizer,
    previous: &[CachedDecorationLabel],
) -> Vec<CachedDecorationLabel> {
    let dirty_node_ids = dirty_node_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let shared_edges = build_shared_edge_geometry_map(layout);
    let mut buffers = Vec::new();
    collect_text_buffers(
        &layout.root,
        "root".into(),
        order_map,
        Some(&dirty_node_ids),
        &shared_edges,
        raster_scale,
        rasterizer,
        previous,
        &mut buffers,
    );
    buffers
}

fn rebuild_partial_icon_buffers(
    layout: &ComputedDecorationTree,
    order_map: &std::collections::HashMap<String, usize>,
    dirty_node_ids: &[String],
    raster_scale: i32,
    snapshot: &WaylandWindowSnapshot,
    rasterizer: &mut crate::backend::icon::IconRasterizer,
) -> Vec<CachedDecorationIcon> {
    let dirty_node_ids = dirty_node_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let shared_edges = build_shared_edge_geometry_map(layout);
    let mut buffers = Vec::new();
    collect_icon_buffers(
        &layout.root,
        "root".into(),
        order_map,
        Some(&dirty_node_ids),
        &shared_edges,
        raster_scale,
        snapshot,
        rasterizer,
        &mut buffers,
    );
    buffers
}

fn merge_cached_buffers(
    previous: &[CachedDecorationBuffer],
    rebuilt: Vec<CachedDecorationBuffer>,
    dirty_node_ids: &[String],
) -> Vec<CachedDecorationBuffer> {
    let dirty_node_ids = dirty_node_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut merged = previous
        .iter()
        .filter(|item| {
            item.owner_node_id
                .as_deref()
                .is_none_or(|node_id| !node_id_matches_dirty_scope(node_id, &dirty_node_ids))
        })
        .cloned()
        .collect::<Vec<_>>();
    merged.extend(rebuilt);
    merged.sort_by_key(|item| item.order);
    merged
}

fn merge_shader_buffers(
    previous: &[CachedShaderEffect],
    rebuilt: Vec<CachedShaderEffect>,
    dirty_node_ids: &[String],
) -> Vec<CachedShaderEffect> {
    let dirty_node_ids = dirty_node_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut merged = previous
        .iter()
        .filter(|item| {
            item.owner_node_id
                .as_deref()
                .is_none_or(|node_id| !node_id_matches_dirty_scope(node_id, &dirty_node_ids))
        })
        .cloned()
        .collect::<Vec<_>>();
    merged.extend(rebuilt);
    merged.sort_by_key(|item| item.order);
    merged
}

fn merge_text_buffers(
    previous: &[CachedDecorationLabel],
    rebuilt: Vec<CachedDecorationLabel>,
    dirty_node_ids: &[String],
) -> Vec<CachedDecorationLabel> {
    let dirty_node_ids = dirty_node_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut merged = previous
        .iter()
        .filter(|item| {
            item.owner_node_id
                .as_deref()
                .is_none_or(|node_id| !node_id_matches_dirty_scope(node_id, &dirty_node_ids))
        })
        .cloned()
        .collect::<Vec<_>>();
    merged.extend(rebuilt);
    merged.sort_by_key(|item| item.order);
    merged
}

fn merge_icon_buffers(
    previous: &[CachedDecorationIcon],
    rebuilt: Vec<CachedDecorationIcon>,
    dirty_node_ids: &[String],
) -> Vec<CachedDecorationIcon> {
    let dirty_node_ids = dirty_node_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut merged = previous
        .iter()
        .filter(|item| {
            item.owner_node_id
                .as_deref()
                .is_none_or(|node_id| !node_id_matches_dirty_scope(node_id, &dirty_node_ids))
        })
        .cloned()
        .collect::<Vec<_>>();
    merged.extend(rebuilt);
    merged.sort_by_key(|item| item.order);
    merged
}

fn is_descendant_node_id(node_id: &str, ancestor_id: &str) -> bool {
    node_id.len() > ancestor_id.len()
        && node_id.starts_with(ancestor_id)
        && node_id.as_bytes().get(ancestor_id.len()) == Some(&b'.')
}

fn node_id_matches_dirty_scope(
    node_id: &str,
    dirty_node_ids: &std::collections::HashSet<&str>,
) -> bool {
    dirty_node_ids
        .iter()
        .any(|dirty_id| node_id == *dirty_id || is_descendant_node_id(node_id, dirty_id))
}

fn paint_ordered_children(
    node: &super::ComputedDecorationNode,
) -> Vec<(usize, &super::ComputedDecorationNode)> {
    let mut children = node.children.iter().enumerate().collect::<Vec<_>>();
    children.sort_by(|(left_index, left), (right_index, right)| {
        right
            .style
            .z_index
            .unwrap_or(0)
            .cmp(&left.style.z_index.unwrap_or(0))
            .then_with(|| right_index.cmp(left_index))
    });
    children
}

fn for_each_paint_ordered_child(
    node: &super::ComputedDecorationNode,
    mut f: impl FnMut(usize, &super::ComputedDecorationNode),
) {
    if node
        .children
        .iter()
        .all(|child| child.style.z_index.unwrap_or(0) == 0)
    {
        for (index, child) in node.children.iter().enumerate().rev() {
            f(index, child);
        }
        return;
    }

    for (index, child) in paint_ordered_children(node) {
        f(index, child);
    }
}

fn collect_render_orders(
    node: &super::ComputedDecorationNode,
    path: String,
    order: &mut usize,
    map: &mut std::collections::HashMap<String, usize>,
) {
    if node.style.visible == Some(false) {
        return;
    }

    match &node.kind {
        super::DecorationNodeKind::Label(_) => {
            map.insert(format!("{path}:label"), *order);
            *order += 1;
            return;
        }
        super::DecorationNodeKind::AppIcon => {
            map.insert(format!("{path}:icon"), *order);
            *order += 1;
            return;
        }
        super::DecorationNodeKind::Image(_) => {
            map.insert(format!("{path}:icon"), *order);
            *order += 1;
            return;
        }
        super::DecorationNodeKind::WindowSlot => return,
        _ => {}
    }

    for_each_paint_ordered_child(node, |index, child| {
        collect_render_orders(child, format!("{path}/child-{index}"), order, map);
    });

    if let Some(border) = node.style.border {
        let color = border.color.with_opacity(node.style.opacity);
        if color.a > 0 && border.width > 0 {
            map.insert(format!("{path}:border"), *order);
            *order += 1;
        }
    }

    if let super::DecorationNodeKind::ShaderEffect(_) = &node.kind {
        map.insert(format!("{path}:shader"), *order);
        *order += 1;
    }

    if let Some(background) = node
        .style
        .background
        .map(|color| color.with_opacity(node.style.opacity))
    {
        if background.a > 0 {
            if matches!(node.kind, super::DecorationNodeKind::WindowBorder) {
                map.insert(format!("{path}:fill-top"), *order);
                *order += 1;
                map.insert(format!("{path}:fill-bottom"), *order);
                *order += 1;
                map.insert(format!("{path}:fill-left"), *order);
                *order += 1;
                map.insert(format!("{path}:fill-right"), *order);
                *order += 1;
            } else {
                map.insert(format!("{path}:fill"), *order);
                *order += 1;
            }
        }
    }
}

fn collect_cached_buffers(
    node: &super::ComputedDecorationNode,
    path: String,
    ancestor_clip: Option<super::DecorationClip>,
    ancestor_resolved_clip: Option<crate::ssd::ResolvedDecorationClip>,
    ancestor_clip_rect_precise: Option<PreciseLogicalRect>,
    ancestor_clip_radius_precise: Option<f32>,
    nearest_rounded_clip: Option<super::DecorationClip>,
    nearest_rounded_clip_rect_precise: Option<PreciseLogicalRect>,
    nearest_rounded_clip_radius_precise: Option<f32>,
    order_map: &std::collections::HashMap<String, usize>,
    dirty_node_ids: Option<&std::collections::HashSet<&str>>,
    shared_edges: &impl SharedEdgeGeometryLookup,
    buffers: &mut Vec<CachedDecorationBuffer>,
    shader_buffers: &mut Vec<CachedShaderEffect>,
) {
    if node.style.visible == Some(false) {
        return;
    }

    let include_node = dirty_node_ids.is_none_or(|dirty_node_ids| {
        node.stable_id
            .as_deref()
            .is_some_and(|stable_id| node_id_matches_dirty_scope(stable_id, dirty_node_ids))
    });
    let shared_geometry = node
        .stable_id
        .as_deref()
        .and_then(|stable_id| shared_edges.shared_edge_geometry(stable_id));

    let node_radius = node.resolved_border_radius.round_to_i32().max(0);
    let current_clip_rect = ancestor_clip.map(|clip| clip.rect);
    let current_clip_radius = ancestor_clip.map(|clip| clip.radius).unwrap_or(0);
    let current_clip_rect_precise = ancestor_clip_rect_precise
        .or_else(|| ancestor_resolved_clip.map(|clip| precise_rect_from_resolved(clip.rect)));
    let current_clip_radius_precise = ancestor_clip_radius_precise
        .or_else(|| ancestor_resolved_clip.map(|clip| clip.radius.to_f32().max(0.0)));
    let border_fit = node.style.effective_border_fit(&node.kind);
    let fit_children = matches!(border_fit, super::BorderFit::FitChildren);
    let fit_children_inner_clip_resolved = if fit_children {
        fit_children_inner_clip_resolved(node)
    } else {
        None
    };
    let fit_children_inner_clip_precise = if fit_children {
        fit_children_inner_clip_resolved.map(|clip| precise_rect_from_resolved(clip.rect))
    } else {
        None
    };
    let fit_children_inner_radius_precise = if fit_children {
        fit_children_inner_clip_resolved.map(|clip| clip.radius.to_f32().max(0.0))
    } else {
        None
    };
    let fit_children_inner_clip = if fit_children {
        fit_children_inner_clip_logical(node)
    } else {
        None
    };
    let child_clip = fit_children_inner_clip.or(node.effective_clip);
    let child_resolved_clip = fit_children_inner_clip_resolved.or(node.resolved_effective_clip);
    let child_clip_rect_precise = if fit_children {
        shared_geometry
            .map(|geometry| geometry.content_rect_precise)
            .or(fit_children_inner_clip_precise)
            .or_else(|| child_resolved_clip.map(|clip| precise_rect_from_resolved(clip.rect)))
    } else {
        shared_geometry
            .and_then(|geometry| geometry.clip_rect_precise)
            .or_else(|| child_resolved_clip.map(|clip| precise_rect_from_resolved(clip.rect)))
    };
    let child_clip_radius_precise = if fit_children {
        fit_children_inner_radius_precise
            .or_else(|| child_resolved_clip.map(|clip| clip.radius.to_f32().max(0.0)))
    } else {
        child_resolved_clip.map(|clip| clip.radius.to_f32().max(0.0))
    };
    let effective_clip_rect = if current_clip_radius_precise.unwrap_or(0.0) > 0.0 {
        current_clip_rect
    } else {
        nearest_rounded_clip.map(|clip| clip.rect)
    };
    let effective_clip_radius = if current_clip_radius_precise.unwrap_or(0.0) > 0.0 {
        current_clip_radius
    } else {
        nearest_rounded_clip.map(|clip| clip.radius).unwrap_or(0)
    };
    let effective_clip_rect_precise = if current_clip_radius_precise.unwrap_or(0.0) > 0.0 {
        current_clip_rect_precise
    } else {
        nearest_rounded_clip_rect_precise
    };
    let effective_clip_radius_precise = if current_clip_radius_precise.unwrap_or(0.0) > 0.0 {
        current_clip_radius_precise
    } else {
        nearest_rounded_clip_radius_precise
    };
    let next_nearest_rounded_clip = if child_clip_radius_precise.unwrap_or(0.0) > 0.0 {
        child_clip
    } else {
        nearest_rounded_clip
    };
    let next_nearest_rounded_clip_rect_precise = if child_clip_radius_precise.unwrap_or(0.0) > 0.0 {
        child_clip_rect_precise
    } else {
        nearest_rounded_clip_rect_precise
    };
    let next_nearest_rounded_clip_radius_precise = if child_clip_radius_precise.unwrap_or(0.0) > 0.0
    {
        child_clip_radius_precise
    } else {
        nearest_rounded_clip_radius_precise
    };
    if clip_debug_enabled() {
        trace!(
            stable_id = node.stable_id.as_deref().unwrap_or("<none>"),
            kind = node_kind_name(&node.kind),
            current_clip_rect = ?current_clip_rect,
            current_clip_rect_precise = ?current_clip_rect_precise,
            current_clip_radius = current_clip_radius,
            current_clip_radius_precise = ?current_clip_radius_precise,
            child_clip_rect = ?child_clip.map(|clip| clip.rect),
            child_clip_rect_precise = ?child_clip_rect_precise,
            child_clip_radius = child_clip.map(|clip| clip.radius),
            child_clip_radius_precise = ?child_clip_radius_precise,
            effective_clip_rect = ?effective_clip_rect,
            effective_clip_rect_precise = ?effective_clip_rect_precise,
            effective_clip_radius = effective_clip_radius,
            effective_clip_radius_precise = ?effective_clip_radius_precise,
            fit_children,
            include_node,
            "clip propagation at cached buffer collection"
        );
    }
    let border_hole_rect = if fit_children {
        fit_children_inner_clip.map(|clip| clip.rect).or_else(|| {
            node.style.border.map(|_border| {
                fit_children_inner_hole_rect(node, node.resolved_border_width.round_to_i32().max(0))
            })
        })
    } else {
        normal_border_inner_rect(node)
    };
    let border_hole_rect_precise = if fit_children {
        shared_geometry
            .map(|geometry| geometry.content_rect_precise)
            .or(fit_children_inner_clip_precise)
            .or_else(|| {
                (!node.children.is_empty()).then(|| {
                    precise_rect_from_resolved(
                        fit_children_inner_clip_resolved
                            .map(|clip| clip.rect)
                            .unwrap_or(node.resolved_content_rect),
                    )
                })
            })
    } else {
        normal_border_inner_rect_precise(node)
    };
    let border_hole_radius = fit_children_inner_clip
        .map(|clip| clip.radius.max(0))
        .unwrap_or_else(|| {
            (node.resolved_border_radius - node.resolved_border_width)
                .round_to_i32()
                .max(0)
        });
    let border_hole_radius_precise = fit_children_inner_radius_precise.or_else(|| {
        (node.style.border.is_some()).then(|| {
            (node.resolved_border_radius - node.resolved_border_width)
                .to_f32()
                .max(0.0)
        })
    });

    match &node.kind {
        super::DecorationNodeKind::Label(_)
        | super::DecorationNodeKind::AppIcon
        | super::DecorationNodeKind::Image(_)
        | super::DecorationNodeKind::WindowSlot => {}
        _ => {
            if include_node {
                if let Some(border) = node.style.border {
                    let color = border.color.with_opacity(node.style.opacity);
                    if color.a > 0 && border.width > 0 {
                        let current_order = *order_map
                            .get(&format!("{path}:border"))
                            .unwrap_or(&usize::MAX);
                        buffers.push(CachedDecorationBuffer {
                            owner_node_id: node.stable_id.clone(),
                            stable_key: format!("{path}:border"),
                            order: current_order,
                            rect: node.rect,
                            rect_precise: Some(
                                shared_geometry
                                    .map(|geometry| geometry.rect_precise)
                                    .unwrap_or_else(|| {
                                        precise_rect_from_resolved(node.resolved_rect)
                                    }),
                            ),
                            color,
                            buffer: SolidColorBuffer::new(
                                (node.rect.width.max(1), node.rect.height.max(1)),
                                [
                                    color.r as f32 / 255.0,
                                    color.g as f32 / 255.0,
                                    color.b as f32 / 255.0,
                                    color.a as f32 / 255.0,
                                ],
                            ),
                            radius: node_radius,
                            radius_precise: (!node.children.is_empty())
                                .then(|| node.resolved_border_radius.to_f32().max(0.0)),
                            border_width: node.resolved_border_width.to_f32().max(0.0),
                            hole_rect: border_hole_rect,
                            hole_rect_precise: border_hole_rect_precise,
                            hole_radius: border_hole_radius,
                            hole_radius_precise: border_hole_radius_precise,
                            shared_inner_hole: !node.children.is_empty() && fit_children,
                            clip_rect: effective_clip_rect,
                            clip_radius: effective_clip_radius,
                            clip_rect_precise: effective_clip_rect_precise,
                            clip_radius_precise: effective_clip_radius_precise,
                            source_kind: node_kind_name(&node.kind),
                        });
                    }
                }

                if let super::DecorationNodeKind::ShaderEffect(effect) = &node.kind {
                    let current_order = *order_map
                        .get(&format!("{path}:shader"))
                        .unwrap_or(&usize::MAX);
                    shader_buffers.push(CachedShaderEffect {
                        owner_node_id: node.stable_id.clone(),
                        stable_key: format!("{path}:shader"),
                        order: current_order,
                        rect: node.rect,
                        rect_precise: Some(
                            shared_geometry
                                .map(|geometry| geometry.rect_precise)
                                .unwrap_or_else(|| precise_rect_from_resolved(node.resolved_rect)),
                        ),
                        shader: effect.shader.clone(),
                        clip_rect: effective_clip_rect,
                        clip_radius: effective_clip_radius,
                        clip_rect_precise: effective_clip_rect_precise,
                        clip_radius_precise: effective_clip_radius_precise,
                    });
                }

                if let Some(background) = node
                    .style
                    .background
                    .map(|color| color.with_opacity(node.style.opacity))
                {
                    if background.a > 0 {
                        if matches!(node.kind, super::DecorationNodeKind::WindowBorder) {
                            if let Some(inner_rect) = border_hole_rect {
                                push_cached_fill(
                                    buffers,
                                    *order_map
                                        .get(&format!("{path}:fill-top"))
                                        .unwrap_or(&usize::MAX),
                                    format!("{path}:fill-top"),
                                    node.rect,
                                    Some(precise_rect_from_resolved(node.resolved_rect)),
                                    background,
                                    node.stable_id.clone(),
                                    node_radius,
                                    Some(node.resolved_border_radius.to_f32().max(0.0)),
                                    0.0,
                                    Some(inner_rect),
                                    border_hole_radius,
                                    fit_children_inner_clip
                                        .map(|clip| precise_rect_from_logical(clip.rect))
                                        .or(border_hole_rect_precise),
                                    border_hole_radius_precise,
                                    effective_clip_rect_precise,
                                    effective_clip_radius_precise,
                                    None,
                                    0,
                                );
                            } else {
                                push_cached_fill(
                                    buffers,
                                    *order_map
                                        .get(&format!("{path}:fill"))
                                        .unwrap_or(&usize::MAX),
                                    format!("{path}:fill"),
                                    node.rect,
                                    Some(precise_rect_from_resolved(node.resolved_rect)),
                                    background,
                                    node.stable_id.clone(),
                                    node_radius,
                                    Some(node.resolved_border_radius.to_f32().max(0.0)),
                                    0.0,
                                    None,
                                    0,
                                    None,
                                    None,
                                    effective_clip_rect_precise,
                                    effective_clip_radius_precise,
                                    None,
                                    0,
                                );
                            }
                        } else {
                            push_cached_fill(
                                buffers,
                                *order_map
                                    .get(&format!("{path}:fill"))
                                    .unwrap_or(&usize::MAX),
                                format!("{path}:fill"),
                                node.rect,
                                Some(precise_rect_from_resolved(node.resolved_rect)),
                                background,
                                node.stable_id.clone(),
                                node_radius,
                                Some(node.resolved_border_radius.to_f32().max(0.0)),
                                0.0,
                                None,
                                0,
                                None,
                                None,
                                effective_clip_rect_precise,
                                effective_clip_radius_precise,
                                effective_clip_rect,
                                effective_clip_radius,
                            );
                        }
                    }
                }
            }

            for_each_paint_ordered_child(node, |index, child| {
                collect_cached_buffers(
                    child,
                    format!("{path}/child-{index}"),
                    child_clip,
                    child_resolved_clip,
                    child_clip_rect_precise,
                    child_clip_radius_precise,
                    next_nearest_rounded_clip,
                    next_nearest_rounded_clip_rect_precise,
                    next_nearest_rounded_clip_radius_precise,
                    order_map,
                    dirty_node_ids,
                    shared_edges,
                    buffers,
                    shader_buffers,
                );
            });
        }
    }
}

fn collect_text_buffers(
    node: &super::ComputedDecorationNode,
    path: String,
    order_map: &std::collections::HashMap<String, usize>,
    dirty_node_ids: Option<&std::collections::HashSet<&str>>,
    shared_edges: &impl SharedEdgeGeometryLookup,
    raster_scale: i32,
    rasterizer: &mut crate::backend::text::TextRasterizer,
    previous: &[CachedDecorationLabel],
    buffers: &mut Vec<CachedDecorationLabel>,
) {
    if node.style.visible == Some(false) {
        return;
    }

    for_each_paint_ordered_child(node, |index, child| {
        collect_text_buffers(
            child,
            format!("{path}/child-{index}"),
            order_map,
            dirty_node_ids,
            shared_edges,
            raster_scale,
            rasterizer,
            previous,
            buffers,
        );
    });

    if dirty_node_ids.is_some_and(|dirty_node_ids| {
        !node
            .stable_id
            .as_deref()
            .is_some_and(|stable_id| node_id_matches_dirty_scope(stable_id, dirty_node_ids))
    }) {
        return;
    }

    let super::DecorationNodeKind::Label(label) = &node.kind else {
        return;
    };
    let shared_geometry = node
        .stable_id
        .as_deref()
        .and_then(|stable_id| shared_edges.shared_edge_geometry(stable_id));
    let color = node.style.color.unwrap_or(super::Color::WHITE);
    if color.a == 0 {
        return;
    }

    let spec = LabelSpec {
        rect: node.rect,
        rect_precise: Some(
            shared_geometry
                .map(|geometry| geometry.rect_precise)
                .unwrap_or_else(|| precise_rect_from_resolved(node.resolved_rect)),
        ),
        text: label.text.clone(),
        color: color.with_opacity(node.style.opacity),
        font_size: node.style.font_size.unwrap_or(13),
        font_weight: node.style.font_weight.clone(),
        font_family: node.style.font_family.clone(),
        text_align: node.style.text_align.clone(),
        line_height: node.style.line_height,
        raster_scale,
    };

    let stable_key = format!("{path}:label");
    let order = *order_map.get(&stable_key).unwrap_or(&usize::MAX);
    let current_rect_precise = shared_geometry
        .map(|geometry| geometry.rect_precise)
        .unwrap_or_else(|| precise_rect_from_resolved(node.resolved_rect));
    let current_clip_rect_precise = shared_geometry
        .and_then(|geometry| geometry.clip_rect_precise)
        .or_else(|| {
            node.resolved_effective_clip
                .map(|clip| precise_rect_from_resolved(clip.rect))
        });
    let current_clip_radius_precise = node
        .resolved_effective_clip
        .map(|clip| clip.radius.to_f32().max(0.0));

    if let Some(buffer) = rasterizer.render_label(&spec) {
        let mut buffer = buffer;
        buffer.owner_node_id = node.stable_id.clone();
        buffer.stable_key = stable_key;
        buffer.order = order;
        buffer.rect_precise = Some(current_rect_precise);
        buffer.clip_rect = node.effective_clip.map(|clip| clip.rect);
        buffer.clip_radius = node.effective_clip.map(|clip| clip.radius).unwrap_or(0);
        buffer.clip_rect_precise = current_clip_rect_precise;
        buffer.clip_radius_precise = current_clip_radius_precise;
        buffers.push(buffer);
    } else if let Some(mut buffer) =
        fallback_text_buffer(previous, node.stable_id.as_deref(), &stable_key)
    {
        // Text rasterization is asynchronous. Keep the previous texture visible until the new
        // spec is ready, otherwise changing a title/label produces a one-frame blank flash.
        buffer.owner_node_id = node.stable_id.clone();
        buffer.stable_key = stable_key;
        buffer.order = order;
        buffer.rect = spec.rect;
        buffer.rect_precise = Some(current_rect_precise);
        buffer.clip_rect = node.effective_clip.map(|clip| clip.rect);
        buffer.clip_radius = node.effective_clip.map(|clip| clip.radius).unwrap_or(0);
        buffer.clip_rect_precise = current_clip_rect_precise;
        buffer.clip_radius_precise = current_clip_radius_precise;
        buffer.color = spec.color;
        buffers.push(buffer);
    }
}

fn fallback_text_buffer(
    previous: &[CachedDecorationLabel],
    owner_node_id: Option<&str>,
    stable_key: &str,
) -> Option<CachedDecorationLabel> {
    if let Some(owner_node_id) = owner_node_id
        && let Some(buffer) = previous
            .iter()
            .find(|buffer| buffer.owner_node_id.as_deref() == Some(owner_node_id))
    {
        return Some(buffer.clone());
    }

    previous
        .iter()
        .find(|buffer| buffer.stable_key == stable_key)
        .cloned()
}

fn collect_icon_buffers(
    node: &super::ComputedDecorationNode,
    path: String,
    order_map: &std::collections::HashMap<String, usize>,
    dirty_node_ids: Option<&std::collections::HashSet<&str>>,
    shared_edges: &impl SharedEdgeGeometryLookup,
    raster_scale: i32,
    snapshot: &WaylandWindowSnapshot,
    rasterizer: &mut crate::backend::icon::IconRasterizer,
    buffers: &mut Vec<CachedDecorationIcon>,
) {
    if node.style.visible == Some(false) {
        return;
    }

    for_each_paint_ordered_child(node, |index, child| {
        collect_icon_buffers(
            child,
            format!("{path}/child-{index}"),
            order_map,
            dirty_node_ids,
            shared_edges,
            raster_scale,
            snapshot,
            rasterizer,
            buffers,
        );
    });

    if dirty_node_ids.is_some_and(|dirty_node_ids| {
        !node
            .stable_id
            .as_deref()
            .is_some_and(|stable_id| node_id_matches_dirty_scope(stable_id, dirty_node_ids))
    }) {
        return;
    }

    let (asset_path, image_fit) = match &node.kind {
        super::DecorationNodeKind::AppIcon => (None, None),
        super::DecorationNodeKind::Image(image) => (Some(image.src.clone()), Some(image.fit)),
        _ => return,
    };
    let shared_geometry = node
        .stable_id
        .as_deref()
        .and_then(|stable_id| shared_edges.shared_edge_geometry(stable_id));

    let spec = IconSpec {
        rect: node.rect,
        rect_precise: Some(
            shared_geometry
                .map(|geometry| geometry.rect_precise)
                .unwrap_or_else(|| precise_rect_from_resolved(node.resolved_rect)),
        ),
        icon: snapshot.icon.clone(),
        app_id: snapshot.app_id.clone(),
        asset_path,
        image_fit,
        raster_scale,
    };

    if let Some(buffer) = rasterizer.render_icon(&spec) {
        let mut buffer = buffer;
        buffer.owner_node_id = node.stable_id.clone();
        buffer.stable_key = format!("{path}:icon");
        buffer.order = *order_map
            .get(&format!("{path}:icon"))
            .unwrap_or(&usize::MAX);
        buffer.rect_precise = Some(
            shared_geometry
                .map(|geometry| geometry.rect_precise)
                .unwrap_or_else(|| precise_rect_from_resolved(node.resolved_rect)),
        );
        buffer.clip_rect = node.effective_clip.map(|clip| clip.rect);
        buffer.clip_radius = node.effective_clip.map(|clip| clip.radius).unwrap_or(0);
        buffer.clip_rect_precise = shared_geometry
            .and_then(|geometry| geometry.clip_rect_precise)
            .or_else(|| {
                node.resolved_effective_clip
                    .map(|clip| precise_rect_from_resolved(clip.rect))
            });
        buffer.clip_radius_precise = node
            .resolved_effective_clip
            .map(|clip| clip.radius.to_f32().max(0.0));
        buffers.push(buffer);
    }
}

fn push_cached_fill(
    buffers: &mut Vec<CachedDecorationBuffer>,
    order: usize,
    stable_key: String,
    rect: LogicalRect,
    rect_precise: Option<PreciseLogicalRect>,
    color: super::Color,
    owner_node_id: Option<String>,
    radius: i32,
    radius_precise: Option<f32>,
    border_width: f32,
    hole_rect: Option<LogicalRect>,
    hole_radius: i32,
    hole_rect_precise: Option<PreciseLogicalRect>,
    hole_radius_precise: Option<f32>,
    clip_rect_precise: Option<PreciseLogicalRect>,
    clip_radius_precise: Option<f32>,
    clip_rect: Option<LogicalRect>,
    clip_radius: i32,
) {
    if rect.width <= 0 || rect.height <= 0 || color.a == 0 {
        return;
    }

    buffers.push(CachedDecorationBuffer {
        owner_node_id,
        stable_key,
        order,
        rect,
        rect_precise: rect_precise.or_else(|| Some(precise_rect_from_logical(rect))),
        color,
        buffer: SolidColorBuffer::new(
            (rect.width.max(1), rect.height.max(1)),
            [
                color.r as f32 / 255.0,
                color.g as f32 / 255.0,
                color.b as f32 / 255.0,
                color.a as f32 / 255.0,
            ],
        ),
        radius,
        radius_precise,
        border_width,
        hole_rect,
        hole_rect_precise,
        hole_radius,
        hole_radius_precise,
        shared_inner_hole: false,
        clip_rect,
        clip_radius,
        clip_rect_precise,
        clip_radius_precise,
        source_kind: "fill",
    });
}

fn node_kind_name(kind: &super::DecorationNodeKind) -> &'static str {
    match kind {
        super::DecorationNodeKind::Box(_) => "box",
        super::DecorationNodeKind::Label(_) => "label",
        super::DecorationNodeKind::Button(_) => "button",
        super::DecorationNodeKind::AppIcon => "app-icon",
        super::DecorationNodeKind::Image(_) => "image",
        super::DecorationNodeKind::ShaderEffect(_) => "shader-effect",
        super::DecorationNodeKind::WindowBorder => "window-border",
        super::DecorationNodeKind::WindowSlot => "window-slot",
    }
}

fn gap_debug_layout_enabled() -> bool {
    std::env::var_os("SHOJI_GAP_LAYOUT_DEBUG").is_some()
        || std::env::var_os("SHOJI_GAP_DEBUG").is_some()
}

fn resolved_rect_right(rect: crate::ssd::ResolvedLogicalRect) -> f32 {
    rect.x.to_f32() + rect.width.to_f32()
}

fn resolved_rect_bottom(rect: crate::ssd::ResolvedLogicalRect) -> f32 {
    rect.y.to_f32() + rect.height.to_f32()
}

fn format_resolved_rect(rect: crate::ssd::ResolvedLogicalRect) -> String {
    format!(
        "x={:.3}, y={:.3}, w={:.3}, h={:.3}, right={:.3}, bottom={:.3}",
        rect.x.to_f32(),
        rect.y.to_f32(),
        rect.width.to_f32(),
        rect.height.to_f32(),
        resolved_rect_right(rect),
        resolved_rect_bottom(rect),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct SharedEdgeId(u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SharedEdgeAxis {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Copy)]
struct SharedEdgeSpec {
    axis: SharedEdgeAxis,
    logical_raw: i32,
}

#[derive(Debug, Clone, Copy)]
struct SharedEdgeRect {
    left: SharedEdgeId,
    top: SharedEdgeId,
    right: SharedEdgeId,
    bottom: SharedEdgeId,
}

#[derive(Debug, Clone)]
struct SharedEdgeTreeNode {
    stable_id: String,
    kind: &'static str,
    rect: SharedEdgeRect,
    content_rect: SharedEdgeRect,
    clip_rect: Option<SharedEdgeRect>,
    children: Vec<SharedEdgeTreeNode>,
}

#[derive(Debug, Clone)]
struct SharedEdgeTree {
    edges: Vec<SharedEdgeSpec>,
    root: SharedEdgeTreeNode,
}

#[derive(Debug, Clone, Copy)]
struct SharedEdgeNodeGeometry {
    rect_precise: PreciseLogicalRect,
    content_rect_precise: PreciseLogicalRect,
    clip_rect_precise: Option<PreciseLogicalRect>,
}

#[derive(Debug, Clone, Copy)]
struct SharedEdgeNodeRefs {
    rect: SharedEdgeRect,
    content: SharedEdgeRect,
}

#[derive(Debug, Clone, Copy, Default)]
struct SharedEdgeBuildContext {
    parent: Option<SharedEdgeNodeRefs>,
    previous_sibling: Option<SharedEdgeNodeRefs>,
}

#[derive(Default)]
struct SharedEdgeBuilder {
    next_id: u32,
    edges: Vec<SharedEdgeSpec>,
}

impl SharedEdgeBuilder {
    fn matching_edge(
        &self,
        axis: SharedEdgeAxis,
        logical_raw: i32,
        candidates: &[SharedEdgeId],
    ) -> Option<SharedEdgeId> {
        candidates.iter().copied().find(|candidate| {
            let spec = self.spec(*candidate);
            spec.axis == axis && spec.logical_raw == logical_raw
        })
    }

    fn new_edge(&mut self, axis: SharedEdgeAxis, logical_raw: i32) -> SharedEdgeId {
        let id = SharedEdgeId(self.next_id);
        self.next_id += 1;
        self.edges.push(SharedEdgeSpec { axis, logical_raw });
        id
    }

    fn edge_with_context(
        &mut self,
        axis: SharedEdgeAxis,
        logical_raw: i32,
        parent_candidates: &[SharedEdgeId],
        previous_candidates: &[SharedEdgeId],
    ) -> SharedEdgeId {
        if let Some(existing) = self.matching_edge(axis, logical_raw, parent_candidates) {
            return existing;
        }
        if let Some(existing) = self.matching_edge(axis, logical_raw, previous_candidates) {
            return existing;
        }

        self.new_edge(axis, logical_raw)
    }

    fn spec(&self, id: SharedEdgeId) -> SharedEdgeSpec {
        self.edges[id.0 as usize]
    }

    fn rect_from_resolved(
        &mut self,
        rect: crate::ssd::ResolvedLogicalRect,
        context: SharedEdgeBuildContext,
    ) -> SharedEdgeRect {
        let parent_left = context
            .parent
            .map(|parent| [parent.rect.left, parent.content.left]);
        let parent_top = context
            .parent
            .map(|parent| [parent.rect.top, parent.content.top]);
        let parent_right = context
            .parent
            .map(|parent| [parent.rect.right, parent.content.right]);
        let parent_bottom = context
            .parent
            .map(|parent| [parent.rect.bottom, parent.content.bottom]);
        let previous_vertical = context.previous_sibling.map(|previous| {
            [
                previous.rect.left,
                previous.rect.right,
                previous.content.left,
                previous.content.right,
            ]
        });
        let previous_horizontal = context.previous_sibling.map(|previous| {
            [
                previous.rect.top,
                previous.rect.bottom,
                previous.content.top,
                previous.content.bottom,
            ]
        });

        SharedEdgeRect {
            left: self.edge_with_context(
                SharedEdgeAxis::Vertical,
                rect.x.raw(),
                parent_left.as_ref().map(|ids| &ids[..]).unwrap_or(&[]),
                previous_vertical
                    .as_ref()
                    .map(|ids| &ids[..])
                    .unwrap_or(&[]),
            ),
            top: self.edge_with_context(
                SharedEdgeAxis::Horizontal,
                rect.y.raw(),
                parent_top.as_ref().map(|ids| &ids[..]).unwrap_or(&[]),
                previous_horizontal
                    .as_ref()
                    .map(|ids| &ids[..])
                    .unwrap_or(&[]),
            ),
            right: self.edge_with_context(
                SharedEdgeAxis::Vertical,
                (rect.x + rect.width).raw(),
                parent_right.as_ref().map(|ids| &ids[..]).unwrap_or(&[]),
                previous_vertical
                    .as_ref()
                    .map(|ids| &ids[..])
                    .unwrap_or(&[]),
            ),
            bottom: self.edge_with_context(
                SharedEdgeAxis::Horizontal,
                (rect.y + rect.height).raw(),
                parent_bottom.as_ref().map(|ids| &ids[..]).unwrap_or(&[]),
                previous_horizontal
                    .as_ref()
                    .map(|ids| &ids[..])
                    .unwrap_or(&[]),
            ),
        }
    }

    fn inner_rect_from_resolved(
        &mut self,
        rect: crate::ssd::ResolvedLogicalRect,
        context: SharedEdgeBuildContext,
        rect_refs: SharedEdgeRect,
    ) -> SharedEdgeRect {
        let parent_left = context
            .parent
            .map(|parent| [rect_refs.left, parent.rect.left, parent.content.left]);
        let parent_top = context
            .parent
            .map(|parent| [rect_refs.top, parent.rect.top, parent.content.top]);
        let parent_right = context
            .parent
            .map(|parent| [rect_refs.right, parent.rect.right, parent.content.right]);
        let parent_bottom = context
            .parent
            .map(|parent| [rect_refs.bottom, parent.rect.bottom, parent.content.bottom]);
        let own_left = [rect_refs.left];
        let own_top = [rect_refs.top];
        let own_right = [rect_refs.right];
        let own_bottom = [rect_refs.bottom];
        let previous_vertical = context.previous_sibling.map(|previous| {
            [
                previous.rect.left,
                previous.rect.right,
                previous.content.left,
                previous.content.right,
            ]
        });
        let previous_horizontal = context.previous_sibling.map(|previous| {
            [
                previous.rect.top,
                previous.rect.bottom,
                previous.content.top,
                previous.content.bottom,
            ]
        });

        SharedEdgeRect {
            left: self.edge_with_context(
                SharedEdgeAxis::Vertical,
                rect.x.raw(),
                parent_left
                    .as_ref()
                    .map(|ids| &ids[..])
                    .unwrap_or(&own_left),
                previous_vertical
                    .as_ref()
                    .map(|ids| &ids[..])
                    .unwrap_or(&[]),
            ),
            top: self.edge_with_context(
                SharedEdgeAxis::Horizontal,
                rect.y.raw(),
                parent_top.as_ref().map(|ids| &ids[..]).unwrap_or(&own_top),
                previous_horizontal
                    .as_ref()
                    .map(|ids| &ids[..])
                    .unwrap_or(&[]),
            ),
            right: self.edge_with_context(
                SharedEdgeAxis::Vertical,
                (rect.x + rect.width).raw(),
                parent_right
                    .as_ref()
                    .map(|ids| &ids[..])
                    .unwrap_or(&own_right),
                previous_vertical
                    .as_ref()
                    .map(|ids| &ids[..])
                    .unwrap_or(&[]),
            ),
            bottom: self.edge_with_context(
                SharedEdgeAxis::Horizontal,
                (rect.y + rect.height).raw(),
                parent_bottom
                    .as_ref()
                    .map(|ids| &ids[..])
                    .unwrap_or(&own_bottom),
                previous_horizontal
                    .as_ref()
                    .map(|ids| &ids[..])
                    .unwrap_or(&[]),
            ),
        }
    }

    fn build_node(
        &mut self,
        node: &super::ComputedDecorationNode,
        context: SharedEdgeBuildContext,
    ) -> SharedEdgeTreeNode {
        let rect = self.rect_from_resolved(node.resolved_rect, context);
        let content_rect = self.inner_rect_from_resolved(node.resolved_content_rect, context, rect);
        let clip_rect = node
            .resolved_effective_clip
            .map(|clip| self.inner_rect_from_resolved(clip.rect, context, content_rect));
        let refs = SharedEdgeNodeRefs {
            rect,
            content: content_rect,
        };
        let mut previous_sibling = None;
        let mut children = Vec::with_capacity(node.children.len());
        for child in &node.children {
            let is_absolute = matches!(child.style.position, Some(super::StylePosition::Absolute));
            let child_context = if is_absolute {
                SharedEdgeBuildContext::default()
            } else {
                SharedEdgeBuildContext {
                    parent: Some(refs),
                    previous_sibling,
                }
            };
            let child_node = self.build_node(child, child_context);
            if !is_absolute {
                previous_sibling = Some(SharedEdgeNodeRefs {
                    rect: child_node.rect,
                    content: child_node.content_rect,
                });
            }
            children.push(child_node);
        }

        SharedEdgeTreeNode {
            stable_id: node.stable_id.as_deref().unwrap_or("<none>").to_string(),
            kind: node_kind_name(&node.kind),
            rect,
            content_rect,
            clip_rect,
            children,
        }
    }
}

fn build_shared_edge_tree(layout: &ComputedDecorationTree) -> SharedEdgeTree {
    let mut builder = SharedEdgeBuilder::default();
    let root = builder.build_node(&layout.root, SharedEdgeBuildContext::default());
    SharedEdgeTree {
        edges: builder.edges,
        root,
    }
}

fn collect_shared_edge_geometry_map_node(
    builder: &mut SharedEdgeBuilder,
    node: &super::ComputedDecorationNode,
    context: SharedEdgeBuildContext,
    out: &mut std::collections::HashMap<String, SharedEdgeNodeGeometry>,
) -> SharedEdgeNodeRefs {
    let rect = builder.rect_from_resolved(node.resolved_rect, context);
    let content_rect = builder.inner_rect_from_resolved(node.resolved_content_rect, context, rect);
    let clip_rect = node
        .resolved_effective_clip
        .map(|clip| builder.inner_rect_from_resolved(clip.rect, context, content_rect));
    let refs = SharedEdgeNodeRefs {
        rect,
        content: content_rect,
    };

    if let Some(stable_id) = node.stable_id.as_deref() {
        out.insert(
            stable_id.to_string(),
            SharedEdgeNodeGeometry {
                rect_precise: precise_rect_from_shared_edges(&builder.edges, rect),
                content_rect_precise: precise_rect_from_shared_edges(&builder.edges, content_rect),
                clip_rect_precise: clip_rect
                    .map(|rect| precise_rect_from_shared_edges(&builder.edges, rect)),
            },
        );
    }

    let mut previous_sibling = None;
    for child in &node.children {
        let is_absolute = matches!(child.style.position, Some(super::StylePosition::Absolute));
        let child_context = if is_absolute {
            SharedEdgeBuildContext::default()
        } else {
            SharedEdgeBuildContext {
                parent: Some(refs),
                previous_sibling,
            }
        };
        let child_refs = collect_shared_edge_geometry_map_node(builder, child, child_context, out);
        if !is_absolute {
            previous_sibling = Some(child_refs);
        }
    }

    refs
}

fn collect_shared_edge_geometry_map_node_in<'a>(
    builder: &mut SharedEdgeBuilder,
    node: &'a super::ComputedDecorationNode,
    context: SharedEdgeBuildContext,
    out: &mut BumpSharedEdgeGeometryMap<'a>,
) -> SharedEdgeNodeRefs {
    let rect = builder.rect_from_resolved(node.resolved_rect, context);
    let content_rect = builder.inner_rect_from_resolved(node.resolved_content_rect, context, rect);
    let clip_rect = node
        .resolved_effective_clip
        .map(|clip| builder.inner_rect_from_resolved(clip.rect, context, content_rect));
    let refs = SharedEdgeNodeRefs {
        rect,
        content: content_rect,
    };

    if let Some(stable_id) = node.stable_id.as_deref() {
        out.insert(
            stable_id,
            SharedEdgeNodeGeometry {
                rect_precise: precise_rect_from_shared_edges(&builder.edges, rect),
                content_rect_precise: precise_rect_from_shared_edges(&builder.edges, content_rect),
                clip_rect_precise: clip_rect
                    .map(|rect| precise_rect_from_shared_edges(&builder.edges, rect)),
            },
        );
    }

    let mut previous_sibling = None;
    for child in &node.children {
        let is_absolute = matches!(child.style.position, Some(super::StylePosition::Absolute));
        let child_context = if is_absolute {
            SharedEdgeBuildContext::default()
        } else {
            SharedEdgeBuildContext {
                parent: Some(refs),
                previous_sibling,
            }
        };
        let child_refs =
            collect_shared_edge_geometry_map_node_in(builder, child, child_context, out);
        if !is_absolute {
            previous_sibling = Some(child_refs);
        }
    }

    refs
}

fn precise_rect_from_shared_edges(
    edges: &[SharedEdgeSpec],
    rect: SharedEdgeRect,
) -> PreciseLogicalRect {
    let left = edges[rect.left.0 as usize].logical_raw as f32
        / crate::ssd::RESOLVED_LAYOUT_SUBPIXELS as f32;
    let top = edges[rect.top.0 as usize].logical_raw as f32
        / crate::ssd::RESOLVED_LAYOUT_SUBPIXELS as f32;
    let right = edges[rect.right.0 as usize].logical_raw as f32
        / crate::ssd::RESOLVED_LAYOUT_SUBPIXELS as f32;
    let bottom = edges[rect.bottom.0 as usize].logical_raw as f32
        / crate::ssd::RESOLVED_LAYOUT_SUBPIXELS as f32;

    PreciseLogicalRect {
        x: left,
        y: top,
        width: (right - left).max(0.0),
        height: (bottom - top).max(0.0),
    }
}

fn build_shared_edge_geometry_map(
    layout: &ComputedDecorationTree,
) -> std::collections::HashMap<String, SharedEdgeNodeGeometry> {
    let mut map = std::collections::HashMap::new();
    let mut builder = SharedEdgeBuilder::default();
    collect_shared_edge_geometry_map_node(
        &mut builder,
        &layout.root,
        SharedEdgeBuildContext::default(),
        &mut map,
    );
    map
}

fn build_shared_edge_geometry_map_in<'a>(
    layout: &'a ComputedDecorationTree,
    arena: &'a Bump,
) -> BumpSharedEdgeGeometryMap<'a> {
    let mut map = BumpSharedEdgeGeometryMap::new_in(arena);
    let mut builder = SharedEdgeBuilder::default();
    collect_shared_edge_geometry_map_node_in(
        &mut builder,
        &layout.root,
        SharedEdgeBuildContext::default(),
        &mut map,
    );
    map
}

fn format_shared_edge_id(id: SharedEdgeId) -> String {
    format!("e{}", id.0)
}

fn format_shared_edge_rect(rect: SharedEdgeRect) -> String {
    format!(
        "L={}, T={}, R={}, B={}",
        format_shared_edge_id(rect.left),
        format_shared_edge_id(rect.top),
        format_shared_edge_id(rect.right),
        format_shared_edge_id(rect.bottom),
    )
}

fn format_shared_edge_rect_values(rect: SharedEdgeRect, tree: &SharedEdgeTree) -> String {
    let left = tree.edges[rect.left.0 as usize].logical_raw as f32
        / crate::ssd::RESOLVED_LAYOUT_SUBPIXELS as f32;
    let top = tree.edges[rect.top.0 as usize].logical_raw as f32
        / crate::ssd::RESOLVED_LAYOUT_SUBPIXELS as f32;
    let right = tree.edges[rect.right.0 as usize].logical_raw as f32
        / crate::ssd::RESOLVED_LAYOUT_SUBPIXELS as f32;
    let bottom = tree.edges[rect.bottom.0 as usize].logical_raw as f32
        / crate::ssd::RESOLVED_LAYOUT_SUBPIXELS as f32;
    format!("left={left:.3}, top={top:.3}, right={right:.3}, bottom={bottom:.3}")
}

fn log_gap_shared_edge_tree(snapshot: &WaylandWindowSnapshot, layout: &ComputedDecorationTree) {
    let tree = build_shared_edge_tree(layout);
    let slot_node = find_shared_edge_node_by_kind(&tree.root, "window-slot");

    info!(
        window_id = snapshot.id,
        title = snapshot.title,
        edge_count = tree.edges.len(),
        root_rect_edges = %format_shared_edge_rect(tree.root.rect),
        root_content_edges = %format_shared_edge_rect(tree.root.content_rect),
        slot_rect_edges = slot_node.map(|node| format_shared_edge_rect(node.rect)),
        slot_content_edges = slot_node.map(|node| format_shared_edge_rect(node.content_rect)),
        "gap shared edge summary"
    );

    log_gap_shared_edge_node(snapshot, &tree, &tree.root, None, 0);
}

fn find_shared_edge_node_by_kind<'a>(
    node: &'a SharedEdgeTreeNode,
    kind: &str,
) -> Option<&'a SharedEdgeTreeNode> {
    if node.kind == kind {
        return Some(node);
    }

    node.children
        .iter()
        .find_map(|child| find_shared_edge_node_by_kind(child, kind))
}

fn log_gap_shared_edge_node(
    snapshot: &WaylandWindowSnapshot,
    tree: &SharedEdgeTree,
    node: &SharedEdgeTreeNode,
    parent: Option<&SharedEdgeTreeNode>,
    depth: usize,
) {
    info!(
        window_id = snapshot.id,
        depth,
        kind = node.kind,
        stable_id = node.stable_id,
        rect_edges = %format_shared_edge_rect(node.rect),
        rect_edge_values = %format_shared_edge_rect_values(node.rect, tree),
        content_edges = %format_shared_edge_rect(node.content_rect),
        content_edge_values = %format_shared_edge_rect_values(node.content_rect, tree),
        clip_edges = node.clip_rect.map(format_shared_edge_rect),
        clip_edge_values = node
            .clip_rect
            .map(|rect| format_shared_edge_rect_values(rect, tree)),
        shares_parent_content_left = parent
            .map(|parent| node.rect.left == parent.content_rect.left),
        shares_parent_content_top = parent
            .map(|parent| node.rect.top == parent.content_rect.top),
        shares_parent_content_right = parent
            .map(|parent| node.rect.right == parent.content_rect.right),
        shares_parent_content_bottom = parent
            .map(|parent| node.rect.bottom == parent.content_rect.bottom),
        rect_shares_own_content_left = node.rect.left == node.content_rect.left,
        rect_shares_own_content_top = node.rect.top == node.content_rect.top,
        rect_shares_own_content_right = node.rect.right == node.content_rect.right,
        rect_shares_own_content_bottom = node.rect.bottom == node.content_rect.bottom,
        "gap shared edge node"
    );

    for child in &node.children {
        log_gap_shared_edge_node(snapshot, tree, child, Some(node), depth + 1);
    }
}

fn log_gap_layout_tree(
    snapshot: &WaylandWindowSnapshot,
    client_rect: LogicalRect,
    layout: &ComputedDecorationTree,
) {
    let Some(slot_rect) = layout.window_slot_rect() else {
        return;
    };
    let Some(slot_resolved_rect) = layout.root.resolved_window_slot_rect() else {
        return;
    };

    let root = &layout.root;
    let root_content_rect = root.resolved_content_rect.round_to_logical_rect();
    info!(
        window_id = snapshot.id,
        title = snapshot.title,
        client_rect = %format_rect(client_rect),
        root_rect = %format_rect(root.rect),
        root_rect_resolved = %format_resolved_rect(root.resolved_rect),
        root_content_rect = %format_rect(root_content_rect),
        root_content_rect_resolved = %format_resolved_rect(root.resolved_content_rect),
        slot_rect = %format_rect(slot_rect),
        slot_rect_resolved = %format_resolved_rect(slot_resolved_rect),
        logical_slot_right_delta_vs_client = (slot_rect.x + slot_rect.width) - (client_rect.x + client_rect.width),
        logical_slot_bottom_delta_vs_client = (slot_rect.y + slot_rect.height) - (client_rect.y + client_rect.height),
        resolved_slot_right_delta_vs_client = resolved_rect_right(slot_resolved_rect)
            - (client_rect.x + client_rect.width) as f32,
        resolved_slot_bottom_delta_vs_client = resolved_rect_bottom(slot_resolved_rect)
            - (client_rect.y + client_rect.height) as f32,
        logical_root_content_right_delta_vs_slot = (root_content_rect.x + root_content_rect.width)
            - (slot_rect.x + slot_rect.width),
        logical_root_content_bottom_delta_vs_slot = (root_content_rect.y + root_content_rect.height)
            - (slot_rect.y + slot_rect.height),
        resolved_root_content_right_delta_vs_slot = resolved_rect_right(root.resolved_content_rect)
            - resolved_rect_right(slot_resolved_rect),
        resolved_root_content_bottom_delta_vs_slot = resolved_rect_bottom(root.resolved_content_rect)
            - resolved_rect_bottom(slot_resolved_rect),
        "gap layout summary"
    );

    log_gap_shared_edge_tree(snapshot, layout);
    log_gap_layout_node(snapshot, root, None, 0);
}

fn log_gap_layout_node(
    snapshot: &WaylandWindowSnapshot,
    node: &super::ComputedDecorationNode,
    parent: Option<&super::ComputedDecorationNode>,
    depth: usize,
) {
    let rect_right = node.rect.x + node.rect.width;
    let rect_bottom = node.rect.y + node.rect.height;
    let content_rect = node.resolved_content_rect.round_to_logical_rect();
    let content_right = content_rect.x + content_rect.width;
    let content_bottom = content_rect.y + content_rect.height;

    let parent_outer_left_delta =
        parent.map(|parent| node.resolved_rect.x.to_f32() - parent.resolved_rect.x.to_f32());
    let parent_content_left_delta = parent
        .map(|parent| node.resolved_rect.x.to_f32() - parent.resolved_content_rect.x.to_f32());
    let parent_outer_top_delta =
        parent.map(|parent| node.resolved_rect.y.to_f32() - parent.resolved_rect.y.to_f32());
    let parent_content_top_delta = parent
        .map(|parent| node.resolved_rect.y.to_f32() - parent.resolved_content_rect.y.to_f32());
    let parent_outer_right_delta =
        parent.map(|parent| (parent.rect.x + parent.rect.width) - rect_right);
    let parent_content_right_delta = parent.map(|parent| {
        let parent_content_rect = parent.resolved_content_rect.round_to_logical_rect();
        (parent_content_rect.x + parent_content_rect.width) - rect_right
    });
    let parent_outer_right_delta_resolved = parent.map(|parent| {
        resolved_rect_right(parent.resolved_rect) - resolved_rect_right(node.resolved_rect)
    });
    let parent_content_right_delta_resolved = parent.map(|parent| {
        resolved_rect_right(parent.resolved_content_rect) - resolved_rect_right(node.resolved_rect)
    });

    let child_union = (!node.children.is_empty()).then(|| {
        let mut min_x = f32::INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_right = f32::NEG_INFINITY;
        let mut max_bottom = f32::NEG_INFINITY;
        for child in &node.children {
            min_x = min_x.min(child.resolved_rect.x.to_f32());
            min_y = min_y.min(child.resolved_rect.y.to_f32());
            max_right = max_right.max(resolved_rect_right(child.resolved_rect));
            max_bottom = max_bottom.max(resolved_rect_bottom(child.resolved_rect));
        }
        (min_x, min_y, max_right, max_bottom)
    });

    info!(
        window_id = snapshot.id,
        depth,
        kind = node_kind_name(&node.kind),
        stable_id = node.stable_id.as_deref().unwrap_or("<none>"),
        rect = %format_rect(node.rect),
        rect_resolved = %format_resolved_rect(node.resolved_rect),
        rect_right,
        rect_bottom,
        content_rect = %format_rect(content_rect),
        content_rect_resolved = %format_resolved_rect(node.resolved_content_rect),
        content_right,
        content_bottom,
        border_width_logical = node.resolved_border_width.round_to_i32(),
        border_width_resolved = node.resolved_border_width.to_f32(),
        border_radius_logical = node.resolved_border_radius.round_to_i32(),
        border_radius_resolved = node.resolved_border_radius.to_f32(),
        parent_kind = parent
            .map(|parent| node_kind_name(&parent.kind))
            .unwrap_or("<root>"),
        parent_outer_left_delta,
        parent_content_left_delta,
        parent_outer_top_delta,
        parent_content_top_delta,
        parent_outer_right_delta,
        parent_content_right_delta,
        parent_outer_right_delta_resolved,
        parent_content_right_delta_resolved,
        child_union_left_resolved = child_union.map(|union| union.0),
        child_union_top_resolved = child_union.map(|union| union.1),
        child_union_right_resolved = child_union.map(|union| union.2),
        child_union_bottom_resolved = child_union.map(|union| union.3),
        child_union_right_delta_from_outer = child_union
            .map(|union| resolved_rect_right(node.resolved_rect) - union.2),
        child_union_right_delta_from_content = child_union
            .map(|union| resolved_rect_right(node.resolved_content_rect) - union.2),
        child_union_bottom_delta_from_outer = child_union
            .map(|union| resolved_rect_bottom(node.resolved_rect) - union.3),
        child_union_bottom_delta_from_content = child_union
            .map(|union| resolved_rect_bottom(node.resolved_content_rect) - union.3),
        "gap layout node"
    );

    for child in &node.children {
        log_gap_layout_node(snapshot, child, Some(node), depth + 1);
    }
}

fn log_decoration_refresh(
    reason: &str,
    snapshot: &WaylandWindowSnapshot,
    client_rect: LogicalRect,
    layout: &ComputedDecorationTree,
    buffers: &[CachedDecorationBuffer],
) {
    let slot_rect = layout.window_slot_rect();
    let root_rect = layout.root.rect;

    debug!(
        reason,
        window_id = snapshot.id,
        title = snapshot.title,
        app_id = snapshot.app_id,
        focused = snapshot.is_focused,
        client_rect = %format_rect(client_rect),
        root_rect = %format_rect(root_rect),
        slot_rect = slot_rect
            .map(format_rect)
            .unwrap_or_else(|| "<missing>".to_string()),
        root_to_client_left = client_rect.x - root_rect.x,
        root_to_client_top = client_rect.y - root_rect.y,
        client_to_root_right = (root_rect.x + root_rect.width) - (client_rect.x + client_rect.width),
        client_to_root_bottom = (root_rect.y + root_rect.height) - (client_rect.y + client_rect.height),
        buffer_count = buffers.len(),
        "updated window decoration layout"
    );

    if gap_debug_layout_enabled() {
        log_gap_layout_tree(snapshot, client_rect, layout);
    }

    for (index, buffer) in buffers.iter().enumerate() {
        trace!(
            reason,
            window_id = snapshot.id,
            index,
            rect = %format_rect(buffer.rect),
            color = %format_color(buffer.color),
            radius = buffer.radius,
            border_width = buffer.border_width,
            hole_rect = buffer
                .hole_rect
                .map(format_rect)
                .unwrap_or_else(|| "<none>".to_string()),
            hole_radius = buffer.hole_radius,
            clip_rect = buffer
                .clip_rect
                .map(format_rect)
                .unwrap_or_else(|| "<none>".to_string()),
            source_kind = buffer.source_kind,
            "cached decoration buffer"
        );
    }
}

fn format_rect(rect: LogicalRect) -> String {
    format!(
        "x={}, y={}, w={}, h={}",
        rect.x, rect.y, rect.width, rect.height
    )
}

fn format_color(color: super::Color) -> String {
    format!("rgba({}, {}, {}, {})", color.r, color.g, color.b, color.a)
}

fn window_snapshot_requires_rebuild(
    previous: &WaylandWindowSnapshot,
    next: &WaylandWindowSnapshot,
) -> bool {
    previous.id != next.id
        || previous.title != next.title
        || previous.app_id != next.app_id
        || previous.is_floating != next.is_floating
        || previous.is_maximized != next.is_maximized
        || previous.is_fullscreen != next.is_fullscreen
        || previous.is_xwayland != next.is_xwayland
        || previous.icon != next.icon
}

fn window_snapshot_requires_runtime_refresh(
    previous: &WaylandWindowSnapshot,
    next: &WaylandWindowSnapshot,
) -> bool {
    previous.is_focused != next.is_focused || previous.interaction != next.interaction
}

fn push_damage_pair(
    damage: &mut Vec<LogicalRect>,
    old_rect: Option<LogicalRect>,
    new_rect: LogicalRect,
) {
    if let Some(old_rect) = old_rect {
        if old_rect != new_rect {
            damage.push(old_rect);
        }
    }
    damage.push(new_rect);
}

fn runtime_dirty_damage_rects(
    previous_buffers: &[CachedDecorationBuffer],
    next_buffers: &[CachedDecorationBuffer],
    previous_shader_buffers: &[CachedShaderEffect],
    next_shader_buffers: &[CachedShaderEffect],
    previous_text_buffers: &[CachedDecorationLabel],
    next_text_buffers: &[CachedDecorationLabel],
    previous_icon_buffers: &[CachedDecorationIcon],
    next_icon_buffers: &[CachedDecorationIcon],
) -> Vec<LogicalRect> {
    let mut damage = Vec::new();

    collect_keyed_rect_damage(
        previous_buffers.iter().map(|item| {
            (
                item.stable_key.clone(),
                (
                    item.rect,
                    format!(
                        "{:?}:{:?}:{}:{}:{:?}:{}:{:?}:{}",
                        item.color,
                        item.source_kind,
                        item.radius,
                        item.border_width,
                        item.hole_rect,
                        item.hole_radius,
                        item.clip_rect,
                        item.clip_radius
                    ),
                ),
            )
        }),
        next_buffers.iter().map(|item| {
            (
                item.stable_key.clone(),
                (
                    item.rect,
                    format!(
                        "{:?}:{:?}:{}:{}:{:?}:{}:{:?}:{}",
                        item.color,
                        item.source_kind,
                        item.radius,
                        item.border_width,
                        item.hole_rect,
                        item.hole_radius,
                        item.clip_rect,
                        item.clip_radius
                    ),
                ),
            )
        }),
        &mut damage,
    );
    collect_keyed_rect_damage(
        previous_shader_buffers.iter().map(|item| {
            (
                item.stable_key.clone(),
                (item.rect, format!("{:?}", item.shader)),
            )
        }),
        next_shader_buffers.iter().map(|item| {
            (
                item.stable_key.clone(),
                (item.rect, format!("{:?}", item.shader)),
            )
        }),
        &mut damage,
    );
    collect_keyed_rect_damage(
        previous_text_buffers.iter().map(|item| {
            (
                format!(
                    "text:{}:{}:{}:{}:{}:{}",
                    item.order,
                    item.rect.x,
                    item.rect.y,
                    item.rect.width,
                    item.rect.height,
                    item.text
                ),
                (item.rect, format!("{:?}", item.color)),
            )
        }),
        next_text_buffers.iter().map(|item| {
            (
                format!(
                    "text:{}:{}:{}:{}:{}:{}",
                    item.order,
                    item.rect.x,
                    item.rect.y,
                    item.rect.width,
                    item.rect.height,
                    item.text
                ),
                (item.rect, format!("{:?}", item.color)),
            )
        }),
        &mut damage,
    );
    collect_keyed_rect_damage(
        previous_icon_buffers.iter().map(|item| {
            (
                format!(
                    "icon:{}:{}:{}:{}:{}",
                    item.order, item.rect.x, item.rect.y, item.rect.width, item.rect.height
                ),
                (item.rect, String::new()),
            )
        }),
        next_icon_buffers.iter().map(|item| {
            (
                format!(
                    "icon:{}:{}:{}:{}:{}",
                    item.order, item.rect.x, item.rect.y, item.rect.width, item.rect.height
                ),
                (item.rect, String::new()),
            )
        }),
        &mut damage,
    );

    damage
}

fn runtime_dirty_node_damage_rects(
    previous_layout: &ComputedDecorationTree,
    previous_transform: WindowTransform,
    next_layout: &ComputedDecorationTree,
    next_transform: WindowTransform,
    dirty_node_ids: &[String],
) -> Vec<LogicalRect> {
    let node_id_set = dirty_node_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut previous_rects = Vec::new();
    let mut next_rects = Vec::new();
    collect_dirty_scope_rects(&previous_layout.root, &node_id_set, &mut previous_rects);
    collect_dirty_scope_rects(&next_layout.root, &node_id_set, &mut next_rects);

    let mut damage = Vec::new();
    for rect in previous_rects {
        damage.push(transformed_root_rect(rect, previous_transform));
    }
    for rect in next_rects {
        damage.push(transformed_root_rect(rect, next_transform));
    }
    damage
}

fn collect_dirty_scope_rects(
    node: &super::ComputedDecorationNode,
    dirty_node_ids: &std::collections::HashSet<&str>,
    rects: &mut Vec<LogicalRect>,
) {
    if node
        .stable_id
        .as_deref()
        .is_some_and(|stable_id| node_id_matches_dirty_scope(stable_id, dirty_node_ids))
    {
        rects.push(node.rect);
    }

    for child in &node.children {
        collect_dirty_scope_rects(child, dirty_node_ids, rects);
    }
}

fn freeze_manual_shader_buffers(
    previous_shader_buffers: &[CachedShaderEffect],
    next_shader_buffers: &mut [CachedShaderEffect],
) {
    let previous_by_key = previous_shader_buffers
        .iter()
        .map(|item| (item.stable_key.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();

    for next in next_shader_buffers.iter_mut() {
        let Some(previous) = previous_by_key.get(next.stable_key.as_str()) else {
            continue;
        };
        if matches!(
            next.shader.invalidate_policy(),
            crate::ssd::EffectInvalidationPolicy::Manual {
                dirty_when: false,
                ..
            }
        ) {
            let invalidate = next.shader.invalidate.clone();
            next.shader = previous.shader.clone();
            next.shader.invalidate = invalidate;
        }
    }
}

fn should_process_window_for_refresh(
    primary_output_name: Option<&str>,
    target_output_name: Option<&str>,
    force_async_asset_refresh: bool,
    force_output_animation_reevaluate: bool,
    force_runtime_reevaluate: bool,
    window_was_runtime_dirty: bool,
) -> bool {
    if force_async_asset_refresh
        || force_output_animation_reevaluate
        || force_runtime_reevaluate
        || window_was_runtime_dirty
    {
        return true;
    }

    target_output_name
        .is_none_or(|target_output_name| primary_output_name == Some(target_output_name))
}

fn collect_keyed_rect_damage<K>(
    previous: impl IntoIterator<Item = (K, (LogicalRect, String))>,
    next: impl IntoIterator<Item = (K, (LogicalRect, String))>,
    damage: &mut Vec<LogicalRect>,
) where
    K: Eq + std::hash::Hash + Clone,
{
    let previous_map: std::collections::HashMap<K, (LogicalRect, String)> =
        previous.into_iter().collect();
    let next_map: std::collections::HashMap<K, (LogicalRect, String)> = next.into_iter().collect();

    for (key, (old_rect, old_sig)) in &previous_map {
        match next_map.get(key) {
            Some((new_rect, new_sig)) if new_rect == old_rect && new_sig == old_sig => {}
            Some((new_rect, _)) => {
                damage.push(*old_rect);
                damage.push(*new_rect);
            }
            None => damage.push(*old_rect),
        }
    }

    for (key, (new_rect, _)) in &next_map {
        if !previous_map.contains_key(key) {
            damage.push(*new_rect);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssd::{
        BorderStyle, BoxNode, Color, DecorationNode, DecorationNodeKind, DecorationStyle, Edges,
        LayoutDirection, Overflow, StylePosition,
    };

    #[test]
    fn managed_rect_rounding_preserves_opposite_edges() {
        let rect = managed_rect_snapshot_to_logical_rect(ManagedWindowRectSnapshot {
            x: 10.4,
            y: 20.4,
            width: 99.4,
            height: 79.4,
        });

        assert_eq!(rect.x, 10);
        assert_eq!(rect.y, 20);
        assert_eq!(rect.x + rect.width, 110);
        assert_eq!(rect.y + rect.height, 100);
    }

    #[test]
    fn async_asset_refresh_processes_windows_outside_target_output() {
        assert!(should_process_window_for_refresh(
            Some("eDP-1"),
            Some("DP-4"),
            true,
            false,
            false,
            false,
        ));
        assert!(!should_process_window_for_refresh(
            Some("eDP-1"),
            Some("DP-4"),
            false,
            false,
            false,
            false,
        ));
        assert!(should_process_window_for_refresh(
            Some("eDP-1"),
            Some("DP-4"),
            false,
            true,
            false,
            false,
        ));
        assert!(should_process_window_for_refresh(
            Some("eDP-1"),
            Some("DP-4"),
            false,
            false,
            false,
            true,
        ));
        assert!(should_process_window_for_refresh(
            Some("eDP-1"),
            Some("DP-4"),
            false,
            false,
            true,
            false,
        ));
        assert!(should_process_window_for_refresh(
            Some("DP-4"),
            Some("DP-4"),
            false,
            false,
            false,
            false,
        ));
    }

    #[test]
    fn dirty_scope_matches_descendant_node_ids() {
        let dirty = ["root.Box[0]"]
            .into_iter()
            .collect::<std::collections::HashSet<_>>();

        assert!(node_id_matches_dirty_scope("root.Box[0]", &dirty));
        assert!(node_id_matches_dirty_scope(
            "root.Box[0].Button[1].Image[0]",
            &dirty
        ));
        assert!(!node_id_matches_dirty_scope("root.Box[1].Image[0]", &dirty));
        assert!(!node_id_matches_dirty_scope(
            "root.Box[0-extra].Image[0]",
            &dirty
        ));
    }

    #[test]
    fn layout_for_client_aligns_window_slot_with_client_rect() {
        let tree = DecorationTree::new(
            DecorationNode::new(DecorationNodeKind::WindowBorder)
                .with_style(DecorationStyle {
                    border: Some(BorderStyle {
                        width: 1,
                        color: Color::WHITE,
                    }),
                    ..Default::default()
                })
                .with_children(vec![
                    DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                        direction: LayoutDirection::Column,
                    }))
                    .with_children(vec![
                        DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                            direction: LayoutDirection::Row,
                        }))
                        .with_style(DecorationStyle {
                            height: Some(30),
                            ..Default::default()
                        }),
                        DecorationNode::new(DecorationNodeKind::WindowSlot),
                    ]),
                ]),
        );

        let layout = tree
            .layout_for_client(LogicalRect::new(50, 100, 800, 600))
            .expect("layout should succeed");

        assert_eq!(
            layout.window_slot_rect(),
            Some(LogicalRect::new(50, 100, 800, 600))
        );
    }

    #[test]
    fn layout_for_client_does_not_expand_root_for_absolute_titlebar_overflow() {
        let titlebar_overlay = DecorationNode::new(DecorationNodeKind::Box(BoxNode {
            direction: LayoutDirection::Row,
        }))
        .with_style(DecorationStyle {
            position: Some(StylePosition::Relative),
            padding: Edges {
                left: 12,
                right: 12,
                ..Default::default()
            },
            ..Default::default()
        })
        .with_children(vec![
            DecorationNode::new(DecorationNodeKind::Box(BoxNode::default())).with_style(
                DecorationStyle {
                    width: Some(10),
                    height: Some(18),
                    margin: Edges {
                        left: 32,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            ),
            DecorationNode::new(DecorationNodeKind::Box(BoxNode::default())).with_style(
                DecorationStyle {
                    position: Some(StylePosition::Absolute),
                    width: Some(96),
                    height: Some(18),
                    ..Default::default()
                },
            ),
        ]);
        let tree = DecorationTree::new(
            DecorationNode::new(DecorationNodeKind::WindowBorder)
                .with_style(DecorationStyle {
                    border: Some(BorderStyle {
                        width: 2,
                        color: Color::WHITE,
                    }),
                    ..Default::default()
                })
                .with_children(vec![
                    DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                        direction: LayoutDirection::Column,
                    }))
                    .with_children(vec![
                        DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                            direction: LayoutDirection::Row,
                        }))
                        .with_style(DecorationStyle {
                            height: Some(30),
                            padding: Edges {
                                left: 8,
                                right: 8,
                                ..Default::default()
                            },
                            gap: Some(8),
                            ..Default::default()
                        })
                        .with_children(vec![
                            DecorationNode::new(DecorationNodeKind::Box(BoxNode::default()))
                                .with_style(DecorationStyle {
                                    flex_grow: Some(1.0),
                                    ..Default::default()
                                }),
                            titlebar_overlay,
                        ]),
                        DecorationNode::new(DecorationNodeKind::WindowSlot),
                    ]),
                ]),
        );

        let client_rect = LogicalRect::new(50, 100, 200, 120);
        let layout = tree
            .layout_for_client(client_rect)
            .expect("layout should succeed");

        assert_eq!(layout.window_slot_rect(), Some(client_rect));
        assert_eq!(layout.root.rect.x, client_rect.x - 2);
        assert_eq!(
            layout.root.rect.x + layout.root.rect.width,
            client_rect.x + client_rect.width + 2
        );
        assert!(layout.bounds_rect().width > layout.root.rect.width);
    }

    #[test]
    fn content_clip_matches_window_slot_not_border_inner() {
        let tree = DecorationTree::new(
            DecorationNode::new(DecorationNodeKind::WindowBorder)
                .with_style(DecorationStyle {
                    border: Some(BorderStyle {
                        width: 2,
                        color: Color::WHITE,
                    }),
                    border_radius: Some(18),
                    ..Default::default()
                })
                .with_children(vec![
                    DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                        direction: LayoutDirection::Column,
                    }))
                    .with_children(vec![
                        DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                            direction: LayoutDirection::Row,
                        }))
                        .with_style(DecorationStyle {
                            height: Some(30),
                            ..Default::default()
                        }),
                        DecorationNode::new(DecorationNodeKind::WindowSlot),
                    ]),
                ]),
        );

        let layout = tree
            .layout_for_client_with_scale(LogicalRect::new(50, 100, 800, 600), 1.25)
            .expect("layout should succeed");
        let slot = layout.window_slot_rect().expect("slot should exist");
        let shared_edges = build_shared_edge_geometry_map(&layout);
        let clip = content_clip_for_layout(&tree, &layout, &shared_edges)
            .expect("content clip should exist");

        assert_eq!(clip.rect.loc.x, slot.x);
        assert_eq!(clip.rect.loc.y, slot.y);
        assert_eq!(clip.rect.size.w, slot.width);
        assert_eq!(clip.rect.size.h, slot.height);
        assert_eq!(clip.radius, 0);
        assert_eq!(clip.radius_precise, 0.0);
        assert!(clip.corner_radii.iter().all(|radius| *radius > 0));
        assert!(clip.corner_radii_precise.iter().all(|radius| *radius > 0.0));
    }

    #[test]
    fn content_clip_keeps_all_shared_corners_when_slot_fills_inner_mask() {
        let tree = DecorationTree::new(
            DecorationNode::new(DecorationNodeKind::WindowBorder)
                .with_style(DecorationStyle {
                    border: Some(BorderStyle {
                        width: 2,
                        color: Color::WHITE,
                    }),
                    border_radius: Some(18),
                    ..Default::default()
                })
                .with_children(vec![DecorationNode::new(DecorationNodeKind::WindowSlot)]),
        );

        let layout = tree
            .layout_for_client_with_scale(LogicalRect::new(50, 100, 800, 600), 1.25)
            .expect("layout should succeed");
        let shared_edges = build_shared_edge_geometry_map(&layout);
        let clip = content_clip_for_layout(&tree, &layout, &shared_edges)
            .expect("content clip should exist");

        assert!(clip.corner_radii.iter().all(|radius| *radius > 0));
        assert!(clip.corner_radii_precise.iter().all(|radius| *radius > 0.0));
    }

    #[test]
    fn content_clip_can_use_rounded_overflow_hidden_box_as_mask() {
        let tree = DecorationTree::new(
            DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                direction: LayoutDirection::Column,
            }))
            .with_style(DecorationStyle {
                overflow: Some(Overflow::Hidden),
                border: Some(BorderStyle {
                    width: 2,
                    color: Color::WHITE,
                }),
                border_radius: Some(18),
                ..Default::default()
            })
            .with_children(vec![DecorationNode::new(DecorationNodeKind::WindowSlot)]),
        );

        let layout = tree
            .layout_for_client_with_scale(LogicalRect::new(50, 100, 800, 600), 1.25)
            .expect("layout should succeed");
        let shared_edges = build_shared_edge_geometry_map(&layout);
        let clip = content_clip_for_layout(&tree, &layout, &shared_edges)
            .expect("content clip should exist");

        assert_eq!(clip.radius, 0);
        assert!(clip.corner_radii.iter().all(|radius| *radius > 0));
        assert!(clip.corner_radii_precise.iter().all(|radius| *radius > 0.0));
    }

    #[test]
    fn content_clip_separates_slot_rect_from_ancestor_mask_through_padding_box() {
        let tree = DecorationTree::new(
            DecorationNode::new(DecorationNodeKind::WindowBorder)
                .with_style(DecorationStyle {
                    border: Some(BorderStyle {
                        width: 2,
                        color: Color::WHITE,
                    }),
                    border_radius: Some(18),
                    ..Default::default()
                })
                .with_children(vec![
                    DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                        direction: LayoutDirection::Column,
                    }))
                    .with_style(DecorationStyle {
                        padding: Edges::all(5),
                        ..Default::default()
                    })
                    .with_children(vec![
                        DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                            direction: LayoutDirection::Row,
                        }))
                        .with_style(DecorationStyle {
                            height: Some(30),
                            ..Default::default()
                        }),
                        DecorationNode::new(DecorationNodeKind::WindowSlot),
                    ]),
                ]),
        );

        let layout = tree
            .layout_for_client_with_scale(LogicalRect::new(50, 100, 800, 600), 1.25)
            .expect("layout should succeed");
        let slot = layout.window_slot_rect().expect("slot should exist");
        let shared_edges = build_shared_edge_geometry_map(&layout);
        let clip = content_clip_for_layout(&tree, &layout, &shared_edges)
            .expect("content clip should exist");

        assert_eq!(clip.rect.loc.x, slot.x);
        assert_eq!(clip.rect.loc.y, slot.y);
        assert_eq!(clip.rect.size.w, slot.width);
        assert_eq!(clip.rect.size.h, slot.height);
        assert!(clip.mask_rect.loc.x < clip.rect.loc.x);
        assert!(clip.mask_rect.loc.y < clip.rect.loc.y);
        assert!(clip.mask_rect.size.w > clip.rect.size.w);
        assert!(clip.mask_rect.size.h > clip.rect.size.h);
        assert!(clip.corner_radii_precise[2] > 0.0);
        assert!(clip.corner_radii_precise[3] > 0.0);
    }

    #[test]
    fn slot_content_clip_uses_nearest_rounded_mask_radius() {
        let rounded_mask = crate::ssd::ResolvedDecorationClip {
            rect: crate::ssd::ResolvedLogicalRect {
                x: crate::ssd::ResolvedLayoutValue::from_raw(100),
                y: crate::ssd::ResolvedLayoutValue::from_raw(200),
                width: crate::ssd::ResolvedLayoutValue::from_raw(1000),
                height: crate::ssd::ResolvedLayoutValue::from_raw(800),
            },
            radius: crate::ssd::ResolvedLayoutValue::from_i32(18),
        };
        let radius = rounded_mask.radius.to_f32();

        assert_eq!([radius; 4], [18.0, 18.0, 18.0, 18.0]);
    }

    #[test]
    fn shared_edge_tree_reuses_parent_content_edges_for_window_border() {
        let tree = DecorationTree::new(
            DecorationNode::new(DecorationNodeKind::WindowBorder)
                .with_style(DecorationStyle {
                    border: Some(BorderStyle {
                        width: 2,
                        color: Color::WHITE,
                    }),
                    ..Default::default()
                })
                .with_children(vec![
                    DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                        direction: LayoutDirection::Column,
                    }))
                    .with_children(vec![DecorationNode::new(DecorationNodeKind::WindowSlot)]),
                ]),
        );

        let layout = tree
            .layout_for_client_with_scale(LogicalRect::new(50, 100, 800, 600), 1.75)
            .expect("layout should succeed");
        let edge_tree = build_shared_edge_tree(&layout);
        let window_border = &edge_tree.root.children[0];

        assert_eq!(edge_tree.root.content_rect.left, window_border.rect.left);
        assert_eq!(edge_tree.root.content_rect.top, window_border.rect.top);
        assert_eq!(edge_tree.root.content_rect.right, window_border.rect.right);
        assert_eq!(
            edge_tree.root.content_rect.bottom,
            window_border.rect.bottom
        );
    }

    #[test]
    fn shared_edge_tree_reuses_box_edges_when_content_matches_rect() {
        let tree = DecorationTree::new(
            DecorationNode::new(DecorationNodeKind::WindowBorder)
                .with_style(DecorationStyle {
                    border: Some(BorderStyle {
                        width: 2,
                        color: Color::WHITE,
                    }),
                    ..Default::default()
                })
                .with_children(vec![
                    DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                        direction: LayoutDirection::Column,
                    }))
                    .with_children(vec![
                        DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                            direction: LayoutDirection::Row,
                        }))
                        .with_style(DecorationStyle {
                            height: Some(30),
                            ..Default::default()
                        }),
                        DecorationNode::new(DecorationNodeKind::WindowSlot),
                    ]),
                ]),
        );

        let layout = tree
            .layout_for_client_with_scale(LogicalRect::new(50, 100, 800, 600), 1.75)
            .expect("layout should succeed");
        let edge_tree = build_shared_edge_tree(&layout);
        let inner_box = &edge_tree.root.children[0];
        let window_slot = &inner_box.children[1];

        assert_eq!(inner_box.rect.left, inner_box.content_rect.left);
        assert_eq!(inner_box.rect.top, inner_box.content_rect.top);
        assert_eq!(inner_box.rect.right, inner_box.content_rect.right);
        assert_eq!(inner_box.rect.bottom, inner_box.content_rect.bottom);

        assert_eq!(inner_box.content_rect.left, window_slot.rect.left);
        assert_eq!(inner_box.content_rect.right, window_slot.rect.right);
    }

    #[test]
    fn shared_edge_tree_reuses_adjacent_row_sibling_boundary() {
        let tree = DecorationTree::new(
            DecorationNode::new(DecorationNodeKind::WindowBorder)
                .with_style(DecorationStyle {
                    border: Some(BorderStyle {
                        width: 2,
                        color: Color::WHITE,
                    }),
                    ..Default::default()
                })
                .with_children(vec![
                    DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                        direction: LayoutDirection::Row,
                    }))
                    .with_children(vec![
                        DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                            direction: LayoutDirection::Column,
                        }))
                        .with_style(DecorationStyle {
                            width: Some(120),
                            ..Default::default()
                        }),
                        DecorationNode::new(DecorationNodeKind::WindowSlot),
                    ]),
                ]),
        );

        let layout = tree
            .layout_for_client_with_scale(LogicalRect::new(50, 100, 800, 600), 1.75)
            .expect("layout should succeed");
        let edge_tree = build_shared_edge_tree(&layout);
        let row_box = &edge_tree.root.children[0];
        let left_box = &row_box.children[0];
        let window_slot = &row_box.children[1];

        assert_eq!(left_box.rect.right, window_slot.rect.left);
        assert_eq!(left_box.rect.top, window_slot.rect.top);
        assert_eq!(left_box.rect.bottom, window_slot.rect.bottom);
    }

    #[test]
    fn shared_edge_tree_reuses_adjacent_column_sibling_boundary() {
        let tree = DecorationTree::new(
            DecorationNode::new(DecorationNodeKind::WindowBorder)
                .with_style(DecorationStyle {
                    border: Some(BorderStyle {
                        width: 2,
                        color: Color::WHITE,
                    }),
                    ..Default::default()
                })
                .with_children(vec![
                    DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                        direction: LayoutDirection::Column,
                    }))
                    .with_children(vec![
                        DecorationNode::new(DecorationNodeKind::Box(BoxNode {
                            direction: LayoutDirection::Row,
                        }))
                        .with_style(DecorationStyle {
                            height: Some(48),
                            ..Default::default()
                        }),
                        DecorationNode::new(DecorationNodeKind::WindowSlot),
                    ]),
                ]),
        );

        let layout = tree
            .layout_for_client_with_scale(LogicalRect::new(50, 100, 800, 600), 1.75)
            .expect("layout should succeed");
        let edge_tree = build_shared_edge_tree(&layout);
        let column_box = &edge_tree.root.children[0];
        let header_box = &column_box.children[0];
        let window_slot = &column_box.children[1];

        assert_eq!(header_box.rect.bottom, window_slot.rect.top);
        assert_eq!(header_box.rect.left, window_slot.rect.left);
        assert_eq!(header_box.rect.right, window_slot.rect.right);
    }
}

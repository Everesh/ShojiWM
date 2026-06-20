use std::{
    ffi::OsString,
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tracing::{debug, error, info, warn};

use super::window_model::{
    GestureSwipeEventSnapshot, GestureSwipePhaseSnapshot, ManagedWindowAnimationSnapshot,
    ManagedWindowState, PointerMoveEventSnapshot, WaylandLayerSnapshot, WaylandOutputSnapshot,
    WaylandPopupSnapshot, WaylandWindowAction, WaylandWindowSnapshot,
    WindowActivateRequestEventSnapshot, WindowFullscreenRequestEventSnapshot,
    WindowMaximizeRequestEventSnapshot, WindowMinimizeRequestEventSnapshot,
    WindowMoveEventSnapshot, WindowResizeEventSnapshot,
};
use super::{
    BackgroundEffectConfig, DecorationBridgeError, DecorationLayoutError, DecorationNode,
    DecorationTree, EffectInput, WindowEffectConfig, WindowTransform, WireCompiledEffect,
    WireWindowEffectConfig, decode_tree_json,
};
use crate::{
    activation_environment::{RuntimeEnvUpdates, apply_runtime_env_updates},
    config::RuntimeDisplayConfigUpdate,
    runtime_debug::RuntimeDebugConfigUpdate,
    runtime_input::{RuntimeInputConfigUpdate, RuntimeInputDeviceSnapshot},
    runtime_key_binding::RuntimeKeyBindingConfigUpdate,
    runtime_pointer::RuntimePointerConfigUpdate,
    runtime_process::{RuntimeProcessAction, RuntimeProcessConfigUpdate},
};
use smithay::reexports::calloop::channel::Sender as CalloopSender;

fn managed_rect_debug_enabled() -> bool {
    std::env::var_os("SHOJI_MANAGED_RECT_DEBUG")
        .is_some_and(|value| value != "0" && !value.is_empty())
}

/// Dynamic decoration evaluation boundary.
///
/// This trait represents the future hand-off point to the Node/TS runtime. For now it allows
/// ShojiWM to build and validate window-aware decoration trees while keeping the dynamic
/// evaluation contract explicit.
pub trait DecorationEvaluator {
    fn evaluate_window(
        &self,
        window: &WaylandWindowSnapshot,
        now_ms: u64,
    ) -> Result<DecorationEvaluationResult, DecorationEvaluationError>;

    fn evaluate_window_preview(
        &self,
        window: &WaylandWindowSnapshot,
        now_ms: u64,
    ) -> Result<DecorationEvaluationResult, DecorationEvaluationError> {
        self.evaluate_window(window, now_ms)
    }

    fn evaluate_cached_window(
        &self,
        _window_id: &str,
        _window: Option<&WaylandWindowSnapshot>,
        _now_ms: u64,
        _force_full_reevaluation: bool,
    ) -> Result<DecorationCachedEvaluationResult, DecorationEvaluationError> {
        Err(DecorationEvaluationError::RuntimeProtocol(
            "cached window evaluation unsupported".into(),
        ))
    }

    fn scheduler_tick(
        &self,
        _now_ms: u64,
    ) -> Result<DecorationSchedulerTick, DecorationEvaluationError> {
        Ok(DecorationSchedulerTick::default())
    }

    fn window_closed(&self, _window_id: &str) -> Result<(), DecorationEvaluationError> {
        Ok(())
    }

    fn invoke_handler(
        &self,
        _window_id: &str,
        _handler_id: &str,
        _now_ms: u64,
    ) -> Result<DecorationHandlerInvocation, DecorationEvaluationError> {
        Ok(DecorationHandlerInvocation::default())
    }

    fn start_close(
        &self,
        _window_id: &str,
        _now_ms: u64,
    ) -> Result<DecorationHandlerInvocation, DecorationEvaluationError> {
        Ok(DecorationHandlerInvocation::default())
    }

    fn invoke_key_binding(
        &self,
        _binding_id: &str,
        _now_ms: u64,
    ) -> Result<DecorationKeyBindingInvocation, DecorationEvaluationError> {
        Ok(DecorationKeyBindingInvocation::default())
    }

    fn window_resize(
        &self,
        _window_id: &str,
        _event: &WindowResizeEventSnapshot,
        _now_ms: u64,
    ) -> Result<DecorationWindowResizeInvocation, DecorationEvaluationError> {
        Ok(DecorationWindowResizeInvocation::default())
    }

    fn window_move(
        &self,
        _window_id: &str,
        _event: &WindowMoveEventSnapshot,
        _now_ms: u64,
    ) -> Result<DecorationWindowMoveInvocation, DecorationEvaluationError> {
        Ok(DecorationWindowMoveInvocation::default())
    }

    fn window_maximize_request(
        &self,
        _snapshot: &WaylandWindowSnapshot,
        _event: &WindowMaximizeRequestEventSnapshot,
        _now_ms: u64,
    ) -> Result<DecorationWindowStateRequestInvocation, DecorationEvaluationError> {
        Ok(DecorationWindowStateRequestInvocation::default())
    }

    fn window_minimize_request(
        &self,
        _snapshot: &WaylandWindowSnapshot,
        _event: &WindowMinimizeRequestEventSnapshot,
        _now_ms: u64,
    ) -> Result<DecorationWindowStateRequestInvocation, DecorationEvaluationError> {
        Ok(DecorationWindowStateRequestInvocation::default())
    }

    fn window_fullscreen_request(
        &self,
        _snapshot: &WaylandWindowSnapshot,
        _event: &WindowFullscreenRequestEventSnapshot,
        _now_ms: u64,
    ) -> Result<DecorationWindowStateRequestInvocation, DecorationEvaluationError> {
        Ok(DecorationWindowStateRequestInvocation::default())
    }

    fn window_activate_request(
        &self,
        _snapshot: &WaylandWindowSnapshot,
        _event: &WindowActivateRequestEventSnapshot,
        _now_ms: u64,
    ) -> Result<DecorationWindowStateRequestInvocation, DecorationEvaluationError> {
        Ok(DecorationWindowStateRequestInvocation::default())
    }

    fn pointer_move_async(&self, _event: PointerMoveEventSnapshot, _now_ms: u64) {}

    fn gesture_swipe_async(&self, _event: GestureSwipeEventSnapshot, _now_ms: u64) {}

    fn evaluate_layer_effects(
        &self,
        _output_name: &str,
        _layers: &[WaylandLayerSnapshot],
        _now_ms: u64,
    ) -> Result<LayerEffectEvaluationResult, DecorationEvaluationError> {
        Ok(LayerEffectEvaluationResult::default())
    }

    fn evaluate_popup_effects(
        &self,
        _output_name: &str,
        _popups: &[WaylandPopupSnapshot],
        _now_ms: u64,
    ) -> Result<PopupEffectEvaluationResult, DecorationEvaluationError> {
        Ok(PopupEffectEvaluationResult::default())
    }
}

#[derive(Debug, Clone)]
pub struct DecorationEvaluationResult {
    pub node: DecorationNode,
    pub transform: WindowTransform,
    pub managed_window: ManagedWindowState,
    pub window_effects: Option<WindowEffectConfig>,
    pub dirty_node_ids: Vec<String>,
    pub next_poll_in_ms: Option<u64>,
    /// Window actions (typically scheduleAnimation / cancelAnimation) queued
    /// by user handlers during this evaluation. Returned in-band so the
    /// compositor can apply them *before* sampling animations for the same
    /// refresh — fixing the one-frame flash at the static target position
    /// before open / first-commit animations kick in.
    pub actions: Vec<RuntimeWindowAction>,
    pub display_config: Option<RuntimeDisplayConfigUpdate>,
    pub key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    pub pointer_config: Option<RuntimePointerConfigUpdate>,
    pub input_config: Option<RuntimeInputConfigUpdate>,
    pub event_config: Option<RuntimeEventConfigUpdate>,
    pub process_config: Option<RuntimeProcessConfigUpdate>,
    pub process_actions: Vec<RuntimeProcessAction>,
}

#[derive(Debug, Clone)]
pub struct DecorationCachedEvaluationResult {
    pub node: Option<DecorationNode>,
    pub transform: WindowTransform,
    pub managed_window: ManagedWindowState,
    pub window_effects: Option<WindowEffectConfig>,
    pub dirty_node_ids: Vec<String>,
    pub managed_window_only: bool,
    pub next_poll_in_ms: Option<u64>,
    /// See `DecorationEvaluationResult::actions`. Same role on the cached path.
    pub actions: Vec<RuntimeWindowAction>,
    pub display_config: Option<RuntimeDisplayConfigUpdate>,
    pub key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    pub pointer_config: Option<RuntimePointerConfigUpdate>,
    pub input_config: Option<RuntimeInputConfigUpdate>,
    pub event_config: Option<RuntimeEventConfigUpdate>,
    pub process_config: Option<RuntimeProcessConfigUpdate>,
    pub process_actions: Vec<RuntimeProcessAction>,
}

impl From<DecorationEvaluationResult> for DecorationCachedEvaluationResult {
    fn from(result: DecorationEvaluationResult) -> Self {
        Self {
            node: Some(result.node),
            transform: result.transform,
            managed_window: result.managed_window,
            window_effects: result.window_effects,
            dirty_node_ids: result.dirty_node_ids,
            managed_window_only: false,
            next_poll_in_ms: result.next_poll_in_ms,
            actions: result.actions,
            display_config: result.display_config,
            key_binding_config: result.key_binding_config,
            pointer_config: result.pointer_config,
            input_config: result.input_config,
            event_config: result.event_config,
            process_config: result.process_config,
            process_actions: result.process_actions,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct DecorationSchedulerTick {
    pub dirty: bool,
    pub dirty_window_ids: Vec<String>,
    pub dirty_managed_window_ids: Vec<String>,
    pub dirty_window_node_ids: std::collections::HashMap<String, Vec<String>>,
    pub dirty_layer_node_ids: std::collections::HashMap<String, Vec<String>>,
    pub actions: Vec<RuntimeWindowAction>,
    pub next_poll_in_ms: Option<u64>,
    pub display_config: Option<RuntimeDisplayConfigUpdate>,
    pub key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    pub pointer_config: Option<RuntimePointerConfigUpdate>,
    pub input_config: Option<RuntimeInputConfigUpdate>,
    pub event_config: Option<RuntimeEventConfigUpdate>,
    pub process_config: Option<RuntimeProcessConfigUpdate>,
    pub process_actions: Vec<RuntimeProcessAction>,
    pub debug_config: Option<RuntimeDebugConfigUpdate>,
}

#[derive(Debug, Clone, Default)]
pub struct DecorationHandlerInvocation {
    pub invoked: bool,
    pub node: Option<DecorationNode>,
    pub transform: Option<WindowTransform>,
    pub managed_window: Option<ManagedWindowState>,
    pub window_effects: Option<WindowEffectConfig>,
    pub dirty_window_ids: Vec<String>,
    pub dirty_managed_window_ids: Vec<String>,
    pub dirty_window_node_ids: std::collections::HashMap<String, Vec<String>>,
    pub actions: Vec<RuntimeWindowAction>,
    pub next_poll_in_ms: Option<u64>,
    pub display_config: Option<RuntimeDisplayConfigUpdate>,
    pub key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    pub pointer_config: Option<RuntimePointerConfigUpdate>,
    pub input_config: Option<RuntimeInputConfigUpdate>,
    pub event_config: Option<RuntimeEventConfigUpdate>,
    pub process_config: Option<RuntimeProcessConfigUpdate>,
    pub process_actions: Vec<RuntimeProcessAction>,
}

#[derive(Debug, Clone, Default)]
pub struct DecorationKeyBindingInvocation {
    pub invoked: bool,
    pub dirty: bool,
    pub dirty_window_ids: Vec<String>,
    pub dirty_managed_window_ids: Vec<String>,
    pub dirty_window_node_ids: std::collections::HashMap<String, Vec<String>>,
    pub dirty_layer_node_ids: std::collections::HashMap<String, Vec<String>>,
    pub actions: Vec<RuntimeWindowAction>,
    pub next_poll_in_ms: Option<u64>,
    pub display_config: Option<RuntimeDisplayConfigUpdate>,
    pub key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    pub pointer_config: Option<RuntimePointerConfigUpdate>,
    pub input_config: Option<RuntimeInputConfigUpdate>,
    pub event_config: Option<RuntimeEventConfigUpdate>,
    pub process_config: Option<RuntimeProcessConfigUpdate>,
    pub process_actions: Vec<RuntimeProcessAction>,
}

#[derive(Debug, Clone, Default)]
pub struct DecorationWindowResizeInvocation {
    pub invoked: bool,
    pub dirty: bool,
    pub dirty_window_ids: Vec<String>,
    pub dirty_managed_window_ids: Vec<String>,
    pub dirty_window_node_ids: std::collections::HashMap<String, Vec<String>>,
    pub dirty_layer_node_ids: std::collections::HashMap<String, Vec<String>>,
    pub actions: Vec<RuntimeWindowAction>,
    pub next_poll_in_ms: Option<u64>,
    pub display_config: Option<RuntimeDisplayConfigUpdate>,
    pub key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    pub pointer_config: Option<RuntimePointerConfigUpdate>,
    pub input_config: Option<RuntimeInputConfigUpdate>,
    pub event_config: Option<RuntimeEventConfigUpdate>,
    pub process_config: Option<RuntimeProcessConfigUpdate>,
    pub process_actions: Vec<RuntimeProcessAction>,
}

#[derive(Debug, Clone, Default)]
pub struct DecorationWindowMoveInvocation {
    pub invoked: bool,
    pub dirty: bool,
    pub dirty_window_ids: Vec<String>,
    pub dirty_managed_window_ids: Vec<String>,
    pub dirty_window_node_ids: std::collections::HashMap<String, Vec<String>>,
    pub dirty_layer_node_ids: std::collections::HashMap<String, Vec<String>>,
    pub actions: Vec<RuntimeWindowAction>,
    pub next_poll_in_ms: Option<u64>,
    pub display_config: Option<RuntimeDisplayConfigUpdate>,
    pub key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    pub pointer_config: Option<RuntimePointerConfigUpdate>,
    pub input_config: Option<RuntimeInputConfigUpdate>,
    pub event_config: Option<RuntimeEventConfigUpdate>,
    pub process_config: Option<RuntimeProcessConfigUpdate>,
    pub process_actions: Vec<RuntimeProcessAction>,
}

#[derive(Debug, Clone, Default)]
pub struct DecorationWindowStateRequestInvocation {
    pub invoked: bool,
    pub dirty: bool,
    pub dirty_window_ids: Vec<String>,
    pub dirty_managed_window_ids: Vec<String>,
    pub dirty_window_node_ids: std::collections::HashMap<String, Vec<String>>,
    pub dirty_layer_node_ids: std::collections::HashMap<String, Vec<String>>,
    pub actions: Vec<RuntimeWindowAction>,
    pub next_poll_in_ms: Option<u64>,
    pub display_config: Option<RuntimeDisplayConfigUpdate>,
    pub key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    pub pointer_config: Option<RuntimePointerConfigUpdate>,
    pub input_config: Option<RuntimeInputConfigUpdate>,
    pub event_config: Option<RuntimeEventConfigUpdate>,
    pub process_config: Option<RuntimeProcessConfigUpdate>,
    pub process_actions: Vec<RuntimeProcessAction>,
}

#[derive(Debug, Clone, Default)]
pub struct DecorationPointerMoveAsyncInvocation {
    pub invoked: bool,
    pub dirty: bool,
    pub dirty_window_ids: Vec<String>,
    pub dirty_managed_window_ids: Vec<String>,
    pub dirty_window_node_ids: std::collections::HashMap<String, Vec<String>>,
    pub dirty_layer_node_ids: std::collections::HashMap<String, Vec<String>>,
    pub actions: Vec<RuntimeWindowAction>,
    pub next_poll_in_ms: Option<u64>,
    pub display_config: Option<RuntimeDisplayConfigUpdate>,
    pub key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    pub pointer_config: Option<RuntimePointerConfigUpdate>,
    pub input_config: Option<RuntimeInputConfigUpdate>,
    pub event_config: Option<RuntimeEventConfigUpdate>,
    pub process_config: Option<RuntimeProcessConfigUpdate>,
    pub process_actions: Vec<RuntimeProcessAction>,
}

pub type DecorationGestureSwipeAsyncInvocation = DecorationPointerMoveAsyncInvocation;

#[derive(Debug, Clone)]
pub enum DecorationRuntimeAsyncInvocation {
    PointerMove(DecorationPointerMoveAsyncInvocation),
    GestureSwipe(DecorationGestureSwipeAsyncInvocation),
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventConfigUpdate {
    pub pointer_move_async: bool,
    #[serde(default)]
    pub gesture_swipe_async: bool,
}

#[derive(Debug, Clone, Default)]
pub struct LayerEffectEvaluationResult {
    pub effects: Vec<RuntimeLayerEffectAssignment>,
    pub next_poll_in_ms: Option<u64>,
    pub display_config: Option<RuntimeDisplayConfigUpdate>,
    pub key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    pub pointer_config: Option<RuntimePointerConfigUpdate>,
    pub input_config: Option<RuntimeInputConfigUpdate>,
    pub event_config: Option<RuntimeEventConfigUpdate>,
    pub process_config: Option<RuntimeProcessConfigUpdate>,
    pub process_actions: Vec<RuntimeProcessAction>,
}

#[derive(Debug, Clone)]
pub struct RuntimeLayerEffectAssignment {
    pub layer_id: String,
    pub effects: Option<WindowEffectConfig>,
}

#[derive(Debug, Clone, Default)]
pub struct PopupEffectEvaluationResult {
    pub effects: Vec<RuntimePopupEffectAssignment>,
    pub next_poll_in_ms: Option<u64>,
    pub display_config: Option<RuntimeDisplayConfigUpdate>,
    pub key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    pub pointer_config: Option<RuntimePointerConfigUpdate>,
    pub input_config: Option<RuntimeInputConfigUpdate>,
    pub event_config: Option<RuntimeEventConfigUpdate>,
    pub process_config: Option<RuntimeProcessConfigUpdate>,
    pub process_actions: Vec<RuntimeProcessAction>,
}

#[derive(Debug, Clone)]
pub struct RuntimePopupEffectAssignment {
    pub popup_id: String,
    pub effects: Option<WindowEffectConfig>,
}

fn validate_popup_effect_config(
    effects: WindowEffectConfig,
) -> Result<WindowEffectConfig, DecorationBridgeError> {
    let is_popup_source =
        |slot: &super::WindowEffectSlot| matches!(slot.effect.input, EffectInput::PopupSource(_));
    // `behind` additionally accepts backdrop inputs that can be resolved from
    // the framebuffer at draw time. They may sample a pre-captured popup
    // source, but not xray/window/layer sources: popups render inline with
    // their parent's element stream, so there is no offline scene capture.
    if effects.behind.as_ref().is_some_and(|slot| {
        !is_popup_source(slot) && !slot.effect.supports_popup_framebuffer_backdrop()
    }) || effects
        .behind_root_surface
        .as_ref()
        .is_some_and(|slot| !is_popup_source(slot))
        || effects
            .in_front
            .as_ref()
            .is_some_and(|slot| !is_popup_source(slot))
        || effects
            .replace
            .as_ref()
            .is_some_and(|slot| !is_popup_source(slot))
    {
        return Err(DecorationBridgeError::InvalidEffectInput);
    }
    Ok(effects)
}

fn validate_layer_effect_config(
    effects: WindowEffectConfig,
) -> Result<WindowEffectConfig, DecorationBridgeError> {
    let is_layer_source =
        |slot: &super::WindowEffectSlot| matches!(slot.effect.input, EffectInput::LayerSource(_));
    if effects
        .behind
        .as_ref()
        .is_some_and(|slot| !is_layer_source(slot) && !slot.effect.is_backdrop())
        || effects
            .behind_root_surface
            .as_ref()
            .is_some_and(|slot| !is_layer_source(slot))
        || effects
            .in_front
            .as_ref()
            .is_some_and(|slot| !is_layer_source(slot))
        || effects
            .replace
            .as_ref()
            .is_some_and(|slot| !is_layer_source(slot))
    {
        return Err(DecorationBridgeError::InvalidEffectInput);
    }
    Ok(effects)
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct RuntimeWindowAction {
    #[serde(rename = "windowId")]
    pub window_id: String,
    pub action: WaylandWindowAction,
    #[serde(default)]
    pub animation: Option<ManagedWindowAnimationSnapshot>,
    #[serde(default)]
    pub channel: Option<String>,
}

/// Temporary Rust-side evaluator that mirrors the intended TS-level behavior:
///
/// - focused windows get a yellow border
/// - unfocused windows get a white border
/// - title is reflected into a label node
///
/// This exists only to establish the per-window reevaluation flow for milestone 3.
#[derive(Debug, Default, Clone, Copy)]
pub struct StaticDecorationEvaluator;

impl DecorationEvaluator for StaticDecorationEvaluator {
    fn evaluate_window(
        &self,
        window: &WaylandWindowSnapshot,
        _now_ms: u64,
    ) -> Result<DecorationEvaluationResult, DecorationEvaluationError> {
        let border_color = if window.is_focused {
            "#ffff00"
        } else {
            "#ffffff"
        };

        let json = format!(
            r##"{{
                "kind": "WindowBorder",
                "props": {{
                    "style": {{
                        "border": {{ "px": 1, "color": "{border_color}" }}
                    }}
                }},
                "children": [
                    {{
                        "kind": "Box",
                        "props": {{
                            "direction": "column"
                        }},
                        "children": [
                            {{
                                "kind": "Box",
                                "props": {{
                                    "direction": "row",
                                    "style": {{
                                        "height": 28,
                                        "paddingX": 8,
                                        "gap": 8
                                    }}
                                }},
                                "children": [
                                    {{
                                        "kind": "Label",
                                        "props": {{
                                            "text": {title:?}
                                        }},
                                        "children": []
                                    }},
                                    {{
                                        "kind": "Box",
                                        "props": {{
                                            "style": {{ "flexGrow": 1 }}
                                        }},
                                        "children": []
                                    }},
                                    {{
                                        "kind": "Button",
                                        "props": {{
                                            "onClick": "close"
                                        }},
                                        "children": []
                                    }}
                                ]
                            }},
                            {{
                                "kind": "Window",
                                "props": {{}},
                                "children": []
                            }}
                        ]
                    }}
                ]
            }}"##,
            title = window.title,
        );

        Ok(DecorationEvaluationResult {
            node: decode_tree_json(&json)?,
            transform: WindowTransform::default(),
            managed_window: ManagedWindowState::default(),
            window_effects: None,
            dirty_node_ids: Vec::new(),
            next_poll_in_ms: None,
            actions: Vec::new(),
            display_config: None,
            key_binding_config: None,
            pointer_config: None,
            input_config: None,
            event_config: None,
            process_config: None,
            process_actions: Vec::new(),
        })
    }
}

pub fn evaluate_dynamic_decoration<E: DecorationEvaluator>(
    evaluator: &E,
    window: &WaylandWindowSnapshot,
    now_ms: u64,
) -> Result<DecorationTree, DecorationEvaluationError> {
    evaluator
        .evaluate_window(window, now_ms)
        .map(|result| DecorationTree::new(result.node))
}

#[derive(Debug, thiserror::Error)]
pub enum DecorationEvaluationError {
    #[error(transparent)]
    Bridge(#[from] DecorationBridgeError),
    #[error("failed to compute decoration layout: {0:?}")]
    Layout(DecorationLayoutError),
    #[error("failed to serialize window snapshot for evaluation: {0}")]
    SnapshotSerialization(String),
    #[error("failed to execute decoration runtime: {0}")]
    Io(#[from] std::io::Error),
    #[error("decoration runtime exited with status {status}: {stderr}")]
    RuntimeFailed { status: i32, stderr: String },
    #[error("decoration runtime returned invalid utf-8 output")]
    InvalidUtf8,
    #[error("decoration runtime returned invalid json: {0}")]
    InvalidResponse(String),
    #[error("decoration runtime protocol error: {0}")]
    RuntimeProtocol(String),
}

pub struct NodeDecorationEvaluator {
    program: PathBuf,
    base_args: Vec<OsString>,
    script_path: PathBuf,
    config_path: PathBuf,
    working_dir: Option<PathBuf>,
    transport: RuntimeTransportKind,
    runtime: Arc<Mutex<Option<NodeDecorationRuntime>>>,
    display_state: Arc<Mutex<std::collections::BTreeMap<String, WaylandOutputSnapshot>>>,
    input_state: Arc<Mutex<std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>>>,
    pointer_move_async: Arc<PointerMoveAsyncDispatcher>,
    async_event_sender: Arc<Mutex<Option<CalloopSender<DecorationRuntimeAsyncInvocation>>>>,
}

#[derive(Debug)]
enum RuntimeAsyncWork {
    PointerMove {
        event: PointerMoveEventSnapshot,
        now_ms: u64,
    },
    GestureSwipe {
        event: GestureSwipeEventSnapshot,
        now_ms: u64,
    },
}

#[derive(Debug, Default)]
struct PointerMoveAsyncDispatcher {
    pending: Mutex<Option<RuntimeAsyncWork>>,
    pending_changed: Condvar,
    worker_started: AtomicBool,
}

struct NodeDecorationRuntime {
    child: Child,
    connection: RuntimeConnection,
    next_request_id: u64,
    stderr_log: Arc<Mutex<String>>,
}

enum RuntimeConnection {
    Stdio {
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
    },
    Uds {
        writer: UnixStream,
        reader: BufReader<UnixStream>,
        socket_path: PathBuf,
    },
}

#[derive(Debug, Clone, Copy)]
enum RuntimeTransportKind {
    Stdio,
    Uds,
}

#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum RuntimeRequest<'a> {
    DrainPreload {
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    Evaluate {
        #[serde(rename = "requestId")]
        request_id: u64,
        snapshot: &'a WaylandWindowSnapshot,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    EvaluatePreview {
        #[serde(rename = "requestId")]
        request_id: u64,
        snapshot: &'a WaylandWindowSnapshot,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    SchedulerTick {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    WindowClosed {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "windowId")]
        window_id: &'a str,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    InvokeHandler {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "windowId")]
        window_id: &'a str,
        #[serde(rename = "handlerId")]
        handler_id: &'a str,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    InvokeKeyBinding {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "bindingId")]
        binding_id: &'a str,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    WindowResize {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "windowId")]
        window_id: &'a str,
        event: &'a WindowResizeEventSnapshot,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    WindowMove {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "windowId")]
        window_id: &'a str,
        event: &'a WindowMoveEventSnapshot,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    WindowMaximizeRequest {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "windowId")]
        window_id: &'a str,
        snapshot: &'a WaylandWindowSnapshot,
        event: &'a WindowMaximizeRequestEventSnapshot,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    WindowMinimizeRequest {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "windowId")]
        window_id: &'a str,
        snapshot: &'a WaylandWindowSnapshot,
        event: &'a WindowMinimizeRequestEventSnapshot,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    WindowFullscreenRequest {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "windowId")]
        window_id: &'a str,
        snapshot: &'a WaylandWindowSnapshot,
        event: &'a WindowFullscreenRequestEventSnapshot,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    WindowActivateRequest {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "windowId")]
        window_id: &'a str,
        snapshot: &'a WaylandWindowSnapshot,
        event: &'a WindowActivateRequestEventSnapshot,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    PointerMoveAsync {
        #[serde(rename = "requestId")]
        request_id: u64,
        event: &'a PointerMoveEventSnapshot,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    GestureSwipeAsync {
        #[serde(rename = "requestId")]
        request_id: u64,
        event: &'a GestureSwipeEventSnapshot,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    StartClose {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "windowId")]
        window_id: &'a str,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    EvaluateCached {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "windowId")]
        window_id: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        snapshot: Option<&'a WaylandWindowSnapshot>,
        #[serde(rename = "forceFullReevaluation")]
        force_full_reevaluation: bool,
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    GetEffectConfig {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    EvaluateLayerEffects {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "outputName")]
        output_name: &'a str,
        layers: &'a [WaylandLayerSnapshot],
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    EvaluatePopupEffects {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(rename = "outputName")]
        output_name: &'a str,
        popups: &'a [WaylandPopupSnapshot],
        #[serde(rename = "nowMs")]
        now_ms: u64,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    LifecycleEnable {
        #[serde(rename = "requestId")]
        request_id: u64,
        reason: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<&'a serde_json::Value>,
        environment: &'a std::collections::BTreeMap<String, String>,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
    LifecycleDisable {
        #[serde(rename = "requestId")]
        request_id: u64,
        reason: &'a str,
        #[serde(rename = "displayState")]
        display_state: &'a std::collections::BTreeMap<String, WaylandOutputSnapshot>,
        #[serde(rename = "inputState")]
        input_state: &'a std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    },
}

#[derive(serde::Deserialize)]
struct RuntimeEvaluateResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    ok: bool,
    serialized: Option<serde_json::Value>,
    transform: Option<WindowTransform>,
    #[serde(rename = "managedWindow")]
    managed_window: Option<ManagedWindowState>,
    #[serde(rename = "windowEffects")]
    window_effects: Option<WireWindowEffectConfig>,
    #[serde(rename = "dirtyNodeIds")]
    dirty_node_ids: Option<Vec<String>>,
    #[serde(rename = "managedWindowOnly")]
    managed_window_only: Option<bool>,
    #[serde(rename = "nextPollInMs")]
    next_poll_in_ms: Option<u64>,
    actions: Option<Vec<RuntimeWindowAction>>,
    #[serde(rename = "displayConfig")]
    display_config: Option<RuntimeDisplayConfigUpdate>,
    #[serde(rename = "keyBindingConfig")]
    key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    #[serde(rename = "pointerConfig")]
    pointer_config: Option<RuntimePointerConfigUpdate>,
    #[serde(rename = "inputConfig")]
    input_config: Option<RuntimeInputConfigUpdate>,
    #[serde(rename = "eventConfig")]
    event_config: Option<RuntimeEventConfigUpdate>,
    #[serde(rename = "processConfig")]
    process_config: Option<RuntimeProcessConfigUpdate>,
    #[serde(rename = "processActions")]
    process_actions: Option<Vec<RuntimeProcessAction>>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RuntimeDrainPreloadResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    ok: bool,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RuntimeSchedulerResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    ok: bool,
    dirty: Option<bool>,
    #[serde(rename = "dirtyWindowIds")]
    dirty_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyManagedWindowIds")]
    dirty_managed_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyWindowNodeIds")]
    dirty_window_node_ids: Option<std::collections::HashMap<String, Vec<String>>>,
    #[serde(rename = "dirtyLayerNodeIds")]
    dirty_layer_node_ids: Option<std::collections::HashMap<String, Vec<String>>>,
    actions: Option<Vec<RuntimeWindowAction>>,
    #[serde(rename = "nextPollInMs")]
    next_poll_in_ms: Option<u64>,
    #[serde(rename = "displayConfig")]
    display_config: Option<RuntimeDisplayConfigUpdate>,
    #[serde(rename = "keyBindingConfig")]
    key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    #[serde(rename = "pointerConfig")]
    pointer_config: Option<RuntimePointerConfigUpdate>,
    #[serde(rename = "inputConfig")]
    input_config: Option<RuntimeInputConfigUpdate>,
    #[serde(rename = "eventConfig")]
    event_config: Option<RuntimeEventConfigUpdate>,
    #[serde(rename = "processConfig")]
    process_config: Option<RuntimeProcessConfigUpdate>,
    #[serde(rename = "processActions")]
    process_actions: Option<Vec<RuntimeProcessAction>>,
    #[serde(rename = "debugConfig")]
    debug_config: Option<RuntimeDebugConfigUpdate>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RuntimeClosedResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    ok: bool,
    #[serde(rename = "displayConfig")]
    _display_config: Option<RuntimeDisplayConfigUpdate>,
    #[serde(rename = "keyBindingConfig")]
    _key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    #[serde(rename = "pointerConfig")]
    _pointer_config: Option<RuntimePointerConfigUpdate>,
    #[serde(rename = "inputConfig")]
    _input_config: Option<RuntimeInputConfigUpdate>,
    #[serde(rename = "eventConfig")]
    _event_config: Option<RuntimeEventConfigUpdate>,
    #[serde(rename = "processConfig")]
    _process_config: Option<RuntimeProcessConfigUpdate>,
    #[serde(rename = "processActions")]
    _process_actions: Option<Vec<RuntimeProcessAction>>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RuntimeInvokeHandlerResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    ok: bool,
    invoked: Option<bool>,
    serialized: Option<serde_json::Value>,
    transform: Option<WindowTransform>,
    #[serde(rename = "managedWindow")]
    managed_window: Option<ManagedWindowState>,
    #[serde(rename = "windowEffects")]
    window_effects: Option<WireWindowEffectConfig>,
    #[serde(rename = "dirtyWindowIds")]
    dirty_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyManagedWindowIds")]
    dirty_managed_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyWindowNodeIds")]
    dirty_window_node_ids: Option<std::collections::HashMap<String, Vec<String>>>,
    actions: Option<Vec<RuntimeWindowAction>>,
    #[serde(rename = "nextPollInMs")]
    next_poll_in_ms: Option<u64>,
    #[serde(rename = "displayConfig")]
    display_config: Option<RuntimeDisplayConfigUpdate>,
    #[serde(rename = "keyBindingConfig")]
    key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    #[serde(rename = "pointerConfig")]
    pointer_config: Option<RuntimePointerConfigUpdate>,
    #[serde(rename = "inputConfig")]
    input_config: Option<RuntimeInputConfigUpdate>,
    #[serde(rename = "eventConfig")]
    event_config: Option<RuntimeEventConfigUpdate>,
    #[serde(rename = "processConfig")]
    process_config: Option<RuntimeProcessConfigUpdate>,
    #[serde(rename = "processActions")]
    process_actions: Option<Vec<RuntimeProcessAction>>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RuntimeStartCloseResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    ok: bool,
    invoked: Option<bool>,
    serialized: Option<serde_json::Value>,
    transform: Option<WindowTransform>,
    #[serde(rename = "managedWindow")]
    managed_window: Option<ManagedWindowState>,
    #[serde(rename = "windowEffects")]
    window_effects: Option<WireWindowEffectConfig>,
    #[serde(rename = "dirtyWindowIds")]
    dirty_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyManagedWindowIds")]
    dirty_managed_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyWindowNodeIds")]
    dirty_window_node_ids: Option<std::collections::HashMap<String, Vec<String>>>,
    actions: Option<Vec<RuntimeWindowAction>>,
    #[serde(rename = "nextPollInMs")]
    next_poll_in_ms: Option<u64>,
    #[serde(rename = "displayConfig")]
    display_config: Option<RuntimeDisplayConfigUpdate>,
    #[serde(rename = "keyBindingConfig")]
    key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    #[serde(rename = "pointerConfig")]
    pointer_config: Option<RuntimePointerConfigUpdate>,
    #[serde(rename = "inputConfig")]
    input_config: Option<RuntimeInputConfigUpdate>,
    #[serde(rename = "eventConfig")]
    event_config: Option<RuntimeEventConfigUpdate>,
    #[serde(rename = "processConfig")]
    process_config: Option<RuntimeProcessConfigUpdate>,
    #[serde(rename = "processActions")]
    process_actions: Option<Vec<RuntimeProcessAction>>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RuntimeEffectConfigResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    ok: bool,
    #[serde(rename = "backgroundEffect")]
    background_effect: Option<WireCompiledEffect>,
    #[serde(rename = "displayConfig")]
    _display_config: Option<RuntimeDisplayConfigUpdate>,
    #[serde(rename = "keyBindingConfig")]
    _key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    #[serde(rename = "pointerConfig")]
    _pointer_config: Option<RuntimePointerConfigUpdate>,
    #[serde(rename = "inputConfig")]
    _input_config: Option<RuntimeInputConfigUpdate>,
    #[serde(rename = "processConfig")]
    _process_config: Option<RuntimeProcessConfigUpdate>,
    #[serde(rename = "processActions")]
    _process_actions: Option<Vec<RuntimeProcessAction>>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RuntimeLayerEffectAssignmentResponse {
    #[serde(rename = "layerId")]
    layer_id: String,
    effects: Option<WireWindowEffectConfig>,
}

#[derive(serde::Deserialize)]
struct RuntimePopupEffectAssignmentResponse {
    #[serde(rename = "popupId")]
    popup_id: String,
    effects: Option<WireWindowEffectConfig>,
}

#[derive(serde::Deserialize)]
struct RuntimePopupEffectsResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    ok: bool,
    effects: Option<Vec<RuntimePopupEffectAssignmentResponse>>,
    #[serde(rename = "nextPollInMs")]
    next_poll_in_ms: Option<u64>,
    #[serde(rename = "displayConfig")]
    display_config: Option<RuntimeDisplayConfigUpdate>,
    #[serde(rename = "keyBindingConfig")]
    key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    #[serde(rename = "pointerConfig")]
    pointer_config: Option<RuntimePointerConfigUpdate>,
    #[serde(rename = "inputConfig")]
    input_config: Option<RuntimeInputConfigUpdate>,
    #[serde(rename = "eventConfig")]
    event_config: Option<RuntimeEventConfigUpdate>,
    #[serde(rename = "processConfig")]
    process_config: Option<RuntimeProcessConfigUpdate>,
    #[serde(rename = "processActions")]
    process_actions: Option<Vec<RuntimeProcessAction>>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RuntimeLayerEffectsResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    ok: bool,
    effects: Option<Vec<RuntimeLayerEffectAssignmentResponse>>,
    #[serde(rename = "nextPollInMs")]
    next_poll_in_ms: Option<u64>,
    #[serde(rename = "displayConfig")]
    display_config: Option<RuntimeDisplayConfigUpdate>,
    #[serde(rename = "keyBindingConfig")]
    key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    #[serde(rename = "pointerConfig")]
    pointer_config: Option<RuntimePointerConfigUpdate>,
    #[serde(rename = "inputConfig")]
    input_config: Option<RuntimeInputConfigUpdate>,
    #[serde(rename = "eventConfig")]
    event_config: Option<RuntimeEventConfigUpdate>,
    #[serde(rename = "processConfig")]
    process_config: Option<RuntimeProcessConfigUpdate>,
    #[serde(rename = "processActions")]
    process_actions: Option<Vec<RuntimeProcessAction>>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RuntimeLifecycleEnableResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: Option<String>,
    ok: bool,
    #[serde(rename = "displayConfig")]
    display_config: Option<RuntimeDisplayConfigUpdate>,
    #[serde(rename = "keyBindingConfig")]
    key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    #[serde(rename = "pointerConfig")]
    pointer_config: Option<RuntimePointerConfigUpdate>,
    #[serde(rename = "inputConfig")]
    input_config: Option<RuntimeInputConfigUpdate>,
    #[serde(rename = "eventConfig")]
    event_config: Option<RuntimeEventConfigUpdate>,
    #[serde(rename = "processConfig")]
    process_config: Option<RuntimeProcessConfigUpdate>,
    #[serde(rename = "processActions")]
    process_actions: Option<Vec<RuntimeProcessAction>>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RuntimeLifecycleDisableResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: Option<String>,
    ok: bool,
    #[serde(default)]
    state: serde_json::Value,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RuntimeInvokeKeyBindingResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    ok: bool,
    invoked: Option<bool>,
    dirty: Option<bool>,
    #[serde(rename = "dirtyWindowIds")]
    dirty_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyManagedWindowIds")]
    dirty_managed_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyWindowNodeIds")]
    dirty_window_node_ids: Option<std::collections::HashMap<String, Vec<String>>>,
    #[serde(rename = "dirtyLayerNodeIds")]
    dirty_layer_node_ids: Option<std::collections::HashMap<String, Vec<String>>>,
    actions: Option<Vec<RuntimeWindowAction>>,
    #[serde(rename = "nextPollInMs")]
    next_poll_in_ms: Option<u64>,
    #[serde(rename = "displayConfig")]
    display_config: Option<RuntimeDisplayConfigUpdate>,
    #[serde(rename = "keyBindingConfig")]
    key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    #[serde(rename = "pointerConfig")]
    pointer_config: Option<RuntimePointerConfigUpdate>,
    #[serde(rename = "inputConfig")]
    input_config: Option<RuntimeInputConfigUpdate>,
    #[serde(rename = "eventConfig")]
    event_config: Option<RuntimeEventConfigUpdate>,
    #[serde(rename = "processConfig")]
    process_config: Option<RuntimeProcessConfigUpdate>,
    #[serde(rename = "processActions")]
    process_actions: Option<Vec<RuntimeProcessAction>>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RuntimeWindowResizeResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    ok: bool,
    invoked: Option<bool>,
    dirty: Option<bool>,
    #[serde(rename = "dirtyWindowIds")]
    dirty_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyManagedWindowIds")]
    dirty_managed_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyWindowNodeIds")]
    dirty_window_node_ids: Option<std::collections::HashMap<String, Vec<String>>>,
    #[serde(rename = "dirtyLayerNodeIds")]
    dirty_layer_node_ids: Option<std::collections::HashMap<String, Vec<String>>>,
    actions: Option<Vec<RuntimeWindowAction>>,
    #[serde(rename = "nextPollInMs")]
    next_poll_in_ms: Option<u64>,
    #[serde(rename = "displayConfig")]
    display_config: Option<RuntimeDisplayConfigUpdate>,
    #[serde(rename = "keyBindingConfig")]
    key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    #[serde(rename = "pointerConfig")]
    pointer_config: Option<RuntimePointerConfigUpdate>,
    #[serde(rename = "inputConfig")]
    input_config: Option<RuntimeInputConfigUpdate>,
    #[serde(rename = "eventConfig")]
    event_config: Option<RuntimeEventConfigUpdate>,
    #[serde(rename = "processConfig")]
    process_config: Option<RuntimeProcessConfigUpdate>,
    #[serde(rename = "processActions")]
    process_actions: Option<Vec<RuntimeProcessAction>>,
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RuntimeWindowMoveResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    ok: bool,
    invoked: Option<bool>,
    dirty: Option<bool>,
    #[serde(rename = "dirtyWindowIds")]
    dirty_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyManagedWindowIds")]
    dirty_managed_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyWindowNodeIds")]
    dirty_window_node_ids: Option<std::collections::HashMap<String, Vec<String>>>,
    #[serde(rename = "dirtyLayerNodeIds")]
    dirty_layer_node_ids: Option<std::collections::HashMap<String, Vec<String>>>,
    actions: Option<Vec<RuntimeWindowAction>>,
    #[serde(rename = "nextPollInMs")]
    next_poll_in_ms: Option<u64>,
    #[serde(rename = "displayConfig")]
    display_config: Option<RuntimeDisplayConfigUpdate>,
    #[serde(rename = "keyBindingConfig")]
    key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    #[serde(rename = "pointerConfig")]
    pointer_config: Option<RuntimePointerConfigUpdate>,
    #[serde(rename = "inputConfig")]
    input_config: Option<RuntimeInputConfigUpdate>,
    #[serde(rename = "eventConfig")]
    event_config: Option<RuntimeEventConfigUpdate>,
    #[serde(rename = "processConfig")]
    process_config: Option<RuntimeProcessConfigUpdate>,
    #[serde(rename = "processActions")]
    process_actions: Option<Vec<RuntimeProcessAction>>,
    error: Option<String>,
}

type RuntimeWindowStateRequestResponse = RuntimeWindowMoveResponse;

#[derive(serde::Deserialize)]
struct RuntimePointerMoveAsyncResponse {
    #[serde(rename = "requestId")]
    request_id: u64,
    kind: String,
    ok: bool,
    invoked: Option<bool>,
    dirty: Option<bool>,
    #[serde(rename = "dirtyWindowIds")]
    dirty_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyManagedWindowIds")]
    dirty_managed_window_ids: Option<Vec<String>>,
    #[serde(rename = "dirtyWindowNodeIds")]
    dirty_window_node_ids: Option<std::collections::HashMap<String, Vec<String>>>,
    #[serde(rename = "dirtyLayerNodeIds")]
    dirty_layer_node_ids: Option<std::collections::HashMap<String, Vec<String>>>,
    actions: Option<Vec<RuntimeWindowAction>>,
    #[serde(rename = "nextPollInMs")]
    next_poll_in_ms: Option<u64>,
    #[serde(rename = "displayConfig")]
    display_config: Option<RuntimeDisplayConfigUpdate>,
    #[serde(rename = "keyBindingConfig")]
    key_binding_config: Option<RuntimeKeyBindingConfigUpdate>,
    #[serde(rename = "pointerConfig")]
    pointer_config: Option<RuntimePointerConfigUpdate>,
    #[serde(rename = "inputConfig")]
    input_config: Option<RuntimeInputConfigUpdate>,
    #[serde(rename = "eventConfig")]
    event_config: Option<RuntimeEventConfigUpdate>,
    #[serde(rename = "processConfig")]
    process_config: Option<RuntimeProcessConfigUpdate>,
    #[serde(rename = "processActions")]
    process_actions: Option<Vec<RuntimeProcessAction>>,
    error: Option<String>,
}

type RuntimeGestureSwipeAsyncResponse = RuntimePointerMoveAsyncResponse;

impl std::fmt::Debug for NodeDecorationEvaluator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeDecorationEvaluator")
            .field("program", &self.program)
            .field("base_args", &self.base_args)
            .field("script_path", &self.script_path)
            .field("config_path", &self.config_path)
            .field("working_dir", &self.working_dir)
            .finish()
    }
}

impl NodeDecorationEvaluator {
    pub fn for_workspace(config_path: impl Into<PathBuf>) -> Self {
        let config_path = config_path.into();
        let local_tsx = PathBuf::from("node_modules/.bin/tsx");
        let program = if local_tsx.exists() {
            local_tsx
        } else {
            PathBuf::from("tsx")
        };

        Self {
            program,
            base_args: Vec::new(),
            script_path: PathBuf::from("tools/decoration-runtime.ts"),
            config_path,
            working_dir: None,
            transport: RuntimeTransportKind::Uds,
            runtime: Arc::new(Mutex::new(None)),
            display_state: Arc::new(Mutex::new(std::collections::BTreeMap::new())),
            input_state: Arc::new(Mutex::new(std::collections::BTreeMap::new())),
            pointer_move_async: Arc::new(PointerMoveAsyncDispatcher::default()),
            async_event_sender: Arc::new(Mutex::new(None)),
        }
    }

    pub fn for_paths(
        program: impl Into<PathBuf>,
        script_path: impl Into<PathBuf>,
        config_path: impl Into<PathBuf>,
    ) -> Self {
        Self {
            program: program.into(),
            base_args: Vec::new(),
            script_path: script_path.into(),
            config_path: config_path.into(),
            working_dir: None,
            transport: RuntimeTransportKind::Uds,
            runtime: Arc::new(Mutex::new(None)),
            display_state: Arc::new(Mutex::new(std::collections::BTreeMap::new())),
            input_state: Arc::new(Mutex::new(std::collections::BTreeMap::new())),
            pointer_move_async: Arc::new(PointerMoveAsyncDispatcher::default()),
            async_event_sender: Arc::new(Mutex::new(None)),
        }
    }

    pub fn with_working_dir(mut self, working_dir: impl Into<PathBuf>) -> Self {
        self.working_dir = Some(working_dir.into());
        self
    }

    pub fn with_command(
        program: impl Into<PathBuf>,
        base_args: Vec<OsString>,
        script_path: impl Into<PathBuf>,
        config_path: impl Into<PathBuf>,
    ) -> Self {
        Self {
            program: program.into(),
            base_args,
            script_path: script_path.into(),
            config_path: config_path.into(),
            working_dir: None,
            transport: RuntimeTransportKind::Stdio,
            runtime: Arc::new(Mutex::new(None)),
            display_state: Arc::new(Mutex::new(std::collections::BTreeMap::new())),
            input_state: Arc::new(Mutex::new(std::collections::BTreeMap::new())),
            pointer_move_async: Arc::new(PointerMoveAsyncDispatcher::default()),
            async_event_sender: Arc::new(Mutex::new(None)),
        }
    }

    fn apply_runtime_wake_pid_to_command(&self, command: &mut Command) {
        // Communicate our PID to the runtime so its IPC handlers can send
        // SIGUSR1 here to wake the compositor loop. tsx forks a child node and
        // does not pass extra inherited fds, so the only reliable cross-wrapper
        // wake channel is a signal.
        command.env("SHOJI_RUNTIME_WAKE_PID", std::process::id().to_string());
    }

    pub fn set_async_event_sender(&self, sender: CalloopSender<DecorationRuntimeAsyncInvocation>) {
        if let Ok(mut guard) = self.async_event_sender.lock() {
            *guard = Some(sender);
        }
    }

    pub fn set_display_state(
        &self,
        display_state: std::collections::BTreeMap<String, WaylandOutputSnapshot>,
    ) {
        if let Ok(mut guard) = self.display_state.lock() {
            *guard = display_state;
        }
    }

    pub fn set_input_state(
        &self,
        input_state: std::collections::BTreeMap<String, RuntimeInputDeviceSnapshot>,
    ) {
        if let Ok(mut guard) = self.input_state.lock() {
            *guard = input_state;
        }
    }

    pub fn fresh_like(&self) -> Self {
        Self {
            program: self.program.clone(),
            base_args: self.base_args.clone(),
            script_path: self.script_path.clone(),
            config_path: self.config_path.clone(),
            working_dir: self.working_dir.clone(),
            transport: self.transport,
            runtime: Arc::new(Mutex::new(None)),
            display_state: Arc::new(Mutex::new(
                self.display_state
                    .lock()
                    .map(|guard| guard.clone())
                    .unwrap_or_default(),
            )),
            input_state: Arc::new(Mutex::new(
                self.input_state
                    .lock()
                    .map(|guard| guard.clone())
                    .unwrap_or_default(),
            )),
            pointer_move_async: Arc::new(PointerMoveAsyncDispatcher::default()),
            async_event_sender: Arc::new(Mutex::new(
                self.async_event_sender
                    .lock()
                    .ok()
                    .and_then(|guard| guard.clone()),
            )),
        }
    }

    pub fn preload(&self) -> Result<(), DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;
        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let request = serde_json::to_string(&RuntimeRequest::DrainPreload { request_id })
            .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeDrainPreloadResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }
        if response.kind != "drainPreload" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for drainPreload: {}",
                response.kind
            )));
        }
        Ok(())
    }

    pub fn lifecycle_enable(
        &self,
        reason: &str,
        state: Option<&serde_json::Value>,
    ) -> Result<DecorationHandlerInvocation, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;
        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let environment = runtime_environment_snapshot();

        let request = serde_json::to_string(&RuntimeRequest::LifecycleEnable {
            request_id,
            reason,
            state,
            environment: &environment,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeLifecycleEnableResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }
        if response.kind.as_deref() != Some("lifecycleEnable") {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for lifecycleEnable: {}",
                response.kind.as_deref().unwrap_or("<missing>")
            )));
        }

        Ok(DecorationHandlerInvocation {
            invoked: true,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
            ..DecorationHandlerInvocation::default()
        })
    }

    pub fn lifecycle_disable(
        &self,
        reason: &str,
    ) -> Result<serde_json::Value, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;
        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::LifecycleDisable {
            request_id,
            reason,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeLifecycleDisableResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }
        if response.kind.as_deref() != Some("lifecycleDisable") {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for lifecycleDisable: {}",
                response.kind.as_deref().unwrap_or("<missing>")
            )));
        }

        Ok(response.state)
    }

    fn ensure_runtime<'a>(
        &'a self,
        runtime: &'a mut Option<NodeDecorationRuntime>,
    ) -> Result<&'a mut NodeDecorationRuntime, DecorationEvaluationError> {
        if runtime.is_none() {
            *runtime = Some(match self.transport {
                RuntimeTransportKind::Stdio => self.spawn_stdio_runtime()?,
                RuntimeTransportKind::Uds => self.spawn_uds_runtime()?,
            });
        }

        runtime
            .as_mut()
            .ok_or_else(|| DecorationEvaluationError::RuntimeProtocol("runtime unavailable".into()))
    }

    fn spawn_stdio_runtime(&self) -> Result<NodeDecorationRuntime, DecorationEvaluationError> {
        let mut command = Command::new(&self.program);
        apply_decoration_runtime_node_options(&mut command);
        command.args(&self.base_args);
        command.arg(&self.script_path);
        command.arg(&self.config_path);
        if let Some(cwd) = &self.working_dir {
            command.current_dir(cwd);
        }
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        self.apply_runtime_wake_pid_to_command(&mut command);

        let mut child = command.spawn()?;
        let stderr_log = spawn_stderr_drain(&mut child);
        let stdin = child.stdin.take().ok_or_else(|| {
            DecorationEvaluationError::RuntimeProtocol("missing runtime stdin".into())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            DecorationEvaluationError::RuntimeProtocol("missing runtime stdout".into())
        })?;

        Ok(NodeDecorationRuntime {
            child,
            connection: RuntimeConnection::Stdio {
                stdin,
                stdout: BufReader::new(stdout),
            },
            next_request_id: 1,
            stderr_log,
        })
    }

    fn spawn_uds_runtime(&self) -> Result<NodeDecorationRuntime, DecorationEvaluationError> {
        debug!("spawning node decoration runtime over uds");
        let socket_path = std::env::temp_dir().join(format!(
            "shojiwm-decoration-runtime-{}-{}.sock",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path)?;
        listener.set_nonblocking(true)?;

        let mut command = Command::new(&self.program);
        apply_decoration_runtime_node_options(&mut command);
        command.args(&self.base_args);
        command.arg(&self.script_path);
        command.arg(&self.config_path);
        command.arg(&socket_path);
        if let Some(cwd) = &self.working_dir {
            command.current_dir(cwd);
        }
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::piped());
        self.apply_runtime_wake_pid_to_command(&mut command);

        let mut child = command.spawn()?;
        let stderr_log = spawn_stderr_drain(&mut child);
        let accept_started_at = Instant::now();
        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if let Some(status) = child.try_wait()? {
                        let status = status.code().unwrap_or(-1);
                        let stderr = stderr_log
                            .lock()
                            .map(|stderr| stderr.clone())
                            .unwrap_or_default();
                        let _ = std::fs::remove_file(&socket_path);
                        return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
                    }

                    if accept_started_at.elapsed() > Duration::from_secs(5) {
                        let _ = child.kill();
                        let _ = child.wait();
                        let _ = std::fs::remove_file(&socket_path);
                        return Err(DecorationEvaluationError::RuntimeProtocol(
                            "timed out waiting for decoration runtime socket".into(),
                        ));
                    }

                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = std::fs::remove_file(&socket_path);
                    return Err(DecorationEvaluationError::Io(error));
                }
            }
        };
        let writer = stream.try_clone()?;

        Ok(NodeDecorationRuntime {
            child,
            connection: RuntimeConnection::Uds {
                writer,
                reader: BufReader::new(stream),
                socket_path,
            },
            next_request_id: 1,
            stderr_log,
        })
    }

    pub fn background_effect_config(
        &self,
    ) -> Result<Option<BackgroundEffectConfig>, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;
        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::GetEffectConfig {
            request_id,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeEffectConfigResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "getEffectConfig" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for getEffectConfig: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        response
            .background_effect
            .map(TryInto::try_into)
            .transpose()
            .map_err(DecorationEvaluationError::Bridge)
    }

    fn enqueue_pointer_move_async(&self, event: PointerMoveEventSnapshot, now_ms: u64) {
        self.ensure_pointer_move_async_worker();
        if let Ok(mut pending) = self.pointer_move_async.pending.lock() {
            if matches!(
                pending.as_ref(),
                Some(RuntimeAsyncWork::GestureSwipe {
                    event: GestureSwipeEventSnapshot {
                        phase: GestureSwipePhaseSnapshot::End | GestureSwipePhaseSnapshot::Cancel,
                        ..
                    },
                    ..
                })
            ) {
                return;
            }
            *pending = Some(RuntimeAsyncWork::PointerMove { event, now_ms });
            self.pointer_move_async.pending_changed.notify_one();
        }
    }

    fn enqueue_gesture_swipe_async(&self, event: GestureSwipeEventSnapshot, now_ms: u64) {
        self.ensure_pointer_move_async_worker();
        if let Ok(mut pending) = self.pointer_move_async.pending.lock() {
            *pending = Some(RuntimeAsyncWork::GestureSwipe { event, now_ms });
            self.pointer_move_async.pending_changed.notify_one();
        }
    }

    fn ensure_pointer_move_async_worker(&self) {
        if self
            .pointer_move_async
            .worker_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        let evaluator = self.clone();
        let spawn_result = std::thread::Builder::new()
            .name("shojiwm-pointer-move-async".into())
            .spawn(move || evaluator.run_pointer_move_async_worker());
        if let Err(error) = spawn_result {
            self.pointer_move_async
                .worker_started
                .store(false, Ordering::Release);
            warn!(?error, "failed to spawn pointer move async worker");
        }
    }

    fn run_pointer_move_async_worker(self) {
        loop {
            let work = {
                let mut pending = match self.pointer_move_async.pending.lock() {
                    Ok(pending) => pending,
                    Err(_) => return,
                };
                while pending.is_none() {
                    pending = match self.pointer_move_async.pending_changed.wait(pending) {
                        Ok(pending) => pending,
                        Err(_) => return,
                    };
                }
                pending.take()
            };
            let Some(work) = work else {
                continue;
            };

            let result = match work {
                RuntimeAsyncWork::PointerMove { event, now_ms } => self
                    .dispatch_pointer_move_async(&event, now_ms)
                    .map(|invocation| {
                        invocation.map(DecorationRuntimeAsyncInvocation::PointerMove)
                    }),
                RuntimeAsyncWork::GestureSwipe { event, now_ms } => self
                    .dispatch_gesture_swipe_async(&event, now_ms)
                    .map(|invocation| {
                        invocation.map(DecorationRuntimeAsyncInvocation::GestureSwipe)
                    }),
            };

            match result {
                Ok(Some(invocation)) => {
                    if let Ok(sender_guard) = self.async_event_sender.lock()
                        && let Some(sender) = sender_guard.as_ref()
                    {
                        let _ = sender.send(invocation);
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    debug!(?error, "failed to dispatch runtime async event");
                }
            }
        }
    }

    fn dispatch_pointer_move_async(
        &self,
        event: &PointerMoveEventSnapshot,
        now_ms: u64,
    ) -> Result<Option<DecorationPointerMoveAsyncInvocation>, DecorationEvaluationError> {
        let Ok(mut runtime_guard) = self.runtime.try_lock() else {
            // Pointer motion is lossy by design. If the runtime is handling a synchronous
            // request, dropping this sample is better than blocking input delivery.
            return Ok(None);
        };
        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::PointerMoveAsync {
            request_id,
            event,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimePointerMoveAsyncResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "pointerMoveAsync" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for pointerMoveAsync: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        Ok(Some(DecorationPointerMoveAsyncInvocation {
            invoked: response.invoked.unwrap_or(false),
            dirty: response.dirty.unwrap_or(false),
            dirty_window_ids: response.dirty_window_ids.unwrap_or_default(),
            dirty_managed_window_ids: response.dirty_managed_window_ids.unwrap_or_default(),
            dirty_window_node_ids: response.dirty_window_node_ids.unwrap_or_default(),
            dirty_layer_node_ids: response.dirty_layer_node_ids.unwrap_or_default(),
            actions: response.actions.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        }))
    }

    fn dispatch_gesture_swipe_async(
        &self,
        event: &GestureSwipeEventSnapshot,
        now_ms: u64,
    ) -> Result<Option<DecorationGestureSwipeAsyncInvocation>, DecorationEvaluationError> {
        let Ok(mut runtime_guard) = self.runtime.try_lock() else {
            return Ok(None);
        };
        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::GestureSwipeAsync {
            request_id,
            event,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeGestureSwipeAsyncResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "gestureSwipeAsync" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for gestureSwipeAsync: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        Ok(Some(DecorationGestureSwipeAsyncInvocation {
            invoked: response.invoked.unwrap_or(false),
            dirty: response.dirty.unwrap_or(false),
            dirty_window_ids: response.dirty_window_ids.unwrap_or_default(),
            dirty_managed_window_ids: response.dirty_managed_window_ids.unwrap_or_default(),
            dirty_window_node_ids: response.dirty_window_node_ids.unwrap_or_default(),
            dirty_layer_node_ids: response.dirty_layer_node_ids.unwrap_or_default(),
            actions: response.actions.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        }))
    }
}

impl Clone for NodeDecorationEvaluator {
    fn clone(&self) -> Self {
        Self {
            program: self.program.clone(),
            base_args: self.base_args.clone(),
            script_path: self.script_path.clone(),
            config_path: self.config_path.clone(),
            working_dir: self.working_dir.clone(),
            transport: self.transport,
            runtime: Arc::clone(&self.runtime),
            display_state: Arc::clone(&self.display_state),
            input_state: Arc::clone(&self.input_state),
            pointer_move_async: Arc::clone(&self.pointer_move_async),
            async_event_sender: Arc::clone(&self.async_event_sender),
        }
    }
}

impl NodeDecorationRuntime {
    fn write_request(&mut self, request: &str) -> Result<(), DecorationEvaluationError> {
        let bytes = request.as_bytes();
        let len = u32::try_from(bytes.len()).map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime request too large".into())
        })?;
        record_runtime_protocol_request(request, bytes.len());
        match &mut self.connection {
            RuntimeConnection::Stdio { stdin, .. } => {
                stdin.write_all(&len.to_le_bytes())?;
                stdin.write_all(bytes)?;
                stdin.flush()?;
            }
            RuntimeConnection::Uds { writer, .. } => {
                writer.write_all(&len.to_le_bytes())?;
                writer.write_all(bytes)?;
                writer.flush()?;
            }
        }
        Ok(())
    }

    fn read_response<T: serde::de::DeserializeOwned>(
        &mut self,
    ) -> Result<Option<T>, DecorationEvaluationError> {
        let payload = match &mut self.connection {
            RuntimeConnection::Stdio { stdout, .. } => read_framed_message(stdout)?,
            RuntimeConnection::Uds { reader, .. } => read_framed_message(reader)?,
        };
        let Some(payload) = payload else {
            return Ok(None);
        };
        let value: serde_json::Value = serde_json::from_slice(&payload).map_err(|error| {
            DecorationEvaluationError::InvalidResponse(format!(
                "{error}; payload={}",
                String::from_utf8_lossy(&payload)
            ))
        })?;

        record_runtime_protocol_response(
            value
                .get("kind")
                .and_then(|kind| kind.as_str())
                .unwrap_or("<missing>"),
            payload.len(),
        );

        if let Some(env_updates) = value.get("envUpdates") {
            let env_updates: RuntimeEnvUpdates = serde_json::from_value(env_updates.clone())
                .map_err(|error| {
                    DecorationEvaluationError::InvalidResponse(format!(
                        "invalid envUpdates: {error}; payload={}",
                        String::from_utf8_lossy(&payload)
                    ))
                })?;
            apply_runtime_env_updates(env_updates, "typescript-runtime");
        }

        serde_json::from_value(value).map(Some).map_err(|error| {
            DecorationEvaluationError::InvalidResponse(format!(
                "{error}; payload={}",
                String::from_utf8_lossy(&payload)
            ))
        })
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct RuntimeProtocolCounter {
    count: u64,
    bytes: u64,
}

#[derive(Debug)]
struct RuntimeProtocolStats {
    last_log_at: Instant,
    requests: std::collections::BTreeMap<String, RuntimeProtocolCounter>,
    responses: std::collections::BTreeMap<String, RuntimeProtocolCounter>,
    request_count: u64,
    response_count: u64,
    request_bytes: u64,
    response_bytes: u64,
}

impl RuntimeProtocolStats {
    fn new() -> Self {
        Self {
            last_log_at: Instant::now(),
            requests: std::collections::BTreeMap::new(),
            responses: std::collections::BTreeMap::new(),
            request_count: 0,
            response_count: 0,
            request_bytes: 0,
            response_bytes: 0,
        }
    }

    fn clear_interval(&mut self, now: Instant) {
        self.last_log_at = now;
        self.requests.clear();
        self.responses.clear();
        self.request_count = 0;
        self.response_count = 0;
        self.request_bytes = 0;
        self.response_bytes = 0;
    }
}

fn runtime_protocol_stats_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os("SHOJI_RUNTIME_PROTOCOL_STATS")
            .is_some_and(|value| value != "0" && value != "off" && !value.is_empty())
    })
}

fn record_runtime_protocol_request(payload: &str, bytes: usize) {
    if !runtime_protocol_stats_enabled() {
        return;
    }
    let kind = extract_json_kind(payload).unwrap_or("<missing>");
    record_runtime_protocol_message(RuntimeProtocolDirection::Request, kind, bytes);
}

fn record_runtime_protocol_response(kind: &str, bytes: usize) {
    if !runtime_protocol_stats_enabled() {
        return;
    }
    record_runtime_protocol_message(RuntimeProtocolDirection::Response, kind, bytes);
}

#[derive(Debug, Clone, Copy)]
enum RuntimeProtocolDirection {
    Request,
    Response,
}

fn record_runtime_protocol_message(direction: RuntimeProtocolDirection, kind: &str, bytes: usize) {
    static STATS: OnceLock<Mutex<RuntimeProtocolStats>> = OnceLock::new();
    let stats = STATS.get_or_init(|| Mutex::new(RuntimeProtocolStats::new()));
    let Ok(mut stats) = stats.lock() else {
        return;
    };

    let bytes = bytes as u64;
    match direction {
        RuntimeProtocolDirection::Request => {
            let counter = stats.requests.entry(kind.to_owned()).or_default();
            counter.count = counter.count.saturating_add(1);
            counter.bytes = counter.bytes.saturating_add(bytes);
            stats.request_count = stats.request_count.saturating_add(1);
            stats.request_bytes = stats.request_bytes.saturating_add(bytes);
        }
        RuntimeProtocolDirection::Response => {
            let counter = stats.responses.entry(kind.to_owned()).or_default();
            counter.count = counter.count.saturating_add(1);
            counter.bytes = counter.bytes.saturating_add(bytes);
            stats.response_count = stats.response_count.saturating_add(1);
            stats.response_bytes = stats.response_bytes.saturating_add(bytes);
        }
    }

    let now = Instant::now();
    let interval = now.duration_since(stats.last_log_at);
    if interval < Duration::from_secs(1) {
        return;
    }

    let interval_ms = interval.as_secs_f64() * 1000.0;
    let requests = summarize_runtime_protocol_counters(&stats.requests);
    let responses = summarize_runtime_protocol_counters(&stats.responses);
    info!(
        interval_ms,
        request_count = stats.request_count,
        response_count = stats.response_count,
        request_bytes = stats.request_bytes,
        response_bytes = stats.response_bytes,
        request_rate_hz = stats.request_count as f64 / interval.as_secs_f64(),
        response_rate_hz = stats.response_count as f64 / interval.as_secs_f64(),
        request_kib_per_s = stats.request_bytes as f64 / 1024.0 / interval.as_secs_f64(),
        response_kib_per_s = stats.response_bytes as f64 / 1024.0 / interval.as_secs_f64(),
        requests = ?requests,
        responses = ?responses,
        "runtime protocol stats"
    );
    stats.clear_interval(now);
}

fn summarize_runtime_protocol_counters(
    counters: &std::collections::BTreeMap<String, RuntimeProtocolCounter>,
) -> Vec<(String, u64, u64)> {
    let mut summary = counters
        .iter()
        .map(|(kind, counter)| (kind.clone(), counter.count, counter.bytes))
        .collect::<Vec<_>>();
    summary.sort_by(|left, right| {
        right
            .2
            .cmp(&left.2)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| left.0.cmp(&right.0))
    });
    summary.truncate(12);
    summary
}

fn extract_json_kind(payload: &str) -> Option<&str> {
    let start = payload.find("\"kind\":\"")? + "\"kind\":\"".len();
    let rest = &payload[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn runtime_environment_snapshot() -> std::collections::BTreeMap<String, String> {
    [
        "WAYLAND_DISPLAY",
        "DISPLAY",
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
        "DESKTOP_SESSION",
    ]
    .into_iter()
    .filter_map(|key| std::env::var(key).ok().map(|value| (key.to_owned(), value)))
    .collect()
}

fn apply_decoration_runtime_node_options(command: &mut Command) {
    let extra = std::env::var("SHOJI_DECORATION_RUNTIME_NODE_OPTIONS")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let Some(extra) = extra else {
        return;
    };

    let merged = match std::env::var("NODE_OPTIONS") {
        Ok(existing) if !existing.trim().is_empty() => format!("{} {}", existing.trim(), extra),
        _ => extra,
    };
    command.env("NODE_OPTIONS", merged);
}

impl Drop for NodeDecorationRuntime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let RuntimeConnection::Uds { socket_path, .. } = &self.connection {
            let _ = std::fs::remove_file(socket_path);
        }
    }
}

fn spawn_stderr_drain(child: &mut Child) -> Arc<Mutex<String>> {
    let stderr_log = Arc::new(Mutex::new(String::new()));

    if let Some(stderr) = child.stderr.take() {
        let stderr_log_clone = Arc::clone(&stderr_log);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();

            loop {
                line.clear();
                let Ok(bytes) = reader.read_line(&mut line) else {
                    break;
                };
                if bytes == 0 {
                    break;
                }

                let trimmed = line.trim_end();
                if !trimmed.is_empty() {
                    if let Some(payload) = trimmed.strip_prefix("__SHOJI_RUNTIME_LOG__") {
                        match serde_json::from_str::<RuntimeConsoleLog>(payload) {
                            Ok(log) => match log.level.as_str() {
                                "debug" => {
                                    debug!(target: "shoji_wm::ssd::runtime", message = %log.message, "decoration runtime log");
                                }
                                "info" => {
                                    info!(target: "shoji_wm::ssd::runtime", message = %log.message, "decoration runtime log");
                                }
                                "warn" => {
                                    warn!(target: "shoji_wm::ssd::runtime", message = %log.message, "decoration runtime log");
                                }
                                "error" => {
                                    error!(target: "shoji_wm::ssd::runtime", message = %log.message, "decoration runtime log");
                                }
                                _ => {
                                    info!(target: "shoji_wm::ssd::runtime", message = %log.message, level = %log.level, "decoration runtime log");
                                }
                            },
                            Err(error) => {
                                warn!(
                                    target: "shoji_wm::ssd::runtime",
                                    line = %trimmed,
                                    ?error,
                                    "failed to decode decoration runtime structured log"
                                );
                            }
                        }
                    } else {
                        warn!(target: "shoji_wm::ssd::runtime", line = %trimmed, "decoration runtime stderr");
                    }
                }

                if let Ok(mut log) = stderr_log_clone.lock() {
                    log.push_str(trimmed);
                    log.push('\n');
                    if log.len() > 64 * 1024 {
                        let mut keep_from = log.len().saturating_sub(64 * 1024);
                        while keep_from < log.len() && !log.is_char_boundary(keep_from) {
                            keep_from += 1;
                        }
                        log.drain(..keep_from);
                    }
                }
            }
        });
    }

    stderr_log
}

fn read_framed_message<R: Read>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }

    let payload_len = u32::from_le_bytes(header) as usize;
    const MAX_RUNTIME_MESSAGE_SIZE: usize = 64 * 1024 * 1024;
    if payload_len > MAX_RUNTIME_MESSAGE_SIZE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("runtime message too large: {payload_len} bytes"),
        ));
    }

    let mut payload = vec![0u8; payload_len];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

#[derive(serde::Deserialize)]
struct RuntimeConsoleLog {
    level: String,
    message: String,
}

impl DecorationEvaluator for NodeDecorationEvaluator {
    fn evaluate_window(
        &self,
        window: &WaylandWindowSnapshot,
        now_ms: u64,
    ) -> Result<DecorationEvaluationResult, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;
        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::Evaluate {
            request_id,
            snapshot: window,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeEvaluateResponse = if let Some(response) = runtime.read_response()? {
            response
        } else {
            let status = runtime
                .child
                .try_wait()?
                .and_then(|status| status.code())
                .unwrap_or(-1);
            let stderr = runtime
                .stderr_log
                .lock()
                .map(|stderr| stderr.clone())
                .unwrap_or_default();
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
        };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "evaluate" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for evaluate: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        let Some(serialized) = response.serialized else {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                "missing serialized tree".into(),
            ));
        };
        let stdout = serde_json::to_string(&serialized)
            .map_err(|err| DecorationEvaluationError::InvalidResponse(err.to_string()))?;
        Ok(DecorationEvaluationResult {
            node: decode_tree_json(stdout.trim()).map_err(DecorationEvaluationError::Bridge)?,
            transform: response.transform.unwrap_or_default(),
            managed_window: response.managed_window.unwrap_or_default(),
            window_effects: response
                .window_effects
                .map(TryInto::try_into)
                .transpose()
                .map_err(DecorationEvaluationError::Bridge)?,
            dirty_node_ids: response.dirty_node_ids.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            actions: response.actions.unwrap_or_default(),
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }

    fn evaluate_window_preview(
        &self,
        window: &WaylandWindowSnapshot,
        now_ms: u64,
    ) -> Result<DecorationEvaluationResult, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;
        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::EvaluatePreview {
            request_id,
            snapshot: window,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeEvaluateResponse = if let Some(response) = runtime.read_response()? {
            response
        } else {
            let status = runtime
                .child
                .try_wait()?
                .and_then(|status| status.code())
                .unwrap_or(-1);
            let stderr = runtime
                .stderr_log
                .lock()
                .map(|stderr| stderr.clone())
                .unwrap_or_default();
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
        };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "evaluatePreview" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for evaluatePreview: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        let Some(serialized) = response.serialized else {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                "missing serialized tree".into(),
            ));
        };
        let stdout = serde_json::to_string(&serialized)
            .map_err(|err| DecorationEvaluationError::InvalidResponse(err.to_string()))?;
        Ok(DecorationEvaluationResult {
            node: decode_tree_json(stdout.trim()).map_err(DecorationEvaluationError::Bridge)?,
            transform: response.transform.unwrap_or_default(),
            managed_window: response.managed_window.unwrap_or_default(),
            window_effects: response
                .window_effects
                .map(TryInto::try_into)
                .transpose()
                .map_err(DecorationEvaluationError::Bridge)?,
            dirty_node_ids: response.dirty_node_ids.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            actions: response.actions.unwrap_or_default(),
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }

    fn evaluate_cached_window(
        &self,
        window_id: &str,
        window: Option<&WaylandWindowSnapshot>,
        now_ms: u64,
        force_full_reevaluation: bool,
    ) -> Result<DecorationCachedEvaluationResult, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;
        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::EvaluateCached {
            request_id,
            window_id,
            snapshot: window,
            force_full_reevaluation,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeEvaluateResponse = if let Some(response) = runtime.read_response()? {
            response
        } else {
            let status = runtime
                .child
                .try_wait()?
                .and_then(|status| status.code())
                .unwrap_or(-1);
            let stderr = runtime
                .stderr_log
                .lock()
                .map(|stderr| stderr.clone())
                .unwrap_or_default();
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
        };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "evaluateCached" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for evaluateCached: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        let managed_window_only = response.managed_window_only.unwrap_or(false);
        let node = if managed_window_only {
            None
        } else {
            let Some(serialized) = response.serialized else {
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeProtocol(
                    "missing serialized tree".into(),
                ));
            };
            let stdout = serde_json::to_string(&serialized)
                .map_err(|err| DecorationEvaluationError::InvalidResponse(err.to_string()))?;
            Some(decode_tree_json(stdout.trim()).map_err(DecorationEvaluationError::Bridge)?)
        };
        Ok(DecorationCachedEvaluationResult {
            node,
            transform: response.transform.unwrap_or_default(),
            managed_window: response.managed_window.unwrap_or_default(),
            window_effects: response
                .window_effects
                .map(TryInto::try_into)
                .transpose()
                .map_err(DecorationEvaluationError::Bridge)?,
            dirty_node_ids: response.dirty_node_ids.unwrap_or_default(),
            managed_window_only,
            next_poll_in_ms: response.next_poll_in_ms,
            actions: response.actions.unwrap_or_default(),
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }

    fn scheduler_tick(
        &self,
        now_ms: u64,
    ) -> Result<DecorationSchedulerTick, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;

        let Some(_) = runtime_guard.as_ref() else {
            return Ok(DecorationSchedulerTick::default());
        };

        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::SchedulerTick {
            request_id,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeSchedulerResponse = if let Some(response) = runtime.read_response()? {
            response
        } else {
            let status = runtime
                .child
                .try_wait()?
                .and_then(|status| status.code())
                .unwrap_or(-1);
            let stderr = runtime
                .stderr_log
                .lock()
                .map(|stderr| stderr.clone())
                .unwrap_or_default();
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
        };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "schedulerTick" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for schedulerTick: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        if managed_rect_debug_enabled() {
            info!(
                now_ms,
                dirty = response.dirty.unwrap_or(false),
                dirty_window_ids = ?response.dirty_window_ids,
                dirty_window_node_ids = ?response.dirty_window_node_ids,
                next_poll_in_ms = ?response.next_poll_in_ms,
                "managed rect debug: runtime scheduler tick"
            );
        }

        Ok(DecorationSchedulerTick {
            dirty: response.dirty.unwrap_or(false),
            dirty_window_ids: response.dirty_window_ids.unwrap_or_default(),
            dirty_managed_window_ids: response.dirty_managed_window_ids.unwrap_or_default(),
            dirty_window_node_ids: response.dirty_window_node_ids.unwrap_or_default(),
            dirty_layer_node_ids: response.dirty_layer_node_ids.unwrap_or_default(),
            actions: response.actions.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
            debug_config: response.debug_config,
        })
    }

    fn window_closed(&self, window_id: &str) -> Result<(), DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;

        let Some(_) = runtime_guard.as_ref() else {
            return Ok(());
        };

        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::WindowClosed {
            request_id,
            window_id,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeClosedResponse = if let Some(response) = runtime.read_response()? {
            response
        } else {
            let status = runtime
                .child
                .try_wait()?
                .and_then(|status| status.code())
                .unwrap_or(-1);
            let stderr = runtime
                .stderr_log
                .lock()
                .map(|stderr| stderr.clone())
                .unwrap_or_default();
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
        };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "windowClosed" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for windowClosed: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        Ok(())
    }

    fn invoke_handler(
        &self,
        window_id: &str,
        handler_id: &str,
        now_ms: u64,
    ) -> Result<DecorationHandlerInvocation, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;

        let Some(_) = runtime_guard.as_ref() else {
            return Ok(DecorationHandlerInvocation::default());
        };

        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::InvokeHandler {
            request_id,
            window_id,
            handler_id,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeInvokeHandlerResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "invokeHandler" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for invokeHandler: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        let node = if let Some(serialized) = response.serialized {
            let stdout = serde_json::to_string(&serialized)
                .map_err(|err| DecorationEvaluationError::InvalidResponse(err.to_string()))?;
            Some(decode_tree_json(stdout.trim()).map_err(DecorationEvaluationError::Bridge)?)
        } else {
            None
        };

        Ok(DecorationHandlerInvocation {
            invoked: response.invoked.unwrap_or(false),
            node,
            transform: response.transform,
            managed_window: response.managed_window,
            window_effects: response
                .window_effects
                .map(TryInto::try_into)
                .transpose()
                .map_err(DecorationEvaluationError::Bridge)?,
            dirty_window_ids: response.dirty_window_ids.unwrap_or_default(),
            dirty_managed_window_ids: response.dirty_managed_window_ids.unwrap_or_default(),
            dirty_window_node_ids: response.dirty_window_node_ids.unwrap_or_default(),
            actions: response.actions.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }

    fn invoke_key_binding(
        &self,
        binding_id: &str,
        now_ms: u64,
    ) -> Result<DecorationKeyBindingInvocation, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;

        let Some(_) = runtime_guard.as_ref() else {
            return Ok(DecorationKeyBindingInvocation::default());
        };

        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::InvokeKeyBinding {
            request_id,
            binding_id,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeInvokeKeyBindingResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "invokeKeyBinding" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for invokeKeyBinding: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        Ok(DecorationKeyBindingInvocation {
            invoked: response.invoked.unwrap_or(false),
            dirty: response.dirty.unwrap_or(false),
            dirty_window_ids: response.dirty_window_ids.unwrap_or_default(),
            dirty_managed_window_ids: response.dirty_managed_window_ids.unwrap_or_default(),
            dirty_window_node_ids: response.dirty_window_node_ids.unwrap_or_default(),
            dirty_layer_node_ids: response.dirty_layer_node_ids.unwrap_or_default(),
            actions: response.actions.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }

    fn window_resize(
        &self,
        window_id: &str,
        event: &WindowResizeEventSnapshot,
        now_ms: u64,
    ) -> Result<DecorationWindowResizeInvocation, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;

        let Some(_) = runtime_guard.as_ref() else {
            return Ok(DecorationWindowResizeInvocation::default());
        };

        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::WindowResize {
            request_id,
            window_id,
            event,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeWindowResizeResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "windowResize" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for windowResize: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        Ok(DecorationWindowResizeInvocation {
            invoked: response.invoked.unwrap_or(false),
            dirty: response.dirty.unwrap_or(false),
            dirty_window_ids: response.dirty_window_ids.unwrap_or_default(),
            dirty_managed_window_ids: response.dirty_managed_window_ids.unwrap_or_default(),
            dirty_window_node_ids: response.dirty_window_node_ids.unwrap_or_default(),
            dirty_layer_node_ids: response.dirty_layer_node_ids.unwrap_or_default(),
            actions: response.actions.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }

    fn window_move(
        &self,
        window_id: &str,
        event: &WindowMoveEventSnapshot,
        now_ms: u64,
    ) -> Result<DecorationWindowMoveInvocation, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;

        let Some(_) = runtime_guard.as_ref() else {
            return Ok(DecorationWindowMoveInvocation::default());
        };

        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::WindowMove {
            request_id,
            window_id,
            event,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeWindowMoveResponse = if let Some(response) = runtime.read_response()? {
            response
        } else {
            let status = runtime
                .child
                .try_wait()?
                .and_then(|status| status.code())
                .unwrap_or(-1);
            let stderr = runtime
                .stderr_log
                .lock()
                .map(|stderr| stderr.clone())
                .unwrap_or_default();
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
        };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "windowMove" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for windowMove: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        Ok(DecorationWindowMoveInvocation {
            invoked: response.invoked.unwrap_or(false),
            dirty: response.dirty.unwrap_or(false),
            dirty_window_ids: response.dirty_window_ids.unwrap_or_default(),
            dirty_managed_window_ids: response.dirty_managed_window_ids.unwrap_or_default(),
            dirty_window_node_ids: response.dirty_window_node_ids.unwrap_or_default(),
            dirty_layer_node_ids: response.dirty_layer_node_ids.unwrap_or_default(),
            actions: response.actions.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }

    fn window_maximize_request(
        &self,
        snapshot: &WaylandWindowSnapshot,
        event: &WindowMaximizeRequestEventSnapshot,
        now_ms: u64,
    ) -> Result<DecorationWindowStateRequestInvocation, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;

        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::WindowMaximizeRequest {
            request_id,
            window_id: &snapshot.id,
            snapshot,
            event,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeWindowStateRequestResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "windowMaximizeRequest" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for windowMaximizeRequest: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        Ok(DecorationWindowStateRequestInvocation {
            invoked: response.invoked.unwrap_or(false),
            dirty: response.dirty.unwrap_or(false),
            dirty_window_ids: response.dirty_window_ids.unwrap_or_default(),
            dirty_managed_window_ids: response.dirty_managed_window_ids.unwrap_or_default(),
            dirty_window_node_ids: response.dirty_window_node_ids.unwrap_or_default(),
            dirty_layer_node_ids: response.dirty_layer_node_ids.unwrap_or_default(),
            actions: response.actions.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }

    fn window_minimize_request(
        &self,
        snapshot: &WaylandWindowSnapshot,
        event: &WindowMinimizeRequestEventSnapshot,
        now_ms: u64,
    ) -> Result<DecorationWindowStateRequestInvocation, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;

        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::WindowMinimizeRequest {
            request_id,
            window_id: &snapshot.id,
            snapshot,
            event,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeWindowStateRequestResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "windowMinimizeRequest" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for windowMinimizeRequest: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        Ok(DecorationWindowStateRequestInvocation {
            invoked: response.invoked.unwrap_or(false),
            dirty: response.dirty.unwrap_or(false),
            dirty_window_ids: response.dirty_window_ids.unwrap_or_default(),
            dirty_managed_window_ids: response.dirty_managed_window_ids.unwrap_or_default(),
            dirty_window_node_ids: response.dirty_window_node_ids.unwrap_or_default(),
            dirty_layer_node_ids: response.dirty_layer_node_ids.unwrap_or_default(),
            actions: response.actions.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }

    fn window_fullscreen_request(
        &self,
        snapshot: &WaylandWindowSnapshot,
        event: &WindowFullscreenRequestEventSnapshot,
        now_ms: u64,
    ) -> Result<DecorationWindowStateRequestInvocation, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;

        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::WindowFullscreenRequest {
            request_id,
            window_id: &snapshot.id,
            snapshot,
            event,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeWindowStateRequestResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "windowFullscreenRequest" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for windowFullscreenRequest: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        Ok(DecorationWindowStateRequestInvocation {
            invoked: response.invoked.unwrap_or(false),
            dirty: response.dirty.unwrap_or(false),
            dirty_window_ids: response.dirty_window_ids.unwrap_or_default(),
            dirty_managed_window_ids: response.dirty_managed_window_ids.unwrap_or_default(),
            dirty_window_node_ids: response.dirty_window_node_ids.unwrap_or_default(),
            dirty_layer_node_ids: response.dirty_layer_node_ids.unwrap_or_default(),
            actions: response.actions.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }

    fn window_activate_request(
        &self,
        snapshot: &WaylandWindowSnapshot,
        event: &WindowActivateRequestEventSnapshot,
        now_ms: u64,
    ) -> Result<DecorationWindowStateRequestInvocation, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;

        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::WindowActivateRequest {
            request_id,
            window_id: &snapshot.id,
            snapshot,
            event,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeWindowStateRequestResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "windowActivateRequest" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for windowActivateRequest: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        Ok(DecorationWindowStateRequestInvocation {
            invoked: response.invoked.unwrap_or(false),
            dirty: response.dirty.unwrap_or(false),
            dirty_window_ids: response.dirty_window_ids.unwrap_or_default(),
            dirty_managed_window_ids: response.dirty_managed_window_ids.unwrap_or_default(),
            dirty_window_node_ids: response.dirty_window_node_ids.unwrap_or_default(),
            dirty_layer_node_ids: response.dirty_layer_node_ids.unwrap_or_default(),
            actions: response.actions.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }

    fn pointer_move_async(&self, event: PointerMoveEventSnapshot, now_ms: u64) {
        self.enqueue_pointer_move_async(event, now_ms);
    }

    fn gesture_swipe_async(&self, event: GestureSwipeEventSnapshot, now_ms: u64) {
        self.enqueue_gesture_swipe_async(event, now_ms);
    }

    fn start_close(
        &self,
        window_id: &str,
        now_ms: u64,
    ) -> Result<DecorationHandlerInvocation, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;

        let Some(_) = runtime_guard.as_ref() else {
            return Ok(DecorationHandlerInvocation::default());
        };

        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::StartClose {
            request_id,
            window_id,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeStartCloseResponse = if let Some(response) = runtime.read_response()? {
            response
        } else {
            let status = runtime
                .child
                .try_wait()?
                .and_then(|status| status.code())
                .unwrap_or(-1);
            let stderr = runtime
                .stderr_log
                .lock()
                .map(|stderr| stderr.clone())
                .unwrap_or_default();
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
        };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "startClose" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for startClose: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        let node = if let Some(serialized) = response.serialized {
            let stdout = serde_json::to_string(&serialized)
                .map_err(|err| DecorationEvaluationError::InvalidResponse(err.to_string()))?;
            Some(decode_tree_json(stdout.trim()).map_err(DecorationEvaluationError::Bridge)?)
        } else {
            None
        };

        Ok(DecorationHandlerInvocation {
            invoked: response.invoked.unwrap_or(false),
            node,
            transform: response.transform,
            managed_window: response.managed_window,
            window_effects: response
                .window_effects
                .map(TryInto::try_into)
                .transpose()
                .map_err(DecorationEvaluationError::Bridge)?,
            dirty_window_ids: response.dirty_window_ids.unwrap_or_default(),
            dirty_managed_window_ids: response.dirty_managed_window_ids.unwrap_or_default(),
            dirty_window_node_ids: response.dirty_window_node_ids.unwrap_or_default(),
            actions: response.actions.unwrap_or_default(),
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }

    fn evaluate_layer_effects(
        &self,
        output_name: &str,
        layers: &[WaylandLayerSnapshot],
        now_ms: u64,
    ) -> Result<LayerEffectEvaluationResult, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;
        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::EvaluateLayerEffects {
            request_id,
            output_name,
            layers,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimeLayerEffectsResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "evaluateLayerEffects" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for evaluateLayerEffects: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        Ok(LayerEffectEvaluationResult {
            effects: response
                .effects
                .unwrap_or_default()
                .into_iter()
                .map(|assignment| {
                    Ok(RuntimeLayerEffectAssignment {
                        layer_id: assignment.layer_id,
                        effects: assignment
                            .effects
                            .map(TryInto::try_into)
                            .transpose()?
                            .map(validate_layer_effect_config)
                            .transpose()?,
                    })
                })
                .collect::<Result<Vec<_>, DecorationBridgeError>>()
                .map_err(DecorationEvaluationError::Bridge)?,
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }

    fn evaluate_popup_effects(
        &self,
        output_name: &str,
        popups: &[WaylandPopupSnapshot],
        now_ms: u64,
    ) -> Result<PopupEffectEvaluationResult, DecorationEvaluationError> {
        let mut runtime_guard = self.runtime.lock().map_err(|_| {
            DecorationEvaluationError::RuntimeProtocol("runtime mutex poisoned".into())
        })?;
        let runtime = self.ensure_runtime(&mut runtime_guard)?;
        let request_id = runtime.next_request_id;
        runtime.next_request_id += 1;
        let display_state = self
            .display_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let input_state = self
            .input_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let request = serde_json::to_string(&RuntimeRequest::EvaluatePopupEffects {
            request_id,
            output_name,
            popups,
            now_ms,
            display_state: &display_state,
            input_state: &input_state,
        })
        .map_err(|err| DecorationEvaluationError::SnapshotSerialization(err.to_string()))?;
        runtime.write_request(&request)?;

        let response: RuntimePopupEffectsResponse =
            if let Some(response) = runtime.read_response()? {
                response
            } else {
                let status = runtime
                    .child
                    .try_wait()?
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
                let stderr = runtime
                    .stderr_log
                    .lock()
                    .map(|stderr| stderr.clone())
                    .unwrap_or_default();
                *runtime_guard = None;
                return Err(DecorationEvaluationError::RuntimeFailed { status, stderr });
            };
        if response.request_id != request_id {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response id: expected {request_id}, got {}",
                response.request_id
            )));
        }
        if response.kind != "evaluatePopupEffects" {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(format!(
                "mismatched response kind for evaluatePopupEffects: {}",
                response.kind
            )));
        }
        if !response.ok {
            *runtime_guard = None;
            return Err(DecorationEvaluationError::RuntimeProtocol(
                response
                    .error
                    .unwrap_or_else(|| "runtime returned failure".into()),
            ));
        }

        Ok(PopupEffectEvaluationResult {
            effects: response
                .effects
                .unwrap_or_default()
                .into_iter()
                .map(|assignment| {
                    Ok(RuntimePopupEffectAssignment {
                        popup_id: assignment.popup_id,
                        effects: assignment
                            .effects
                            .map(TryInto::try_into)
                            .transpose()?
                            .map(validate_popup_effect_config)
                            .transpose()?,
                    })
                })
                .collect::<Result<Vec<_>, DecorationBridgeError>>()
                .map_err(DecorationEvaluationError::Bridge)?,
            next_poll_in_ms: response.next_poll_in_ms,
            display_config: response.display_config,
            key_binding_config: response.key_binding_config,
            pointer_config: response.pointer_config,
            input_config: response.input_config,
            event_config: response.event_config,
            process_config: response.process_config,
            process_actions: response.process_actions.unwrap_or_default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssd::{
        BackdropBlur, CompiledEffect, DecorationNodeKind, EffectAlphaMode,
        EffectInvalidationPolicy, EffectOutsets, EffectStage, ShaderModule, ShaderStage,
        WindowEffectSlot, WindowSourceInclude,
        window_model::{WaylandWindowSnapshot, WindowPositionSnapshot},
    };

    fn make_window(is_focused: bool) -> WaylandWindowSnapshot {
        WaylandWindowSnapshot {
            id: "1".into(),
            title: "Kitty".into(),
            app_id: Some("kitty".into()),
            position: WindowPositionSnapshot {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
            },
            rect: WindowPositionSnapshot {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
            },
            is_focused,
            is_floating: true,
            is_maximized: false,
            is_fullscreen: false,
            is_xwayland: false,
            size_constraints: Default::default(),
            is_resizable: true,
            is_transient: false,
            parent_id: None,
            icon: None,
            interaction: crate::ssd::DecorationInteractionSnapshot::default(),
        }
    }

    #[test]
    fn evaluator_reflects_title_into_tree() {
        let tree = evaluate_dynamic_decoration(&StaticDecorationEvaluator, &make_window(false), 0)
            .expect("evaluation should succeed");

        let title_node = &tree.root.children[0].children[0].children[0];
        assert!(
            matches!(&title_node.kind, DecorationNodeKind::Label(label) if label.text == "Kitty")
        );
    }

    #[test]
    fn evaluator_changes_border_color_for_focused_window() {
        let focused =
            evaluate_dynamic_decoration(&StaticDecorationEvaluator, &make_window(true), 0)
                .expect("focused evaluation should succeed");
        let unfocused =
            evaluate_dynamic_decoration(&StaticDecorationEvaluator, &make_window(false), 0)
                .expect("unfocused evaluation should succeed");

        assert_ne!(focused.root.style.border, unfocused.root.style.border);
    }

    #[test]
    fn popup_backdrop_mask_can_sample_popup_source() {
        let effect = CompiledEffect {
            input: EffectInput::Backdrop,
            invalidate: EffectInvalidationPolicy::Always,
            pipeline: vec![
                EffectStage::DualKawaseBlur(BackdropBlur {
                    radius: 4,
                    passes: 2,
                }),
                EffectStage::Shader(ShaderStage {
                    shader: ShaderModule {
                        path: "popup-mask.frag".into(),
                    },
                    uniforms: std::collections::BTreeMap::new(),
                    textures: std::collections::BTreeMap::from([(
                        "popup_mask".into(),
                        EffectInput::PopupSource(WindowSourceInclude::Full),
                    )]),
                }),
            ],
            alpha: EffectAlphaMode::Preserve,
        };
        let effects = WindowEffectConfig {
            behind: Some(WindowEffectSlot {
                effect,
                outsets: EffectOutsets::default(),
            }),
            ..Default::default()
        };

        assert!(validate_popup_effect_config(effects).is_ok());
    }
}

//! Output enumeration via wayland-client.
//!
//! Connects to $WAYLAND_DISPLAY, performs one roundtrip to gather wl_output
//! globals, then disconnects. Cheap to call per-`SelectSources`.

use std::sync::{Arc, Mutex};

use wayland_client::protocol::{wl_output, wl_registry};
use wayland_client::{Connection, Dispatch, QueueHandle};

#[derive(Debug, Clone)]
pub struct OutputInfo {
    pub name: String,
    pub description: String,
    pub width: i32,
    pub height: i32,
    pub refresh_mhz: i32,
}

#[derive(Default)]
struct State {
    outputs: Vec<OutputInfo>,
    pending: Vec<OutputInfo>,
}

struct AppData {
    state: Arc<Mutex<State>>,
}

impl Dispatch<wl_registry::WlRegistry, ()> for AppData {
    fn event(
        _app: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global { name, interface, version } = event
            && interface == "wl_output"
        {
            registry.bind::<wl_output::WlOutput, _, _>(name, version.min(4), qh, ());
        }
    }
}

impl Dispatch<wl_output::WlOutput, ()> for AppData {
    fn event(
        app: &mut Self,
        _output: &wl_output::WlOutput,
        event: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let mut state = app.state.lock().unwrap();
        // The first event for an output is what tells us to start filling a
        // pending slot; mode/geometry/name all arrive separately.
        if state.pending.is_empty() {
            state.pending.push(OutputInfo {
                name: String::new(),
                description: String::new(),
                width: 0,
                height: 0,
                refresh_mhz: 0,
            });
        }
        let cur = state.pending.last_mut().unwrap();
        match event {
            wl_output::Event::Name { name } => cur.name = name,
            wl_output::Event::Description { description } => cur.description = description,
            wl_output::Event::Mode {
                flags, width, height, refresh,
            } => {
                if flags.into_result().map(|f| f.contains(wl_output::Mode::Current)).unwrap_or(false) {
                    cur.width = width;
                    cur.height = height;
                    cur.refresh_mhz = refresh;
                }
            }
            wl_output::Event::Done => {
                let info = state.pending.pop().unwrap();
                state.outputs.push(info);
            }
            _ => {}
        }
    }
}

/// Enumerate outputs by connecting to the Wayland session display.
///
/// Returns an empty Vec on any error (display unavailable, etc.) — the picker
/// will then show "no outputs" rather than crash.
pub fn enumerate() -> Vec<OutputInfo> {
    let conn = match Connection::connect_to_env() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("wayland connect failed: {e}");
            return Vec::new();
        }
    };
    let display = conn.display();
    let mut event_queue = conn.new_event_queue::<AppData>();
    let qh = event_queue.handle();
    let _registry = display.get_registry(&qh, ());

    let state = Arc::new(Mutex::new(State::default()));
    let mut app = AppData { state: state.clone() };

    // First roundtrip: receive globals and bind wl_output's.
    if let Err(e) = event_queue.roundtrip(&mut app) {
        tracing::warn!("wayland first roundtrip failed: {e}");
        return Vec::new();
    }
    // Second roundtrip: receive each output's geometry/mode/name/done.
    if let Err(e) = event_queue.roundtrip(&mut app) {
        tracing::warn!("wayland second roundtrip failed: {e}");
    }

    let s = state.lock().unwrap();
    s.outputs.clone()
}

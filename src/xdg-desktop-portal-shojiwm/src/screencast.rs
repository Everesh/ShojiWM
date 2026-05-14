//! org.freedesktop.impl.portal.ScreenCast backend implementation.
//!
//! See: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.impl.portal.ScreenCast.html

use std::collections::HashMap;
use std::sync::Mutex;

use zbus::object_server::SignalEmitter;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

use crate::outputs::{self, OutputInfo};
use crate::picker::{PickResult, PickerHandle};
use crate::pipewire_stream::{self, StreamHandle, StreamSpec};

/// SourceTypes bitmask values from the portal spec.
#[allow(dead_code)]
mod source_types {
    pub const MONITOR: u32 = 1 << 0;
    pub const WINDOW: u32 = 1 << 1;
    pub const VIRTUAL: u32 = 1 << 2;
}

/// CursorMode bitmask values from the portal spec.
#[allow(dead_code)]
mod cursor_modes {
    pub const HIDDEN: u32 = 1 << 0;
    pub const EMBEDDED: u32 = 1 << 1;
    pub const METADATA: u32 = 1 << 2;
}

/// Per-session state: what the user picked at SelectSources time. Looked up
/// again by Start so it knows what to capture.
#[derive(Debug, Clone)]
pub enum Selection {
    Output(OutputInfo),
}

pub struct ScreenCast {
    picker: PickerHandle,
    sessions: Mutex<HashMap<String, Selection>>,
    /// Live streams keyed by session_handle. Held to keep the PW thread
    /// alive; per-session teardown will arrive with Phase 4b.
    streams: Mutex<HashMap<String, StreamHandle>>,
}

impl ScreenCast {
    pub fn new(picker: PickerHandle) -> Self {
        Self {
            picker,
            sessions: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
        }
    }
}

#[zbus::interface(name = "org.freedesktop.impl.portal.ScreenCast")]
impl ScreenCast {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        4
    }

    /// Bitmask of source types we can capture. Phase 4a starts with MONITOR only —
    /// WINDOW will be added once ext-image-copy-capture-v1 lands in the compositor.
    #[zbus(property, name = "AvailableSourceTypes")]
    fn available_source_types(&self) -> u32 {
        source_types::MONITOR
    }

    /// wlr-screencopy already embeds the cursor into the captured frame.
    #[zbus(property, name = "AvailableCursorModes")]
    fn available_cursor_modes(&self) -> u32 {
        cursor_modes::EMBEDDED
    }

    async fn create_session(
        &self,
        handle: ObjectPath<'_>,
        session_handle: ObjectPath<'_>,
        app_id: String,
        options: HashMap<String, OwnedValue>,
        #[zbus(signal_emitter)] _emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<(u32, HashMap<String, OwnedValue>)> {
        tracing::info!(
            %handle, %session_handle, %app_id, option_keys = ?options.keys().collect::<Vec<_>>(),
            "CreateSession"
        );
        Ok((0, HashMap::new()))
    }

    async fn select_sources(
        &self,
        handle: ObjectPath<'_>,
        session_handle: ObjectPath<'_>,
        app_id: String,
        options: HashMap<String, OwnedValue>,
    ) -> zbus::fdo::Result<(u32, HashMap<String, OwnedValue>)> {
        let requested = options
            .get("types")
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(source_types::MONITOR);
        tracing::info!(
            %handle, %session_handle, %app_id, requested_types = requested,
            "SelectSources: enumerating outputs and prompting picker"
        );

        let outputs = tokio::task::spawn_blocking(outputs::enumerate)
            .await
            .unwrap_or_default();
        tracing::info!(count = outputs.len(), "enumerated outputs");

        match self.picker.pick(outputs).await {
            PickResult::Output(out) => {
                tracing::info!(?out, %session_handle, "picker: selected output");
                self.sessions
                    .lock()
                    .unwrap()
                    .insert(session_handle.to_string(), Selection::Output(out));
                Ok((0, HashMap::new()))
            }
            PickResult::Cancelled => {
                tracing::info!(%session_handle, "picker: cancelled");
                Ok((1, HashMap::new()))
            }
        }
    }

    async fn start(
        &self,
        handle: ObjectPath<'_>,
        session_handle: ObjectPath<'_>,
        app_id: String,
        parent_window: String,
        _options: HashMap<String, OwnedValue>,
    ) -> zbus::fdo::Result<(u32, HashMap<String, OwnedValue>)> {
        let selection = self
            .sessions
            .lock()
            .unwrap()
            .get(&session_handle.to_string())
            .cloned();
        tracing::info!(%handle, %session_handle, %app_id, %parent_window, ?selection, "Start");

        let Some(Selection::Output(out)) = selection else {
            tracing::warn!(%session_handle, "Start with no selection — cancelling");
            return Ok((1, HashMap::new()));
        };

        // Frames are synthetic (Phase 4a). Use the output's refresh rounded
        // to integer Hz, clamped to [30, 120]. Clamping avoids exotic high
        // refresh values being rejected by some consumers, and avoids 0 for
        // outputs that didn't report a refresh.
        let framerate = {
            let hz = (out.refresh_mhz as f32 / 1000.0).round() as u32;
            hz.clamp(30, 120)
        };
        let spec = StreamSpec {
            output_name: out.name.clone(),
            width: out.width.max(1) as u32,
            height: out.height.max(1) as u32,
            framerate,
        };
        let session_key = session_handle.to_string();
        let spec_for_task = spec.clone();
        let stream_result =
            tokio::task::spawn_blocking(move || pipewire_stream::start(spec_for_task))
                .await
                .map_err(|e| zbus::fdo::Error::Failed(format!("stream task panic: {e}")))?;

        let (node_id, handle_owned) = match stream_result {
            Ok(v) => v,
            Err(e) => {
                tracing::error!("pipewire stream failed: {e}");
                return Ok((2, HashMap::new()));
            }
        };
        self.streams.lock().unwrap().insert(session_key, handle_owned);

        // Build the streams array per portal spec:
        //   a(ua{sv}): array of (node_id, properties)
        // Properties advertise size and source_type so OBS/Vesktop see them.
        let mut stream_props: HashMap<String, Value> = HashMap::new();
        stream_props.insert(
            "size".to_string(),
            Value::from((spec.width as i32, spec.height as i32)),
        );
        stream_props.insert("source_type".to_string(), Value::from(source_types::MONITOR));

        let streams: Vec<(u32, HashMap<String, Value>)> = vec![(node_id, stream_props)];
        let mut results = HashMap::new();
        results.insert(
            "streams".to_string(),
            OwnedValue::try_from(Value::from(streams)).unwrap(),
        );
        Ok((0, results))
    }
}

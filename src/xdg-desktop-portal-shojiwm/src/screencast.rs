//! org.freedesktop.impl.portal.ScreenCast backend implementation.
//!
//! See: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.impl.portal.ScreenCast.html

use std::collections::HashMap;
use std::sync::Mutex;

use zbus::object_server::SignalEmitter;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

use crate::picker::{PickResult, PickerHandle};
use crate::pipewire_stream::{self, StreamHandle, StreamSpec};
use crate::sources::{self, OutputInfo, SourceInfo, SourceKind, ThumbnailUpdate, ToplevelInfo};
use crate::toplevel_stream::{
    self, StreamHandle as ToplevelStreamHandle, StreamSpec as ToplevelStreamSpec,
};

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

/// What the user picked at SelectSources time. Reused by Start to set up the
/// actual PipeWire stream.
#[derive(Debug, Clone)]
#[allow(dead_code)] // ToplevelInfo fields are read in Phase 5d.
pub enum Selection {
    Output(OutputInfo),
    Toplevel(ToplevelInfo),
}

/// Per-session handle to keep the streaming pipeline alive. Either branch of
/// `Start` may stash one here; dropping it stops the corresponding thread.
#[allow(dead_code)]
enum AnyStreamHandle {
    Output(StreamHandle),
    Toplevel(ToplevelStreamHandle),
}

pub struct ScreenCast {
    picker: PickerHandle,
    sessions: Mutex<HashMap<String, Selection>>,
    streams: Mutex<HashMap<String, AnyStreamHandle>>,
    /// Per-session `cursor_mode & EMBEDDED != 0`. Filled by SelectSources,
    /// consumed by Start to configure the streaming pipeline.
    cursor_visibility: Mutex<HashMap<String, bool>>,
    thumbnail_tx: tokio::sync::mpsc::UnboundedSender<ThumbnailUpdate>,
}

impl ScreenCast {
    pub fn new(
        picker: PickerHandle,
        thumbnail_tx: tokio::sync::mpsc::UnboundedSender<ThumbnailUpdate>,
    ) -> Self {
        Self {
            picker,
            sessions: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            cursor_visibility: Mutex::new(HashMap::new()),
            thumbnail_tx,
        }
    }
}

#[zbus::interface(name = "org.freedesktop.impl.portal.ScreenCast")]
impl ScreenCast {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        4
    }

    /// We now advertise both MONITOR and WINDOW. WINDOW capture is wired
    /// through the picker but Start for WINDOW currently fails (Phase 5d
    /// migrates the streaming pipeline to ext-image-copy-capture-v1).
    #[zbus(property, name = "AvailableSourceTypes")]
    fn available_source_types(&self) -> u32 {
        source_types::MONITOR | source_types::WINDOW
    }

    /// Both HIDDEN and EMBEDDED — the OBS "Show cursor" checkbox toggles
    /// between these. Compositor honours the choice per session.
    #[zbus(property, name = "AvailableCursorModes")]
    fn available_cursor_modes(&self) -> u32 {
        cursor_modes::HIDDEN | cursor_modes::EMBEDDED
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
        // OBS sends `cursor_mode` per its "Show cursor" checkbox. EMBEDDED =
        // cursor in the stream, HIDDEN = no cursor. We default to EMBEDDED.
        let cursor_mode = options
            .get("cursor_mode")
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(cursor_modes::EMBEDDED);
        let cursor_visible = cursor_mode & cursor_modes::EMBEDDED != 0;
        self.cursor_visibility
            .lock()
            .unwrap()
            .insert(session_handle.to_string(), cursor_visible);
        tracing::info!(
            %handle, %session_handle, %app_id, requested_types = requested, cursor_mode, cursor_visible,
            "SelectSources: enumerating sources and prompting picker"
        );

        // Spawn the long-lived thumbnail refresh thread; it does initial
        // discovery + first thumbnails, then keeps refreshing each source in
        // round-robin until the returned handle is dropped.
        let (init_tx, init_rx) = tokio::sync::oneshot::channel();
        let thumbnail_tx = self.thumbnail_tx.clone();
        let _stream_guard = tokio::task::spawn_blocking(move || {
            sources::start_thumbnail_stream(init_tx, thumbnail_tx)
        })
        .await
        .map_err(|e| zbus::fdo::Error::Failed(format!("thumbnail thread join: {e}")))?;

        let sources_initial = init_rx.await.unwrap_or_default();
        let filtered: Vec<SourceInfo> = sources_initial
            .into_iter()
            .filter(|s| match &s.kind {
                SourceKind::Output(_) => requested & source_types::MONITOR != 0,
                SourceKind::Toplevel(_) => requested & source_types::WINDOW != 0,
            })
            .collect();
        tracing::info!(count = filtered.len(), "enumerated sources");

        let pick = self.picker.pick(filtered).await;
        drop(_stream_guard);

        match pick {
            PickResult::Source(src) => match src.kind {
                SourceKind::Output(out) => {
                    tracing::info!(?out, %session_handle, "picker: selected output");
                    self.sessions
                        .lock()
                        .unwrap()
                        .insert(session_handle.to_string(), Selection::Output(out));
                    Ok((0, HashMap::new()))
                }
                SourceKind::Toplevel(top) => {
                    tracing::info!(?top, %session_handle, "picker: selected toplevel");
                    self.sessions
                        .lock()
                        .unwrap()
                        .insert(session_handle.to_string(), Selection::Toplevel(top));
                    Ok((0, HashMap::new()))
                }
            },
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

        let session_key = session_handle.to_string();
        let cursor_visible = self
            .cursor_visibility
            .lock()
            .unwrap()
            .get(&session_key)
            .copied()
            .unwrap_or(true);
        match selection {
            Some(Selection::Output(out)) => {
                let framerate = {
                    let hz = (out.refresh_mhz as f32 / 1000.0).round() as u32;
                    hz.clamp(30, 120)
                };
                let spec = StreamSpec {
                    output_name: out.name.clone(),
                    width: out.width.max(1) as u32,
                    height: out.height.max(1) as u32,
                    framerate,
                    cursor_visible,
                };
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
                self.streams
                    .lock()
                    .unwrap()
                    .insert(session_key, AnyStreamHandle::Output(handle_owned));

                let mut stream_props: HashMap<String, Value> = HashMap::new();
                stream_props.insert(
                    "size".to_string(),
                    Value::from((spec.width as i32, spec.height as i32)),
                );
                stream_props.insert(
                    "source_type".to_string(),
                    Value::from(source_types::MONITOR),
                );
                let streams: Vec<(u32, HashMap<String, Value>)> = vec![(node_id, stream_props)];
                let mut results = HashMap::new();
                results.insert(
                    "streams".to_string(),
                    OwnedValue::try_from(Value::from(streams)).unwrap(),
                );
                Ok((0, results))
            }
            Some(Selection::Toplevel(top)) => {
                // Compositor's session events advertise the actual buffer
                // dims; we just pass identifier + a target framerate. 60Hz is
                // a reasonable cap regardless of which output the window is
                // currently visible on.
                let spec = ToplevelStreamSpec {
                    toplevel_identifier: top.identifier.clone(),
                    framerate: 60,
                    cursor_visible,
                };
                let spec_for_task = spec.clone();
                let stream_result =
                    tokio::task::spawn_blocking(move || toplevel_stream::start(spec_for_task))
                        .await
                        .map_err(|e| {
                            zbus::fdo::Error::Failed(format!("toplevel stream task panic: {e}"))
                        })?;
                let (node_id, handle_owned) = match stream_result {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::error!("toplevel stream failed: {e}");
                        return Ok((2, HashMap::new()));
                    }
                };
                self.streams
                    .lock()
                    .unwrap()
                    .insert(session_key, AnyStreamHandle::Toplevel(handle_owned));

                let mut stream_props: HashMap<String, Value> = HashMap::new();
                stream_props.insert("source_type".to_string(), Value::from(source_types::WINDOW));
                let streams: Vec<(u32, HashMap<String, Value>)> = vec![(node_id, stream_props)];
                let mut results = HashMap::new();
                results.insert(
                    "streams".to_string(),
                    OwnedValue::try_from(Value::from(streams)).unwrap(),
                );
                Ok((0, results))
            }
            None => {
                tracing::warn!(%session_handle, "Start with no selection — cancelling");
                Ok((1, HashMap::new()))
            }
        }
    }
}

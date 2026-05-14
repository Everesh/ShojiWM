//! iced-based source picker.
//!
//! `iced::daemon` lets us run an app with no initial window. We open a window
//! when a `PickRequest` arrives over the cross-thread channel and close it
//! once the user clicks a choice (or cancels). cosmic-text under the hood
//! handles font fallback, so CJK strings render without any font setup.
//!
//! Threading model:
//! - main thread runs iced (winit event loop)
//! - the D-Bus / tokio worker thread sends `PickRequest`s via an mpsc channel
//! - the receiver is parked in a `OnceLock` and pulled out by the iced
//!   subscription on first poll

use std::sync::{Mutex, OnceLock};

use iced::widget::{button, column, container, row, scrollable, space, text};
use iced::window;
use iced::{Element, Length, Subscription, Task};
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;

use crate::outputs::OutputInfo;

#[derive(Debug, Clone)]
pub enum PickResult {
    Output(OutputInfo),
    Cancelled,
}

pub struct PickRequest {
    pub outputs: Vec<OutputInfo>,
    pub responder: oneshot::Sender<PickResult>,
}

/// Handle the D-Bus side uses to request a pick. Cheap to clone.
#[derive(Clone)]
pub struct PickerHandle {
    tx: mpsc::UnboundedSender<PickRequest>,
}

impl PickerHandle {
    pub async fn pick(&self, outputs: Vec<OutputInfo>) -> PickResult {
        let (responder, rx) = oneshot::channel();
        if self.tx.send(PickRequest { outputs, responder }).is_err() {
            tracing::error!("picker thread is gone");
            return PickResult::Cancelled;
        }
        rx.await.unwrap_or(PickResult::Cancelled)
    }
}

/// Holds the mpsc Receiver until the iced subscription consumes it.
type ReceiverSlot = Mutex<Option<mpsc::UnboundedReceiver<PickRequest>>>;
static PICKER_RX: OnceLock<ReceiverSlot> = OnceLock::new();

/// Build the channel and return both a handle for the D-Bus side and a setup
/// guard that must be installed before `run_on_main_thread`.
pub fn setup() -> PickerHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let _ = PICKER_RX.set(Mutex::new(Some(rx)));
    PickerHandle { tx }
}

/// Run the iced daemon on the calling (main) thread. Blocks forever.
pub fn run_on_main_thread() -> iced::Result {
    iced::daemon(|| (State::default(), Task::none()), update, view)
        .title(|_state: &State, _id: window::Id| "ShojiWM — Pick a screen".to_string())
        .subscription(subscription)
        .run()
}

#[derive(Default)]
struct State {
    active: Option<Active>,
    window_id: Option<window::Id>,
}

struct Active {
    outputs: Vec<OutputInfo>,
    responder: Option<oneshot::Sender<PickResult>>,
    tab: Tab,
}

#[derive(Debug, Default, PartialEq, Eq, Clone, Copy)]
enum Tab {
    #[default]
    FullScreen,
    Window,
}

#[derive(Debug, Clone)]
enum Message {
    RequestArrived(RequestArrived),
    WindowOpened(window::Id),
    WindowClosed(window::Id),
    TabSelected(Tab),
    OutputClicked(usize),
    Cancelled,
}

/// Boxed handoff for the responder so Message can stay `Clone`.
#[derive(Debug, Clone)]
struct RequestArrived(std::sync::Arc<Mutex<Option<(Vec<OutputInfo>, oneshot::Sender<PickResult>)>>>);

fn update(state: &mut State, message: Message) -> Task<Message> {
    match message {
        Message::RequestArrived(arrived) => {
            let Some((outputs, responder)) = arrived.0.lock().unwrap().take() else {
                return Task::none();
            };
            // If a pick is already in flight, cancel the old one rather than
            // queue it. We only have one window.
            if let Some(mut prev) = state.active.take()
                && let Some(r) = prev.responder.take()
            {
                let _ = r.send(PickResult::Cancelled);
            }
            state.active = Some(Active {
                outputs,
                responder: Some(responder),
                tab: Tab::FullScreen,
            });

            if state.window_id.is_some() {
                // A window is already open — its view() will just re-render.
                Task::none()
            } else {
                let (id, open_task) = window::open(window::Settings {
                    size: iced::Size::new(540.0, 440.0),
                    min_size: Some(iced::Size::new(360.0, 240.0)),
                    ..Default::default()
                });
                state.window_id = Some(id);
                open_task.map(Message::WindowOpened)
            }
        }
        Message::WindowOpened(_id) => Task::none(),
        Message::WindowClosed(id) => {
            if state.window_id == Some(id) {
                state.window_id = None;
            }
            // Treat unexpected close as cancellation if a request was still
            // active.
            if let Some(mut active) = state.active.take()
                && let Some(r) = active.responder.take()
            {
                let _ = r.send(PickResult::Cancelled);
            }
            Task::none()
        }
        Message::TabSelected(tab) => {
            if let Some(active) = state.active.as_mut() {
                active.tab = tab;
            }
            Task::none()
        }
        Message::OutputClicked(index) => finish(state, |outputs| {
            outputs.get(index).cloned().map(PickResult::Output)
        }),
        Message::Cancelled => finish(state, |_| Some(PickResult::Cancelled)),
    }
}

fn finish<F>(state: &mut State, choose: F) -> Task<Message>
where
    F: FnOnce(&[OutputInfo]) -> Option<PickResult>,
{
    let Some(mut active) = state.active.take() else {
        return Task::none();
    };
    let result = choose(&active.outputs).unwrap_or(PickResult::Cancelled);
    if let Some(r) = active.responder.take() {
        let _ = r.send(result);
    }
    if let Some(id) = state.window_id.take() {
        window::close(id)
    } else {
        Task::none()
    }
}

fn view(state: &State, _id: window::Id) -> Element<'_, Message> {
    let Some(active) = state.active.as_ref() else {
        return container(text("Idle.")).padding(16).into();
    };

    let tabs = row![
        tab_button("全画面", active.tab == Tab::FullScreen, Tab::FullScreen),
        tab_button("ウィンドウ", active.tab == Tab::Window, Tab::Window),
    ]
    .spacing(8);

    let body: Element<'_, Message> = match active.tab {
        Tab::FullScreen => {
            if active.outputs.is_empty() {
                column![
                    text("出力が検出できませんでした。"),
                    text(
                        "ShojiWM 上で起動しているか、WAYLAND_DISPLAY が設定されているか確認してください。"
                    ),
                ]
                .spacing(8)
                .into()
            } else {
                let mut list = column![].spacing(6);
                for (i, out) in active.outputs.iter().enumerate() {
                    let header = if out.description.is_empty() {
                        out.name.clone()
                    } else {
                        format!("{} — {}", out.name, out.description)
                    };
                    let detail = format!(
                        "{}×{} @ {:.2}Hz",
                        out.width,
                        out.height,
                        out.refresh_mhz as f64 / 1000.0,
                    );
                    let label: Element<'_, Message> = column![
                        text(header).size(14),
                        text(detail).size(12),
                    ]
                    .spacing(2)
                    .into();
                    list = list.push(
                        button(label)
                            .width(Length::Fill)
                            .padding(10)
                            .on_press(Message::OutputClicked(i)),
                    );
                }
                scrollable(list).height(Length::Fill).into()
            }
        }
        Tab::Window => column![
            text("ウィンドウ単位のキャプチャは未実装です。"),
            text("（compositor 側に ext-image-copy-capture-v1 を実装してから対応します。）"),
        ]
        .spacing(8)
        .into(),
    };

    let footer = row![
        space::horizontal(),
        button(text("キャンセル")).on_press(Message::Cancelled),
    ];

    container(
        column![
            text("画面共有の対象を選択").size(18),
            tabs,
            body,
            footer,
        ]
        .spacing(12),
    )
    .padding(16)
    .into()
}

fn tab_button<'a>(label: &'a str, selected: bool, kind: Tab) -> Element<'a, Message> {
    let btn = button(text(label));
    let btn = if selected {
        btn.style(button::primary)
    } else {
        btn.style(button::secondary)
    };
    btn.on_press(Message::TabSelected(kind)).into()
}

fn subscription(_state: &State) -> Subscription<Message> {
    // Bridge mpsc → iced messages. The receiver is taken out of the OnceLock
    // on first subscription call.
    let request_stream = Subscription::run(|| {
        let rx = PICKER_RX
            .get()
            .expect("picker::setup() not called before run_on_main_thread")
            .lock()
            .unwrap()
            .take()
            .expect("picker subscription started twice");
        UnboundedReceiverStream::new(rx).map(|req| {
            Message::RequestArrived(RequestArrived(std::sync::Arc::new(Mutex::new(Some((
                req.outputs,
                req.responder,
            ))))))
        })
    });

    let close_events = window::close_events().map(Message::WindowClosed);

    Subscription::batch([request_stream, close_events])
}

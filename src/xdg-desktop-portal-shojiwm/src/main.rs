mod i18n;
mod picker;
mod pipewire_stream;
mod screencast;
mod sources;
mod toplevel_stream;

use std::error::Error;
use std::sync::Arc;

use tracing_subscriber::EnvFilter;

const BUS_NAME: &str = "org.freedesktop.impl.portal.desktop.shojiwm";

fn main() -> Result<(), Box<dyn Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    tracing::info!("xdg-desktop-portal-shojiwm starting");
    i18n::init();

    // Build a multi-thread tokio runtime that lives on a dedicated worker
    // thread. The main thread is reserved for eframe/winit because winit
    // strongly prefers the main thread for its EventLoop on Linux.
    let runtime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("portal-tokio")
            .build()?,
    );

    let (picker_handle, thumbnail_tx) = picker::setup();

    // Bring up zbus before iced starts spinning.
    let connection = runtime.block_on(async {
        zbus::connection::Builder::session()?
            .name(BUS_NAME)?
            .serve_at(
                "/org/freedesktop/portal/desktop",
                screencast::ScreenCast::new(picker_handle.clone(), thumbnail_tx),
            )?
            .build()
            .await
    })?;

    tracing::info!(bus = BUS_NAME, "claimed D-Bus name; serving ScreenCast");

    // Spawn a ctrl-c watcher on the runtime that will tear us down.
    let rt_for_signal = runtime.clone();
    std::thread::Builder::new()
        .name("portal-signal".into())
        .spawn(move || {
            rt_for_signal.block_on(async {
                if let Err(e) = tokio::signal::ctrl_c().await {
                    tracing::warn!("ctrl_c watcher failed: {e}");
                }
                tracing::info!("shutting down (ctrl-c)");
                std::process::exit(0);
            });
        })?;

    // Block here forever, owning the main thread for the winit event loop.
    if let Err(e) = picker::run_on_main_thread() {
        tracing::error!("picker iced exited: {e}");
    }

    drop(connection);
    Ok(())
}

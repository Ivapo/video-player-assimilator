// The desktop shell (spec vpa-001 §2.8–§2.12): the web page in a Tauri 2 window, files
// served by the `stream:` scheme, and file open through the dialog and "Open with".
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod opened;
mod stream;
#[cfg(feature = "gate")]
mod gate;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent};

fn main() {
    let builder = tauri::Builder::default();

    // Windows and Linux: a second launch hands its argv to the running app (§2.10).
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        opened::deliver(app, opened::paths_from_args(argv.into_iter().skip(1)));
    }));

    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(stream::Allowed::default())
        .manage(opened::Opened::default());

    #[cfg(not(feature = "gate"))]
    let builder = builder.invoke_handler(tauri::generate_handler![opened::subscribe_opened, opened::pick_file]);
    #[cfg(feature = "gate")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        opened::subscribe_opened,
        opened::pick_file,
        gate::gate_open
    ]);

    let app = builder
        .register_asynchronous_uri_scheme_protocol("stream", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || stream::handle(&app, request, responder));
        })
        .setup(|app| {
            stream::log::init(app.handle());
            // The window is declared with "create": false and made here, so that the gate
            // build can add its agent as a document-start script (§2.8).
            let conf = app.config().app.windows.first().expect("window config").clone();
            let wb = tauri::WebviewWindowBuilder::from_config(app.handle(), &conf)?.on_page_load(|w, payload| {
                if payload.event() == PageLoadEvent::Started {
                    w.state::<opened::Opened>().reset();
                }
            });
            #[cfg(feature = "gate")]
            let wb = wb.initialization_script(gate::agent_script());
            let w = wb.build()?;
            let _ = w.set_focus();
            // Windows and Linux "Open with" at start; on macOS argv holds no path.
            opened::deliver(app.handle(), opened::paths_from_args(std::env::args_os().skip(1)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|_app, _event| {
        // macOS "Open with", for a running app and on a cold start, where it arrives before
        // `setup`: the paths wait in the buffer until the page subscribes.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let RunEvent::Opened { urls } = _event {
            let paths = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            opened::deliver(_app, paths);
        }
    });
}

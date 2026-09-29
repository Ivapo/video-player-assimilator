//! The gate build only (Cargo feature `gate`, spec vpa-001 §2.12): the in-page agent and
//! `gate_open`. The per-request log is in `stream::log`. Nothing here is in the release app.

use tauri::AppHandle;

/// Opens a file as `RunEvent::Opened` does: the same `deliver`, so the same buffer.
#[tauri::command]
pub fn gate_open(app: AppHandle, path: String) {
    crate::opened::deliver(&app, vec![path]);
}

/// `test/desktop/agent.js`, run at document start in every page. `VPA_RUNNER` overrides the
/// runner's address.
pub fn agent_script() -> String {
    let runner = std::env::var("VPA_RUNNER").unwrap_or_else(|_| "http://127.0.0.1:5181".into());
    format!(
        "window.__VPA_RUNNER = {};\n{}",
        serde_json::Value::String(runner),
        include_str!("../../test/desktop/agent.js")
    )
}

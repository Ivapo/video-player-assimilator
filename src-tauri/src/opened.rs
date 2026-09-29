//! Opening a file in the desktop app (spec vpa-001 §2.10): the dialog, and file-open paths
//! held until the page subscribes.

use crate::stream::Allowed;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Paths that arrived before the page subscribed, and whether it has. One lock over both, so
/// every path is delivered exactly once, whichever side comes first.
#[derive(Default, Debug)]
pub struct Inbox {
    subscribed: bool,
    buffer: Vec<String>,
}

impl Inbox {
    /// Returns the paths to emit now, or buffers them for the next subscription.
    pub fn deliver(&mut self, paths: Vec<String>) -> Option<Vec<String>> {
        if self.subscribed {
            Some(paths)
        } else {
            self.buffer.extend(paths);
            None
        }
    }

    /// The page has its listener: hand over the buffer and emit from now on.
    pub fn subscribe(&mut self) -> Vec<String> {
        self.subscribed = true;
        std::mem::take(&mut self.buffer)
    }

    /// A new page is loading: it has no listener until it subscribes (R1-B3).
    pub fn reset(&mut self) {
        self.subscribed = false;
    }
}

#[derive(Default)]
pub struct Opened(Mutex<Inbox>);

impl Opened {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inbox> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn reset(&self) {
        self.lock().reset();
    }
}

/// From `RunEvent::Opened`, argv, the single-instance callback, or the gate's `gate_open`:
/// allow each path on the `stream:` scheme, then emit `opened` or buffer.
pub fn deliver<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let allowed = app.state::<Allowed>();
    for p in &paths {
        allowed.add(std::path::Path::new(p));
    }
    let opened = app.state::<Opened>();
    let mut inbox = opened.lock();
    if let Some(paths) = inbox.deliver(paths) {
        let _ = app.emit("opened", paths);
    }
}

/// Paths of files on a command line (Windows and Linux "Open with"). Flags and anything that
/// is not a file are skipped.
pub fn paths_from_args<I: IntoIterator<Item = S>, S: Into<std::ffi::OsString>>(args: I) -> Vec<String> {
    args.into_iter()
        .map(|a| PathBuf::from(a.into()))
        .filter(|p| !p.to_string_lossy().starts_with('-') && p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
pub fn subscribe_opened(opened: tauri::State<'_, Opened>) -> Vec<String> {
    opened.lock().subscribe()
}

/// "Open mp4…": the system dialog, from Rust, so the shell knows the path it may serve.
/// `async`, so the blocking dialog does not run on the main thread (R1-N9).
#[tauri::command]
pub async fn pick_file(app: AppHandle) -> Option<String> {
    let picked = app.dialog().file().add_filter("MPEG-4 video", &["mp4"]).blocking_pick_file()?;
    let path = picked.into_path().ok()?;
    app.state::<Allowed>().add(&path);
    Some(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn delivered_before_subscribe_comes_from_the_buffer_once() {
        let mut i = Inbox::default();
        assert_eq!(i.deliver(s(&["/a.mp4"])), None);
        assert_eq!(i.deliver(s(&["/b.mp4"])), None);
        assert_eq!(i.subscribe(), s(&["/a.mp4", "/b.mp4"]));
        assert_eq!(i.subscribe(), Vec::<String>::new(), "not twice");
    }

    #[test]
    fn delivered_after_subscribe_is_emitted_not_buffered() {
        let mut i = Inbox::default();
        assert!(i.subscribe().is_empty());
        assert_eq!(i.deliver(s(&["/a.mp4"])), Some(s(&["/a.mp4"])));
        assert!(i.subscribe().is_empty(), "not also buffered");
    }

    #[test]
    fn a_page_reset_buffers_until_the_new_page_subscribes() {
        // R2-N4: subscribe, reset on page load, deliver, subscribe again.
        let mut i = Inbox::default();
        i.subscribe();
        i.reset();
        assert_eq!(i.deliver(s(&["/c.mp4"])), None, "no listener on the new page yet");
        assert_eq!(i.subscribe(), s(&["/c.mp4"]));
        assert!(i.subscribe().is_empty());
        assert_eq!(i.deliver(s(&["/d.mp4"])), Some(s(&["/d.mp4"])));
    }

    #[test]
    fn args_keep_only_files() {
        let f = tempfile::Builder::new().suffix(".mp4").tempfile().unwrap();
        let p = f.path().to_string_lossy().into_owned();
        let got = paths_from_args([p.as_str(), "-psn_0_123", "--flag", "/nonexistent/x.mp4"]);
        assert_eq!(got, vec![p]);
    }
}

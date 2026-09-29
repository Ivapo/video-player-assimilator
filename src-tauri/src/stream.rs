//! The `stream:` scheme (spec vpa-001 §2.9): serves byte ranges of files the user opened,
//! at most 1 MiB per answer, and nothing else.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, UriSchemeResponder};

/// The largest body one answer carries.
pub const CHUNK: u64 = 1024 * 1024;

/// Paths the user opened in this process, through the dialog or a file-open event (§2.10).
/// Each is stored as delivered and, when `canonicalize` succeeds at open time, in canonical
/// form, so a deleted file still matches (and answers 404) and an alias of an opened file
/// matches through its own canonical form (review round 1, R1-B5).
#[derive(Default)]
pub struct AllowList {
    delivered: HashSet<PathBuf>,
    canonical: HashSet<PathBuf>,
}

impl AllowList {
    pub fn add(&mut self, path: &Path) {
        self.delivered.insert(path.to_path_buf());
        if let Ok(c) = std::fs::canonicalize(path) {
            self.canonical.insert(c);
        }
    }

    pub fn allows(&self, path: &Path) -> bool {
        self.delivered.contains(path)
            || self.canonical.contains(path)
            || std::fs::canonicalize(path).is_ok_and(|c| self.canonical.contains(&c))
    }
}

/// The app's allow-list, shared by the handler and the file-open paths.
#[derive(Default)]
pub struct Allowed(Mutex<AllowList>);

impl Allowed {
    pub fn add(&self, path: &Path) {
        lock(&self.0).add(path);
    }
    pub fn allows(&self, path: &Path) -> bool {
        lock(&self.0).allows(path)
    }
}

/// A poisoned lock (a panic elsewhere while holding it) still holds a valid list.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The file path a request names: `/<percent-encoded absolute path>`.
pub fn request_path(req: &Request<Vec<u8>>) -> PathBuf {
    let raw = req.uri().path().strip_prefix('/').unwrap_or(req.uri().path());
    PathBuf::from(percent_encoding::percent_decode_str(raw).decode_utf8_lossy().into_owned())
}

fn base() -> tauri::http::response::Builder {
    // Every answer, errors included: without them the page sees only "Load failed".
    Response::builder()
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "content-range, accept-ranges, content-length")
        .header(header::ACCEPT_RANGES, "bytes")
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    base().status(code).body(Vec::new()).expect("static response")
}

/// The answer to one request, for a path already checked against the allow-list.
pub fn respond(method: &Method, range: Option<&str>, path: &Path, allowed: bool) -> Response<Vec<u8>> {
    if !allowed {
        return status(StatusCode::FORBIDDEN);
    }
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return status(StatusCode::NOT_FOUND),
        Err(_) => return status(StatusCode::FORBIDDEN),
    };
    let len = match file.metadata() {
        Ok(m) if m.is_file() => m.len(),
        _ => return status(StatusCode::FORBIDDEN),
    };
    let is_mp4 = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("mp4"));
    let mime = if is_mp4 { "video/mp4" } else { "application/octet-stream" };
    if method == Method::HEAD {
        return base()
            .header(header::CONTENT_TYPE, mime)
            .header(header::CONTENT_LENGTH, len)
            .body(Vec::new())
            .expect("static response");
    }
    // No Range: the first chunk as a 206, not the whole file as a 200. A deliberate departure
    // from HTTP; WebKit's media stack always sends Range.
    let Some((start, end)) = parse_range(range.unwrap_or("bytes=0-"), len) else {
        return base()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(Vec::new())
            .expect("static response");
    };
    let end = end.min(start + CHUNK - 1);
    let mut buf = vec![0u8; (end + 1 - start) as usize];
    if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut buf)).is_err() {
        return status(StatusCode::INTERNAL_SERVER_ERROR);
    }
    base()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
        .header(header::CONTENT_LENGTH, buf.len())
        .body(buf)
        .expect("static response")
}

/// A single range, `bytes=a-b`, `bytes=a-` or `bytes=-n`, with the end clamped to the file.
/// None if it is malformed, multi-range or unsatisfiable.
pub fn parse_range(h: &str, len: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", "") => return None,
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            if n == 0 {
                return None;
            }
            (len.saturating_sub(n), len - 1)
        }
        (a, "") => (a.parse().ok()?, len - 1),
        (a, b) => (a.parse().ok()?, b.parse::<u64>().ok()?.min(len - 1)),
    };
    (start < len && start <= end).then_some((start, end))
}

/// Answers one request on its own thread. Every request gets an answer: a panic is caught
/// and answered with 500, so no seek waits forever on it.
pub fn handle(app: &AppHandle, req: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let t0 = std::time::Instant::now();
    let path = request_path(&req);
    let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let allowed = app.state::<Allowed>().allows(&path);
        respond(req.method(), range.as_deref(), &path, allowed)
    }));
    let res = res.unwrap_or_else(|_| {
        log::line(&format!("PANIC {} range={} path={}", req.method(), range.as_deref().unwrap_or("-"), path.display()));
        status(StatusCode::INTERNAL_SERVER_ERROR)
    });
    log::line(&format!(
        "{} range={} -> {} cr={} {}B {}us path={}",
        req.method(),
        range.as_deref().unwrap_or("-"),
        res.status().as_u16(),
        res.headers().get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).unwrap_or("-"),
        res.body().len(),
        t0.elapsed().as_micros(),
        path.display(),
    ));
    responder.respond(res);
}

/// The per-request log, `stream.log` in the app's log directory: in debug builds and the
/// gate build only, not in release (§2.9). Each line starts with the time in ms since the
/// Unix epoch.
#[cfg(any(debug_assertions, feature = "gate"))]
pub mod log {
    use std::io::Write;
    use std::sync::{Mutex, OnceLock};
    use tauri::Manager;

    static FILE: OnceLock<Mutex<std::fs::File>> = OnceLock::new();

    pub fn init(app: &tauri::AppHandle) {
        let Ok(dir) = app.path().app_log_dir() else { return };
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("stream.log")) {
            let _ = FILE.set(Mutex::new(f));
        }
    }

    pub fn line(s: &str) {
        let Some(f) = FILE.get() else { return };
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let mut f = f.lock().unwrap_or_else(|e| e.into_inner());
        let _ = writeln!(f, "{ms} {s}");
    }
}

#[cfg(not(any(debug_assertions, feature = "gate")))]
pub mod log {
    pub fn init(_: &tauri::AppHandle) {}
    pub fn line(_: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn get(range: Option<&str>, path: &Path) -> Response<Vec<u8>> {
        respond(&Method::GET, range, path, true)
    }
    fn hdr<'a>(r: &'a Response<Vec<u8>>, h: header::HeaderName) -> Option<&'a str> {
        r.headers().get(h).and_then(|v| v.to_str().ok())
    }
    fn file_of(len: usize) -> tempfile::NamedTempFile {
        let mut f = tempfile::Builder::new().suffix(".mp4").tempfile().unwrap();
        f.write_all(&(0..len).map(|i| (i % 251) as u8).collect::<Vec<_>>()).unwrap();
        f
    }

    #[test]
    fn parse_range_forms() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=100-", 1000), Some((100, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=900-5000", 1000), Some((900, 999)), "end clamped");
        assert_eq!(parse_range(" bytes=1-1 ", 1000), Some((1, 1)));
    }

    #[test]
    fn parse_range_rejects() {
        for h in ["bytes=1000-", "bytes=2000-3000", "bytes=99-10", "bytes=abc", "bytes=0-9,20-29", "bytes=-0",
            "bytes=-", "items=0-1", "0-99", ""]
        {
            assert_eq!(parse_range(h, 1000), None, "{h}");
        }
        assert_eq!(parse_range("bytes=0-", 0), None, "empty file");
    }

    #[test]
    fn allow_list_matches_delivered_or_canonical() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("a b.mp4");
        std::fs::write(&real, b"x").unwrap();
        let other = dir.path().join("other.mp4");
        std::fs::write(&other, b"x").unwrap();
        let mut a = AllowList::default();
        assert!(!a.allows(&real), "never opened");
        a.add(&real);
        assert!(a.allows(&real));
        assert!(a.allows(&dir.path().join(".").join("a b.mp4")), "an alias, through its canonical form");
        assert!(!a.allows(&other), "a sibling never opened");
        #[cfg(unix)]
        {
            let link = dir.path().join("link.mp4");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert!(a.allows(&link), "a symlink to an opened file");
            let link2 = dir.path().join("link2.mp4");
            std::os::unix::fs::symlink(&other, &link2).unwrap();
            assert!(!a.allows(&link2), "a symlink to a file never opened");
        }
        std::fs::remove_file(&real).unwrap();
        assert!(a.allows(&real), "deleted after opening: still matched, so it answers 404");
        assert_eq!(respond(&Method::GET, None, &real, a.allows(&real)).status(), 404);
    }

    #[test]
    fn statuses_and_cors() {
        let f = file_of(52_036);
        let p = f.path();
        let forbidden = respond(&Method::GET, Some("bytes=0-1"), p, false);
        let missing = get(None, Path::new("/nonexistent/vpa-missing.mp4"));
        let bad = get(Some("bytes=abc"), p);
        let multi = get(Some("bytes=0-9,20-29"), p);
        let out = get(Some("bytes=60000-"), p);
        assert_eq!(forbidden.status(), 403);
        assert_eq!(missing.status(), 404);
        for r in [&bad, &multi, &out] {
            assert_eq!(r.status(), 416);
            assert_eq!(hdr(r, header::CONTENT_RANGE), Some("bytes */52036"));
        }
        for r in [&forbidden, &missing, &bad, &multi, &out] {
            assert_eq!(hdr(r, header::ACCESS_CONTROL_ALLOW_ORIGIN), Some("*"));
            assert!(hdr(r, header::ACCESS_CONTROL_EXPOSE_HEADERS).unwrap().contains("content-range"));
            assert!(r.body().is_empty());
        }
    }

    #[test]
    fn ranges_answer_the_right_bytes() {
        let f = file_of(52_036);
        let all = std::fs::read(f.path()).unwrap();
        let head = respond(&Method::HEAD, None, f.path(), true);
        assert_eq!(head.status(), 200);
        assert_eq!(hdr(&head, header::CONTENT_LENGTH), Some("52036"));
        assert_eq!(hdr(&head, header::CONTENT_TYPE), Some("video/mp4"));
        for (range, a, b) in [("bytes=0-99", 0, 99), ("bytes=100-", 100, 52_035), ("bytes=-100", 51_936, 52_035)] {
            let r = get(Some(range), f.path());
            assert_eq!(r.status(), 206, "{range}");
            assert_eq!(hdr(&r, header::CONTENT_RANGE), Some(format!("bytes {a}-{b}/52036").as_str()));
            assert_eq!(r.body().as_slice(), &all[a..=b]);
            assert_eq!(hdr(&r, header::ACCESS_CONTROL_ALLOW_ORIGIN), Some("*"));
        }
    }

    #[test]
    fn at_most_one_mib() {
        let f = file_of(3 * 1024 * 1024 + 17);
        let len = 3 * 1024 * 1024 + 17;
        for range in [Some("bytes=0-2097151"), Some("bytes=0-"), None] {
            let r = get(range, f.path());
            assert_eq!(r.status(), 206, "{range:?}");
            assert_eq!(r.body().len(), 1_048_576);
            assert_eq!(hdr(&r, header::CONTENT_RANGE), Some(format!("bytes 0-1048575/{len}").as_str()));
        }
        let r = get(Some("bytes=-10"), f.path());
        assert_eq!(r.body().len(), 10);
    }

    #[test]
    fn content_type_by_extension() {
        let mut f = tempfile::Builder::new().suffix(".bin").tempfile().unwrap();
        f.write_all(b"abc").unwrap();
        let r = get(None, f.path());
        assert_eq!(hdr(&r, header::CONTENT_TYPE), Some("application/octet-stream"));
    }

    #[test]
    fn request_path_decodes() {
        let p = "/Users/me/dir with spaces & ünï/%20#?.mp4";
        let enc = percent_encoding::utf8_percent_encode(p, percent_encoding::NON_ALPHANUMERIC).to_string();
        let req = Request::builder().uri(format!("stream://localhost/{enc}")).body(Vec::new()).unwrap();
        assert_eq!(request_path(&req), PathBuf::from(p));
    }
}

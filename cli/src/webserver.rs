// The web server of `sushila serve`:
//   /                         the page (web/sushila_page.js): Chat, Code, Images, Music, Video, Queue, managing Sushila
//   /api/state                the public part of state.json (installed packs, running models)
//   /api/mode, /api/queue...  mode switches and the background queue (request files in data_dir, applied by the owner)
//   /api/control, /api/logs   install, remove, start, stop... and the shared log (this computer only; applied by sushila serve)
//   /api/shutdown             asks the owner to stop (this computer only; the sushila command honours it)
//   /v1/*, /health            forwarded to the running Sushila Engine for the named model (OpenAI-compatible)
// Only this computer may call it unless sharing is on (state.json "share"): then the listed host names and access keys.
use std::{collections::HashMap, path::{Path, PathBuf}, sync::Arc, time::Duration};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use crate::net::client;

pub const APP_JS: &str = include_str!("../web/sushila_page.js");
/// The documentation (one self-contained file; the website can serve the same file).
pub const DOCS_HTML: &str = include_str!("../web/sushila_docs.html");
/// Example prompts for new pictures (one per line, # = note): the Random button on the picture page (app and browser).
const IMAGE_PROMPTS: &str = include_str!("../web/prompts/images.txt");
pub fn image_prompts() -> Vec<&'static str> { IMAGE_PROMPTS.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).collect() }

// Sushila Station's own screens (a copy of station/dist, checked equal by check_sync.sh) plus bridge.js, which turns the
// app's requests into requests to this engine: the preview of one design for the app and the browser, at /station/.
const STATION_FILES: &[(&str, &str, &[u8])] = &[
    ("index.html", "text/html; charset=utf-8", include_bytes!("../web/station/index.html")),
    ("app.js", "text/javascript; charset=utf-8", include_bytes!("../web/station/app.js")),
    ("bridge.js", "text/javascript; charset=utf-8", include_bytes!("../web/station/bridge.js")),
    ("app.css", "text/css; charset=utf-8", include_bytes!("../web/station/app.css")),
    ("ipad.css", "text/css; charset=utf-8", include_bytes!("../web/station/ipad.css")),
    ("logo.png", "image/png", include_bytes!("../web/station/logo.png")),
];
/// Sushila's logo, as on sushila.ai: the favicon in three sizes and the logo animation (logo/SushilaLogoWithBaseG.mp4,
/// the swan cropped square, 72 px, 12 frames a second, played once) for the header of every page.
const BRAND: [(&str, &str, &[u8]); 7] = [
    ("/favicon.ico", "image/png", include_bytes!("../web/brand/sushila-logo-32.png")),
    ("/favicon-32.png", "image/png", include_bytes!("../web/brand/sushila-logo-32.png")),
    ("/favicon.png", "image/png", include_bytes!("../web/brand/sushila-logo-64.png")),
    ("/apple-touch-icon.png", "image/png", include_bytes!("../web/brand/sushila-logo-180.png")),
    ("/brand/logo-anim.webp", "image/webp", include_bytes!("../web/brand/logo-anim.webp")),
    ("/brand/logo.png", "image/png", include_bytes!("../web/brand/logo-still.png")),
    ("/brand/logo-64.png", "image/png", include_bytes!("../web/brand/sushila-logo-64.png")),
];
async fn srv_brand(uri: axum::http::Uri) -> axum::response::Response {
    use axum::response::IntoResponse;
    match BRAND.iter().find(|(p, _, _)| *p == uri.path()) {
        Some((_, ct, b)) => ([("content-type", *ct), ("cache-control", "public, max-age=86400")], *b).into_response(),
        None => (axum::http::StatusCode::NOT_FOUND, "not found").into_response(),
    }
}
const PAGE_HTML: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sushila Inference</title><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="icon" type="image/png" sizes="64x64" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"></head><body><div id="app"></div><script src="/sushila.js"></script></body></html>"#;

// ---------- local web server ----------
pub struct Srv { port: u16, data_dir: PathBuf, http: reqwest::Client, hits: std::sync::Mutex<HashMap<String, (u32, std::time::Instant)>>,
                 metrics: std::sync::Mutex<Metrics>, started: std::time::Instant }

/// Counters for /metrics (Prometheus text format), per model.
#[derive(Default)]
pub struct Metrics { requests: HashMap<(String, u16), u64>, inflight: HashMap<String, i64>, rejected: HashMap<String, u64>, seconds: HashMap<String, (f64, u64)> }

/// Per model: requests in flight and the last use (for unloading idle models), and the models unloaded for being idle
/// (a request for one starts it again). Shared with the owner loop, which runs in the same process.
static USE: std::sync::LazyLock<std::sync::Mutex<HashMap<String, (i64, std::time::SystemTime)>>> = std::sync::LazyLock::new(Default::default);
static IDLE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::LazyLock::new(Default::default);
pub fn touch(model: &str, d: i64) { if let Ok(mut u) = USE.lock() { let e = u.entry(model.to_string()).or_insert((0, std::time::SystemTime::now())); e.0 += d; e.1 = std::time::SystemTime::now(); } }
static SERVED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Requests forwarded to models since the server started (the ticker shows it).
pub fn requests_served() -> u64 { SERVED.load(std::sync::atomic::Ordering::Relaxed) }
pub fn in_flight(model: &str) -> i64 { USE.lock().ok().and_then(|u| u.get(model).map(|x| x.0)).unwrap_or(0) }
pub fn last_use(model: &str) -> Option<std::time::SystemTime> { USE.lock().ok().and_then(|u| u.get(model).map(|x| x.1)) }
pub fn mark_idle(model: &str, idle: bool) { if let Ok(mut s) = IDLE.lock() { if idle { s.insert(model.to_string()); } else { s.remove(model); } } }
fn was_idle(model: &str) -> bool { IDLE.lock().map(|s| s.contains(model)).unwrap_or(false) }

/// Asks the owner to start a model (a control request, like the Admin tab's Start) and waits until it is ready.
pub async fn start_and_wait(dir: &Path, model: &str, secs: u64) -> Option<Value> {
    let st = read_state(dir);
    if st.get("running").and_then(|r| r.get(model)).and_then(|r| r.get("ready")).and_then(|x| x.as_bool()) == Some(true) { return Some(st); }
    if st.get("running").and_then(|r| r.get(model)).is_none() {
        let id = new_id().replacen("job-", "task-", 1);
        let _ = crate::util::post_request(dir, "control-in", &id, &json!({ "id": id, "action": "start", "pack": model, "source": "on demand" }));
    }
    for _ in 0..secs * 2 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let st = read_state(dir);
        if st.get("running").and_then(|r| r.get(model)).and_then(|r| r.get("ready")).and_then(|x| x.as_bool()) == Some(true) { return Some(st); }
    }
    None
}

/// One forwarded request: counted while in flight (admission control), timed, and logged with its request id when it
/// ends, including when a streamed answer finishes or the client disconnects.
struct InFlight { s: Arc<Srv>, model: String, rid: String, who: String, what: String, t0: std::time::Instant, status: u16 }
impl Drop for InFlight {
    fn drop(&mut self) {
        let secs = self.t0.elapsed().as_secs_f64();
        touch(&self.model, -1);
        SERVED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut m) = self.s.metrics.lock() {
            *m.inflight.entry(self.model.clone()).or_default() -= 1;
            *m.requests.entry((self.model.clone(), self.status)).or_default() += 1;
            let e = m.seconds.entry(self.model.clone()).or_default(); e.0 += secs; e.1 += 1;
        }
        crate::core::log(true, &format!("api {} {} {} {} -> {} in {:.0} ms", self.rid, self.who, self.model, self.what, self.status, secs * 1000.0));
    }
}
/// The request id: the caller's (x-request-id, e.g. from a reverse proxy) if it is sane, else a new one.
fn request_id(headers: &axum::http::HeaderMap) -> String {
    headers.get("x-request-id").and_then(|h| h.to_str().ok()).filter(|r| !r.is_empty() && r.len() <= 64 && r.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).map(String::from)
        .unwrap_or_else(|| { let mut b = [0u8; 8]; let _ = getrandom::getrandom(&mut b); format!("r-{}", hex::encode(b)) })
}
/// A caller's name for logs: local, open, or the access key's name.
fn who_name(who: &str, st: &Value) -> String {
    if who == "local" || who.starts_with("open") { return who.chars().take(13).collect(); }
    share(st).and_then(|sh| sh.get("keys")).and_then(|k| k.as_array()).and_then(|a| a.iter().find(|k| k.get("sha256").and_then(|x| x.as_str()) == Some(who)))
        .and_then(|k| k.get("name").and_then(|n| n.as_str())).map(|n| format!("key:{n}")).unwrap_or_else(|| "key".into())
}

// ---------- the Admin tab: no password. Who may manage Sushila is decided by where a request comes from: this computer's
// own page (http://localhost:<port>, its token, checked against the real connection) or the computer's owner through
// the internet link (an owner pass from sushila.ai, tunnel::owner_ok). The sushila commands run as the same user and
// also send <data>/admin-cli.token, a random file only that user can read.
/// A file only this user can read (Unix mode 600; on Windows the user's own AppData folder).
pub fn write_private(p: &Path, content: &str) -> Result<(), String> {
    std::fs::write(p, content).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600)); }
    Ok(())
}
pub fn cli_token(dir: &Path) -> String {
    let p = dir.join("admin-cli.token");
    if let Ok(t) = std::fs::read_to_string(&p) { if t.trim().len() >= 32 { return t.trim().to_string(); } }
    let mut b = [0u8; 24]; let _ = getrandom::getrandom(&mut b);
    let t = hex::encode(b); let _ = write_private(&p, &t); t
}
/// "This computer": a request whose connection really comes from this machine (loopback) and did not pass through a
/// proxy or tunnel, and which names this server by a local address. The connection's origin is set by `mark_peer`
/// (from the socket, never from the request), so another machine cannot claim it with a Host header.
const PEER_LOCAL: &str = "x-sushila-peer-local";
const PEER_IP: &str = "x-sushila-peer-ip";
fn this_computer(headers: &axum::http::HeaderMap, port: u16) -> bool {
    let host = headers.get("host").and_then(|h| h.to_str().ok()).unwrap_or("");
    headers.get(PEER_LOCAL).map(|v| v == "1").unwrap_or(false) && (host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}"))
}
/// The owner of the temporary internet URL, signed in at sushila.ai: the page sends the owner pass sushila.ai gave it
/// (as its token), checked by tunnel::owner_ok. The owner has everything this computer's own page has.
fn owner(headers: &axum::http::HeaderMap) -> bool {
    headers.get("x-sushila-token").and_then(|h| h.to_str().ok()).filter(|t| t.starts_with("owner.")).map(crate::tunnel::owner_ok).unwrap_or(false)
}
/// This computer, or its owner through the internet link.
fn local_host(headers: &axum::http::HeaderMap, port: u16) -> bool { this_computer(headers, port) || owner(headers) }
/// Requests per minute for another device: by access key, or in open mode by the caller's real address (an open-mode
/// visitor id is chosen by the browser, so it cannot be the limit). Windows older than a minute are dropped as the
/// map is used, so it holds only the last minute's callers.
fn rate_ok(s: &Srv, who: &str, headers: &axum::http::HeaderMap, st: &Value) -> bool {
    let per_min = share(st).and_then(|sh| sh.get("perMinute")).and_then(|v| v.as_u64()).unwrap_or(30).max(1) as u32;
    let bucket = if who.starts_with("open") { format!("ip-{}", peer_ip(headers)) } else { who.to_string() };
    let mut hits = s.hits.lock().unwrap();
    if hits.len() > 256 { hits.retain(|_, (_, t)| t.elapsed() < Duration::from_secs(60)); }
    let e = hits.entry(bucket).or_insert((0, std::time::Instant::now()));
    if e.1.elapsed() > Duration::from_secs(60) { *e = (0, std::time::Instant::now()); }
    e.0 += 1;
    e.0 <= per_min
}
/// A file sent in pieces (never read whole into memory), with Range support so players can seek: one byte range
/// ("bytes=a-b", "bytes=a-", "bytes=-n"); anything else gets the whole file.
async fn file_response(p: &Path, mime: &str, disp: String, cache: &str, range: Option<&axum::http::HeaderValue>) -> axum::response::Response {
    use axum::response::IntoResponse;
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let Ok(mut f) = tokio::fs::File::open(p).await else { return (axum::http::StatusCode::NOT_FOUND, "not found").into_response() };
    let Ok(len) = f.metadata().await.map(|m| m.len()) else { return (axum::http::StatusCode::NOT_FOUND, "not found").into_response() };
    let want = range.and_then(|r| r.to_str().ok()).and_then(|r| parse_range(r, len));
    let mut h = axum::http::HeaderMap::new();
    for (k, v) in [("content-type", mime), ("content-disposition", disp.as_str()), ("cache-control", cache), ("accept-ranges", "bytes"), ("x-content-type-options", "nosniff"), ("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'")] {
        if let Ok(v) = axum::http::HeaderValue::from_str(v) { h.insert(k, v); }
    }
    let (status, start, n) = match want {
        Some((a, b)) => { if let Ok(v) = axum::http::HeaderValue::from_str(&format!("bytes {a}-{b}/{len}")) { h.insert("content-range", v); } (axum::http::StatusCode::PARTIAL_CONTENT, a, b - a + 1) }
        None if range.is_some() && len > 0 && range.and_then(|r| r.to_str().ok()).map(|r| r.starts_with("bytes=")).unwrap_or(false) => {
            if let Ok(v) = axum::http::HeaderValue::from_str(&format!("bytes */{len}")) { h.insert("content-range", v); }
            return (axum::http::StatusCode::RANGE_NOT_SATISFIABLE, h).into_response();
        }
        None => (axum::http::StatusCode::OK, 0, len),
    };
    if start > 0 && f.seek(std::io::SeekFrom::Start(start)).await.is_err() { return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "could not read the file").into_response(); }
    if let Ok(v) = axum::http::HeaderValue::from_str(&n.to_string()) { h.insert("content-length", v); }
    (status, h, axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(f.take(n)))).into_response()
}
/// "bytes=a-b" / "bytes=a-" / "bytes=-n" within a file of `len` bytes -> (first, last), inclusive.
fn parse_range(r: &str, len: u64) -> Option<(u64, u64)> {
    let spec = r.strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 { return None; }
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    let (first, last) = if a.is_empty() { let n: u64 = b.parse().ok()?; if n == 0 { return None; } (len.saturating_sub(n), len - 1) }
        else { let first: u64 = a.parse().ok()?; let last = if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) }; (first, last) };
    (first <= last && first < len).then_some((first, last))
}
/// A path that may be forwarded to an engine: no "." or ".." segment, no encoded dot, slash or backslash, no backslash
/// (the query cannot change the path, so it is not checked).
fn proxy_path_ok(path: &str) -> bool {
    let low = path.to_ascii_lowercase();
    !path.split('/').any(|seg| seg == "." || seg == "..") && !path.contains('\\') && !["%2e", "%2f", "%5c"].iter().any(|e| low.contains(e))
}
/// The model server path for an API path, or None: only these are forwarded (OpenAI-style text, embeddings and images;
/// ACE-Step's /lm, /synth, /job; stable-diffusion.cpp's video jobs). The prefix must end at a "/".
fn upstream_path(path: &str) -> Option<String> {
    const OPENAI: [&str; 6] = ["/v1/chat/completions", "/v1/completions", "/v1/embeddings", "/v1/models", "/v1/images/generations", "/v1/rerank"];
    if OPENAI.contains(&path) { return Some(path.to_string()); }
    if let Some(r) = path.strip_prefix("/v1/music/") { return ["lm", "synth", "job"].contains(&r).then(|| format!("/{r}")); }
    if let Some(r) = path.strip_prefix("/v1/video/") {
        if r == "vid_gen" { return Some("/sdcpp/v1/vid_gen".into()); }
        let mut seg = r.splitn(3, '/');
        if let (Some("jobs"), Some(id)) = (seg.next(), seg.next()) {
            let tail = seg.next();
            if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') && matches!(tail, None | Some("cancel")) {
                return Some(format!("/sdcpp/v1/jobs/{id}{}", if tail.is_some() { "/cancel" } else { "" }));
            }
        }
    }
    None
}
/// http://127.0.0.1:<port><path>?<query>, made by the URL parser and checked: host 127.0.0.1, that port, that path.
fn upstream_url(port: u16, path: &str, query: Option<&str>) -> Option<reqwest::Url> {
    let mut u = reqwest::Url::parse("http://127.0.0.1/").ok()?;
    u.set_port(Some(port)).ok()?;
    u.set_path(path);
    u.set_query(query);
    (u.host_str() == Some("127.0.0.1") && u.port() == Some(port) && u.path() == path).then_some(u)
}
/// The peer's IP address (from the socket), for rate limits.
fn peer_ip(headers: &axum::http::HeaderMap) -> String { headers.get(PEER_IP).and_then(|v| v.to_str().ok()).unwrap_or("?").to_string() }
/// Every request passes here first: what the request says about its own origin is removed, and the socket's truth is
/// written instead. A request through cloudflared also arrives from 127.0.0.1, but carries Cloudflare's headers.
async fn mark_peer(axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>, mut req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    let h = req.headers_mut();
    h.remove(PEER_LOCAL); h.remove(PEER_IP);
    let proxied = ["cf-connecting-ip", "cf-ray", "cdn-loop", "x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip"].iter().any(|k| h.contains_key(*k));
    // and it names this computer: a request through cloudflared names the tunnel's host (even if a proxy header were missing)
    let host = h.get("host").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    let host_name = host.rsplit_once(':').map(|(n, p)| if p.chars().all(|c| c.is_ascii_digit()) { n } else { host.as_str() }).unwrap_or(host.as_str());
    let names_local = matches!(host_name, "localhost" | "127.0.0.1" | "[::1]");
    if peer.ip().is_loopback() && !proxied && names_local { h.insert(PEER_LOCAL, axum::http::HeaderValue::from_static("1")); }
    if let Ok(v) = axum::http::HeaderValue::from_str(&peer.ip().to_string()) { h.insert(PEER_IP, v); }
    next.run(req).await
}
/// Admin requests: this computer's own page or its owner through the internet link (the local token or the owner pass,
/// which also keeps other web sites from sending admin requests: a custom header they cannot add without asking), or
/// the sushila commands with their token.
fn admin_ok(s: &Srv, headers: &axum::http::HeaderMap, st: &Value) -> bool {
    if !host_ok(headers, s.port, st) || !local_host(headers, s.port) { return false; }
    if caller(headers, st).as_deref() == Some("local") { return true; }
    let given = headers.get("x-sushila-admin").and_then(|h| h.to_str().ok()).unwrap_or("");
    given.len() >= 32 && given == cli_token(&s.data_dir)
}

// Sharing (Settings -> Share on the network), read from state.json on every request:
//   share.enabled        accept requests from other machines (the server then listens on share.bind, e.g. 0.0.0.0)
//   share.hosts          host names a browser or reverse proxy may use, e.g. ["ai.example.com"]; "*" accepts any
//   share.keys           [{name, sha256}] of access keys; callers send "Authorization: Bearer <key>"
//   share.perMinute      requests per minute per key
fn share(st: &Value) -> Option<&Value> { st.get("share").filter(|s| s.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false)) }

/// state.json as the owner last wrote it. Kept in memory and re-read only when the file changed (its time or size),
/// so a request costs one file-status check instead of reading and parsing the file.
pub fn read_state(dir: &Path) -> Value {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, (std::time::SystemTime, u64, Value)>>> = std::sync::OnceLock::new();
    let p = dir.join("state.json");
    let Ok(meta) = std::fs::metadata(&p) else { return Value::Null };
    let stamp = (meta.modified().unwrap_or(std::time::UNIX_EPOCH), meta.len());
    let cache = CACHE.get_or_init(Default::default);
    if let Some((t, n, v)) = cache.lock().unwrap().get(&p) { if (*t, *n) == stamp { return v.clone(); } }
    let v: Value = std::fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    cache.lock().unwrap().insert(p, (stamp.0, stamp.1, v.clone()));
    v
}

fn host_ok(headers: &axum::http::HeaderMap, port: u16, st: &Value) -> bool {
    // Local use: only pages on this machine (blocks DNS-rebinding pages from other sites). Shared: also the configured
    // public host names (as sent by browsers or a reverse proxy).
    let host = headers.get("host").and_then(|h| h.to_str().ok()).unwrap_or("");
    if local_host(headers, port) { return true; }
    let Some(sh) = share(st) else { return false };
    let name = host.rsplit_once(':').map(|(h, p)| if p.chars().all(|c| c.is_ascii_digit()) { h } else { host }).unwrap_or(host).to_ascii_lowercase();
    sh.get("hosts").and_then(|h| h.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).any(|x| x == "*" || x.eq_ignore_ascii_case(&name))).unwrap_or(false)
}

/// Who is calling: the local session token, or (when sharing) a valid access key. Returns the rate-limit bucket.
fn caller(headers: &axum::http::HeaderMap, st: &Value) -> Option<String> {
    let token = st.get("token").and_then(|t| t.as_str()).unwrap_or("");
    let given = headers.get("x-sushila-token").and_then(|h| h.to_str().ok()).unwrap_or("");
    // the token counts only on a connection that really comes from this computer (not through a proxy or tunnel)
    if !token.is_empty() && given == token && headers.get(PEER_LOCAL).map(|v| v == "1").unwrap_or(false) { return Some("local".into()); }
    if owner(headers) { return Some("local".into()); }
    let sh = share(st)?;
    let keyed = headers.get("authorization").and_then(|h| h.to_str().ok()).and_then(|h| h.strip_prefix("Bearer ")).map(|k| k.trim())
        .filter(|k| k.len() >= 20).map(|k| hex::encode(Sha256::digest(k.as_bytes())))
        .filter(|h| sh.get("keys").and_then(|k| k.as_array()).map(|a| a.iter().any(|k| k.get("sha256").and_then(|x| x.as_str()) == Some(h.as_str()))).unwrap_or(false));
    // share.open (sushila serve --open, a trusted network): anyone who can reach the port may chat and generate, without a
    // key (one shared rate-limit bucket); managing Sushila stays this computer's only
    // in open mode each browser is its own anonymous user (x-sushila-visitor, a random id the page keeps), so visitors
    // never see each other's queue jobs
    // open mode is for a trusted local network: never through the internet link (cloudflared, sushila.ai)
    let through_tunnel = headers.contains_key("cf-connecting-ip") || headers.contains_key("cf-ray")
        || headers.get("host").and_then(|h| h.to_str().ok()).map(|h| h.to_ascii_lowercase().contains(".trycloudflare.com")).unwrap_or(false);
    // ... and only for this server's own pages: a request another web site's page makes (its Origin names another host) is refused
    let host = headers.get("host").and_then(|h| h.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    let foreign_page = headers.get("origin").and_then(|o| o.to_str().ok()).map(|o| { let o = o.to_ascii_lowercase(); o != format!("http://{host}") && o != format!("https://{host}") }).unwrap_or(false);
    keyed.or_else(|| sh.get("open").and_then(|o| o.as_bool()).filter(|o| *o && !through_tunnel && !foreign_page).map(|_| {
        headers.get("x-sushila-visitor").and_then(|h| h.to_str().ok()).filter(|v| v.len() >= 16 && v.len() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric()))
            .map(|v| format!("open-{v}")).unwrap_or_else(|| "open".to_string())
    }))
}

async fn srv_page(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !host_ok(&headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    // Opened on this computer (http://localhost:<port>/ or 127.0.0.1): the page carries this computer's token, so the
    // address alone is enough. Other sites cannot read this page (no CORS on /), and it may not be framed.
    // (never through the internet link, not even for its owner: the owner's page has its own pass)
    let local = this_computer(&headers, s.port);
    let html = match (local, st.get("token").and_then(|t| t.as_str())) {
        (true, Some(t)) => PAGE_HTML.replace("<div id=\"app\"></div>", &format!("<div id=\"app\"></div><script>window.SUSHILA_TOKEN={};</script>", Value::String(t.to_string()))),
        _ => PAGE_HTML.to_string(),
    };
    ([("content-type", "text/html; charset=utf-8"), ("cache-control", "no-store"), ("x-frame-options", "DENY"), ("referrer-policy", "no-referrer")], html).into_response()
}

/// GET /api/prompts/images: the example prompts for new pictures ({prompts: [...]}); the same list for everyone.
async fn srv_prompts(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !host_ok(&headers, s.port, &read_state(&s.data_dir)) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    ([("cache-control", "max-age=3600")], axum::Json(json!({ "prompts": image_prompts() }))).into_response()
}

/// GET /api/notifications: the messages sushila.ai asks every Sushila app to show at start (sushilaai-notifications rows
/// with active = true). Asked at most once an hour; kept in <home>/notifications.json, so they still show offline (and
/// an answer that fails keeps the last good one). Plain text, title, an optional https:// link: the pages make links clickable.
async fn srv_notifications(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !host_ok(&headers, s.port, &read_state(&s.data_dir)) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    static LAST: std::sync::LazyLock<tokio::sync::Mutex<Option<std::time::Instant>>> = std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));
    let file = s.data_dir.join("notifications.json");
    let mut last = LAST.lock().await;  // one question to sushila.ai at a time
    if last.map(|t| t.elapsed() > Duration::from_secs(3600)).unwrap_or(true) || !file.exists() {
        *last = Some(std::time::Instant::now());
        let url = format!("{}/api/notifications", crate::share::site(&s.data_dir));
        let got = async {
            let u = crate::net::check_url(&url, false)?;
            let r = crate::net::client()?.get(u).timeout(Duration::from_secs(5)).send().await.map_err(|e| e.to_string())?;
            if !r.status().is_success() { return Err(format!("HTTP {}", r.status())); }
            r.json::<Value>().await.map_err(|e| e.to_string())
        }.await;
        match got {
            Ok(v) if v["notifications"].is_array() => { let _ = crate::util::write_atomic(&file, v.to_string().as_bytes()); }
            Ok(_) => {}
            Err(e) => crate::core::log(true, &format!("notifications: sushila.ai did not answer ({e}); showing the last ones")),
        }
    }
    let v = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v["notifications"].is_array()).unwrap_or(json!({ "notifications": [] }));
    ([("cache-control", "no-store")], axum::Json(v)).into_response()
}

/// GET /station/ and /station/<file>: Sushila Station's screens in the browser, on this computer only (the page carries
/// this computer's token, like /). /station without the slash goes to /station/ so the files' relative names work.
async fn srv_station(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap, uri: axum::http::Uri) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !host_ok(&headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    if !this_computer(&headers, s.port) {
        return (axum::http::StatusCode::FORBIDDEN, "The Sushila Station page opens on this computer only: http://localhost:7874/station/").into_response();
    }
    let path = uri.path();
    if path == "/station" { return ([("location", "/station/")], axum::http::StatusCode::MOVED_PERMANENTLY).into_response(); }
    let name = path.strip_prefix("/station/").filter(|n| !n.is_empty()).unwrap_or("index.html");
    let Some((_, ctype, bytes)) = STATION_FILES.iter().find(|(n, _, _)| *n == name) else { return (axum::http::StatusCode::NOT_FOUND, "not found").into_response(); };
    let mut body = bytes.to_vec();
    if name == "index.html" {
        let tok = st.get("token").and_then(|t| t.as_str()).unwrap_or("");
        let html = String::from_utf8_lossy(bytes).replace("<script src=\"app.js\"></script>",
            &format!("<script>window.SUSHILA_TOKEN={};</script><script src=\"bridge.js\"></script><script src=\"app.js\"></script>", Value::String(tok.to_string())));
        body = html.into_bytes();
    }
    ([("content-type", *ctype), ("cache-control", "no-store"), ("x-frame-options", "DENY"), ("referrer-policy", "no-referrer")], body).into_response()
}

async fn srv_js(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !host_ok(&headers, s.port, &read_state(&s.data_dir)) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    ([("content-type", "text/javascript; charset=utf-8"), ("cache-control", "no-store")], APP_JS).into_response()
}

/// When sharing, pages on other sites (e.g. an inference page on another computer pointed at this server) may call
/// /api/state and /v1/*: they authenticate with an access key, never with cookies, so any origin is allowed.
/// The Host Station window itself (tauri://localhost, http(s)://tauri.localhost) may always call it ("Generate here").
fn with_cors_for(mut resp: axum::response::Response, st: &Value, origin: Option<&str>) -> axum::response::Response {
    let app_window = matches!(origin, Some("tauri://localhost") | Some("http://tauri.localhost") | Some("https://tauri.localhost"));
    if share(st).is_some() || app_window {
        let h = resp.headers_mut();
        let allow = if app_window { axum::http::HeaderValue::from_str(origin.unwrap()).unwrap_or(axum::http::HeaderValue::from_static("*")) } else { axum::http::HeaderValue::from_static("*") };
        h.insert("access-control-allow-origin", allow);
        h.insert("access-control-allow-headers", axum::http::HeaderValue::from_static("authorization, content-type, x-sushila-model, x-sushila-token, x-sushila-visitor, x-request-id"));
        h.insert("access-control-allow-methods", axum::http::HeaderValue::from_static("GET, POST, OPTIONS"));
    }
    resp
}

fn with_cors(resp: axum::response::Response, st: &Value) -> axum::response::Response { with_cors_for(resp, st, None) }

async fn srv_state(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !host_ok(&headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    // only the "public" part of the Host Station state (models and what runs): never the session token or keys
    let origin = headers.get("origin").and_then(|o| o.to_str().ok()).map(String::from);
    let mut v = st.get("public").cloned().unwrap_or(json!({}));
    if v.get("appVersion").and_then(|x| x.as_str()).map(|x| x.is_empty()).unwrap_or(true) { v["appVersion"] = json!(env!("CARGO_PKG_VERSION")); }  // this program's version, always
    if local_host(&headers, s.port) {  // the page on this computer (http://localhost:<port>/)
        v["now"] = crate::util::progress_now();  // downloads in progress (for the Admin page)
        // this computer's full state: never with CORS (other web sites open in this browser must not read it)
        if this_computer(&headers, s.port) { return axum::Json(v).into_response(); }
    } else {
        // another device (the network, or a temporary internet URL): only what the Inference page needs - which
        // models run - never this computer's packs, settings, recent actions or downloads
        let running: Vec<Value> = v["running"].as_array().cloned().unwrap_or_default().into_iter()
            .map(|r| json!({ "packId": r["packId"], "name": r["name"], "kind": r["kind"], "category": r["category"], "mode": r["mode"], "turbo": r["turbo"], "ready": r["ready"] })).collect();
        v = json!({ "app": v["app"], "appVersion": v["appVersion"], "running": running, "packs": [], "remote": true });
    }
    with_cors_for(axum::Json(v).into_response(), &st, origin.as_deref())
}

/// The Library (this computer only): GET /api/library -> {folder, items, trash: [...]}, GET /api/library/file?rel=&trash=1
/// (the file itself, for previews; ?t= carries the token for <img>/<audio>/<video>), POST /api/library/<delete|restore|purge|empty>
/// {"rel": ...}.
// Picture, song and video addresses (<img>/<audio>/<video> cannot send headers) carry ?t=. On the owner's internet-link
// page that is a media token, never the owner pass: "media.<expiry ms>.<HMAC of it with this computer's token>", good
// for one hour and only for reading the Library's files and queue outputs, so an address that ends up in a browser's
// history or a log cannot manage this computer.
const MEDIA_MS: u64 = 3_600_000;
pub(crate) fn media_token(local_token: &str, now_ms: u64) -> String {
    let exp = now_ms + MEDIA_MS;
    format!("media.{exp}.{}", hex::encode(crate::tunnel::hmac_sha256(local_token.as_bytes(), format!("sushila-media|{exp}").as_bytes())))
}
pub(crate) fn media_ok(t: &str, local_token: &str, now_ms: u64) -> bool {
    let parts: Vec<&str> = t.split('.').collect();
    let ["media", exp, sig] = parts[..] else { return false };
    let Ok(e) = exp.parse::<u64>() else { return false };
    if local_token.is_empty() || e <= now_ms || e > now_ms + MEDIA_MS + 60_000 || sig.len() != 64 { return false; }
    let want = hex::encode(crate::tunnel::hmac_sha256(local_token.as_bytes(), format!("sushila-media|{exp}").as_bytes()));
    want.bytes().zip(sig.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}
fn media_q(q: &HashMap<String, String>, st: &Value) -> bool {
    q.get("t").map(|t| t.starts_with("media.") && media_ok(t, st.get("token").and_then(|x| x.as_str()).unwrap_or(""), crate::cmds::now_secs() * 1000)).unwrap_or(false)
}
/// GET /api/media-token -> {token}: for this computer's page or its owner (a media token, above).
async fn srv_media_token(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !host_ok(&headers, s.port, &st) || caller(&headers, &st).as_deref() != Some("local") { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    axum::Json(json!({ "token": media_token(st.get("token").and_then(|x| x.as_str()).unwrap_or(""), crate::cmds::now_secs() * 1000), "seconds": MEDIA_MS / 1000 })).into_response()
}
fn lib_local(s: &Srv, headers: &axum::http::HeaderMap, q: &HashMap<String, String>) -> bool {
    let st = read_state(&s.data_dir);
    let mut h = headers.clone();
    if let Some(t) = q.get("t").filter(|t| !t.starts_with("media.")) { if let Ok(v) = axum::http::HeaderValue::from_str(t) { h.insert("x-sushila-token", v); } }
    host_ok(&h, s.port, &st) && caller(&h, &st).as_deref() == Some("local")
}
/// A Library file: this computer's page or its owner, or a media token (files only, never the Library's list).
fn lib_file_ok(s: &Srv, headers: &axum::http::HeaderMap, q: &HashMap<String, String>) -> bool {
    let st = read_state(&s.data_dir);
    if media_q(q, &st) { return host_ok(headers, s.port, &st); }
    lib_local(s, headers, q)
}
async fn srv_library(axum::extract::State(s): axum::extract::State<Arc<Srv>>, axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !lib_local(&s, &headers, &q) { return (axum::http::StatusCode::FORBIDDEN, "the Library is for this computer only").into_response(); }
    let dir = s.data_dir.clone();
    let v = tokio::task::spawn_blocking(move || {
        // each file with its share link, if it has one
        let links = crate::share::links(&dir);
        let items: Vec<Value> = crate::library::list(&dir).into_iter().map(|mut x| { if let Some(l) = x["rel"].as_str().and_then(|r| links.get(r)) { x["link"] = l["link"].clone(); x["shareId"] = l["id"].clone(); } x }).collect();
        json!({ "folder": crate::locate::outputs(&dir).to_string_lossy(), "items": items, "trash": crate::library::list_trash(&dir) })
    }).await.unwrap_or(Value::Null);
    axum::Json(v).into_response()
}
async fn srv_library_file(axum::extract::State(s): axum::extract::State<Arc<Srv>>, axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !lib_file_ok(&s, &headers, &q) { return (axum::http::StatusCode::FORBIDDEN, "this computer only").into_response(); }
    let rel = q.get("rel").cloned().unwrap_or_default();
    let base = if q.contains_key("trash") { crate::locate::outputs(&s.data_dir).join(".trash") } else { crate::locate::outputs(&s.data_dir) };
    let Some(p) = crate::library::resolve(&base, &rel) else { return (axum::http::StatusCode::NOT_FOUND, "not found").into_response() };
    let name = p.file_name().map(|n| n.to_string_lossy().replace(['"', '\r', '\n'], "")).unwrap_or_default();
    let disp = format!("{}; filename=\"{name}\"", if q.contains_key("download") { "attachment" } else { "inline" });
    file_response(&p, crate::library::mime_of(&p), disp, "private, max-age=3600", headers.get("range")).await
}
async fn srv_library_act(axum::extract::State(s): axum::extract::State<Arc<Srv>>, axum::extract::Path(act): axum::extract::Path<String>, headers: axum::http::HeaderMap, body: axum::body::Bytes) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !lib_local(&s, &headers, &HashMap::new()) { return (axum::http::StatusCode::FORBIDDEN, "this computer only").into_response(); }
    let rel = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["rel"].as_str().map(String::from)).unwrap_or_default();
    let dir = s.data_dir.clone();
    let r = match act.as_str() {
        "delete" => crate::library::delete(&dir, &rel).map(|_| json!({ "ok": true })),
        "restore" => crate::library::restore(&dir, &rel).map(|_| json!({ "ok": true })),
        "purge" => crate::library::purge(&dir, &rel).map(|_| json!({ "ok": true })),
        "empty" => Ok(json!({ "ok": true, "removed": crate::library::empty_trash(&dir) })),
        _ => Err("unknown action".into()),
    };
    crate::core::log(true, &format!("library: {act} {rel}: {}", r.as_ref().map(|_| "done".to_string()).unwrap_or_else(|e| e.clone())));
    match r { Ok(v) => axum::Json(v).into_response(), Err(e) => (axum::http::StatusCode::BAD_REQUEST, e).into_response() }
}

/// Share link (this computer only): GET /api/share/me | list; POST /api/share/code {email, purpose} | verify {email, code,
/// firstName} | signout | upload {rel} | delete {id}. This server keeps the sushila.ai token; the page never sees it.
async fn srv_share(axum::extract::State(s): axum::extract::State<Arc<Srv>>, axum::extract::Path(act): axum::extract::Path<String>, method: axum::http::Method,
                   headers: axum::http::HeaderMap, body: axum::body::Bytes) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !lib_local(&s, &headers, &HashMap::new()) { return (axum::http::StatusCode::FORBIDDEN, "this computer only").into_response(); }
    let d: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let g = |k: &str| d[k].as_str().unwrap_or("").to_string();
    let dir = s.data_dir.clone();
    let r = match (method.as_str(), act.as_str()) {
        ("GET", "me") => Ok(crate::share::me(&dir)),
        ("GET", "list") => crate::share::list(&dir).await,
        ("POST", "code") => crate::share::send_code(&dir, &g("email"), &g("purpose")).await,
        ("POST", "verify") => crate::share::verify(&dir, &g("email"), &g("code"), &g("firstName")).await,
        ("POST", "signout") => Ok(crate::share::sign_out(&dir)),
        ("POST", "upload") => crate::share::upload(&dir, &g("rel")).await,
        ("POST", "delete") => crate::share::delete(&dir, &g("id")).await,
        _ => Err("unknown".into()),
    };
    match r { Ok(v) => axum::Json(v).into_response(), Err(e) => (axum::http::StatusCode::BAD_REQUEST, axum::Json(json!({ "error": e }))).into_response() }
}

/// GET /api/diagnose?pack=<id>: why that pack failed (GPU and RAM free, programs on the GPU, disk, its log, crashes),
/// with advice; this computer only (it names programs and paths).
async fn srv_diagnose(axum::extract::State(s): axum::extract::State<Arc<Srv>>, axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>,
                      headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !host_ok(&headers, s.port, &st) || caller(&headers, &st).as_deref() != Some("local") { return (axum::http::StatusCode::FORBIDDEN, "this computer only").into_response(); }
    let pack = q.get("pack").cloned().unwrap_or_default();
    if pack.is_empty() || !crate::core::safe_id_dots(&pack) { return (axum::http::StatusCode::BAD_REQUEST, "pack=<id>").into_response(); }
    let dir = s.data_dir.clone();
    let d = tokio::task::spawn_blocking(move || crate::diag::diagnose(&dir, &pack)).await.unwrap_or(Value::Null);
    axum::Json(d).into_response()
}

/// GET /api/system (Admin): the health of this computer and of Sushila: GPU, CPU, memory, disk, engine, uptime, crashes.
async fn srv_system(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !host_ok(&headers, s.port, &st) || !admin_ok(&s, &headers, &st) { return (axum::http::StatusCode::UNAUTHORIZED, "admin login required").into_response(); }
    // nvidia-smi takes a moment: asked at most every 5 s
    static GPU: std::sync::LazyLock<std::sync::Mutex<(Option<std::time::Instant>, Value)>> = std::sync::LazyLock::new(|| std::sync::Mutex::new((None, Value::Null)));
    let stale = GPU.lock().unwrap().0.map(|t| t.elapsed() > Duration::from_secs(5)).unwrap_or(true);
    if stale {
        let out = crate::util::hidden_async(&mut tokio::process::Command::new("nvidia-smi")).args(["--query-gpu=name,memory.total,memory.used,utilization.gpu,driver_version,temperature.gpu", "--format=csv,noheader,nounits"])
            .stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output().await.ok();
        let g = out.filter(|o| o.status.success()).and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(|l| {
            let f: Vec<&str> = l.split(',').map(str::trim).collect();
            let n = |i: usize| f.get(i).and_then(|x| x.parse::<f64>().ok());
            json!({ "name": f.first(), "memTotalGB": n(1).map(|m| (m / 1024.0 * 10.0).round() / 10.0), "memUsedGB": n(2).map(|m| (m / 1024.0 * 10.0).round() / 10.0), "utilPct": n(3), "driver": f.get(4), "tempC": n(5) }) }))
            .unwrap_or(Value::Null);
        *GPU.lock().unwrap() = (Some(std::time::Instant::now()), g);
    }
    let gpu = GPU.lock().unwrap().1.clone();
    let mut sys = sysinfo::System::new(); sys.refresh_memory(); sys.refresh_cpu_usage();
    let cpu = sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default();
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let home = std::fs::canonicalize(&s.data_dir).unwrap_or(s.data_dir.clone());
    let disk = disks.list().iter().filter(|d| home.starts_with(d.mount_point())).max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| json!({ "mount": d.mount_point().to_string_lossy(), "freeGB": (d.available_space() as f64 / 1e9 * 10.0).round() / 10.0, "totalGB": (d.total_space() as f64 / 1e9).round() }));
    let crashes: Vec<Value> = std::fs::read_to_string(s.data_dir.join("crashes.json")).ok().and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok()).unwrap_or_default();
    let day_ago = { let n = crate::util::now_iso(); n[..10].to_string() };
    let recent = crashes.iter().filter(|c| c["time"].as_str().map(|t| t.starts_with(&day_ago)).unwrap_or(false)).count();
    let eng = st.get("engine").cloned().unwrap_or(Value::Null);
    axum::Json(json!({ "gpu": gpu, "cpu": { "name": cpu, "cores": sys.cpus().len() },
        "ram": { "totalGB": (sys.total_memory() as f64 / 1e9 * 10.0).round() / 10.0, "freeGB": (sys.available_memory() as f64 / 1e9 * 10.0).round() / 10.0 },
        "disk": disk, "home": s.data_dir.to_string_lossy(), "os": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "engine": { "version": eng["version"], "key": eng["key"], "gpuBuild": eng["key"].as_str().map(|k| k.ends_with("-cuda") || k.ends_with("-vulkan") || k.starts_with("macos-aarch64")).unwrap_or(false) },
        "uptimeS": s.started.elapsed().as_secs(), "requests": requests_served(), "crashesToday": recent, "crashesTotal": crashes.len(),
        "app": env!("CARGO_PKG_VERSION") })).into_response()
}

async fn srv_proxy(axum::extract::State(s): axum::extract::State<Arc<Srv>>, req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, body) = req.into_parts();
    let st = read_state(&s.data_dir);
    if !host_ok(&parts.headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    let path = parts.uri.path().to_string();
    if path == "/health" || path == "/ready" || path == "/metrics" {
        // the sushila.ai website checks whether Sushila runs on this computer (to show "running" or "get it / start it"
        // next to its Install buttons): only that origin may read /health, and Chrome's private-network check is answered
        let site = parts.headers.get("origin").and_then(|o| o.to_str().ok()).filter(|o| matches!(*o, "https://sushila.ai" | "https://www.sushila.ai")).map(String::from);
        let mut r = if parts.method == axum::http::Method::OPTIONS { axum::http::StatusCode::NO_CONTENT.into_response() } else { health(&s, &parts.headers, &st, &path) };
        if let (Some(o), "/health") = (site, path.as_str()) {
            let h = r.headers_mut();
            if let Ok(v) = axum::http::HeaderValue::from_str(&o) { h.insert("access-control-allow-origin", v); }
            h.insert("vary", axum::http::HeaderValue::from_static("origin"));
            h.insert("access-control-allow-methods", axum::http::HeaderValue::from_static("GET, OPTIONS"));
            h.insert("access-control-allow-private-network", axum::http::HeaderValue::from_static("true"));
        }
        return r;
    }
    if !path.starts_with("/v1/") { return (axum::http::StatusCode::NOT_FOUND, "not found").into_response(); }
    // only the engine API itself: no dot segments or encoded separators (they would let a URL resolve outside /v1/
    // on the engine), and only the methods the API uses
    if !proxy_path_ok(&path) { return (axum::http::StatusCode::BAD_REQUEST, "bad path").into_response(); }
    if parts.method != axum::http::Method::GET && parts.method != axum::http::Method::POST { return (axum::http::StatusCode::METHOD_NOT_ALLOWED, "GET or POST").into_response(); }
    let rid = request_id(&parts.headers);
    let origin = parts.headers.get("origin").and_then(|o| o.to_str().ok()).map(String::from);
    let with_cors = |r: axum::response::Response, st: &Value| with_cors_for(r, st, origin.as_deref());
    if parts.method == axum::http::Method::OPTIONS { return with_cors(axum::http::StatusCode::NO_CONTENT.into_response(), &st); }
    let deny = |code: axum::http::StatusCode, msg: &'static str| with_cors((code, msg).into_response(), &st);
    let mut who_s = String::new();
    let mut local = false;
    if path.starts_with("/v1/") {
        let Some(who) = caller(&parts.headers, &st) else {
            return deny(axum::http::StatusCode::UNAUTHORIZED, "an access key is required (Authorization: Bearer <key>), or open this page from Sushila Host Station");
        };
        who_s = who_name(&who, &st);
        local = who == "local";
        if who != "local" {
            if !rate_ok(&s, &who, &parts.headers, &st) { return deny(axum::http::StatusCode::TOO_MANY_REQUESTS, "too many requests for this key; try again in a minute"); }
        }
    }
    // several models can run at once (state.running = {pack id: {port, ...}}); a request names its model like any
    // OpenAI client ("model" in the JSON body) or with the x-sushila-model header; with one model running, it is used
    let empty = serde_json::Map::new();
    let running = st.get("running").and_then(|r| r.as_object()).unwrap_or(&empty);
    if path == "/v1/models" {
        let data: Vec<Value> = running.iter().map(|(id, r)| json!({ "id": id, "object": "model", "owned_by": "sushila", "name": r.get("name") })).collect();
        return with_cors(axum::Json(json!({ "object": "list", "data": data })).into_response(), &st);
    }
    let bytes = match axum::body::to_bytes(body, 64 << 20).await { Ok(b) => b, Err(_) => return deny(axum::http::StatusCode::PAYLOAD_TOO_LARGE, "request too large") };
    let wanted = parts.headers.get("x-sushila-model").and_then(|h| h.to_str().ok()).map(String::from)
        .or_else(|| serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v.get("model").and_then(|m| m.as_str()).map(String::from)));
    // a model unloaded for being idle is started again when asked for (named, or the only one when none runs)
    let reload = match wanted.as_deref() { Some(m) if !running.contains_key(m) && was_idle(m) => Some(m.to_string()),
        None if running.is_empty() => IDLE.lock().ok().filter(|s| s.len() == 1).and_then(|s| s.iter().next().cloned()), _ => None };
    let st2 = match reload { Some(m) => { crate::core::log(true, &format!("{m}: requested while unloaded for being idle; loading it again")); start_and_wait(&s.data_dir, &m, 300).await } None => None };
    let running = match &st2 { Some(x) => x.get("running").and_then(|r| r.as_object()).unwrap_or(&empty), None => running };
    let pick = match wanted.as_deref() {
        Some(m) if running.contains_key(m) => running.get(m),
        _ if running.len() == 1 => running.values().next(),
        _ => None,
    };
    let Some(up) = pick.and_then(|r| r.get("port")).and_then(|p| p.as_u64()) else {
        // a named pack that is installed but not running: say which, and how to start it
        if let Some(m) = wanted.as_deref().filter(|m| !running.contains_key(*m)) {
            return with_cors((axum::http::StatusCode::SERVICE_UNAVAILABLE, not_running_msg(&st, m, None)).into_response(), &st);
        }
        return deny(axum::http::StatusCode::SERVICE_UNAVAILABLE, if running.is_empty() { "no model is running: start one on the Admin page (Packs, Start), or type start <pack> in the Sushila window" } else { "name a running model (\"model\" field); GET /v1/models lists them" });
    };
    let model = running.iter().find(|(_, r)| r.get("port").and_then(|p| p.as_u64()) == Some(up)).map(|(k, _)| k.clone()).unwrap_or_default();
    // admission control: each model serves `slots` requests at once (continuous batching) and lets up to 3x that wait
    // in its engine; beyond, the caller gets 429 with Retry-After instead of an ever longer wait
    let slots = pick.and_then(|r| r.get("slots")).and_then(|v| v.as_i64()).unwrap_or(1).max(1);
    let limit = slots * 4;
    let mut guard = {
        let mut m = s.metrics.lock().unwrap();
        let n = m.inflight.entry(model.clone()).or_default();
        if *n >= limit {
            *m.rejected.entry(model.clone()).or_default() += 1;
            drop(m);
            crate::core::log(true, &format!("api {rid} {who_s} {model} {path} -> 429 busy ({limit} in flight)"));
            let mut r = deny(axum::http::StatusCode::TOO_MANY_REQUESTS, "busy: every slot of this model is in use and its waiting line is full; retry shortly");
            r.headers_mut().insert("retry-after", axum::http::HeaderValue::from_static("2"));
            r.headers_mut().insert("x-request-id", axum::http::HeaderValue::from_str(&rid).unwrap_or(axum::http::HeaderValue::from_static("r")));
            return r;
        }
        *n += 1;
        touch(&model, 1);
        InFlight { s: s.clone(), model: model.clone(), rid: rid.clone(), who: who_s.clone(), what: format!("{} {}", parts.method, path), t0: std::time::Instant::now(), status: 0 }
    };
    // music servers have their own paths; video uses stable-diffusion.cpp's native async API (/sdcpp/v1/vid_gen, /sdcpp/v1/jobs/..).
    // Only the model APIs Sushila uses are forwarded, and the address is built by a URL parser and checked to be the
    // model's own port on this computer: a path like /v1/music@127.0.0.1:7874/ must never reach anything else.
    let Some(upstream_path) = upstream_path(&path) else { return deny(axum::http::StatusCode::NOT_FOUND, "not a model API path"); };
    let Some(url) = upstream_url(up as u16, &upstream_path, parts.uri.query()) else { return deny(axum::http::StatusCode::BAD_REQUEST, "bad path"); };
    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut r = s.http.request(method, url).body(bytes.to_vec()).header("x-request-id", &rid);
    for h in ["content-type", "accept"] {
        if let Some(v) = parts.headers.get(h).and_then(|v| v.to_str().ok()) { r = r.header(h, v); }
    }
    let req_json = serde_json::from_slice::<Value>(&bytes).ok().unwrap_or(Value::Null);
    let prompt = req_json.get("prompt").and_then(|p| p.as_str()).map(String::from).unwrap_or_default();
    // songs and videos come back later, by job id: what was asked is kept until then, so the result is saved with it
    let music_synth = parts.method == axum::http::Method::POST && path == "/v1/music/synth";
    let video_gen = parts.method == axum::http::Method::POST && path == "/v1/video/vid_gen";
    let result_of = if path == "/v1/music/job" && parts.uri.query().map(|q| q.contains("result=1")).unwrap_or(false) {
        parts.uri.query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("id=")).map(String::from)) }
        else { path.strip_prefix("/v1/video/jobs/").filter(|x| !x.contains('/')).map(String::from) };
    let asked = { let first = if req_json.is_array() { req_json[0].clone() } else { req_json.clone() };
        json!({ "pack": model, "remote": !local, "prompt": first.get("caption").or(first.get("prompt")).cloned(), "lyrics": first.get("lyrics").cloned(),
                "duration": first.get("duration").cloned(), "seed": first.get("seed").cloned(), "frames": first.get("video_frames").cloned(),
                "size": first.get("width").and_then(|w| w.as_u64()).map(|w| format!("{w}x{}", first["height"].as_u64().unwrap_or(0))),
                "details": crate::library::prompt_details(&first) }) };
    let mut resp = match r.send().await {
        // a picture is also saved in the home folder (outputs/images/<date>/), so it can be found without downloading;
        // this computer gets the path of each file in the answer (sushila_file), other machines do not
        Ok(resp) if path == "/v1/images/generations" && resp.status().is_success() => {
            guard.status = 200;
            let body = resp.bytes().await.unwrap_or_default();
            drop(guard);
            let out = match serde_json::from_slice::<Value>(&body) {
                Ok(mut v) => { save_images(&s.data_dir, &prompt, &mut v, local, &model, req_json.get("size").and_then(|x| x.as_str()).unwrap_or("")); serde_json::to_vec(&v).unwrap_or(body.to_vec()) }
                Err(_) => body.to_vec(),
            };
            (axum::http::StatusCode::OK, [("content-type", "application/json".to_string()), ("cache-control", "no-store".to_string())], out).into_response()
        }
        // a music or video job just started: remember what was asked, by its id
        Ok(resp) if (music_synth || video_gen) && resp.status().is_success() => {
            guard.status = 200;
            let body = resp.bytes().await.unwrap_or_default();
            drop(guard);
            if let Some(id) = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["id"].as_str().map(String::from)) {
                pending_add(id, if video_gen { "video" } else { "music" }, &asked);
            }
            (axum::http::StatusCode::OK, [("content-type", "application/json".to_string()), ("cache-control", "no-store".to_string())], body.to_vec()).into_response()
        }
        // its result: saved once in the Library (outputs/music or outputs/video), then passed on unchanged
        Ok(resp) if result_of.as_ref().map(|id| PENDING.lock().map(|m| m.contains_key(id)).unwrap_or(false)).unwrap_or(false) && resp.status().is_success() => {
            guard.status = 200;
            let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
            let body = resp.bytes().await.unwrap_or_default();
            drop(guard);
            let id = result_of.clone().unwrap_or_default();
            let saved = save_job_result(&s.data_dir, &id, &ctype, &body);
            if saved { if let Ok(mut m) = PENDING.lock() { m.remove(&id); } }
            (axum::http::StatusCode::OK, [("content-type", ctype), ("cache-control", "no-store".to_string())], body.to_vec()).into_response()
        }
        Ok(resp) => {
            let status = axum::http::StatusCode::from_u16(resp.status().as_u16()).unwrap_or(axum::http::StatusCode::BAD_GATEWAY);
            guard.status = status.as_u16();
            let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string();
            // the guard lives as long as the answer streams: in flight until the last byte (or a disconnect)
            let stream = futures_util::StreamExt::map(resp.bytes_stream(), move |c| { let _ = &guard; c });
            (status, [("content-type", ctype), ("cache-control", "no-store".to_string())], axum::body::Body::from_stream(stream)).into_response()
        }
        Err(e) => {
            guard.status = 503; drop(guard);
            crate::core::log(true, &format!("api {rid} {model}: its engine did not answer: {e}"));
            // still loading, or its engine stopped: in plain words, with the engine's last log line
            let loading = pick.and_then(|r| r.get("ready")).and_then(|x| x.as_bool()) == Some(false);
            (axum::http::StatusCode::SERVICE_UNAVAILABLE, not_running_msg(&st, &model, Some((loading, &s.data_dir)))).into_response()
        }
    };
    resp.headers_mut().insert("x-request-id", axum::http::HeaderValue::from_str(&rid).unwrap_or(axum::http::HeaderValue::from_static("r")));
    with_cors(resp, &st)
}

/// What a person needs to hear when a pack does not answer: its name, that it is not running (or still loading), how to
/// start it, and the last line its engine wrote.
fn not_running_msg(st: &Value, id: &str, engine: Option<(bool, &Path)>) -> String {
    let name = st.get("packs").and_then(|p| p.get(id)).and_then(|p| p.get("name")).and_then(|n| n.as_str()).unwrap_or(id);
    let last = engine.and_then(|(_, dir)| std::fs::read_to_string(dir.join("logs").join(format!("{id}.log"))).ok())
        .and_then(|t| t.lines().rev().find(|l| !l.trim().is_empty()).map(|l| l.chars().take(200).collect::<String>()));
    let tail = last.map(|l| format!(" (its last log line: {l})")).unwrap_or_default();
    match engine {
        Some((true, _)) => format!("{name} is still loading. Wait until it shows as ready (Admin page, Packs; or the Sushila window), then try again{tail}."),
        // stopped: Sushila's own diagnosis (GPU and RAM free, programs on the GPU, its log), then how to start it again
        Some((false, dir)) => format!("{name} is not running. {}{tail} Start it again on the Admin page (Packs, Start) or at the top of the Inference page.", crate::diag::one_line(&crate::diag::diagnose(dir, id))),
        None => format!("{name} is installed but not running, in Standard or Accelerated mode. Start it on the Admin page (Packs, Start), or type start {id} in the Sushila window, then choose it at the top of this page."),
    }
}

/// Writes each image of an images answer to outputs/images/<YYYY-MM-DD>/<HHMMSS>-<first words of the prompt>-<n>.png
/// and, for this computer, adds its path to the answer (data[i].sushila_file).
/// Music and video jobs started through this server, by id: (kind, what was asked), until their result is saved.
/// Entries are small (texts cut to 4,000 characters), expire after a day (results never fetched) and are at most 1,000.
static PENDING: std::sync::LazyLock<std::sync::Mutex<HashMap<String, (&'static str, Value, std::time::Instant)>>> = std::sync::LazyLock::new(Default::default);
fn pending_add(id: String, kind: &'static str, asked: &Value) {
    let mut a = asked.clone();
    if let Some(o) = a.as_object_mut() { for v in o.values_mut() { if let Some(t) = v.as_str() { if t.len() > 4000 { *v = json!(t.chars().take(4000).collect::<String>()); } } } }
    let Ok(mut m) = PENDING.lock() else { return };
    m.retain(|_, (_, _, t)| t.elapsed() < Duration::from_secs(24 * 3600));
    if m.len() >= 1000 { if let Some(old) = m.iter().min_by_key(|(_, (_, _, t))| *t).map(|(k, _)| k.clone()) { m.remove(&old); } }
    m.insert(id, (kind, a, std::time::Instant::now()));
}
/// A finished song (audio, or multipart with the audio in it) or video (JSON with base64 once completed): saved.
fn save_job_result(dir: &Path, id: &str, ctype: &str, body: &[u8]) -> bool {
    use base64::Engine;
    let Some((kind, asked, _)) = PENDING.lock().ok().and_then(|m| m.get(id).cloned()) else { return false };
    let title = asked["prompt"].as_str().unwrap_or(kind).to_string();
    if kind == "music" {
        let (audio, t) = if ctype.starts_with("audio/") { (body.to_vec(), ctype.to_string()) } else { match crate::library::audio_in_multipart(body, ctype) { Some(x) => x, None => return false } };
        let ext = if t.contains("mpeg") { "mp3" } else if t.contains("wav") { "wav" } else if t.contains("flac") { "flac" } else { "ogg" };
        return crate::library::save(dir, "music", ext, &audio, &title, asked).is_some();
    }
    let Ok(v) = serde_json::from_slice::<Value>(body) else { return false };
    if v["status"] != "completed" { return false; }
    let Some(b) = v["result"]["b64_json"].as_str() else { return false };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b) else { return false };
    let ext = v["result"]["output_format"].as_str().filter(|e| ["webm", "mp4", "webp", "gif"].contains(e)).unwrap_or("webm").to_string();
    crate::library::save(dir, "video", &ext, &bytes, &title, asked).is_some()
}

fn save_images(dir: &Path, prompt: &str, v: &mut Value, local: bool, pack: &str, size: &str) {
    use base64::Engine;
    let now = crate::util::now_iso();
    let day = crate::locate::outputs(&dir).join(crate::library::kind_folder(&crate::locate::outputs(&dir), "image")).join(&now[..10]);
    if std::fs::create_dir_all(&day).is_err() { return; }
    let clean = prompt.split("<sd_cpp_extra_args>").next().unwrap_or("");
    let slug: String = clean.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).take(6).collect::<Vec<_>>().join("-").to_lowercase().chars().take(48).collect();
    let stamp: String = now[11..19].chars().filter(|c| c.is_ascii_digit()).collect();
    let Some(items) = v.get_mut("data").and_then(|d| d.as_array_mut()) else { return };
    for (i, it) in items.iter_mut().enumerate() {
        let Some(b) = it.get("b64_json").and_then(|b| b.as_str()) else { continue };
        let Ok(png) = base64::engine::general_purpose::STANDARD.decode(b) else { continue };
        let mut f = day.join(format!("{stamp}-{}-{}.png", if slug.is_empty() { "image" } else { &slug }, i + 1));
        let mut k = 2; while f.exists() { f = day.join(format!("{stamp}-{slug}-{}-{k}.png", i + 1)); k += 1; }
        if std::fs::write(&f, crate::library::mark_ai(&png, "png", pack, clean, !local)).is_ok() {
            crate::library::record(dir, &f, "image", json!({ "pack": pack, "prompt": clean, "size": size, "seed": it.get("seed").cloned(), "remote": !local }));
            if local { it["sushila_file"] = json!(f.to_string_lossy()); }
        }
    }
}

/// POST /api/use {"action": "start"|"stop", "pack": id, "mode": "turbo"|"regular"}: the inference page starts or stops a
/// pack (one at a time; the assistant's model stays). This computer only; the same request the Admin page sends, so both
/// pages, the terminal and `sushila status` always show the same state.
async fn srv_use(axum::extract::State(s): axum::extract::State<Arc<Srv>>, req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, body) = req.into_parts();
    let st = read_state(&s.data_dir);
    if !host_ok(&parts.headers, s.port, &st) || caller(&parts.headers, &st).as_deref() != Some("local") { return (axum::http::StatusCode::FORBIDDEN, "only this computer can start and stop models").into_response(); }
    let Ok(bytes) = axum::body::to_bytes(body, 4096).await else { return (axum::http::StatusCode::BAD_REQUEST, "bad request").into_response() };
    let Ok(v) = serde_json::from_slice::<Value>(&bytes) else { return (axum::http::StatusCode::BAD_REQUEST, "bad request").into_response() };
    let (action, pack) = (v["action"].as_str().unwrap_or(""), v["pack"].as_str().unwrap_or(""));
    if !(action == "start" || action == "stop") || pack.is_empty() || pack.len() > 80 || !pack.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_') {
        return (axum::http::StatusCode::BAD_REQUEST, "action start or stop and a pack id").into_response();
    }
    let mode = v["mode"].as_str().filter(|m| *m == "turbo" || *m == "regular");
    let id = new_id().replacen("job-", "task-", 1);
    let req = json!({ "id": id, "action": action, "pack": pack, "mode": mode, "source": "inference page" });
    if crate::util::post_request(&s.data_dir, "control-in", &id, &req).is_err() { return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "could not queue the request").into_response(); }
    (axum::http::StatusCode::ACCEPTED, axum::Json(json!({ "id": id }))).into_response()
}

/// The temporary internet URL (tunnel.rs): status, start, stop. This computer only (the local token).
async fn srv_tunnel(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !host_ok(&headers, s.port, &st) || caller(&headers, &st).as_deref() != Some("local") || !local_host(&headers, s.port) { return (axum::http::StatusCode::FORBIDDEN, "only this computer").into_response(); }
    axum::Json(crate::tunnel::status().await).into_response()
}
async fn srv_tunnel_act(axum::extract::State(s): axum::extract::State<Arc<Srv>>, axum::extract::Path(act): axum::extract::Path<String>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !host_ok(&headers, s.port, &st) || caller(&headers, &st).as_deref() != Some("local") || !local_host(&headers, s.port) { return (axum::http::StatusCode::FORBIDDEN, "only this computer can open or close its internet URL").into_response(); }
    match act.as_str() {
        "start" => match crate::tunnel::start(&s.data_dir, s.port).await { Ok(v) => axum::Json(v).into_response(), Err(e) => (axum::http::StatusCode::BAD_GATEWAY, e).into_response() },
        "stop" => axum::Json(crate::tunnel::stop(&s.data_dir).await).into_response(),
        "renew" => match crate::tunnel::renew(&s.data_dir, s.port).await { Ok(v) => axum::Json(v).into_response(), Err(e) => (axum::http::StatusCode::BAD_GATEWAY, e).into_response() },
        "new-key" => match crate::tunnel::new_key(&s.data_dir).await { Ok(v) => axum::Json(v).into_response(), Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e).into_response() },
        // a new link at every start, or not (this computer's choice; no admin login needed for its own internet link)
        "at-start-on" | "at-start-off" => {
            let id = new_id().replacen("job-", "task-", 1);
            let req = json!({ "id": id, "action": "settings", "values": { "internetUrlAtStart": act == "at-start-on" }, "source": "temporary internet URL" });
            if crate::util::post_request(&s.data_dir, "control-in", &id, &req).is_err() { return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "could not save").into_response(); }
            axum::Json(json!({ "ok": true })).into_response()
        }
        _ => (axum::http::StatusCode::NOT_FOUND, "start or stop").into_response(),
    }
}

/// GET /api/files-folder: where your pictures, songs and videos go ("folder"), the default (Documents/Sushila), the
/// chosen one, files from before still in the app folder ("old": the one question is shown while it is set), and why
/// the wanted folder cannot be written ("blocked", e.g. Windows' Controlled folder access).
/// POST {"action": "move"} moves the old files to Documents/Sushila (or {"folder"}); {"action": "keep"} keeps them
/// where they are; {"action": "choose", "folder", "move": true|false} chooses any folder, with or without the files;
/// {"action": "default"} goes back to Documents/Sushila; {"action": "retry"} asks the OS again (after allowing Sushila).
/// Changing it is for this computer only (not through the internet link).
fn files_status(home: &Path) -> Value {
    let (folder, blocked) = crate::locate::outputs_status(home);
    json!({ "folder": folder.to_string_lossy(), "default": crate::locate::default_outputs().map(|d| d.to_string_lossy().to_string()),
            "chosen": crate::locate::chosen_outputs(home).map(|d| d.to_string_lossy().to_string()),
            "old": crate::locate::old_outputs(home).map(|d| d.to_string_lossy().to_string()), "blocked": blocked, "home": home.to_string_lossy() })
}
async fn srv_files_folder_get(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !local_host(&headers, s.port) { return (axum::http::StatusCode::FORBIDDEN, "this computer only").into_response(); }
    let home = s.data_dir.clone();
    axum::Json(tokio::task::spawn_blocking(move || files_status(&home)).await.unwrap_or(Value::Null)).into_response()
}
async fn srv_files_folder(axum::extract::State(s): axum::extract::State<Arc<Srv>>, req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, body) = req.into_parts();
    let st = read_state(&s.data_dir);
    if !this_computer(&parts.headers, s.port) || caller(&parts.headers, &st).as_deref() != Some("local") { return (axum::http::StatusCode::FORBIDDEN, "only this computer can change where its files go").into_response(); }
    let Ok(bytes) = axum::body::to_bytes(body, 8192).await else { return (axum::http::StatusCode::BAD_REQUEST, "bad request").into_response() };
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let home = s.data_dir.clone();
    let r = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let act = v["action"].as_str().unwrap_or("");
        let current = crate::locate::outputs(&home);
        let target = |f: Option<&str>| -> Result<PathBuf, String> {
            let p = match f.map(str::trim).filter(|f| !f.is_empty()) {
                Some(f) => { let p = PathBuf::from(f); if !p.is_absolute() { return Err("give the whole path of the folder".into()); } p }
                None => crate::locate::default_outputs().ok_or("this system has no Documents folder; choose one")?,
            };
            crate::locate::writable_forget();
            crate::locate::writable(&p)?;
            Ok(p)
        };
        let moved = match act {
            "keep" => { crate::locate::choose_outputs(&home, &home.join("outputs")).map_err(|e| e.to_string())?; 0 }
            "retry" => { crate::locate::writable_forget(); 0 }
            "move" | "default" | "choose" => {
                let to = target(if act == "choose" { v["folder"].as_str() } else { None })?;
                let n = if act == "move" || v["move"] == true { crate::library::move_files(&current, &to)? } else { 0 };
                crate::locate::choose_outputs(&home, &to).map_err(|e| e.to_string())?;
                n
            }
            _ => return Err("unknown action".into()),
        };
        let mut out = files_status(&home); out["ok"] = json!(true); out["moved"] = json!(moved);
        Ok(out)
    }).await.unwrap_or_else(|e| Err(e.to_string()));
    match r {
        Ok(v) => { crate::core::log(true, &format!("files folder: {} ({} moved)", v["folder"].as_str().unwrap_or(""), v["moved"])); axum::Json(v).into_response() }
        Err(e) => (axum::http::StatusCode::CONFLICT, axum::Json(json!({ "ok": false, "error": e }))).into_response(),
    }
}
/// POST /api/reveal {"path": ...}: opens the system's file manager at a file in the home folder's outputs (Explorer with
/// the file selected, Finder likewise, the folder elsewhere). Only for this computer, and only inside outputs/.
async fn srv_reveal(axum::extract::State(s): axum::extract::State<Arc<Srv>>, req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, body) = req.into_parts();
    let st = read_state(&s.data_dir);
    if !host_ok(&parts.headers, s.port, &st) || caller(&parts.headers, &st).as_deref() != Some("local") { return (axum::http::StatusCode::FORBIDDEN, "only this computer can open its folders").into_response(); }
    let Ok(bytes) = axum::body::to_bytes(body, 8192).await else { return (axum::http::StatusCode::BAD_REQUEST, "bad request").into_response() };
    let p = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v.get("path").and_then(|p| p.as_str()).map(PathBuf::from));
    let outputs = crate::locate::outputs(&s.data_dir);
    // a bare file name means a queue output (outputs/<job>.<ext>)
    let p = p.map(|p| if p.is_absolute() { p } else { outputs.join(p) });
    let (Some(f), Ok(root)) = (p.and_then(|p| std::fs::canonicalize(p).ok()), std::fs::canonicalize(&outputs)) else { return (axum::http::StatusCode::NOT_FOUND, "that file is not there any more").into_response() };
    if !f.starts_with(&root) { return (axum::http::StatusCode::FORBIDDEN, "only files in the outputs folder").into_response(); }
    // a folder (Where are my files) opens as itself; a file opens its folder with it selected
    let r = if f.is_dir() {
        let d = f.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        std::process::Command::new(if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" }).arg(d).spawn()
    } else if cfg!(windows) {
        // explorer wants /select,"<path>" as one argument, with the Windows path (no \\?\ prefix)
        let w = f.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        std::process::Command::new("explorer").arg(format!("/select,{w}")).spawn()
    } else if cfg!(target_os = "macos") { std::process::Command::new("open").arg("-R").arg(&f).spawn() }
    else { std::process::Command::new("xdg-open").arg(f.parent().unwrap_or(&root)).spawn() };
    match r { Ok(_) => axum::Json(json!({ "ok": true, "path": f.to_string_lossy() })).into_response(), Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("could not open the folder: {e}")).into_response() }
}

/// GET /health: the server is alive (200, for process monitors). GET /ready: 200 when at least one model is loaded and
/// answering, else 503 (for load balancers). GET /metrics: Prometheus counters (this computer, or callers with a key).
fn health(s: &Arc<Srv>, headers: &axum::http::HeaderMap, st: &Value, path: &str) -> axum::response::Response {
    use axum::response::IntoResponse;
    let running = st.get("running").and_then(|r| r.as_object()).cloned().unwrap_or_default();
    let ready = running.values().filter(|r| r.get("ready").and_then(|x| x.as_bool()).unwrap_or(false)).count();
    match path {
        "/health" => axum::Json(json!({ "ok": true, "app": "sushila", "version": env!("CARGO_PKG_VERSION"), "build": crate::BUILD, "port": s.port, "uptimeSeconds": s.started.elapsed().as_secs(), "models": running.len(), "ready": ready })).into_response(),
        "/ready" => (if ready > 0 { axum::http::StatusCode::OK } else { axum::http::StatusCode::SERVICE_UNAVAILABLE }, axum::Json(json!({ "ready": ready }))).into_response(),
        _ => {
            let allowed = local_host(headers, s.port) || caller(headers, st).map(|w| !w.starts_with("open")).unwrap_or(false) || admin_ok(s, headers, st);
            if !allowed { return (axum::http::StatusCode::UNAUTHORIZED, "metrics: this computer, or a key").into_response(); }
            let m = s.metrics.lock().unwrap();
            let mut t = String::from("# HELP sushila_requests_total Requests forwarded to models, by model and HTTP status.\n# TYPE sushila_requests_total counter\n");
            for ((model, code), n) in &m.requests { t += &format!("sushila_requests_total{{model=\"{model}\",code=\"{code}\"}} {n}\n"); }
            t += "# HELP sushila_inflight Requests in flight per model.\n# TYPE sushila_inflight gauge\n";
            for (model, n) in &m.inflight { t += &format!("sushila_inflight{{model=\"{model}\"}} {n}\n"); }
            t += "# HELP sushila_rejected_total Requests refused with 429 (model busy).\n# TYPE sushila_rejected_total counter\n";
            for (model, n) in &m.rejected { t += &format!("sushila_rejected_total{{model=\"{model}\"}} {n}\n"); }
            t += "# HELP sushila_request_seconds Time per request, until the last byte.\n# TYPE sushila_request_seconds summary\n";
            for (model, (sum, n)) in &m.seconds { t += &format!("sushila_request_seconds_sum{{model=\"{model}\"}} {sum:.3}\nsushila_request_seconds_count{{model=\"{model}\"}} {n}\n"); }
            t += "# HELP sushila_model_slots Parallel slots per running model.\n# TYPE sushila_model_slots gauge\n";
            for (id, r) in &running { t += &format!("sushila_model_slots{{model=\"{id}\",ready=\"{}\"}} {}\n", r.get("ready").and_then(|x| x.as_bool()).unwrap_or(false), r.get("slots").and_then(|x| x.as_i64()).unwrap_or(1)); }
            let q = read_queue(&s.data_dir);
            let mut by: HashMap<String, u64> = HashMap::new();
            for j in q.get("jobs").and_then(|j| j.as_array()).cloned().unwrap_or_default() { *by.entry(j.get("status").and_then(|x| x.as_str()).unwrap_or("?").to_string()).or_default() += 1; }
            t += "# HELP sushila_queue_jobs Background queue jobs by status.\n# TYPE sushila_queue_jobs gauge\n";
            for (k, n) in by { t += &format!("sushila_queue_jobs{{status=\"{k}\"}} {n}\n"); }
            t += &format!("# HELP sushila_uptime_seconds Seconds since the server started.\n# TYPE sushila_uptime_seconds gauge\nsushila_uptime_seconds {}\n", s.started.elapsed().as_secs());
            ([("content-type", "text/plain; version=0.0.4")], t).into_response()
        }
    }
}

/// POST /api/mode {"model": id, "mode": "turbo"|"regular"}: the browser page asks Host Station to restart a model with or
/// without its precomputed files. Only this computer's own pages (session token) may ask; the window applies it.
async fn srv_mode(axum::extract::State(s): axum::extract::State<Arc<Srv>>, req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, body) = req.into_parts();
    let st = read_state(&s.data_dir);
    let origin = parts.headers.get("origin").and_then(|o| o.to_str().ok()).map(String::from);
    if parts.method == axum::http::Method::OPTIONS { return with_cors_for(axum::http::StatusCode::NO_CONTENT.into_response(), &st, origin.as_deref()); }
    if !host_ok(&parts.headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    if caller(&parts.headers, &st).as_deref() != Some("local") { return (axum::http::StatusCode::FORBIDDEN, "only this computer can switch modes").into_response(); }
    let Ok(bytes) = axum::body::to_bytes(body, 4096).await else { return (axum::http::StatusCode::BAD_REQUEST, "bad request").into_response() };
    let Ok(v) = serde_json::from_slice::<Value>(&bytes) else { return (axum::http::StatusCode::BAD_REQUEST, "bad request").into_response() };
    let (Some(model), Some(mode)) = (v.get("model").and_then(|m| m.as_str()), v.get("mode").and_then(|m| m.as_str())) else { return (axum::http::StatusCode::BAD_REQUEST, "model and mode required").into_response() };
    if !(mode == "turbo" || mode == "regular") || model.len() > 80 || !model.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return (axum::http::StatusCode::BAD_REQUEST, "bad model or mode").into_response();
    }
    let _ = std::fs::write(s.data_dir.join("mode-request.json"), json!({ "model": model, "mode": mode }).to_string());
    with_cors_for((axum::http::StatusCode::ACCEPTED, axum::Json(json!({ "ok": true }))).into_response(), &st, origin.as_deref())
}

// ---------- background queue ----------
// The window owns the queue (data_dir/queue.json, outputs in data_dir/outputs/): it runs the jobs one at a time, also while
// hidden in the tray. Pages (this computer's, or shared users with a key) add jobs and actions as request files in
// data_dir/queue-in/, read the queue, and fetch finished outputs. Each caller sees only its own jobs; this computer sees all.
pub fn read_queue(dir: &Path) -> Value {
    std::fs::read_to_string(dir.join("queue.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({ "paused": false, "jobs": [] }))
}
fn queue_job(dir: &Path, id: &str) -> Option<Value> {
    read_queue(dir).get("jobs")?.as_array()?.iter().find(|j| j.get("id").and_then(|x| x.as_str()) == Some(id)).cloned()
}
/// This computer sees every job; a key (or an anonymous open-mode browser) sees its own.
fn owns(who: &str, job: &Value) -> bool { who == "local" || job.get("owner").and_then(|o| o.as_str()) == Some(who) }
pub fn safe_id(id: &str) -> bool { !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') }
pub fn new_id() -> String {  // unique per call: time, process, a counter, hashed (no extra dependency)
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let h = Sha256::digest(format!("{t}-{}-{n}", std::process::id()).as_bytes());
    format!("job-{}", &hex::encode(h)[..18])
}
async fn srv_queue(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    let origin = headers.get("origin").and_then(|o| o.to_str().ok()).map(String::from);
    if !host_ok(&headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    let Some(who) = caller(&headers, &st) else { return with_cors_for((axum::http::StatusCode::UNAUTHORIZED, "a key or this computer's page is needed").into_response(), &st, origin.as_deref()) };
    let q = read_queue(&s.data_dir);
    let jobs: Vec<Value> = q.get("jobs").and_then(|j| j.as_array()).map(|a| a.iter().filter(|j| owns(&who, j)).map(|j| {
        let mut j = j.clone();
        if let Some(o) = j.as_object_mut() { o.remove("owner"); o.remove("params"); }  // the request itself (prompts, pictures) stays private
        j
    }).collect()).unwrap_or_default();
    with_cors_for(axum::Json(json!({ "paused": q.get("paused").cloned().unwrap_or(json!(false)), "jobs": jobs })).into_response(), &st, origin.as_deref())
}
async fn srv_queue_add(axum::extract::State(s): axum::extract::State<Arc<Srv>>, req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, body) = req.into_parts();
    let st = read_state(&s.data_dir);
    let origin = parts.headers.get("origin").and_then(|o| o.to_str().ok()).map(String::from);
    if parts.method == axum::http::Method::OPTIONS { return with_cors_for(axum::http::StatusCode::NO_CONTENT.into_response(), &st, origin.as_deref()); }
    if !host_ok(&parts.headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    let Some(who) = caller(&parts.headers, &st) else { return with_cors_for((axum::http::StatusCode::UNAUTHORIZED, "a key or this computer's page is needed").into_response(), &st, origin.as_deref()) };
    let Ok(bytes) = axum::body::to_bytes(body, 16 << 20).await else { return (axum::http::StatusCode::PAYLOAD_TOO_LARGE, "request too large").into_response() };
    let Ok(v) = serde_json::from_slice::<Value>(&bytes) else { return (axum::http::StatusCode::BAD_REQUEST, "bad request").into_response() };
    let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    let model = v.get("model").and_then(|m| m.as_str()).unwrap_or("");
    if !["text", "image", "video", "music"].contains(&kind) || !safe_id(&model.replace('.', "_")) {
        return with_cors_for((axum::http::StatusCode::BAD_REQUEST, "kind (text, image, video, music) and model are required").into_response(), &st, origin.as_deref());
    }
    let pending = std::fs::read_dir(s.data_dir.join("queue-in")).map(|d| d.filter_map(|e| e.ok()).filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false)).count()).unwrap_or(0);
    // only jobs still to do count (finished ones are pruned by the owner and never fill the queue)
    let queued = read_queue(&s.data_dir).get("jobs").and_then(|j| j.as_array()).map(|a| a.iter().filter(|j| ["queued", "running", "paused"].contains(&j["status"].as_str().unwrap_or(""))).count()).unwrap_or(0);
    if pending + queued > 500 { return with_cors_for((axum::http::StatusCode::TOO_MANY_REQUESTS, "the queue is full").into_response(), &st, origin.as_deref()); }
    let id = new_id();
    // a song without a style gets the default one (kept in the job, so the file's details say which style made it)
    let mut params = v.get("params").cloned().filter(|p| p.is_object()).unwrap_or(json!({}));
    let mut title = v.get("title").and_then(|t| t.as_str()).unwrap_or("").chars().take(200).collect::<String>();
    if kind == "music" && params["style"].as_str().map(|t| t.trim().is_empty()).unwrap_or(true) {
        params["style"] = json!(crate::library::DEFAULT_MUSIC_STYLE);
        if title.trim().is_empty() { title = crate::library::DEFAULT_MUSIC_STYLE.into(); }
    }
    let item = json!({ "action": "add", "id": id, "owner": who, "kind": kind, "model": model, "title": title, "params": params });
    if crate::util::post_request(&s.data_dir, "queue-in", &id, &item).is_err() {
        return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "could not queue").into_response();
    }
    with_cors_for((axum::http::StatusCode::ACCEPTED, axum::Json(json!({ "id": id, "status": "queued" }))).into_response(), &st, origin.as_deref())
}
async fn srv_queue_action(axum::extract::State(s): axum::extract::State<Arc<Srv>>, axum::extract::Path((id, action)): axum::extract::Path<(String, String)>,
                          req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, _) = req.into_parts();
    let st = read_state(&s.data_dir);
    let origin = parts.headers.get("origin").and_then(|o| o.to_str().ok()).map(String::from);
    if parts.method == axum::http::Method::OPTIONS { return with_cors_for(axum::http::StatusCode::NO_CONTENT.into_response(), &st, origin.as_deref()); }
    if !host_ok(&parts.headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    let Some(who) = caller(&parts.headers, &st) else { return (axum::http::StatusCode::UNAUTHORIZED, "unauthorized").into_response() };
    if !["pause", "resume", "cancel", "remove"].contains(&action.as_str()) || !safe_id(&id) { return (axum::http::StatusCode::BAD_REQUEST, "bad action").into_response(); }
    // "all" pauses or resumes the whole queue: only this computer
    if id == "all" { if who != "local" { return (axum::http::StatusCode::FORBIDDEN, "only this computer can pause the whole queue").into_response(); } }
    else if !queue_job(&s.data_dir, &id).map(|j| owns(&who, &j)).unwrap_or(false) { return with_cors_for((axum::http::StatusCode::NOT_FOUND, "no such job").into_response(), &st, origin.as_deref()); }
    let _ = crate::util::post_request(&s.data_dir, "queue-in", &new_id(), &json!({ "action": action, "id": id }));
    with_cors_for((axum::http::StatusCode::ACCEPTED, axum::Json(json!({ "ok": true }))).into_response(), &st, origin.as_deref())
}
async fn srv_queue_output(axum::extract::State(s): axum::extract::State<Arc<Srv>>, axum::extract::Path(id): axum::extract::Path<String>,
                          axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    let origin = headers.get("origin").and_then(|o| o.to_str().ok()).map(String::from);
    if !host_ok(&headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    // <video>/<img> tags cannot send headers: the token or key may also come as ?t= / ?key=
    let mut h = headers.clone();
    if let Some(t) = q.get("t") { if let Ok(v) = axum::http::HeaderValue::from_str(t) { h.insert("x-sushila-token", v); } }
    if let Some(k) = q.get("key") { if let Ok(v) = axum::http::HeaderValue::from_str(&format!("Bearer {k}")) { h.insert("authorization", v); } }
    let Some(who) = (if media_q(&q, &st) { Some("local".to_string()) } else { caller(&h, &st) }) else { return (axum::http::StatusCode::UNAUTHORIZED, "unauthorized").into_response() };
    let Some(job) = queue_job(&s.data_dir, &id).filter(|j| safe_id(&id) && owns(&who, j)) else { return (axum::http::StatusCode::NOT_FOUND, "no such job").into_response() };
    let out = job.get("output").cloned().unwrap_or(Value::Null);
    let file = out.get("file").and_then(|f| f.as_str()).unwrap_or("");
    // a queue file (job-<id>.<ext>) or, since build 27, one of your files (Images/<date>/<name>): inside the files folder only
    if file.is_empty() || file.starts_with('.') { return (axum::http::StatusCode::NOT_FOUND, "no output yet").into_response(); }
    let Some(path) = crate::library::resolve(&crate::locate::outputs(&s.data_dir), file) else { return (axum::http::StatusCode::NOT_FOUND, "that file is not there any more").into_response() };
    if who != "local" && !rate_ok(&s, &who, &h, &st) { return (axum::http::StatusCode::TOO_MANY_REQUESTS, "too many requests; try again in a minute").into_response(); }
    // the type as the engine reported it, only if it is a picture, a song, a video or plain text: never a web page
    let mime = out.get("mime").and_then(|m| m.as_str()).filter(|m| ["image/png", "image/jpeg", "image/webp", "audio/mpeg", "audio/wav", "audio/flac", "audio/ogg", "video/webm", "video/mp4", "text/plain", "text/markdown"].contains(m))
        .unwrap_or("application/octet-stream").to_string();
    let disp = format!("{}; filename=\"{}\"", if q.contains_key("download") { "attachment" } else { "inline" }, file.replace(['"', '\r', '\n'], ""));
    with_cors_for(file_response(&path, &mime, disp, "no-store", headers.get("range")).await, &st, origin.as_deref())
}


/// POST /api/shutdown: this computer's own callers (session token) ask the owner of the server to stop. Written as a
/// request file like mode switches; the sushila command stops its models and exits, the desktop app ignores it.
async fn srv_shutdown(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !host_ok(&headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    if !admin_ok(&s, &headers, &st) { return (axum::http::StatusCode::UNAUTHORIZED, "admin login required (Admin tab), or use the sushila command on this computer").into_response(); }
    let _ = std::fs::write(s.data_dir.join("shutdown-request.json"), "{}");
    (axum::http::StatusCode::ACCEPTED, axum::Json(json!({ "ok": true }))).into_response()
}

/// POST /api/control {"action": ..., ...}: this computer asks the owner of the server (sushila serve) to install, remove,
/// start or stop something. Written to control-in/<id>.json; the owner applies it, reports progress in /api/state
/// (public.tasks[id]) and writes every step to logs/sushila.log. Actions: engine-install {build?}, install {pack},
/// remove {pack}, start {pack, mode?}, stop {pack}, settings {values}.
async fn srv_control(axum::extract::State(s): axum::extract::State<Arc<Srv>>, req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, body) = req.into_parts();
    let st = read_state(&s.data_dir);
    let origin = parts.headers.get("origin").and_then(|o| o.to_str().ok()).map(String::from);
    if parts.method == axum::http::Method::OPTIONS { return with_cors_for(axum::http::StatusCode::NO_CONTENT.into_response(), &st, origin.as_deref()); }
    if !host_ok(&parts.headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    if !admin_ok(&s, &parts.headers, &st) { return (axum::http::StatusCode::UNAUTHORIZED, "admin login required (Admin tab), or use the sushila command on this computer").into_response(); }
    let Ok(bytes) = axum::body::to_bytes(body, 65536).await else { return (axum::http::StatusCode::BAD_REQUEST, "bad request").into_response() };
    let Ok(mut v) = serde_json::from_slice::<Value>(&bytes) else { return (axum::http::StatusCode::BAD_REQUEST, "bad request").into_response() };
    let action = v.get("action").and_then(|a| a.as_str()).unwrap_or("");
    if !["engine-install", "install", "install-file", "install-hf", "remove", "start", "stop", "settings", "verify", "catalog", "share", "mode"].contains(&action) { return (axum::http::StatusCode::BAD_REQUEST, "unknown action").into_response(); }
    let id = new_id().replacen("job-", "task-", 1);
    v["id"] = json!(id);
    if crate::util::post_request(&s.data_dir, "control-in", &id, &v).is_err() {
        return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "could not queue the request").into_response();
    }
    with_cors_for((axum::http::StatusCode::ACCEPTED, axum::Json(json!({ "id": id }))).into_response(), &st, origin.as_deref())
}

/// GET /api/logs?since=<byte offset>: the shared log (logs/sushila.log) from that offset, for this computer only.
async fn srv_logs(axum::extract::State(s): axum::extract::State<Arc<Srv>>, axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>,
                  headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !host_ok(&headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    if !admin_ok(&s, &headers, &st) { return (axum::http::StatusCode::UNAUTHORIZED, "admin login required (Admin tab), or use the sushila command on this computer").into_response(); }
    // only what is new since `since`, at most the last 256 KB, read from the end (the log can be large); a log that
    // became shorter (rotated) starts again from its beginning
    let (next, text) = crate::util::read_tail(&s.data_dir.join("logs").join("sushila.log"), q.get("since").and_then(|x| x.parse::<u64>().ok()).unwrap_or(0), 256 << 10);
    axum::Json(json!({ "next": next, "text": text })).into_response()
}

/// GET /api/catalog: the model packs this computer can install (written by the owner to catalog-cache.json), this computer only.
async fn srv_catalog(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !admin_ok(&s, &headers, &st) { return (axum::http::StatusCode::UNAUTHORIZED, "admin login required").into_response(); }
    let v = std::fs::read_to_string(s.data_dir.join("catalog-cache.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(json!({ "packs": [] }));
    axum::Json(v).into_response()
}

/// GET /install/<pack>: the "Install" buttons on sushila.ai link here; the page asks before installing anything.
async fn srv_install_link(axum::extract::State(s): axum::extract::State<Arc<Srv>>, axum::extract::Path(pack): axum::extract::Path<String>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !host_ok(&headers, s.port, &read_state(&s.data_dir)) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    if !safe_id(&pack.replace('.', "_")) { return (axum::http::StatusCode::BAD_REQUEST, "bad pack").into_response(); }
    axum::response::Redirect::to(&format!("/?install={pack}#admin/packs")).into_response()
}

/// GET /api/crashes: why the server or a model crashed (crashes.json), for the Admin tab.
async fn srv_crashes(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !admin_ok(&s, &headers, &st) { return (axum::http::StatusCode::UNAUTHORIZED, "admin login required").into_response(); }
    let v: Value = std::fs::read_to_string(s.data_dir.join("crashes.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!([]));
    axum::Json(v).into_response()
}

async fn srv_docs(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !host_ok(&headers, s.port, &read_state(&s.data_dir)) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    ([("content-type", "text/html; charset=utf-8"), ("cache-control", "no-store")], DOCS_HTML).into_response()
}

/// GET /api/admin: {loggedIn, allowed, home}: what the Admin tab should show (no password: allowed is logged in).
async fn srv_admin(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !host_ok(&headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    // the home folder only for the computer itself (the ☰ menu shows it there; other machines never see local paths)
    let home = if this_computer(&headers, s.port) { Some(s.data_dir.to_string_lossy().to_string()) } else { None };
    let ok = admin_ok(&s, &headers, &st);
    axum::Json(json!({ "passwordSet": true, "loggedIn": ok, "allowed": ok, "home": home })).into_response()
}

/// POST /api/assistant {question, history?} -> {answer, sources, model}: "Ask Sushila", answered by the largest installed
/// text model from Sushila's documentation and live facts (webserver and CLI share assistant.rs). This computer's page,
/// or (when sharing) a key; visitors from other machines never see local paths.
async fn srv_assistant(axum::extract::State(s): axum::extract::State<Arc<Srv>>, req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, body) = req.into_parts();
    let st = read_state(&s.data_dir);
    let origin = parts.headers.get("origin").and_then(|o| o.to_str().ok()).map(String::from);
    let cors = |r: axum::response::Response| with_cors_for(r, &st, origin.as_deref());
    if parts.method == axum::http::Method::OPTIONS { return cors(axum::http::StatusCode::NO_CONTENT.into_response()); }
    if !host_ok(&parts.headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    let Some(who) = caller(&parts.headers, &st) else { return cors((axum::http::StatusCode::UNAUTHORIZED, "an access key is required").into_response()) };
    let local = who == "local" && local_host(&parts.headers, s.port);
    if who != "local" {
        if !rate_ok(&s, &who, &parts.headers, &st) { return cors((axum::http::StatusCode::TOO_MANY_REQUESTS, "too many requests; try again in a minute").into_response()); }
    }
    let Ok(bytes) = axum::body::to_bytes(body, 256 << 10).await else { return (axum::http::StatusCode::PAYLOAD_TOO_LARGE, "request too large").into_response() };
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let q: String = v.get("question").and_then(|x| x.as_str()).unwrap_or("").trim().chars().take(2000).collect();
    if q.is_empty() { return cors((axum::http::StatusCode::BAD_REQUEST, "question required").into_response()); }
    let history: Vec<Value> = v.get("history").and_then(|h| h.as_array()).cloned().unwrap_or_default();
    match crate::assistant::answer_here(&s.data_dir, s.port, &q, &history, local).await {
        Ok(r) => cors(axum::Json(r).into_response()),
        Err(e) => cors((axum::http::StatusCode::SERVICE_UNAVAILABLE, e).into_response()),
    }
}

/// Starts the web server on bind:port. Returns its address and the stop signal.
pub async fn start(data_dir: PathBuf, port: u16, bind: &str) -> Result<(String, oneshot::Sender<()>), String> {
    let ip: std::net::IpAddr = bind.parse().map_err(|_| format!("not an IP address: {bind}"))?;
    let listener = tokio::net::TcpListener::bind((ip, port)).await.map_err(|e| format!("port {port} is busy: {e}"))?;
    let _ = cli_token(&data_dir);
    let srv = Arc::new(Srv { port, data_dir, http: client()?, hits: std::sync::Mutex::new(HashMap::new()), metrics: Default::default(), started: std::time::Instant::now() });
    let app = axum::Router::new()
        .route("/", axum::routing::get(srv_page))
        .route("/docs", axum::routing::get(srv_docs))
        .route("/api/prompts/images", axum::routing::get(srv_prompts))
        .route("/api/notifications", axum::routing::get(srv_notifications))
        .route("/station", axum::routing::get(srv_station))
        .route("/station/", axum::routing::get(srv_station))
        .route("/station/:file", axum::routing::get(srv_station))
        .route("/api/crashes", axum::routing::get(srv_crashes))
        .route("/sushila.js", axum::routing::get(srv_js))
        .route("/api/state", axum::routing::get(srv_state))
        .route("/api/mode", axum::routing::post(srv_mode).options(srv_mode))
        .route("/api/reveal", axum::routing::post(srv_reveal))
        .route("/api/files-folder", axum::routing::get(srv_files_folder_get).post(srv_files_folder))
        .route("/api/use", axum::routing::post(srv_use))
        .route("/api/media-token", axum::routing::get(srv_media_token)).route("/api/tunnel", axum::routing::get(srv_tunnel)).route("/api/tunnel/:act", axum::routing::post(srv_tunnel_act))
        .route("/api/system", axum::routing::get(srv_system))
        .route("/favicon.ico", axum::routing::get(srv_brand)).route("/favicon.png", axum::routing::get(srv_brand)).route("/favicon-32.png", axum::routing::get(srv_brand))
        .route("/apple-touch-icon.png", axum::routing::get(srv_brand)).route("/brand/:file", axum::routing::get(srv_brand))
        .route("/api/diagnose", axum::routing::get(srv_diagnose))
        .route("/api/library", axum::routing::get(srv_library))
        .route("/api/library/file", axum::routing::get(srv_library_file))
        .route("/api/library/:act", axum::routing::post(srv_library_act))
        .route("/api/share/:act", axum::routing::get(srv_share).post(srv_share))
        .route("/api/shutdown", axum::routing::post(srv_shutdown))
        .route("/api/control", axum::routing::post(srv_control).options(srv_control))
        .route("/api/logs", axum::routing::get(srv_logs))
        .route("/api/catalog", axum::routing::get(srv_catalog))
        .route("/api/admin", axum::routing::get(srv_admin))
        .route("/install/:pack", axum::routing::get(srv_install_link))
        .route("/admin", axum::routing::get(|| async { axum::response::Redirect::to("/#admin") }))
        .route("/api/assistant", axum::routing::post(srv_assistant).options(srv_assistant))
        .route("/api/queue", axum::routing::get(srv_queue).post(srv_queue_add).options(srv_queue_add))
        .route("/api/queue/:id/output", axum::routing::get(srv_queue_output))
        .route("/api/queue/:id/:action", axum::routing::post(srv_queue_action).options(srv_queue_action))
        .fallback(srv_proxy)
        .with_state(srv)
        .layer(axum::middleware::from_fn(mark_peer));
    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move { let _ = axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).with_graceful_shutdown(async { let _ = rx.await; }).await; });
    Ok((format!("http://{bind}:{port}"), tx))
}

#[cfg(test)]
mod robustness_tests {
    use super::*;
    #[test] fn image_prompts_are_new_pictures() {
        let p = image_prompts();
        assert_eq!(p.len(), 70);
        assert!(p.iter().all(|x| !x.starts_with('#') && !x.contains("this photo") && x.len() > 20));
        // the Station screens the engine serves at /station/ are all there
        for f in ["index.html", "app.js", "bridge.js", "app.css", "ipad.css", "logo.png"] { assert!(STATION_FILES.iter().any(|(n, _, b)| *n == f && !b.is_empty()), "{f}"); }
    }
    #[test] fn proxy_paths() {
        for ok in ["/v1/chat/completions", "/v1/models", "/v1/video/jobs/abc", "/v1/music/job"] { assert!(proxy_path_ok(ok), "{ok}"); }
        for bad in ["/v1/../slots", "/v1/./props", "/v1/%2e%2e/props", "/v1/%2E%2e/x", "/v1/a%2fb", "/v1/a%5Cb", "/v1/a\\b", "/v1/video/../../x"] { assert!(!proxy_path_ok(bad), "{bad}"); }
    }
    #[test] fn ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
        for bad in ["bytes=1000-", "bytes=5-2", "bytes=0-1,5-6", "items=0-1", "bytes=-0", "bytes=x-y"] { assert_eq!(parse_range(bad, 1000), None, "{bad}"); }
        assert_eq!(parse_range("bytes=0-", 0), None);
    }
    #[test] fn local_needs_the_socket_not_the_host_header() {
        let mut h = axum::http::HeaderMap::new();
        h.insert("host", axum::http::HeaderValue::from_static("localhost:7874"));
        assert!(!local_host(&h, 7874), "a Host header alone is not this computer");
        h.insert(PEER_LOCAL, axum::http::HeaderValue::from_static("1"));
        assert!(local_host(&h, 7874));
        h.insert("host", axum::http::HeaderValue::from_static("abc.trycloudflare.com"));
        assert!(!local_host(&h, 7874));
    }
    #[test] fn only_model_apis_are_forwarded() {
        assert_eq!(upstream_path("/v1/chat/completions").as_deref(), Some("/v1/chat/completions"));
        assert_eq!(upstream_path("/v1/music/synth").as_deref(), Some("/synth"));
        assert_eq!(upstream_path("/v1/video/vid_gen").as_deref(), Some("/sdcpp/v1/vid_gen"));
        assert_eq!(upstream_path("/v1/video/jobs/abc-1").as_deref(), Some("/sdcpp/v1/jobs/abc-1"));
        assert_eq!(upstream_path("/v1/video/jobs/abc-1/cancel").as_deref(), Some("/sdcpp/v1/jobs/abc-1/cancel"));
        for bad in ["/v1/music@127.0.0.1:7874/", "/v1/music@169.254.169.254/latest", "/v1/musicx", "/v1/music/../api", "/v1/music/slots",
                    "/v1/video@evil/x", "/v1/video/jobs/a@b", "/v1/video/jobs/a/b/c", "/slots/0", "/props", "/v1/music", "/api/state"] {
            assert!(upstream_path(bad).is_none(), "{bad}");
        }
        let u = upstream_url(8080, "/synth", Some("a=1")).unwrap();
        assert_eq!(u.as_str(), "http://127.0.0.1:8080/synth?a=1");
        assert!(upstream_url(8080, "/x@evil.com/", None).map(|u| u.host_str() == Some("127.0.0.1")).unwrap_or(true));
    }
    #[test] fn media_tokens() {
        let now = 1_800_000_000_000u64; let t = media_token("local-tok", now);
        assert!(media_ok(&t, "local-tok", now + 1000), "fresh: ok");
        assert!(!media_ok(&t, "local-tok", now + MEDIA_MS + 1), "an hour later: expired");
        assert!(!media_ok(&t, "other-tok", now), "another computer's token: refused");
        assert!(!media_ok(&t.replace("media.", "owner."), "local-tok", now) && !media_ok("media.1.x", "local-tok", now) && !media_ok(&t, "", now));
        let mut q = HashMap::new(); q.insert("t".to_string(), t.clone());
        // a media token is no caller: it never opens anything but the two file routes
        let mut h = axum::http::HeaderMap::new(); h.insert("x-sushila-token", axum::http::HeaderValue::from_str(&t).unwrap());
        assert!(caller(&h, &json!({ "token": "local-tok" })).is_none());
    }
    #[test] fn owner_pass_through_the_internet_link() {
        let (id, sec) = ("aaaaaaaaaaaaaaaaaaaa", "12".repeat(32));
        crate::tunnel::set_owner_for_test(id, &sec);
        let now = crate::cmds::now_secs() * 1000;
        let tunnel = |pass: &str| { let mut h = axum::http::HeaderMap::new();
            h.insert("host", axum::http::HeaderValue::from_static("abc-def.trycloudflare.com"));
            h.insert("cf-connecting-ip", axum::http::HeaderValue::from_static("198.51.100.7"));
            if let Ok(v) = axum::http::HeaderValue::from_str(pass) { h.insert("x-sushila-token", v); } h };
        let st = json!({ "token": "local-token-xyz", "share": { "enabled": true, "hosts": ["abc-def.trycloudflare.com"], "keys": [] } });
        let good = tunnel(&crate::tunnel::pass_for_test(id, &sec, now + 3_600_000));
        assert!(local_host(&good, 7874) && caller(&good, &st).as_deref() == Some("local") && host_ok(&good, 7874, &st), "the owner: everything this computer has");
        assert!(!this_computer(&good, 7874), "but never this computer's own token in the page");
        let open = json!({ "token": "t", "share": { "enabled": true, "open": true, "hosts": ["*"], "keys": [] } });
        assert!(caller(&tunnel(""), &open).is_none(), "open mode: never through the internet link");
        let mut lan = axum::http::HeaderMap::new(); lan.insert("host", axum::http::HeaderValue::from_static("192.168.1.5:7874"));
        assert!(caller(&lan, &open).is_some(), "open mode: still for the local network");
        lan.insert("origin", axum::http::HeaderValue::from_static("https://evil.example"));
        assert!(caller(&lan, &open).is_none(), "open mode: not for another web site's page");
        lan.insert("origin", axum::http::HeaderValue::from_static("http://192.168.1.5:7874"));
        assert!(caller(&lan, &open).is_some(), "open mode: this server's own page");
        for (bad, why) in [(crate::tunnel::pass_for_test(id, &"34".repeat(32), now + 3_600_000), "forged (another secret)"),
                           (crate::tunnel::pass_for_test(id, &sec, now - 1), "expired"),
                           (crate::tunnel::pass_for_test("bbbbbbbbbbbbbbbbbbbb", &sec, now + 3_600_000), "another link"),
                           ("local-token-xyz".to_string(), "the local token through the tunnel"), ("owner.".to_string(), "garbage")] {
            let h = tunnel(&bad);
            assert!(!local_host(&h, 7874) && caller(&h, &st).is_none(), "{why}: refused");
        }
    }
}

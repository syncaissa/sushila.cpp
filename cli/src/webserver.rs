// The web server of `sushila serve`:
//   /                         the page (web/sushila_page.js): Chat, Code, Images, Music, Video, Queue, managing Sushila
//   /api/state                the public part of state.json (installed packs, running models)
//   /api/mode, /api/queue...  mode switches and the background queue (request files in data_dir, applied by the owner)
//   /api/control, /api/logs   install, remove, start, stop... and the shared log (this computer only; applied by sushila serve)
//   /api/shutdown             asks the owner to stop (this computer only; the sushila command honours it)
//   /v1/*, /health            forwarded to the running Sushila.cpp server for the named model (OpenAI-compatible)
// Only this computer may call it unless sharing is on (state.json "share"): then the listed host names and access keys.
use std::{collections::HashMap, path::{Path, PathBuf}, sync::Arc, time::Duration};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use crate::net::client;

pub const APP_JS: &str = include_str!("../web/sushila_page.js");
/// The documentation (one self-contained file; the website can serve the same file).
pub const DOCS_HTML: &str = include_str!("../web/sushila_docs.html");
const PAGE_HTML: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sushila Inference</title></head><body><div id="app"></div><script src="/sushila.js"></script></body></html>"#;

// ---------- local web server ----------
pub struct Srv { port: u16, data_dir: PathBuf, http: reqwest::Client, hits: std::sync::Mutex<HashMap<String, (u32, std::time::Instant)>>,
                 sessions: std::sync::Mutex<HashMap<String, (std::time::Instant, String)>>,  // session -> (since, which password)
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
        let cdir = dir.join("control-in"); let _ = std::fs::create_dir_all(&cdir);
        let _ = std::fs::write(cdir.join(format!("{id}.json")), json!({ "id": id, "action": "start", "pack": model, "source": "on demand" }).to_string());
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

// ---------- the Admin tab: one password per computer
// <data>/adminpassword holds an Argon2id hash of the admin password (not the password; it cannot be read back). It is
// created the first time (in the terminal, or on the Admin tab from this computer only). Changing it needs the current
// password (Admin tab or `sushila password`). Lost it? On this computer: `sushila password --reset` (as the user who owns
// the data folder), so the owner is never locked out and nobody else can reset it. The sushila commands do not need the
// password: they run as the same user and prove it with <data>/admin-cli.token, a random file only that user can read.
pub fn password_set(dir: &Path) -> bool { dir.join("adminpassword").exists() }
/// Which password a session was made with: a login ends when the password is changed or reset.
fn password_id(dir: &Path) -> String { std::fs::read(dir.join("adminpassword")).map(|b| hex::encode(Sha256::digest(&b))).unwrap_or_default() }
pub fn set_password(dir: &Path, pw: &str) -> Result<(), String> {
    use argon2::{password_hash::{PasswordHasher, SaltString}, Argon2};
    if pw.chars().count() < 8 { return Err("the admin password needs at least 8 characters".into()); }
    let mut salt = [0u8; 16]; getrandom::getrandom(&mut salt).map_err(|e| e.to_string())?;
    let salt = SaltString::encode_b64(&salt).map_err(|e| e.to_string())?;
    let hash = Argon2::default().hash_password(pw.as_bytes(), &salt).map_err(|e| e.to_string())?.to_string();
    write_private(&dir.join("adminpassword"), &hash)
}
pub fn check_password(dir: &Path, pw: &str) -> bool {
    use argon2::{password_hash::{PasswordHash, PasswordVerifier}, Argon2};
    let Ok(h) = std::fs::read_to_string(dir.join("adminpassword")) else { return false };
    let Ok(parsed) = PasswordHash::new(h.trim()) else { return false };
    Argon2::default().verify_password(pw.as_bytes(), &parsed).is_ok()
}
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
fn local_host(headers: &axum::http::HeaderMap, port: u16) -> bool {
    let host = headers.get("host").and_then(|h| h.to_str().ok()).unwrap_or("");
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}
/// Admin requests: from this computer (or from anywhere when share.remoteAdmin is on), with an Admin-tab session or
/// the sushila commands' token.
fn admin_ok(s: &Srv, headers: &axum::http::HeaderMap, st: &Value) -> bool {
    if !host_ok(headers, s.port, st) { return false; }
    let remote_ok = share(st).and_then(|sh| sh.get("remoteAdmin")).and_then(|v| v.as_bool()).unwrap_or(false);
    if !local_host(headers, s.port) && !remote_ok { return false; }
    let given = headers.get("x-sushila-admin").and_then(|h| h.to_str().ok()).unwrap_or("");
    if given.len() < 32 { return false; }
    if given == cli_token(&s.data_dir) { return true; }
    let mut ss = s.sessions.lock().unwrap();
    let pid = password_id(&s.data_dir);  // changed or reset: sessions of the old password end
    ss.retain(|_, (t, p)| t.elapsed() < Duration::from_secs(12 * 3600) && !pid.is_empty() && *p == pid);
    ss.contains_key(given)
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
    if host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}") { return true; }
    let Some(sh) = share(st) else { return false };
    let name = host.rsplit_once(':').map(|(h, p)| if p.chars().all(|c| c.is_ascii_digit()) { h } else { host }).unwrap_or(host).to_ascii_lowercase();
    sh.get("hosts").and_then(|h| h.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).any(|x| x == "*" || x.eq_ignore_ascii_case(&name))).unwrap_or(false)
}

/// Who is calling: the local session token, or (when sharing) a valid access key. Returns the rate-limit bucket.
fn caller(headers: &axum::http::HeaderMap, st: &Value) -> Option<String> {
    let token = st.get("token").and_then(|t| t.as_str()).unwrap_or("");
    let given = headers.get("x-sushila-token").and_then(|h| h.to_str().ok()).unwrap_or("");
    if !token.is_empty() && given == token { return Some("local".into()); }
    let sh = share(st)?;
    let keyed = headers.get("authorization").and_then(|h| h.to_str().ok()).and_then(|h| h.strip_prefix("Bearer ")).map(|k| k.trim())
        .filter(|k| k.len() >= 20).map(|k| hex::encode(Sha256::digest(k.as_bytes())))
        .filter(|h| sh.get("keys").and_then(|k| k.as_array()).map(|a| a.iter().any(|k| k.get("sha256").and_then(|x| x.as_str()) == Some(h.as_str()))).unwrap_or(false));
    // share.open (sushila serve --open, a trusted network): anyone who can reach the port may chat and generate, without a
    // key (one shared rate-limit bucket); managing Sushila stays this computer's only
    // in open mode each browser is its own anonymous user (x-sushila-visitor, a random id the page keeps), so visitors
    // never see each other's queue jobs
    keyed.or_else(|| sh.get("open").and_then(|o| o.as_bool()).filter(|o| *o).map(|_| {
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
    let host = headers.get("host").and_then(|h| h.to_str().ok()).unwrap_or("");
    let local = host == format!("127.0.0.1:{}", s.port) || host == format!("localhost:{}", s.port);
    let html = match (local, st.get("token").and_then(|t| t.as_str())) {
        (true, Some(t)) => PAGE_HTML.replace("<div id=\"app\"></div>", &format!("<div id=\"app\"></div><script>window.SUSHILA_TOKEN={};</script>", Value::String(t.to_string()))),
        _ => PAGE_HTML.to_string(),
    };
    ([("content-type", "text/html; charset=utf-8"), ("cache-control", "no-store"), ("x-frame-options", "DENY"), ("referrer-policy", "no-referrer")], html).into_response()
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
    with_cors_for(axum::Json(st.get("public").cloned().unwrap_or(json!({}))).into_response(), &st, origin.as_deref())
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
            let per_min = share(&st).and_then(|sh| sh.get("perMinute")).and_then(|v| v.as_u64()).unwrap_or(30).max(1) as u32;
            let mut hits = s.hits.lock().unwrap();
            let e = hits.entry(who).or_insert((0, std::time::Instant::now()));
            if e.1.elapsed() > Duration::from_secs(60) { *e = (0, std::time::Instant::now()); }
            e.0 += 1;
            if e.0 > per_min { drop(hits); return deny(axum::http::StatusCode::TOO_MANY_REQUESTS, "too many requests for this key; try again in a minute"); }
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
    let pq = parts.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or(path.clone());
    // music servers have their own paths; video uses stable-diffusion.cpp's native async API (/sdcpp/v1/vid_gen, /sdcpp/v1/jobs/..)
    let upstream_path = if let Some(r) = pq.strip_prefix("/v1/video") { format!("/sdcpp/v1{r}") }
        else { pq.strip_prefix("/v1/music").map(|r| r.to_string()).unwrap_or(pq) };
    let url = format!("http://127.0.0.1:{up}{upstream_path}");
    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut r = s.http.request(method, url).body(bytes.to_vec()).header("x-request-id", &rid);
    for h in ["content-type", "accept"] {
        if let Some(v) = parts.headers.get(h).and_then(|v| v.to_str().ok()) { r = r.header(h, v); }
    }
    let prompt = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v.get("prompt").and_then(|p| p.as_str()).map(String::from)).unwrap_or_default();
    let mut resp = match r.send().await {
        // a picture is also saved in the home folder (outputs/images/<date>/), so it can be found without downloading;
        // this computer gets the path of each file in the answer (sushila_file), other machines do not
        Ok(resp) if path == "/v1/images/generations" && resp.status().is_success() => {
            guard.status = 200;
            let body = resp.bytes().await.unwrap_or_default();
            drop(guard);
            let out = match serde_json::from_slice::<Value>(&body) {
                Ok(mut v) => { save_images(&s.data_dir, &prompt, &mut v, local); serde_json::to_vec(&v).unwrap_or(body.to_vec()) }
                Err(_) => body.to_vec(),
            };
            (axum::http::StatusCode::OK, [("content-type", "application/json".to_string()), ("cache-control", "no-store".to_string())], out).into_response()
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
        Some((false, _)) => format!("{name} is not running: its engine stopped{tail}. Start it again on the Admin page (Packs, Start), or type start {id} in the Sushila window; if it stops again, Admin page, Logs, Crashes says why (often: not enough GPU memory, so stop another model first)."),
        None => format!("{name} is installed but not running, in Standard or Accelerated mode. Start it on the Admin page (Packs, Start), or type start {id} in the Sushila window, then choose it at the top of this page."),
    }
}

/// Writes each image of an images answer to outputs/images/<YYYY-MM-DD>/<HHMMSS>-<first words of the prompt>-<n>.png
/// and, for this computer, adds its path to the answer (data[i].sushila_file).
fn save_images(dir: &Path, prompt: &str, v: &mut Value, local: bool) {
    use base64::Engine;
    let now = crate::util::now_iso();
    let day = dir.join("outputs").join("images").join(&now[..10]);
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
        if std::fs::write(&f, png).is_ok() && local { it["sushila_file"] = json!(f.to_string_lossy()); }
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
    let dir = s.data_dir.join("control-in");
    let req = json!({ "id": id, "action": action, "pack": pack, "mode": mode, "source": "inference page" });
    if std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(dir.join(format!("{id}.json")), req.to_string())).is_err() { return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "could not queue the request").into_response(); }
    (axum::http::StatusCode::ACCEPTED, axum::Json(json!({ "id": id }))).into_response()
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
    let outputs = s.data_dir.join("outputs");
    // a bare file name means a queue output (outputs/<job>.<ext>)
    let p = p.map(|p| if p.is_absolute() { p } else { outputs.join(p) });
    let (Some(f), Ok(root)) = (p.and_then(|p| std::fs::canonicalize(p).ok()), std::fs::canonicalize(&outputs)) else { return (axum::http::StatusCode::NOT_FOUND, "that file is not there any more").into_response() };
    if !f.starts_with(&root) { return (axum::http::StatusCode::FORBIDDEN, "only files in the outputs folder").into_response(); }
    let r = if cfg!(windows) {
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
        "/health" => axum::Json(json!({ "ok": true, "app": "sushila", "version": env!("CARGO_PKG_VERSION"), "port": s.port, "uptimeSeconds": s.started.elapsed().as_secs(), "models": running.len(), "ready": ready })).into_response(),
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
    let pending = std::fs::read_dir(s.data_dir.join("queue-in")).map(|d| d.count()).unwrap_or(0);
    let queued = read_queue(&s.data_dir).get("jobs").and_then(|j| j.as_array()).map(|a| a.len()).unwrap_or(0);
    if pending + queued > 500 { return with_cors_for((axum::http::StatusCode::TOO_MANY_REQUESTS, "the queue is full").into_response(), &st, origin.as_deref()); }
    let id = new_id();
    let item = json!({ "action": "add", "id": id, "owner": who, "kind": kind, "model": model,
        "title": v.get("title").and_then(|t| t.as_str()).unwrap_or("").chars().take(200).collect::<String>(), "params": v.get("params").cloned().unwrap_or(json!({})) });
    let dir = s.data_dir.join("queue-in");
    if std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(dir.join(format!("{id}.json")), item.to_string())).is_err() {
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
    let dir = s.data_dir.join("queue-in");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(format!("{}.json", new_id())), json!({ "action": action, "id": id }).to_string());
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
    let Some(who) = caller(&h, &st) else { return (axum::http::StatusCode::UNAUTHORIZED, "unauthorized").into_response() };
    let Some(job) = queue_job(&s.data_dir, &id).filter(|j| safe_id(&id) && owns(&who, j)) else { return (axum::http::StatusCode::NOT_FOUND, "no such job").into_response() };
    let out = job.get("output").cloned().unwrap_or(Value::Null);
    let file = out.get("file").and_then(|f| f.as_str()).unwrap_or("");
    if file.is_empty() || file.contains('/') || file.contains('\\') || file.starts_with('.') { return (axum::http::StatusCode::NOT_FOUND, "no output yet").into_response(); }
    let Ok(data) = tokio::fs::read(s.data_dir.join("outputs").join(file)).await else { return (axum::http::StatusCode::NOT_FOUND, "output missing").into_response() };
    let mime = out.get("mime").and_then(|m| m.as_str()).unwrap_or("application/octet-stream").to_string();
    let disp = format!("{}; filename=\"{}\"", if q.contains_key("download") { "attachment" } else { "inline" }, file);
    with_cors_for(([("content-type", mime), ("content-disposition", disp), ("cache-control", "no-store".to_string())], data).into_response(), &st, origin.as_deref())
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
    let dir = s.data_dir.join("control-in");
    if std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(dir.join(format!("{id}.json")), v.to_string())).is_err() {
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
    let data = std::fs::read(s.data_dir.join("logs").join("sushila.log")).unwrap_or_default();
    let since = q.get("since").and_then(|x| x.parse::<usize>().ok()).unwrap_or(0).min(data.len());
    let start = since.max(data.len().saturating_sub(256 << 10));  // at most the last 256 KB
    axum::Json(json!({ "next": data.len(), "text": String::from_utf8_lossy(&data[start..]) })).into_response()
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

/// GET /api/admin: {passwordSet, loggedIn, local}: what the Admin tab should show.
async fn srv_admin(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !host_ok(&headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    let remote_ok = share(&st).and_then(|sh| sh.get("remoteAdmin")).and_then(|v| v.as_bool()).unwrap_or(false);
    // the home folder only for the computer itself (the ☰ menu shows it there; other machines never see local paths)
    let home = if local_host(&headers, s.port) { Some(s.data_dir.to_string_lossy().to_string()) } else { None };
    axum::Json(json!({ "passwordSet": password_set(&s.data_dir), "loggedIn": admin_ok(&s, &headers, &st), "allowed": local_host(&headers, s.port) || remote_ok, "home": home })).into_response()
}
/// POST /api/login {password} -> {session}; POST /api/setup {password}: the first password, only from this computer
/// and only while none is set; POST /api/admin/change {current, password} (logged in + the current password); POST /api/admin/logout.
async fn srv_login(axum::extract::State(s): axum::extract::State<Arc<Srv>>, axum::extract::Path(what): axum::extract::Path<String>, req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, body) = req.into_parts();
    let st = read_state(&s.data_dir);
    let remote_ok = share(&st).and_then(|sh| sh.get("remoteAdmin")).and_then(|v| v.as_bool()).unwrap_or(false);
    if !host_ok(&parts.headers, s.port, &st) || !(local_host(&parts.headers, s.port) || remote_ok) { return (axum::http::StatusCode::FORBIDDEN, "admin is available on this computer only").into_response(); }
    let Ok(bytes) = axum::body::to_bytes(body, 4096).await else { return (axum::http::StatusCode::BAD_REQUEST, "bad request").into_response() };
    let pw = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v.get("password").and_then(|p| p.as_str()).map(String::from)).unwrap_or_default();
    let new_session = |s: &Srv| { let mut b = [0u8; 24]; let _ = getrandom::getrandom(&mut b); let id = hex::encode(b); s.sessions.lock().unwrap().insert(id.clone(), (std::time::Instant::now(), password_id(&s.data_dir))); id };
    match what.as_str() {
        "setup" => {
            if password_set(&s.data_dir) { return (axum::http::StatusCode::CONFLICT, "a password is already set (delete the adminpassword file to start over)").into_response(); }
            if !local_host(&parts.headers, s.port) { return (axum::http::StatusCode::FORBIDDEN, "the first password can only be set on this computer").into_response(); }
            if let Err(e) = set_password(&s.data_dir, &pw) { return (axum::http::StatusCode::BAD_REQUEST, e).into_response(); }
            axum::Json(json!({ "session": new_session(&s) })).into_response()
        }
        "login" => {
            let dir = s.data_dir.clone(); let pw2 = pw.clone();
            let ok = tokio::task::spawn_blocking(move || check_password(&dir, &pw2)).await.unwrap_or(false);
            if !ok { tokio::time::sleep(Duration::from_secs(1)).await; return (axum::http::StatusCode::UNAUTHORIZED, "wrong password").into_response(); }
            axum::Json(json!({ "session": new_session(&s) })).into_response()
        }
        "change" => {
            // changing needs a logged-in session AND the current password; a lost password is reset only with
            // `sushila password --reset` on this computer
            if !admin_ok(&s, &parts.headers, &st) { return (axum::http::StatusCode::UNAUTHORIZED, "log in first").into_response(); }
            let v = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
            let (cur, new) = (v.get("current").and_then(|p| p.as_str()).unwrap_or("").to_string(), v.get("password").and_then(|p| p.as_str()).unwrap_or("").to_string());
            let dir = s.data_dir.clone();
            if !tokio::task::spawn_blocking(move || check_password(&dir, &cur)).await.unwrap_or(false) { tokio::time::sleep(Duration::from_secs(1)).await; return (axum::http::StatusCode::UNAUTHORIZED, "wrong current password").into_response(); }
            if let Err(e) = set_password(&s.data_dir, &new) { return (axum::http::StatusCode::BAD_REQUEST, e).into_response(); }
            let keep = parts.headers.get("x-sushila-admin").and_then(|h| h.to_str().ok()).unwrap_or("").to_string();
            let pid = password_id(&s.data_dir);
            let mut ss = s.sessions.lock().unwrap();
            ss.retain(|k, _| *k == keep);  // other browsers log in again with the new password
            if let Some(v) = ss.get_mut(&keep) { v.1 = pid; }
            axum::Json(json!({ "ok": true })).into_response()
        }
        "logout" => {
            if let Some(t) = parts.headers.get("x-sushila-admin").and_then(|h| h.to_str().ok()) { s.sessions.lock().unwrap().remove(t); }
            axum::Json(json!({ "ok": true })).into_response()
        }
        _ => (axum::http::StatusCode::NOT_FOUND, "not found").into_response(),
    }
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
        let per_min = share(&st).and_then(|sh| sh.get("perMinute")).and_then(|v| v.as_u64()).unwrap_or(30).max(1) as u32;
        let mut hits = s.hits.lock().unwrap();
        let e = hits.entry(who.clone()).or_insert((0, std::time::Instant::now()));
        if e.1.elapsed() > Duration::from_secs(60) { *e = (0, std::time::Instant::now()); }
        e.0 += 1;
        if e.0 > per_min { return cors((axum::http::StatusCode::TOO_MANY_REQUESTS, "too many requests; try again in a minute").into_response()); }
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
    let srv = Arc::new(Srv { port, data_dir, http: client()?, hits: std::sync::Mutex::new(HashMap::new()), sessions: std::sync::Mutex::new(HashMap::new()), metrics: Default::default(), started: std::time::Instant::now() });
    let app = axum::Router::new()
        .route("/", axum::routing::get(srv_page))
        .route("/docs", axum::routing::get(srv_docs))
        .route("/api/crashes", axum::routing::get(srv_crashes))
        .route("/sushila.js", axum::routing::get(srv_js))
        .route("/api/state", axum::routing::get(srv_state))
        .route("/api/mode", axum::routing::post(srv_mode).options(srv_mode))
        .route("/api/reveal", axum::routing::post(srv_reveal))
        .route("/api/use", axum::routing::post(srv_use))
        .route("/api/shutdown", axum::routing::post(srv_shutdown))
        .route("/api/control", axum::routing::post(srv_control).options(srv_control))
        .route("/api/logs", axum::routing::get(srv_logs))
        .route("/api/catalog", axum::routing::get(srv_catalog))
        .route("/api/admin", axum::routing::get(srv_admin))
        .route("/api/admin/:what", axum::routing::post(srv_login))
        .route("/install/:pack", axum::routing::get(srv_install_link))
        .route("/admin", axum::routing::get(|| async { axum::response::Redirect::to("/#admin") }))
        .route("/api/assistant", axum::routing::post(srv_assistant).options(srv_assistant))
        .route("/api/queue", axum::routing::get(srv_queue).post(srv_queue_add).options(srv_queue_add))
        .route("/api/queue/:id/output", axum::routing::get(srv_queue_output))
        .route("/api/queue/:id/:action", axum::routing::post(srv_queue_action).options(srv_queue_action))
        .fallback(srv_proxy)
        .with_state(srv);
    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move { let _ = axum::serve(listener, app).with_graceful_shutdown(async { let _ = rx.await; }).await; });
    Ok((format!("http://{bind}:{port}"), tx))
}

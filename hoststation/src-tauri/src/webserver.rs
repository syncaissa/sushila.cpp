// The local web server, shared by Sushila Host Station (the desktop app) and the sushila command (no window):
//   /                         the inference page (Chat, Code, Images, Music, Video, Queue), the same JS file as the app
//   /api/state                the public part of state.json (installed packs, running models)
//   /api/mode, /api/queue...  mode switches and the background queue (request files in data_dir, applied by the owner)
//   /api/shutdown             asks the owner to stop (this computer only; the sushila command honours it)
//   /v1/*, /health            forwarded to the running Sushila.cpp server for the named model (OpenAI-compatible)
// Only this computer may call it unless sharing is on (state.json "share"): then the listed host names and access keys.
use std::{collections::HashMap, path::{Path, PathBuf}, sync::Arc, time::Duration};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use crate::net::client;

pub const APP_JS: &str = include_str!("../../worker_sushila_host.js");
const PAGE_HTML: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sushila Inference</title></head><body><div id="app"></div><script src="/worker_sushila_host.js"></script></body></html>"#;

// ---------- local web server ----------
pub struct Srv { port: u16, data_dir: PathBuf, http: reqwest::Client, hits: std::sync::Mutex<HashMap<String, (u32, std::time::Instant)>> }

// Sharing (Settings -> Share on the network), read from state.json on every request:
//   share.enabled        accept requests from other machines (the server then listens on share.bind, e.g. 0.0.0.0)
//   share.hosts          host names a browser or reverse proxy may use, e.g. ["ai.example.com"]; "*" accepts any
//   share.keys           [{name, sha256}] of access keys; callers send "Authorization: Bearer <key>"
//   share.perMinute      requests per minute per key
fn share(st: &Value) -> Option<&Value> { st.get("share").filter(|s| s.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false)) }

pub fn read_state(dir: &Path) -> Value {
    std::fs::read_to_string(dir.join("state.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
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
    let key = headers.get("authorization").and_then(|h| h.to_str().ok())?.strip_prefix("Bearer ")?.trim();
    if key.len() < 20 { return None; }
    let h = hex::encode(Sha256::digest(key.as_bytes()));
    sh.get("keys")?.as_array()?.iter().find(|k| k.get("sha256").and_then(|x| x.as_str()) == Some(h.as_str())).map(|_| h)
}

async fn srv_page(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !host_ok(&headers, s.port, &read_state(&s.data_dir)) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    ([("content-type", "text/html; charset=utf-8"), ("cache-control", "no-store")], PAGE_HTML).into_response()
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
        h.insert("access-control-allow-headers", axum::http::HeaderValue::from_static("authorization, content-type, x-sushila-model, x-sushila-token"));
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
    if !(path.starts_with("/v1/") || path == "/health") { return (axum::http::StatusCode::NOT_FOUND, "not found").into_response(); }
    let origin = parts.headers.get("origin").and_then(|o| o.to_str().ok()).map(String::from);
    let with_cors = |r: axum::response::Response, st: &Value| with_cors_for(r, st, origin.as_deref());
    if parts.method == axum::http::Method::OPTIONS { return with_cors(axum::http::StatusCode::NO_CONTENT.into_response(), &st); }
    let deny = |code: axum::http::StatusCode, msg: &'static str| with_cors((code, msg).into_response(), &st);
    if path.starts_with("/v1/") {
        let Some(who) = caller(&parts.headers, &st) else {
            return deny(axum::http::StatusCode::UNAUTHORIZED, "an access key is required (Authorization: Bearer <key>), or open this page from Sushila Host Station");
        };
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
    let pick = match wanted.as_deref() {
        Some(m) if running.contains_key(m) => running.get(m),
        _ if running.len() == 1 => running.values().next(),
        _ => None,
    };
    let Some(up) = pick.and_then(|r| r.get("port")).and_then(|p| p.as_u64()) else {
        return deny(axum::http::StatusCode::SERVICE_UNAVAILABLE, if running.is_empty() { "no model is running: start one in Sushila Host Station" } else { "name a running model (\"model\" field); GET /v1/models lists them" });
    };
    let pq = parts.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or(path.clone());
    // music servers have their own paths; video uses stable-diffusion.cpp's native async API (/sdcpp/v1/vid_gen, /sdcpp/v1/jobs/..)
    let upstream_path = if let Some(r) = pq.strip_prefix("/v1/video") { format!("/sdcpp/v1{r}") }
        else { pq.strip_prefix("/v1/music").map(|r| r.to_string()).unwrap_or(pq) };
    let url = format!("http://127.0.0.1:{up}{upstream_path}");
    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut r = s.http.request(method, url).body(bytes.to_vec());
    for h in ["content-type", "accept"] {
        if let Some(v) = parts.headers.get(h).and_then(|v| v.to_str().ok()) { r = r.header(h, v); }
    }
    let resp = match r.send().await {
        Ok(resp) => {
            let status = axum::http::StatusCode::from_u16(resp.status().as_u16()).unwrap_or(axum::http::StatusCode::BAD_GATEWAY);
            let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string();
            let stream = resp.bytes_stream();
            (status, [("content-type", ctype), ("cache-control", "no-store".to_string())], axum::body::Body::from_stream(stream)).into_response()
        }
        Err(e) => (axum::http::StatusCode::BAD_GATEWAY, format!("the model server did not answer: {e}")).into_response(),
    };
    with_cors(resp, &st)
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
    if caller(&headers, &st).as_deref() != Some("local") { return (axum::http::StatusCode::FORBIDDEN, "only this computer can stop the server").into_response(); }
    let _ = std::fs::write(s.data_dir.join("shutdown-request.json"), "{}");
    (axum::http::StatusCode::ACCEPTED, axum::Json(json!({ "ok": true }))).into_response()
}

/// Starts the web server on bind:port. Returns its address and the stop signal.
pub async fn start(data_dir: PathBuf, port: u16, bind: &str) -> Result<(String, oneshot::Sender<()>), String> {
    let ip: std::net::IpAddr = bind.parse().map_err(|_| format!("not an IP address: {bind}"))?;
    let listener = tokio::net::TcpListener::bind((ip, port)).await.map_err(|e| format!("port {port} is busy: {e}"))?;
    let srv = Arc::new(Srv { port, data_dir, http: client()?, hits: std::sync::Mutex::new(HashMap::new()) });
    let app = axum::Router::new()
        .route("/", axum::routing::get(srv_page))
        .route("/worker_sushila_host.js", axum::routing::get(srv_js))
        .route("/api/state", axum::routing::get(srv_state))
        .route("/api/mode", axum::routing::post(srv_mode).options(srv_mode))
        .route("/api/shutdown", axum::routing::post(srv_shutdown))
        .route("/api/queue", axum::routing::get(srv_queue).post(srv_queue_add).options(srv_queue_add))
        .route("/api/queue/:id/output", axum::routing::get(srv_queue_output))
        .route("/api/queue/:id/:action", axum::routing::post(srv_queue_action).options(srv_queue_action))
        .fallback(srv_proxy)
        .with_state(srv);
    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move { let _ = axum::serve(listener, app).with_graceful_shutdown(async { let _ = rx.await; }).await; });
    Ok((format!("http://{bind}:{port}"), tx))
}

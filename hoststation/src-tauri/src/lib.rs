// Sushila Host Station: the native layer.
//
// The application (screens, catalog, install flows, the inference page) is entirely in ../worker_sushila_host.js. This
// file only gives that script the abilities a browser page does not have, as small generic commands:
//   files        read, write, list, remove (removal only inside the app's data folder), sha256, archive extraction
//   network      download with resume, progress events and sha256 check; fetch text
//   programs     run and capture; start a long-running program with live logs; stop it; run with admin rights
//                (Windows UAC, macOS administrator prompt, Linux pkexec)
//   web server   http://127.0.0.1:<port>/ serves the inference page (the same JS file) and forwards /v1/* to the
//                running Sushila.cpp server; only localhost may call it, and model calls need the session token
//   system       OS, CPU, memory, data folder; open a web page in the default browser
use std::{collections::HashMap, path::{Path, PathBuf}, process::Stdio, sync::Arc, time::Duration};

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader}, sync::{oneshot, Mutex}};

const UA: &str = concat!("SushilaHostStation/", env!("CARGO_PKG_VERSION"));
const APP_JS: &str = include_str!("../../worker_sushila_host.js");
const PAGE_HTML: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sushila Inference</title></head><body><div id="app"></div><script src="/worker_sushila_host.js"></script></body></html>"#;

struct Host {
    data_dir: PathBuf,
    procs: Mutex<HashMap<String, oneshot::Sender<()>>>,
    server_port: Mutex<Option<u16>>,
}

fn err<E: std::fmt::Display>(e: E) -> String { e.to_string() }

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent(UA).connect_timeout(Duration::from_secs(20)).build().map_err(err)
}

// ---------- system ----------
#[tauri::command]
fn host_info(app: AppHandle, host: State<'_, Host>) -> Value {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    json!({
        "app_version": app.package_info().version.to_string(),
        "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "family": std::env::consts::FAMILY,
        "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        "memory_bytes": sys.total_memory(),
        "data_dir": host.data_dir.to_string_lossy(),
        "home_dir": std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default(),
    })
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !(url.starts_with("http://") || url.starts_with("https://")) { return Err("only http(s) links can be opened".into()); }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

// ---------- files ----------
#[tauri::command]
fn read_text(path: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(&path) { Ok(s) => Ok(Some(s)), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None), Err(e) => Err(err(e)) }
}

#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(err)?; }
    let tmp = p.with_extension("tmp-write");
    std::fs::write(&tmp, content).map_err(err)?;
    std::fs::rename(&tmp, p).map_err(err)
}

#[derive(Serialize)]
struct Entry { name: String, is_dir: bool, bytes: u64 }

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let rd = match std::fs::read_dir(&path) { Ok(r) => r, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]), Err(e) => return Err(err(e)) };
    let mut out = vec![];
    for e in rd.flatten() {
        let m = e.metadata().map_err(err)?;
        out.push(Entry { name: e.file_name().to_string_lossy().into(), is_dir: m.is_dir(), bytes: m.len() });
    }
    Ok(out)
}

#[tauri::command]
fn path_exists(path: String) -> bool { Path::new(&path).exists() }

#[tauri::command]
fn make_dirs(path: String) -> Result<(), String> { std::fs::create_dir_all(path).map_err(err) }

/// Deletes a file or folder, but only inside the app's own data folder (packs, engines, downloads). Anything
/// installed for all users is removed through run_elevated instead.
#[tauri::command]
fn remove_path(host: State<'_, Host>, path: String) -> Result<(), String> {
    let root = std::fs::canonicalize(&host.data_dir).map_err(err)?;
    let target = match std::fs::canonicalize(&path) { Ok(t) => t, Err(_) => return Ok(()) };
    if !target.starts_with(&root) || target == root { return Err(format!("refusing to delete outside the app folder: {path}")); }
    if target.is_dir() { std::fs::remove_dir_all(target).map_err(err) } else { std::fs::remove_file(target).map_err(err) }
}

#[tauri::command]
fn set_executable(path: String) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut p = std::fs::metadata(&path).map_err(err)?.permissions();
        p.set_mode(p.mode() | 0o755);
        std::fs::set_permissions(&path, p).map_err(err)?;
    }
    let _ = path;
    Ok(())
}

fn sha256_of(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(err)?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h).map_err(err)?;
    Ok(hex::encode(h.finalize()))
}

#[tauri::command]
async fn file_sha256(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || sha256_of(Path::new(&path))).await.map_err(err)?
}

/// Unpacks a .zip, .tar.gz or .tgz archive into dest (paths that would escape dest are skipped).
#[tauri::command]
async fn extract_archive(archive: String, dest: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&dest).map_err(err)?;
        let f = std::fs::File::open(&archive).map_err(err)?;
        if archive.ends_with(".zip") {
            let mut z = zip::ZipArchive::new(f).map_err(err)?;
            for i in 0..z.len() {
                let mut e = z.by_index(i).map_err(err)?;
                let Some(rel) = e.enclosed_name() else { continue };
                let out = Path::new(&dest).join(rel);
                if e.is_dir() { std::fs::create_dir_all(&out).map_err(err)?; continue; }
                if let Some(d) = out.parent() { std::fs::create_dir_all(d).map_err(err)?; }
                let mut o = std::fs::File::create(&out).map_err(err)?;
                std::io::copy(&mut e, &mut o).map_err(err)?;
                #[cfg(unix)]
                if let Some(mode) = e.unix_mode() {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode)).map_err(err)?;
                }
            }
            Ok(())
        } else {
            let mut t = tar::Archive::new(flate2::read::GzDecoder::new(f));
            t.set_preserve_permissions(true);
            for e in t.entries().map_err(err)? {
                let mut e = e.map_err(err)?;
                e.unpack_in(&dest).map_err(err)?;  // unpack_in refuses paths outside dest
            }
            Ok(())
        }
    }).await.map_err(err)?
}

// ---------- trust ----------
/// Checks an Ed25519 signature (base64) over the exact text of a catalog index, with a public key built into the app.
#[tauri::command]
fn verify_signature(public_key_b64: String, message: String, signature_b64: String) -> bool {
    use base64::Engine;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let b64 = base64::engine::general_purpose::STANDARD;
    let (Ok(pk), Ok(sig)) = (b64.decode(public_key_b64.trim()), b64.decode(signature_b64.trim())) else { return false };
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::try_from(pk.as_slice()), <[u8; 64]>::try_from(sig.as_slice())) else { return false };
    let Ok(key) = VerifyingKey::from_bytes(&pk) else { return false };
    key.verify(message.as_bytes(), &Signature::from_bytes(&sig)).is_ok()
}

/// Downloads may only be written inside the app's data folder (packs and engines are staged there first).
fn inside_data_dir(host: &Host, dest: &Path) -> Result<(), String> {
    if dest.components().any(|c| matches!(c, std::path::Component::ParentDir)) { return Err("download path contains '..'".into()); }
    let root = std::fs::canonicalize(&host.data_dir).map_err(err)?;
    let mut probe = dest.to_path_buf();
    while !probe.exists() { if !probe.pop() { break; } }
    let real = std::fs::canonicalize(&probe).map_err(err)?;
    if real.starts_with(&root) { Ok(()) } else { Err(format!("refusing to download outside the app folder: {}", dest.display())) }
}

// ---------- network ----------
#[tauri::command]
async fn http_text(url: String, timeout_s: Option<u64>) -> Result<String, String> {
    let r = client()?.get(&url).timeout(Duration::from_secs(timeout_s.unwrap_or(30))).send().await.map_err(err)?;
    let status = r.status();
    let body = r.text().await.map_err(err)?;
    if !status.is_success() { return Err(format!("HTTP {status}: {}", body.chars().take(200).collect::<String>())); }
    Ok(body)
}

/// Downloads url to dest, resuming a partial download, emitting "download-progress" {id, done, total}, and checking
/// the sha256 when one is given. Returns the file's sha256.
#[tauri::command]
async fn download(app: AppHandle, host: State<'_, Host>, id: String, url: String, dest: String, sha256: Option<String>, bytes: Option<u64>) -> Result<String, String> {
    let dest_p = PathBuf::from(&dest);
    if !url.starts_with("https://") { return Err("downloads must use https".into()); }
    inside_data_dir(&host, &dest_p)?;
    if let Some(d) = dest_p.parent() { tokio::fs::create_dir_all(d).await.map_err(err)?; }
    let part = PathBuf::from(format!("{dest}.part"));
    let mut start = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    let mut hasher = Sha256::new();
    if start > 0 {
        let p = part.clone();
        hasher = tokio::task::spawn_blocking(move || -> Result<Sha256, String> {
            let mut h = Sha256::new();
            let mut f = std::fs::File::open(&p).map_err(err)?;
            std::io::copy(&mut f, &mut h).map_err(err)?;
            Ok(h)
        }).await.map_err(err)??;
    }
    let mut req = client()?.get(&url);
    if start > 0 { req = req.header(reqwest::header::RANGE, format!("bytes={start}-")); }
    let resp = req.send().await.map_err(err)?;
    if !resp.status().is_success() { return Err(format!("download failed: HTTP {}", resp.status())); }
    if start > 0 && resp.status().as_u16() != 206 {  // the server ignored the range: start over
        start = 0;
        hasher = Sha256::new();
    }
    let total = bytes.or_else(|| resp.content_length().map(|n| n + start)).unwrap_or(0);
    let mut file = tokio::fs::OpenOptions::new().create(true).write(true).append(start > 0).truncate(start == 0).open(&part).await.map_err(err)?;
    let mut done = start;
    let mut last = std::time::Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(err)?;
        file.write_all(&chunk).await.map_err(err)?;
        hasher.update(&chunk);
        done += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(250) {
            let _ = app.emit("download-progress", json!({ "id": id, "done": done, "total": total }));
            last = std::time::Instant::now();
        }
    }
    file.flush().await.map_err(err)?;
    drop(file);
    let got = hex::encode(hasher.finalize());
    if let Some(want) = sha256.filter(|s| !s.is_empty()) {
        if !got.eq_ignore_ascii_case(&want) {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(format!("sha256 mismatch for {dest}: expected {want}, got {got}; the file was deleted"));
        }
    }
    tokio::fs::rename(&part, &dest_p).await.map_err(err)?;
    let _ = app.emit("download-progress", json!({ "id": id, "done": done, "total": total.max(done), "finished": true }));
    Ok(got)
}

// ---------- programs ----------
fn command(program: &str, args: &[String]) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(program);
    c.args(args).stdin(Stdio::null());
    #[cfg(windows)]
    {
        c.creation_flags(0x0800_0000);  // CREATE_NO_WINDOW: no console window pops up
    }
    c
}

#[tauri::command]
async fn run_capture(program: String, args: Vec<String>, cwd: Option<String>, timeout_s: Option<u64>) -> Result<Value, String> {
    let mut c = command(&program, &args);
    if let Some(d) = cwd { c.current_dir(d); }
    let out = tokio::time::timeout(Duration::from_secs(timeout_s.unwrap_or(60)), c.output()).await
        .map_err(|_| format!("{program} did not finish in time"))?.map_err(err)?;
    Ok(json!({ "code": out.status.code(), "stdout": String::from_utf8_lossy(&out.stdout), "stderr": String::from_utf8_lossy(&out.stderr) }))
}

/// Starts a long-running program (e.g. the Sushila.cpp server). Its output arrives as "proc-log" {id, stream, line}
/// events and its end as "proc-exit" {id, code}. Returns the process id.
#[tauri::command]
async fn spawn_process(app: AppHandle, host: State<'_, Host>, id: String, program: String, args: Vec<String>, cwd: Option<String>,
                       env: Option<HashMap<String, String>>) -> Result<u32, String> {
    if host.procs.lock().await.contains_key(&id) { return Err(format!("{id} is already running")); }
    let mut c = command(&program, &args);
    c.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(d) = cwd { c.current_dir(d); }
    if let Some(e) = env { c.envs(e); }
    let mut child = c.spawn().map_err(|e| format!("could not start {program}: {e}"))?;
    let pid = child.id().unwrap_or(0);
    for (name, pipe) in [("stdout", child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)),
                         ("stderr", child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>))] {
        if let Some(pipe) = pipe {
            let (app2, id2) = (app.clone(), id.clone());
            tokio::spawn(async move {
                let mut lines = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = app2.emit("proc-log", json!({ "id": id2, "stream": name, "line": line }));
                }
            });
        }
    }
    let (tx, rx) = oneshot::channel::<()>();
    host.procs.lock().await.insert(id.clone(), tx);
    let app2 = app.clone();
    tokio::spawn(async move {
        let code = tokio::select! {
            s = child.wait() => s.ok().and_then(|s| s.code()),
            _ = rx => { let _ = child.kill().await; None }
        };
        app2.state::<Host>().procs.lock().await.remove(&id);
        let _ = app2.emit("proc-exit", json!({ "id": id, "code": code }));
    });
    Ok(pid)
}

#[tauri::command]
async fn kill_process(host: State<'_, Host>, id: String) -> Result<bool, String> {
    Ok(match host.procs.lock().await.remove(&id) { Some(tx) => tx.send(()).is_ok(), None => false })
}

#[tauri::command]
async fn running_processes(host: State<'_, Host>) -> Result<Vec<String>, String> {
    Ok(host.procs.lock().await.keys().cloned().collect())
}

/// Runs one program with administrator rights after the operating system asks the user: UAC on Windows, the
/// administrator password dialog on macOS, pkexec on Linux. Returns the exit code.
#[tauri::command]
async fn run_elevated(program: String, args: Vec<String>) -> Result<i32, String> {
    #[cfg(windows)]
    let mut c = {
        let quoted: Vec<String> = args.iter().map(|a| format!("\"{}\"", a.replace('"', "\\\""))).collect();
        let script = "$r = Start-Process -FilePath $env:SH_PROGRAM -ArgumentList $env:SH_ARGS -Verb RunAs -Wait -PassThru; exit $r.ExitCode";
        let mut c = command("powershell", &["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), script.into()]);
        c.env("SH_PROGRAM", &program).env("SH_ARGS", quoted.join(" "));
        c
    };
    #[cfg(target_os = "macos")]
    let mut c = {
        let sh = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
        let line = std::iter::once(sh(&program)).chain(args.iter().map(|a| sh(a))).collect::<Vec<_>>().join(" ");
        let apple = line.replace('\\', "\\\\").replace('"', "\\\"");
        command("osascript", &["-e".into(), format!("do shell script \"{apple}\" with administrator privileges")])
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut c = {
        let mut all = vec![program.clone()];
        all.extend(args.iter().cloned());
        command("pkexec", &all)
    };
    let out = c.output().await.map_err(err)?;
    if !out.status.success() && out.status.code().is_none() { return Err("the elevated command was interrupted".into()); }
    Ok(out.status.code().unwrap_or(-1))
}

// ---------- local web server ----------
struct Srv { port: u16, data_dir: PathBuf, http: reqwest::Client }

fn read_state(dir: &Path) -> Value {
    std::fs::read_to_string(dir.join("state.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

fn local_host_ok(headers: &axum::http::HeaderMap, port: u16) -> bool {
    // Only pages on this machine may use the server (blocks DNS-rebinding pages from other sites).
    let host = headers.get("host").and_then(|h| h.to_str().ok()).unwrap_or("");
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

async fn srv_page(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !local_host_ok(&headers, s.port) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    ([("content-type", "text/html; charset=utf-8"), ("cache-control", "no-store")], PAGE_HTML).into_response()
}

async fn srv_js(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !local_host_ok(&headers, s.port) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    ([("content-type", "text/javascript; charset=utf-8"), ("cache-control", "no-store")], APP_JS).into_response()
}

async fn srv_state(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    if !local_host_ok(&headers, s.port) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    // only the "public" part of the Host Station state: never the session token
    let st = read_state(&s.data_dir);
    axum::Json(st.get("public").cloned().unwrap_or(json!({}))).into_response()
}

async fn srv_proxy(axum::extract::State(s): axum::extract::State<Arc<Srv>>, req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, body) = req.into_parts();
    if !local_host_ok(&parts.headers, s.port) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    let path = parts.uri.path();
    if !(path.starts_with("/v1/") || path == "/health" || path == "/props") { return (axum::http::StatusCode::NOT_FOUND, "not found").into_response(); }
    let st = read_state(&s.data_dir);
    let token = st.get("token").and_then(|t| t.as_str()).unwrap_or("");
    let given = parts.headers.get("x-sushila-token").and_then(|h| h.to_str().ok()).unwrap_or("");
    if path.starts_with("/v1/") && (token.is_empty() || given != token) {
        return (axum::http::StatusCode::UNAUTHORIZED, "open this page from Sushila Host Station (Launch Inference Page)").into_response();
    }
    let Some(up) = st.pointer("/running/port").and_then(|p| p.as_u64()) else {
        return (axum::http::StatusCode::SERVICE_UNAVAILABLE, "no model is running: start one in Sushila Host Station").into_response();
    };
    let bytes = match axum::body::to_bytes(body, 64 << 20).await { Ok(b) => b, Err(_) => return (axum::http::StatusCode::PAYLOAD_TOO_LARGE, "request too large").into_response() };
    let url = format!("http://127.0.0.1:{up}{}", parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or(path));
    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut r = s.http.request(method, url).body(bytes.to_vec());
    for h in ["content-type", "accept"] {
        if let Some(v) = parts.headers.get(h).and_then(|v| v.to_str().ok()) { r = r.header(h, v); }
    }
    match r.send().await {
        Ok(resp) => {
            let status = axum::http::StatusCode::from_u16(resp.status().as_u16()).unwrap_or(axum::http::StatusCode::BAD_GATEWAY);
            let ctype = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/json").to_string();
            let stream = resp.bytes_stream();
            (status, [("content-type", ctype), ("cache-control", "no-store".to_string())], axum::body::Body::from_stream(stream)).into_response()
        }
        Err(e) => (axum::http::StatusCode::BAD_GATEWAY, format!("the model server did not answer: {e}")).into_response(),
    }
}

/// Starts the local web server on 127.0.0.1:port (once). Returns its address.
#[tauri::command]
async fn server_start(host: State<'_, Host>, port: u16) -> Result<String, String> {
    let mut cur = host.server_port.lock().await;
    if let Some(p) = *cur { return Ok(format!("http://127.0.0.1:{p}")); }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("port {port} is busy: {e}"))?;
    let srv = Arc::new(Srv { port, data_dir: host.data_dir.clone(), http: client()? });
    let app = axum::Router::new()
        .route("/", axum::routing::get(srv_page))
        .route("/worker_sushila_host.js", axum::routing::get(srv_js))
        .route("/api/state", axum::routing::get(srv_state))
        .fallback(srv_proxy)
        .with_state(srv);
    tokio::spawn(async move { let _ = axum::serve(listener, app).await; });
    *cur = Some(port);
    Ok(format!("http://127.0.0.1:{port}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(Host { data_dir, procs: Mutex::new(HashMap::new()), server_port: Mutex::new(None) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_info, open_url, verify_signature, read_text, write_text, list_dir, path_exists, make_dirs, remove_path, set_executable,
            file_sha256, extract_archive, http_text, download, run_capture, spawn_process, kill_process,
            running_processes, run_elevated, server_start
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sushila Host Station");
}

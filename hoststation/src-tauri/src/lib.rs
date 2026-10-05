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

/// "SushilaHostStation/0.1.0 (windows; x86_64)": sushila.ai counts downloads per system from it (no other data is sent).
fn ua() -> String { format!("SushilaHostStation/{} ({}; {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH) }
const APP_JS: &str = include_str!("../../worker_sushila_host.js");
const PAGE_HTML: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sushila Inference</title></head><body><div id="app"></div><script src="/worker_sushila_host.js"></script></body></html>"#;

struct Host {
    data_dir: PathBuf,
    downloads_dir: Option<PathBuf>,  // the user's Downloads folder: packs are saved there too, and looked for there
    procs: Mutex<HashMap<String, oneshot::Sender<()>>>,
    server: Mutex<Option<(String, oneshot::Sender<()>)>>,  // (address, stop signal) of the running web server
    links: std::sync::Mutex<Vec<String>>,  // sushila:// links received before the page was ready
    downloads: std::sync::Mutex<HashMap<String, Arc<std::sync::atomic::AtomicU8>>>,  // 0 run, 1 pause, 2 cancel
}

fn err<E: std::fmt::Display>(e: E) -> String { e.to_string() }

/// Where Host Station may download from, checked here (not in the page) for the first request and every redirect:
///   https://sushila.ai                         the catalog
///   https://f<NNN>.backblazeb2.com/file/sushila-ai/...   our own B2 bucket, and only that bucket
///   https://huggingface.co, *.huggingface.co, *.hf.co    Hugging Face and its file CDNs
///   https://registry.ollama.ai, ollama.com, and Ollama's registry storage (one Cloudflare R2 bucket, /ollama/)
///   http://127.0.0.1, localhost                this computer's own model servers (http_text only)
/// Everything installed must also match a Sushila-signed index (sha256), wherever it comes from.
const OLLAMA_STORAGE: &str = "dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com";
fn allowed_url(u: &reqwest::Url, local_ok: bool) -> bool {
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if local_ok && u.scheme() == "http" && (host == "127.0.0.1" || host == "localhost") { return true; }
    if u.scheme() != "https" { return false; }
    let under = |d: &str| host == d || host.ends_with(&format!(".{d}"));
    host == "sushila.ai" || host == "www.sushila.ai"
        || (host.ends_with(".backblazeb2.com") && u.path().starts_with("/file/sushila-ai/"))
        || under("huggingface.co") || under("hf.co")
        || host == "registry.ollama.ai" || host == "ollama.com" || host == "registry.ollama.com"
        || (host == OLLAMA_STORAGE && u.path().starts_with("/ollama/"))
}
fn check_url(url: &str, local_ok: bool) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(url).map_err(|_| format!("not a valid address: {url}"))?;
    if allowed_url(&u, local_ok) { Ok(u) } else {
        Err(format!("Host Station only downloads from sushila.ai, the Sushila B2 bucket, Hugging Face and Ollama; refusing {}", u.host_str().unwrap_or("?")))
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent(ua()).connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 5 { attempt.error("too many redirects") }
            else if allowed_url(attempt.url(), false) { attempt.follow() }
            else { let host = attempt.url().host_str().unwrap_or("?").to_string(); attempt.error(format!("redirect to a source that is not allowed: {host}")) }
        }))
        .build().map_err(err)
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
        "downloads_dir": host.downloads_dir.as_ref().map(|d| d.to_string_lossy().to_string()),
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
async fn extract_archive(host: State<'_, Host>, archive: String, dest: String) -> Result<(), String> {
    if !under(&host.data_dir, Path::new(&dest)) { return Err("archives unpack only into the app folder".into()); }
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
        } else if archive.ends_with(".sushilapack") || archive.ends_with(".tar") {
            let mut t = tar::Archive::new(f);  // a pack: plain tar; the page verifies the signed index and every sha256
            for e in t.entries().map_err(err)? {
                let mut e = e.map_err(err)?;
                if !matches!(e.header().entry_type(), tar::EntryType::Regular | tar::EntryType::Directory) { continue; }  // no links
                e.unpack_in(&dest).map_err(err)?;
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

/// Files may only be written inside the app's data folder, or, for .sushilapack files, the user's Downloads folder.
fn under(root: &Path, dest: &Path) -> bool {
    let Ok(root) = std::fs::canonicalize(root) else { return false };
    let mut probe = dest.to_path_buf();
    while !probe.exists() { if !probe.pop() { return false; } }
    std::fs::canonicalize(&probe).map(|r| r.starts_with(&root)).unwrap_or(false)
}
fn inside_data_dir(host: &Host, dest: &Path) -> Result<(), String> {
    if dest.components().any(|c| matches!(c, std::path::Component::ParentDir)) { return Err("path contains '..'".into()); }
    if under(&host.data_dir, dest) { return Ok(()); }
    let pack_file = dest.extension().and_then(|e| e.to_str()).map(|e| e == "sushilapack" || e == "part").unwrap_or(false)
        && dest.to_string_lossy().contains(".sushilapack");
    if pack_file { if let Some(dl) = &host.downloads_dir { if under(dl, dest) { return Ok(()); } } }
    Err(format!("refusing to write outside the app folder: {}", dest.display()))
}

/// Copies a file into the app's data folder (e.g. a pack file found in Downloads); the page checks its sha256 after.
#[tauri::command]
async fn copy_file(host: State<'_, Host>, src: String, dest: String) -> Result<(), String> {
    let d = PathBuf::from(&dest);
    if !under(&host.data_dir, &d) { return Err("copies go only into the app folder".into()); }
    if let Some(p) = d.parent() { tokio::fs::create_dir_all(p).await.map_err(err)?; }
    tokio::fs::copy(&src, &d).await.map(|_| ()).map_err(err)
}

/// Moves a file or folder within the app's data folder (a verified pack from staging into place).
#[tauri::command]
fn move_path(host: State<'_, Host>, src: String, dest: String) -> Result<(), String> {
    let (s, d) = (PathBuf::from(&src), PathBuf::from(&dest));
    if !under(&host.data_dir, &s) || !under(&host.data_dir, &d) { return Err("moves stay inside the app folder".into()); }
    if let Some(p) = d.parent() { std::fs::create_dir_all(p).map_err(err)?; }
    if d.exists() { if d.is_dir() { std::fs::remove_dir_all(&d).map_err(err)?; } else { std::fs::remove_file(&d).map_err(err)?; } }
    std::fs::rename(&s, &d).map_err(err)
}

/// The operating system's "open file" dialog. Returns the chosen path, or nothing if the user cancels.
#[tauri::command]
async fn pick_file(app: AppHandle, title: String, extensions: Vec<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = oneshot::channel();
    let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    app.dialog().file().set_title(&title).add_filter("Sushila model pack", &exts).pick_file(move |p| { let _ = tx.send(p); });
    let picked = rx.await.map_err(err)?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()))
}

// ---------- network ----------
#[tauri::command]
async fn http_text(url: String, timeout_s: Option<u64>) -> Result<String, String> {
    let url = check_url(&url, true)?;
    let r = client()?.get(url).timeout(Duration::from_secs(timeout_s.unwrap_or(30))).send().await.map_err(err)?;
    let status = r.status();
    let body = r.text().await.map_err(err)?;
    if !status.is_success() { return Err(format!("HTTP {status}: {}", body.chars().take(200).collect::<String>())); }
    Ok(body)
}

async fn download_body(app: &AppHandle, id: &str, resp: reqwest::Response, part: &Path, start: u64, total: u64, mut hasher: Sha256,
                       flag: &std::sync::atomic::AtomicU8) -> Result<(String, u64), String> {
    let mut file = tokio::fs::OpenOptions::new().create(true).write(true).append(start > 0).truncate(start == 0).open(part).await.map_err(err)?;
    let mut done = start;
    let mut last = std::time::Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(err)?;
        file.write_all(&chunk).await.map_err(err)?;
        hasher.update(&chunk);
        done += chunk.len() as u64;
        match flag.load(std::sync::atomic::Ordering::Relaxed) {
            1 => { file.flush().await.map_err(err)?; return Err("paused".into()); }
            2 => return Err("cancelled".into()),
            _ => {}
        }
        if last.elapsed() > Duration::from_millis(250) {
            let _ = app.emit("download-progress", json!({ "id": id, "done": done, "total": total }));
            last = std::time::Instant::now();
        }
    }
    file.flush().await.map_err(err)?;
    Ok((hex::encode(hasher.finalize()), done))
}

/// Pauses ("pause": the partial file stays and the next download call resumes it) or cancels ("cancel": the partial
/// file is deleted) a running download.
#[tauri::command]
fn download_control(host: State<'_, Host>, id: String, action: String) -> bool {
    let code = match action.as_str() { "pause" => 1, "cancel" => 2, _ => return false };
    match host.downloads.lock().unwrap().get(&id) { Some(f) => { f.store(code, std::sync::atomic::Ordering::Relaxed); true } None => false }
}

/// Downloads url to dest, resuming a partial download, emitting "download-progress" {id, done, total}, and checking
/// the sha256 when one is given. Returns the file's sha256.
#[tauri::command]
async fn download(app: AppHandle, host: State<'_, Host>, id: String, url: String, dest: String, sha256: Option<String>, bytes: Option<u64>) -> Result<String, String> {
    let dest_p = PathBuf::from(&dest);
    let url = check_url(&url, false)?.to_string();
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
    let flag = Arc::new(std::sync::atomic::AtomicU8::new(0));
    host.downloads.lock().unwrap().insert(id.clone(), flag.clone());
    let result = download_body(&app, &id, resp, &part, start, total, hasher, &flag).await;
    host.downloads.lock().unwrap().remove(&id);
    let (got, done) = match result {
        Ok(v) => v,
        Err(e) if e == "cancelled" => { let _ = tokio::fs::remove_file(&part).await; return Err(e); }
        Err(e) => return Err(e),  // "paused" keeps the .part file: the next call resumes from it
    };
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
struct Srv { port: u16, data_dir: PathBuf, http: reqwest::Client, hits: std::sync::Mutex<HashMap<String, (u32, std::time::Instant)>> }

// Sharing (Settings -> Share on the network), read from state.json on every request:
//   share.enabled        accept requests from other machines (the server then listens on share.bind, e.g. 0.0.0.0)
//   share.hosts          host names a browser or reverse proxy may use, e.g. ["ai.example.com"]; "*" accepts any
//   share.keys           [{name, sha256}] of access keys; callers send "Authorization: Bearer <key>"
//   share.perMinute      requests per minute per key
fn share(st: &Value) -> Option<&Value> { st.get("share").filter(|s| s.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false)) }

fn read_state(dir: &Path) -> Value {
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
fn with_cors(mut resp: axum::response::Response, st: &Value) -> axum::response::Response {
    if share(st).is_some() {
        let h = resp.headers_mut();
        h.insert("access-control-allow-origin", axum::http::HeaderValue::from_static("*"));
        h.insert("access-control-allow-headers", axum::http::HeaderValue::from_static("authorization, content-type, x-sushila-model"));
        h.insert("access-control-allow-methods", axum::http::HeaderValue::from_static("GET, POST, OPTIONS"));
    }
    resp
}

async fn srv_state(axum::extract::State(s): axum::extract::State<Arc<Srv>>, headers: axum::http::HeaderMap) -> axum::response::Response {
    use axum::response::IntoResponse;
    let st = read_state(&s.data_dir);
    if !host_ok(&headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    // only the "public" part of the Host Station state (models and what runs): never the session token or keys
    with_cors(axum::Json(st.get("public").cloned().unwrap_or(json!({}))).into_response(), &st)
}

async fn srv_proxy(axum::extract::State(s): axum::extract::State<Arc<Srv>>, req: axum::extract::Request) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, body) = req.into_parts();
    let st = read_state(&s.data_dir);
    if !host_ok(&parts.headers, s.port, &st) { return (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response(); }
    let path = parts.uri.path().to_string();
    if !(path.starts_with("/v1/") || path == "/health") { return (axum::http::StatusCode::NOT_FOUND, "not found").into_response(); }
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
    let url = format!("http://127.0.0.1:{up}{}", parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or(&path));
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

/// sushila:// links that arrived before the page asked (e.g. the link that started the app).
#[tauri::command]
fn take_links(host: State<'_, Host>) -> Vec<String> { std::mem::take(&mut *host.links.lock().unwrap()) }

/// Starts the web server on bind:port (127.0.0.1 unless sharing is on). Returns its address. Call server_stop first to
/// change the address.
#[tauri::command]
async fn server_start(host: State<'_, Host>, port: u16, bind: Option<String>) -> Result<String, String> {
    let mut cur = host.server.lock().await;
    if let Some((addr, _)) = cur.as_ref() { return Ok(addr.clone()); }
    let bind = bind.unwrap_or_else(|| "127.0.0.1".into());
    let ip: std::net::IpAddr = bind.parse().map_err(|_| format!("not an IP address: {bind}"))?;
    let listener = tokio::net::TcpListener::bind((ip, port)).await.map_err(|e| format!("port {port} is busy: {e}"))?;
    let srv = Arc::new(Srv { port, data_dir: host.data_dir.clone(), http: client()?, hits: std::sync::Mutex::new(HashMap::new()) });
    let app = axum::Router::new()
        .route("/", axum::routing::get(srv_page))
        .route("/worker_sushila_host.js", axum::routing::get(srv_js))
        .route("/api/state", axum::routing::get(srv_state))
        .fallback(srv_proxy)
        .with_state(srv);
    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move { let _ = axum::serve(listener, app).with_graceful_shutdown(async { let _ = rx.await; }).await; });
    let addr = format!("http://{bind}:{port}");
    *cur = Some((addr.clone(), tx));
    Ok(addr)
}

#[tauri::command]
async fn server_stop(host: State<'_, Host>) -> Result<(), String> {
    if let Some((_, tx)) = host.server.lock().await.take() { let _ = tx.send(()); tokio::time::sleep(Duration::from_millis(300)).await; }
    Ok(())
}

/// Addresses of this machine on the local network, to show where shared users can reach it.
#[tauri::command]
fn local_addresses() -> Vec<String> {
    // the address the OS would use to reach the internet (no packet is sent)
    let mut out = vec![];
    if let Ok(s) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if s.connect("8.8.8.8:80").is_ok() { if let Ok(a) = s.local_addr() { out.push(a.ip().to_string()); } }
    }
    out
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // one window only: a second start (e.g. from a sushila:// link) focuses the running app, which receives the link
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(w) = app.get_webview_window("main") { let _ = w.unminimize(); let _ = w.set_focus(); }
    }));
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let downloads_dir = app.path().download_dir().ok();
            app.manage(Host { data_dir, downloads_dir, procs: Mutex::new(HashMap::new()), server: Mutex::new(None), links: std::sync::Mutex::new(vec![]), downloads: std::sync::Mutex::new(HashMap::new()) });
            // sushila:// links (the "Install in Host Station" buttons on sushila.ai). The page decides what to do and
            // always asks the user first; here they are only queued and passed on.
            use tauri_plugin_deep_link::DeepLinkExt;
            #[cfg(any(windows, target_os = "linux"))]
            { let _ = app.deep_link().register_all(); }
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                app.state::<Host>().links.lock().unwrap().extend(urls.iter().map(|u| u.to_string()));
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                handle.state::<Host>().links.lock().unwrap().extend(urls.clone());
                let _ = handle.emit("deep-link", urls);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_info, open_url, verify_signature, download_control, copy_file, move_path, pick_file, read_text, write_text, list_dir, path_exists, make_dirs, remove_path, set_executable,
            file_sha256, extract_archive, http_text, download, run_capture, spawn_process, kill_process,
            running_processes, run_elevated, server_start, server_stop, local_addresses, take_links
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sushila Host Station");
}

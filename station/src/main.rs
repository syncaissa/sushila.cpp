// Sushila Station: the desktop app for Sushila.cpp. A native window (sidebar, toolbar, menus, tray, notifications,
// file dialogs) over the Sushila engine running on this computer. Every request goes from here (Rust) to the engine
// at http://127.0.0.1:7874 with this computer's token, so the window's page never needs the engine's web page, a
// browser, a password or an access key.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod engine;

use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

#[derive(Default)]
struct Inner { token: String, media: Option<(String, Instant)>, chats: HashMap<String, tokio::task::AbortHandle> }
struct St { http: reqwest::Client, inner: Mutex<Inner> }
type S<'a> = tauri::State<'a, Arc<St>>;

impl St {
    async fn token(&self, fresh: bool) -> Result<String, String> {
        let mut g = self.inner.lock().await;
        if fresh || g.token.is_empty() { g.token = engine::fetch_token(&self.http).await?; }
        Ok(g.token.clone())
    }
    /// One request to the engine; a refused token is fetched again once (the engine restarted with a new one).
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        if !path.starts_with('/') || path.starts_with("//") { return Err("bad path".into()); }
        for attempt in 0..2 {
            let tok = self.token(attempt > 0).await?;
            let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
            let mut r = self.http.request(m, format!("{}{path}", engine::base())).header("x-sushila-token", &tok).header("host", format!("localhost:{}", engine::PORT)).timeout(Duration::from_secs(120));
            if let Some(b) = &body { r = r.json(b); }
            let resp = r.send().await.map_err(|e| format!("Sushila is not answering ({e})"))?;
            let status = resp.status().as_u16();
            if (status == 401 || status == 403) && attempt == 0 { continue; }
            let text = resp.text().await.map_err(|e| e.to_string())?;
            let data = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
            return Ok(json!({ "status": status, "ok": (200..300).contains(&status), "data": data }));
        }
        Err("the engine refused this app's token".into())
    }
}

// ---------------------------------------------------------------- commands the window calls
#[tauri::command]
async fn api(st: S<'_>, method: String, path: String, body: Option<Value>) -> Result<Value, String> { st.call(&method, &path, body).await }

#[tauri::command]
async fn engine_status(st: S<'_>) -> Result<Value, String> {
    let mut h = engine::health(&st.http).await;
    h["cli"] = json!(engine::cli_path().to_string_lossy());
    h["cliInstalled"] = json!(engine::cli_path().is_file());
    h["bundled"] = json!(if engine::BUNDLED_SHA == "none" { String::new() } else { engine::BUNDLED_SHA[..12].to_string() });
    h["station"] = json!(env!("CARGO_PKG_VERSION"));
    h["os"] = json!(std::env::consts::OS);
    Ok(h)
}
#[tauri::command]
async fn engine_start(st: S<'_>) -> Result<Value, String> {
    if engine::health(&st.http).await["running"] == true { return Ok(json!({ "already": true })); }
    let v = engine::start()?;
    for _ in 0..60 { tokio::time::sleep(Duration::from_millis(500)).await; if engine::health(&st.http).await["running"] == true { st.inner.lock().await.token.clear(); return Ok(v); } }
    Err("Sushila was started but does not answer yet; it may still be setting itself up (see Logs)".into())
}
#[tauri::command]
async fn engine_stop(st: S<'_>) -> Result<Value, String> { let r = engine::stop().await; st.inner.lock().await.token.clear(); r }
#[tauri::command]
async fn engine_restart(st: S<'_>) -> Result<Value, String> {
    let _ = engine::stop().await;
    for _ in 0..40 { if engine::health(&st.http).await["running"] != true { break; } tokio::time::sleep(Duration::from_millis(500)).await; }
    engine_start(st).await
}
#[tauri::command] fn install_cli() -> Result<Value, String> { engine::install_cli() }
#[tauri::command] fn uninstall_cli() -> Result<Value, String> { engine::uninstall_cli() }

/// A URL the window can show in <img>/<audio>/<video>: a Library file or a queue output, with a media token (read-only,
/// one hour), never this computer's token.
#[tauri::command]
async fn media_url(st: S<'_>, kind: String, id: String) -> Result<String, String> {
    let tok = {
        let cached = st.inner.lock().await.media.clone();
        match cached { Some((t, at)) if at.elapsed() < Duration::from_secs(45 * 60) => t, _ => {
            let r = st.call("GET", "/api/media-token", None).await?;
            let t = r["data"]["token"].as_str().ok_or("no media token")?.to_string();
            st.inner.lock().await.media = Some((t.clone(), Instant::now())); t } }
    };
    let enc = |s: &str| s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
    Ok(match kind.as_str() {
        "output" => format!("{}/api/queue/{}/output?t={}", engine::base(), enc(&id), tok),
        "trash" => format!("{}/api/library/file?rel={}&trash=1&t={}", engine::base(), enc(&id), tok),
        _ => format!("{}/api/library/file?rel={}&t={}", engine::base(), enc(&id), tok),
    })
}

/// Chat with a running text model, streamed: events "chat" {id, delta} ... {id, done, usage} or {id, error}.
#[tauri::command]
async fn chat_start(app: AppHandle, st: S<'_>, id: String, body: Value) -> Result<(), String> {
    let tok = st.token(false).await?;
    let http = st.http.clone();
    let (app2, id2) = (app.clone(), id.clone());
    let task = tokio::spawn(async move {
        let mut body = body; body["stream"] = json!(true);
        let res = http.post(format!("{}/v1/chat/completions", engine::base())).header("x-sushila-token", &tok).header("host", format!("localhost:{}", engine::PORT)).json(&body).send().await;
        let resp = match res { Ok(r) if r.status().is_success() => r, Ok(r) => { let t = r.text().await.unwrap_or_default(); let _ = app2.emit("chat", json!({ "id": id2, "error": t })); return; }
            Err(e) => { let _ = app2.emit("chat", json!({ "id": id2, "error": format!("Sushila is not answering ({e})") })); return; } };
        let mut stream = resp.bytes_stream(); let mut buf = String::new(); let mut usage = Value::Null;
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else { break };
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(i) = buf.find('\n') {
                let line = buf[..i].trim().to_string(); buf.drain(..=i);
                let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
                if data == "[DONE]" { continue; }
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                if v.get("usage").is_some() && !v["usage"].is_null() { usage = v["usage"].clone(); }
                if let Some(d) = v["choices"][0]["delta"]["content"].as_str() { if !d.is_empty() { let _ = app2.emit("chat", json!({ "id": id2, "delta": d })); } }
            }
        }
        let _ = app2.emit("chat", json!({ "id": id2, "done": true, "usage": usage }));
    });
    st.inner.lock().await.chats.insert(id, task.abort_handle());
    Ok(())
}
#[tauri::command]
async fn chat_stop(app: AppHandle, st: S<'_>, id: String) -> Result<(), String> {
    if let Some(h) = st.inner.lock().await.chats.remove(&id) { h.abort(); let _ = app.emit("chat", json!({ "id": id, "done": true, "stopped": true })); }
    Ok(())
}

/// A file the user picked in the native dialog (a start picture for a video), as a data URL; pictures only, 25 MB at most.
#[tauri::command]
fn read_picture(path: String) -> Result<String, String> {
    let low = path.to_lowercase();
    let mime = if low.ends_with(".png") { "image/png" } else if low.ends_with(".jpg") || low.ends_with(".jpeg") { "image/jpeg" } else if low.ends_with(".webp") { "image/webp" } else { return Err("choose a PNG, JPEG or WebP picture".into()) };
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 25_000_000 { return Err("the picture is larger than 25 MB".into()); }
    use base64::Engine;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(std::fs::read(&path).map_err(|e| e.to_string())?)))
}
/// Saves a Library file or queue output to a place the user chose in the native Save dialog.
#[tauri::command]
async fn save_to(st: S<'_>, url: String, dest: String) -> Result<(), String> {
    if !url.starts_with(&engine::base()) { return Err("only files from Sushila on this computer".into()); }
    let bytes = st.http.get(&url).timeout(Duration::from_secs(600)).send().await.map_err(|e| e.to_string())?.bytes().await.map_err(|e| e.to_string())?;
    tokio::fs::write(&dest, &bytes).await.map_err(|e| e.to_string())
}

/// Copies text to the system clipboard through the operating system (no web permission prompt in the window).
#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> { app.clipboard().write_text(text).map_err(|e| e.to_string()) }
/// A system notification, sent from here (the web Notification API would ask the user for permission).
#[tauri::command]
fn notify_os(app: AppHandle, title: String, body: String) -> Result<(), String> { app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string()) }

// ---------------------------------------------------------------- the window and the tray
fn show_main(app: &AppHandle) { if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus(); } }

fn main() {
    let st = Arc::new(St { http: engine::client(), inner: Mutex::new(Inner::default()) });
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .manage(st)
        .invoke_handler(tauri::generate_handler![api, engine_status, engine_start, engine_stop, engine_restart, install_cli, uninstall_cli, media_url, chat_start, chat_stop, read_picture, save_to, copy_text, notify_os])
        .setup(|app| {
            let hidden = std::env::args().any(|a| a == "--hidden");  // started at login: only the tray icon
            let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Sushila Station").inner_size(1280.0, 840.0).min_inner_size(900.0, 600.0).visible(!hidden)
                // links leave the app for the default browser; the window shows only its own pages
                .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"));
            #[cfg(target_os = "macos")] { b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true); }
            b.build()?;
            let open = MenuItem::with_id(app, "open", "Open Sushila Station", true, None::<&str>)?;
            let start = MenuItem::with_id(app, "start", "Start Sushila", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop Sushila", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Sushila Station (Sushila keeps running)", true, None::<&str>)?;
            let quit_all = MenuItem::with_id(app, "quitall", "Quit and stop Sushila", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?; let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &sep, &start, &stop, &sep2, &quit, &quit_all])?;
            TrayIconBuilder::with_id("tray").icon(app.default_window_icon().cloned().ok_or("no icon")?).tooltip("Sushila Station").menu(&menu)
                .on_menu_event(|app, ev| {
                    let app = app.clone();
                    match ev.id.as_ref() {
                        "open" => show_main(&app),
                        "start" => { tauri::async_runtime::spawn(async move { let _ = engine::start(); let _ = app.emit("engine", json!({ "changed": true })); }); }
                        "stop" => { tauri::async_runtime::spawn(async move { let _ = engine::stop().await; let _ = app.emit("engine", json!({ "changed": true })); }); }
                        "quit" => app.exit(0),
                        "quitall" => { tauri::async_runtime::spawn(async move { let _ = engine::stop().await; app.exit(0); }); }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, ev| { if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev { show_main(tray.app_handle()); } })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|w, ev| {
            // closing the window keeps Station in the tray (the queue goes on); Quit is in the tray and the app menu
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev { let _ = w.hide(); api.prevent_close(); }
        })
        .run(tauri::generate_context!())
        .expect("Sushila Station could not start");
}

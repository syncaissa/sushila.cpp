// Temporary internet URL ("Get temporary internet URL" on every tab of this computer's page): a Cloudflare quick tunnel
// from the internet to this Sushila Engine, shown as https://sushila.ai/localhost/<id>/.
//   1. cloudflared (Cloudflare's own program, Apache-2.0) is fetched once through sushila.ai/install (an exact copy of
//      release CLOUDFLARED_VERSION); its SHA-256 is checked against the value below before it is used.
//   2. `cloudflared tunnel --url http://127.0.0.1:<port>` prints a random https://<words>.trycloudflare.com address.
//   3. That host name is allowed on this engine (share.hosts) and a new access key is made for the link: visitors
//      from the internet are remote callers, so they use the Inference page with that key; Admin, Library and this
//      computer's files stay on this computer (they need the local token, which only localhost pages get).
//   4. sushila.ai records the link (signed-in account: user id, time, IP) and forwards /localhost/<id>/ to the tunnel.
// Stop (or quitting Sushila) ends the tunnel; the link then answers "not online". The key and host are removed.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const CLOUDFLARED_VERSION: &str = "2026.10.0";
/// (file on files.sushila.ai/public/tools/cloudflared/<version>/, its SHA-256 = the official release asset's)
fn asset() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some(("cloudflared-windows-amd64.exe", "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c")),
        ("linux", "x86_64") => Some(("cloudflared-linux-amd64", "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db")),
        ("linux", "aarch64") => Some(("cloudflared-linux-arm64", "e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08")),
        ("macos", "x86_64") => Some(("cloudflared-darwin-amd64.tgz", "903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f")),
        ("macos", "aarch64") => Some(("cloudflared-darwin-arm64.tgz", "a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70")),
        _ => None,
    }
}

struct Tunnel { child: tokio::process::Child, target: String, link: String, id: String, key_name: String, key: String, since: String }
static TUNNEL: std::sync::LazyLock<tokio::sync::Mutex<Option<Tunnel>>> = std::sync::LazyLock::new(Default::default);

/// The cloudflared program in <home>/tools/cloudflared-<version>/, downloaded and checked the first time.
async fn cloudflared(dir: &Path) -> Result<PathBuf, String> {
    let (file, sha) = asset().ok_or("a temporary internet URL is not available on this system yet")?;
    let tdir = dir.join("tools").join(format!("cloudflared-{CLOUDFLARED_VERSION}"));
    let exe = tdir.join(if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" });
    if exe.is_file() { return Ok(exe); }
    std::fs::create_dir_all(&tdir).map_err(|e| e.to_string())?;
    // through sushila.ai/install (counted; GitHub or files.sushila.ai behind it), files.sushila.ai directly if that fails;
    // either way the SHA-256 above decides
    let dl = tdir.join(file);
    let mut last = String::new();
    for base in ["https://sushila.ai/install/get", "https://files.sushila.ai/public"] {
        match crate::util::download(&format!("{base}/tools/cloudflared/{CLOUDFLARED_VERSION}/{file}"), &dl, Some(sha), None, "cloudflared (Cloudflare tunnel)", true).await {
            Ok(_) => { last.clear(); break; }
            Err(e) => last = e,
        }
    }
    if !last.is_empty() { return Err(last); }
    if file.ends_with(".tgz") {
        crate::util::extract_archive(&dl, &tdir).await?;
        let _ = std::fs::remove_file(&dl);
    } else { std::fs::rename(&dl, &exe).map_err(|e| e.to_string())?; }
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)); }
    if !exe.is_file() { return Err("cloudflared was not found after the download".into()); }
    Ok(exe)
}

/// The link and its access key stay the same from start to start (until deleted at sushila.ai/mycontent or a new key
/// is chosen): <home>/tunnel.json {id, key}. Only this computer has the key itself; the engine stores its SHA-256.
fn saved(dir: &Path) -> Value { std::fs::read_to_string(dir.join("tunnel.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({})) }
fn save(dir: &Path, v: &Value) { let _ = std::fs::write(dir.join("tunnel.json"), v.to_string()); }

/// A change for the engine's owner loop (it owns state.json): allowed host names and access keys.
fn control(dir: &Path, values: Value) -> Result<(), String> {
    let id = format!("task-tunnel-{}", crate::util::random_token().chars().take(12).collect::<String>());
    crate::util::post_request(dir, "control-in", &id, &json!({ "id": id, "action": "share", "values": values, "source": "temporary internet URL" }))
}

pub async fn status() -> Value {
    let mut g = TUNNEL.lock().await;
    if let Some(t) = g.as_mut() {
        if matches!(t.child.try_wait(), Ok(Some(_))) { *g = None; return json!({ "running": false, "ended": true }); }
        return json!({ "running": true, "link": t.link, "target": t.target, "since": t.since, "key": t.key });  // this computer only (srv_tunnel)
    }
    json!({ "running": false })
}

/// Starts the tunnel (or returns the running one). The access key is in the answer only here, once.
pub async fn start(dir: &Path, port: u16) -> Result<Value, String> {
    if status().await["running"] == true { return Ok(status().await); }
    let exe = cloudflared(dir).await?;
    let log_path = dir.join("logs").join("tunnel.log");
    let mut child = tokio::process::Command::new(&exe)
        .args(["tunnel", "--no-autoupdate", "--url", &format!("http://127.0.0.1:{port}")])
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped())
        .kill_on_drop(true).spawn().map_err(|e| format!("could not start cloudflared: {e}"))?;
    crate::core::tie_to_us(&child);
    // its log names the address: https://<words>.trycloudflare.com
    use tokio::io::AsyncBufReadExt;
    let mut lines = tokio::io::BufReader::new(child.stderr.take().unwrap()).lines();
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).ok();
    let found = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        while let Ok(Some(l)) = lines.next_line().await {
            if let Some(f) = log.as_mut() { use std::io::Write; let _ = writeln!(f, "{l}"); }
            if let Some(i) = l.find("https://") {
                let u: String = l[i..].chars().take_while(|c| c.is_ascii_alphanumeric() || ".:/-".contains(*c)).collect();
                if u.ends_with(".trycloudflare.com") && u.len() > 30 { return Some(u); }
            }
        }
        None
    }).await.ok().flatten();
    let Some(target) = found else { let _ = child.kill().await; return Err("cloudflared did not get an address within a minute (is the internet reachable?); see logs/tunnel.log".into()) };
    // the rest of its log goes to logs/tunnel.log
    tokio::spawn(async move { while let Ok(Some(l)) = lines.next_line().await { if let Some(f) = log.as_mut() { use std::io::Write; let _ = writeln!(f, "{l}"); } } });
    let host = target.trim_start_matches("https://").to_string();
    let keep = saved(dir);
    let key = keep["key"].as_str().filter(|k| k.starts_with("sk-sushila-")).map(String::from).unwrap_or_else(|| format!("sk-sushila-{}", crate::util::random_token()));
    let key_name = format!("internet-link-{}", &crate::util::now_iso()[..16].replace([':', 'T'], "-"));
    use sha2::{Digest, Sha256};
    // one link at a time: keys of earlier links (e.g. before a crash) are removed with this one's arrival
    control(dir, json!({ "enabled": true, "removeHostSuffix": ".trycloudflare.com", "addHost": host, "removeKeyPrefix": "internet-link-", "addKey": { "name": key_name, "sha256": hex::encode(Sha256::digest(key.as_bytes())) } }))?;
    let reg = match crate::share::tunnel_register(dir, &target, keep["id"].as_str().unwrap_or("")).await { Ok(v) => v, Err(e) => { let _ = child.kill().await; let _ = control(dir, json!({ "removeHost": host, "removeKey": key_name })); return Err(e); } };
    let link = reg["link"].as_str().unwrap_or("").to_string();
    save(dir, &json!({ "id": reg["id"], "key": key }));
    let since = crate::util::now_iso();
    crate::core::log(true, &format!("temporary internet URL: {link} -> {target}"));
    *TUNNEL.lock().await = Some(Tunnel { child, target: target.clone(), link: link.clone(), id: reg["id"].as_str().unwrap_or("").to_string(), key_name, key: key.clone(), since: since.clone() });
    Ok(json!({ "running": true, "link": link, "target": target, "since": since, "key": key }))
}

/// At every start (settings.internetUrlAtStart, on unless switched off): once the engine answers, and when this
/// computer is signed in to sushila.ai, a new link is made and printed under the localhost addresses.
pub async fn at_start(dir: PathBuf, port: u16) {
    // the answer may still come (the first-start question in the window): waited for, up to an hour
    let mut chosen = Value::Null;
    for _ in 0..720 {
        chosen = crate::webserver::read_state(&dir)["settings"]["internetUrlAtStart"].clone();
        if !chosen.is_null() { break; }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    if chosen != true { return; }
    for _ in 0..120 {  // wait for the engine to answer
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        if crate::util::http_text(&format!("http://127.0.0.1:{port}/health"), 2).await.is_ok() { break; }
    }
    if crate::share::me(&dir)["signedIn"] != true {
        crate::core::log(false, "Internet link: none yet. Sign in to sushila.ai once (the page: 🌐 Get temporary internet URL, or Library: Upload and get link); then every start makes one.");
        return;
    }
    match start(&dir, port).await {
        Ok(v) => crate::core::log(false, &format!("Internet:  {}   (visitors need the access key {} ; this computer's Admin, Library and files stay here; switch off: 🌐 on the page)",
            v["link"].as_str().unwrap_or(""), v["key"].as_str().unwrap_or(""))),
        Err(e) => crate::core::log(false, &format!("Internet link: not made ({e})")),
    }
}

/// A new access key for the link (the old one stops working at once); the link stays the same.
pub async fn new_key(dir: &Path) -> Result<Value, String> {
    let key = format!("sk-sushila-{}", crate::util::random_token());
    let mut keep = saved(dir); keep["key"] = json!(key); save(dir, &keep);
    let mut g = TUNNEL.lock().await;
    if let Some(t) = g.as_mut() {
        use sha2::{Digest, Sha256};
        let key_name = format!("internet-link-{}", &crate::util::now_iso()[..19].replace([':', 'T'], "-"));
        control(dir, json!({ "removeKeyPrefix": "internet-link-", "addKey": { "name": key_name, "sha256": hex::encode(Sha256::digest(key.as_bytes())) } }))?;
        t.key = key.clone(); t.key_name = key_name;
    }
    Ok(json!({ "key": key }))
}

pub async fn stop(dir: &Path) -> Value {
    let t = TUNNEL.lock().await.take();
    let Some(mut t) = t else { return json!({ "running": false }) };
    let _ = t.child.kill().await;
    let host = t.target.trim_start_matches("https://").to_string();
    let _ = control(dir, json!({ "removeHost": host, "removeKey": t.key_name }));
    let _ = crate::share::tunnel_stop(dir, &t.id).await;
    crate::core::log(true, &format!("temporary internet URL stopped: {}", t.link));
    json!({ "running": false, "stopped": t.link })
}

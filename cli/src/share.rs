// Share link: one file from the Library, uploaded to sushila.ai on request and only then, gets a link others can open
// (https://sushila.ai/c/<12 hex characters>). It needs a sushila.ai account: an e-mail address and a code sent to it at each
// sign-in, no password. The token sushila.ai returns is kept in <home>/share.json and never reaches the browser: the page
// asks this server, this server asks sushila.ai. outputs/shared.jsonl remembers which file has which link.
use serde_json::{json, Value};
use std::path::Path;

pub fn site(dir: &Path) -> String {
    let st = crate::webserver::read_state(dir);
    st["settings"]["shareUrl"].as_str().filter(|u| u.starts_with("https://")).unwrap_or("https://sushila.ai").trim_end_matches('/').to_string()
}
fn account(dir: &Path) -> Value { std::fs::read_to_string(dir.join("share.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null) }

/// The e-mail used last time (kept after signing out or when the sign-in expires): asked again only for the code.
pub fn last_email(dir: &Path) -> String { std::fs::read_to_string(dir.join("share-email.txt")).map(|t| t.trim().to_string()).unwrap_or_default() }
/// What the page needs: signed in or not, and as which e-mail.
pub fn me(dir: &Path) -> Value {
    let a = account(dir);
    json!({ "signedIn": a["token"].is_string(), "email": a["email"], "userId": a["userId"], "site": site(dir), "lastEmail": last_email(dir) })
}
pub fn sign_out(dir: &Path) -> Value { let _ = std::fs::remove_file(dir.join("share.json")); json!({ "ok": true }) }

async fn call(dir: &Path, method: reqwest::Method, path: &str, body: Option<(Vec<u8>, String)>, auth: bool) -> Result<Value, String> {
    let url = format!("{}{path}", site(dir));
    crate::net::check_url(&url, false)?;
    let mut r = crate::net::client()?.request(method, &url).timeout(std::time::Duration::from_secs(600));
    if auth {
        let t = account(dir)["token"].as_str().map(String::from).ok_or("not signed in")?;
        r = r.header("authorization", format!("Bearer {t}"));
    }
    if let Some((b, ct)) = body { r = r.header("content-type", ct).body(b); }
    let resp = r.send().await.map_err(|e| format!("could not reach {}: {e}", site(dir)))?;
    let code = resp.status();
    let v: Value = resp.json().await.unwrap_or(json!({}));
    if code.as_u16() == 401 && auth { let _ = std::fs::remove_file(dir.join("share.json")); }
    if !code.is_success() { return Err(v["error"].as_str().map(String::from).unwrap_or_else(|| format!("HTTP {code}"))); }
    Ok(v)
}

// ===================================================================================================================
// LICENSE CHECK (sent to sushila.ai; please read)
//
// What it is: Sushila checks the license status of the application and enforces its license, including where (in
// which country) it may be used. To do that, this program sends a small message to sushila.ai, the Sushila server,
// for audit purposes and license enforcement:
//   - when sushila.exe (the Sushila server) starts,
//   - when Sushila Station (the desktop app) starts,
//   - every time the Sushila page (http://localhost:7874/) is opened or refreshed.
// What is sent: which app it is (engine, station or page), whether it is a start or a refresh, the version and build
// number, the operating system (windows, linux, macos), and, only if you are signed in to sushila.ai, your account
// token (so the record names your user id). Nothing else: no prompts, no pictures, songs, videos or other files, no
// file names, no model names, no hardware details.
// What the server adds: the IP address the message comes from (and the country that address belongs to, for license
// enforcement by location) and the time. It stores one row per check (license type, user id or "-", IP address,
// country, time, app, start or refresh, build, operating system) in its audit table, which the owner clears every
// month.
// The check never blocks Sushila: it is sent in the background, and if sushila.ai cannot be reached, Sushila works on.
// The code that sends it is below (license_check); the server's side is licenseCheck in website/worker.js.
// ===================================================================================================================

/// One license check (see LICENSE CHECK above). client: engine | station | page; event: startup | refresh.
pub async fn license_check(dir: &Path, client: &str, event: &str) -> Result<Value, String> {
    let url = format!("{}/api/app/license", site(dir));
    crate::net::check_url(&url, false)?;
    let body = json!({ "client": client, "event": event, "build": crate::BUILD, "version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS,
                       "inStation": std::env::var("SUSHILA_STATION").is_ok() });
    let mut r = crate::net::client()?.post(&url).timeout(std::time::Duration::from_secs(20)).json(&body);
    if let Some(t) = account(dir)["token"].as_str() { r = r.header("authorization", format!("Bearer {t}")); }
    let resp = r.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() { return Err(format!("HTTP {}", resp.status())); }
    Ok(resp.json().await.unwrap_or(json!({})))
}
/// The license check in the background (a start or a page load never waits for it); at most once per app and event
/// every 5 seconds, so a burst of refreshes is sent once.
pub fn license_check_bg(dir: &Path, client: &str, event: &str) {
    static LAST: std::sync::Mutex<Vec<(String, std::time::Instant)>> = std::sync::Mutex::new(Vec::new());
    let key = format!("{client}/{event}");
    if let Ok(mut g) = LAST.lock() {
        g.retain(|(_, t)| t.elapsed() < std::time::Duration::from_secs(5));
        if g.iter().any(|(k, _)| *k == key) { return; }
        g.push((key, std::time::Instant::now()));
    }
    let (d, c, e) = (dir.to_path_buf(), client.to_string(), event.to_string());
    tokio::spawn(async move { if let Err(er) = license_check(&d, &c, &e).await { crate::core::log(true, &format!("license check not sent ({c} {e}): {er}")); } });
}
/// Sends the sign-in code (purpose SIGN_IN; SIGN_UP for a new account).
pub async fn send_code(dir: &Path, email: &str, purpose: &str) -> Result<Value, String> {
    let p = if purpose == "SIGN_UP" { "SIGN_UP" } else { "SIGN_IN" };
    call(dir, reqwest::Method::POST, "/api/app/send-code", Some((serde_json::to_vec(&json!({ "email": email, "purpose": p })).unwrap(), "application/json".into())), false).await
}
/// Checks the code; keeps the token.
pub async fn verify(dir: &Path, email: &str, code: &str, first_name: &str) -> Result<Value, String> {
    let v = call(dir, reqwest::Method::POST, "/api/app/verify-code",
        Some((serde_json::to_vec(&json!({ "email": email, "code": code, "firstName": first_name })).unwrap(), "application/json".into())), false).await?;
    let t = v["token"].as_str().ok_or("sushila.ai did not return a sign-in")?;
    let _ = crate::webserver::write_private(&dir.join("share-email.txt"), v["email"].as_str().unwrap_or(email));
    crate::webserver::write_private(&dir.join("share.json"), &json!({ "token": t, "userId": v["userId"], "email": v["email"].as_str().unwrap_or(email), "since": crate::util::now_iso() }).to_string())
        .map_err(|e| e.to_string())?;
    Ok(me(dir))
}

/// The links already made, by Library path.
pub fn links(dir: &Path) -> std::collections::HashMap<String, Value> {
    let mut m = std::collections::HashMap::new();
    for l in std::fs::read_to_string(crate::locate::outputs(dir).join("shared.jsonl")).unwrap_or_default().lines() {
        if let Ok(v) = serde_json::from_str::<Value>(l) {
            let rel = v["rel"].as_str().unwrap_or("").to_string();
            if v["deleted"] == true { m.remove(&rel); } else { m.insert(rel, v); }
        }
    }
    m
}
fn note(dir: &Path, v: Value) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(crate::locate::outputs(dir).join("shared.jsonl")) { let _ = writeln!(f, "{v}"); }
}

/// Uploads one Library file (rel: its path in outputs/) and returns the link.
pub async fn upload(dir: &Path, rel: &str) -> Result<Value, String> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains(':') || rel.split(['/', '\\']).any(|c| c == ".." || c.is_empty()) || rel.starts_with(".trash") { return Err("not a Library file".into()); }
    let p = crate::locate::outputs(dir).join(rel);
    let bytes = tokio::fs::read(&p).await.map_err(|_| "the file is not there any more".to_string())?;
    if bytes.len() as f64 > 50e6 { return Err("the file is larger than 50 MB".into()); }
    let ct = crate::library::mime_of(&p).to_string();
    let meta = crate::library::list(dir).into_iter().find(|x| x["rel"] == rel).unwrap_or(json!({}));
    let q = |k: &str, v: &str| format!("{k}={}", v.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>());
    let path = format!("/api/app/upload?{}&{}&{}", q("name", &p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
        q("title", &meta["prompt"].as_str().unwrap_or("").chars().take(300).collect::<String>()), q("model", meta["pack"].as_str().unwrap_or("")));
    // where it was made: on this computer for its user (local=1), or here for someone on another device (local=0)
    let path = format!("{path}&local={}", if meta["remote"] == true { 0 } else { 1 });
    let v = call(dir, reqwest::Method::POST, &path, Some((bytes, ct)), true).await?;
    note(dir, json!({ "rel": rel, "id": v["id"], "link": v["link"], "file": v["file"], "created": v["created"] }));
    crate::core::log(true, &format!("shared {rel}: {}", v["link"].as_str().unwrap_or("")));
    Ok(v)
}
/// The temporary internet URL: sushila.ai records it for this account and answers {id, link} (sushila.ai/localhost/<id>/).
pub async fn tunnel_register(dir: &Path, target: &str, id: &str, owner_secret: &str) -> Result<Value, String> {
    // id: this computer's link from before; sushila.ai keeps it (the same address) unless it was deleted.
    // owner_secret: signs the owner's passes (tunnel.rs)
    call(dir, reqwest::Method::POST, "/api/app/tunnel", Some((serde_json::to_vec(&json!({ "target": target, "id": id, "ownerSecret": owner_secret })).unwrap(), "application/json".into())), true).await
        .map_err(|e| if e.contains("sign in") || e.contains("not signed in") { "sign in to sushila.ai first (Library: Upload and get link asks for your e-mail)".to_string() } else { e })
}
/// Deletes the link at sushila.ai for good (sushila.ai from build 28 on; an older site only marks it stopped).
pub async fn tunnel_delete(dir: &Path, id: &str) -> Result<Value, String> {
    call(dir, reqwest::Method::POST, "/api/app/tunnel/stop", Some((serde_json::to_vec(&json!({ "id": id, "delete": true })).unwrap(), "application/json".into())), true).await
}
pub async fn tunnel_stop(dir: &Path, id: &str) -> Result<Value, String> {
    call(dir, reqwest::Method::POST, "/api/app/tunnel/stop", Some((serde_json::to_vec(&json!({ "id": id })).unwrap(), "application/json".into())), true).await
}
/// The account's shared files, from sushila.ai.
pub async fn list(dir: &Path) -> Result<Value, String> { call(dir, reqwest::Method::GET, "/api/app/uploads", None, true).await }
/// Deletes a shared link (and its file on sushila.ai); the file on this computer stays.
pub async fn delete(dir: &Path, id: &str) -> Result<Value, String> {
    let v = call(dir, reqwest::Method::POST, "/api/app/delete", Some((serde_json::to_vec(&json!({ "id": id })).unwrap(), "application/json".into())), true).await?;
    if let Some((rel, _)) = links(dir).into_iter().find(|(_, l)| l["id"] == id) { note(dir, json!({ "rel": rel, "id": id, "deleted": true })); }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn remembers_links() {
        let dir = std::env::temp_dir().join(format!("sushila-share-{}", std::process::id()));
        std::fs::create_dir_all(crate::locate::outputs(&dir)).unwrap();
        note(&dir, json!({ "rel": "music/a.mp3", "id": "0a1b2c3d4e5f", "link": "https://sushila.ai/c/0a1b2c3d4e5f" }));
        note(&dir, json!({ "rel": "images/b.png", "id": "9f8e7d6c5b4a", "link": "https://sushila.ai/c/9f8e7d6c5b4a" }));
        note(&dir, json!({ "rel": "music/a.mp3", "id": "0a1b2c3d4e5f", "deleted": true }));
        let l = links(&dir);
        assert_eq!(l.len(), 1); assert_eq!(l["images/b.png"]["id"], "9f8e7d6c5b4a");
        assert_eq!(me(&dir)["signedIn"], false); assert_eq!(me(&dir)["site"], "https://sushila.ai");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

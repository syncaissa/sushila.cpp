// Upgrade in place: at start Station asks sushila.ai for the newest Station (the sushilaai-versions row with latest = true).
// Only a newer build than this one is offered (no row, or an older one: nothing is shown). Upgrade downloads the file for
// this system, checks its size, SHA-256 and the Sushila signature (the same key that signs engine and pack indexes, built
// in here; the private key never leaves the signing machine), puts it in place of the running program and restarts it.
// Windows cannot overwrite a running .exe but can rename it: the old one becomes <name>.old.exe and is removed next start.
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// This Station's build number (keep equal to the published build; the release script refuses an older one).
pub const STATION_BUILD: u64 = 13;
const SITE: &str = "https://sushila.ai";
/// Downloads come only from here.
const FILES: &str = "https://files.sushila.ai/";
/// The Sushila signing key (public half), the same as the engine's core::SIGNING_KEYS.
const SIGNING_KEY: &str = "Z1PIla052/oI3aZmZvsgB/V3lZUrqnjEoJEeYv4OwTs=";

/// The key of this system in a release row's files: windows-x64, linux-x64 (macOS: the .app updates itself later).
pub fn os_key() -> &'static str {
    if cfg!(all(windows, target_arch = "x86_64")) { "windows-x64" } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) { "linux-x64" } else { "" }
}
/// The text the release script signs for one file.
pub fn signed_text(build: u64, os: &str, sha256: &str, bytes: u64) -> String {
    format!("sushila-release|app=station|build={build}|os={os}|sha256={sha256}|bytes={bytes}")
}
fn verify(message: &str, signature_b64: &str) -> bool {
    use base64::Engine;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let b64 = base64::engine::general_purpose::STANDARD;
    let (Ok(pk), Ok(sig)) = (b64.decode(SIGNING_KEY), b64.decode(signature_b64.trim())) else { return false };
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::try_from(pk.as_slice()), <[u8; 64]>::try_from(sig.as_slice())) else { return false };
    let Ok(key) = VerifyingKey::from_bytes(&pk) else { return false };
    key.verify(message.as_bytes(), &Signature::from_bytes(&sig)).is_ok()
}

/// The newest release for this system, if it is newer than this Station; None otherwise (also when sushila.ai has none).
async fn newer(http: &reqwest::Client) -> Result<Option<(Value, Value)>, String> {
    let r = http.get(format!("{SITE}/api/versions/latest?app=station")).timeout(Duration::from_secs(8)).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() { return Ok(None); }
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    let l = v["latest"].clone();
    let build = l["build"].as_u64().unwrap_or(0);
    if !l.is_object() || build <= STATION_BUILD { return Ok(None); }
    let f = l["files"][os_key()].clone();
    if !f.is_object() { return Ok(None); }
    Ok(Some((l, f)))
}

/// {available, build, version, releaseNotes, bytes} for the window's notice.
pub async fn check(http: &reqwest::Client) -> Value {
    match newer(http).await {
        Ok(Some((l, f))) => json!({ "available": true, "build": l["build"], "version": l["version"], "releaseNotes": l["releaseNotes"], "bytes": f["bytes"], "current": STATION_BUILD }),
        _ => json!({ "available": false, "current": STATION_BUILD }),
    }
}

/// Downloads, checks and installs the newest Station, then starts it and ends this one. Progress: events "update"
/// {done, total}. Every check happens before anything is replaced; on any problem the running Station stays as it is.
pub async fn apply(app: AppHandle, http: &reqwest::Client) -> Result<(), String> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;
    let (l, f) = newer(http).await?.ok_or("there is no newer Sushila Station")?;
    let build = l["build"].as_u64().unwrap_or(0);
    let url = f["url"].as_str().unwrap_or("");
    let sha = f["sha256"].as_str().unwrap_or("").to_ascii_lowercase();
    let bytes = f["bytes"].as_u64().unwrap_or(0);
    if !url.starts_with(FILES) || url.contains("..") { return Err("the download address is not on files.sushila.ai".into()); }
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) || bytes == 0 { return Err("the release has no valid checksum".into()); }
    if !verify(&signed_text(build, os_key(), &sha, bytes), f["signature"].as_str().unwrap_or("")) { return Err("the release is not signed by Sushila: not installed".into()); }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let new = exe.with_file_name(format!("{}.new", exe.file_name().and_then(|n| n.to_str()).unwrap_or("SushilaStation")));
    // download next to the program (same drive: the swap is a rename)
    let resp = http.get(url).timeout(Duration::from_secs(3600)).send().await.map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() { return Err(format!("download failed: HTTP {}", resp.status())); }
    let mut out = tokio::fs::File::create(&new).await.map_err(|e| format!("cannot write next to {} ({e}); download the new Station from sushila.ai/install", exe.display()))?;
    let (mut h, mut done) = (Sha256::new(), 0u64);
    let mut stream = resp.bytes_stream();
    let mut last = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download failed: {e}"))?;
        done += chunk.len() as u64;
        if done > bytes { let _ = tokio::fs::remove_file(&new).await; return Err("the download is larger than the release says".into()); }
        h.update(&chunk);
        out.write_all(&chunk).await.map_err(|e| e.to_string())?;
        if last.elapsed() > Duration::from_millis(300) { last = std::time::Instant::now(); let _ = app.emit("update", json!({ "done": done, "total": bytes })); }
    }
    out.flush().await.map_err(|e| e.to_string())?; drop(out);
    if done != bytes || hex::encode(h.finalize()) != sha { let _ = tokio::fs::remove_file(&new).await; return Err("the download does not match its checksum: not installed".into()); }
    let _ = app.emit("update", json!({ "done": done, "total": bytes, "installing": true }));
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755)); }
    // swap: Windows renames the running program aside first; Unix replaces it in one rename
    #[cfg(windows)] {
        let old = old_path(&exe);
        let _ = std::fs::remove_file(&old);
        std::fs::rename(&exe, &old).map_err(|e| { let _ = std::fs::remove_file(&new); format!("cannot replace {} ({e})", exe.display()) })?;
        if let Err(e) = std::fs::rename(&new, &exe) { let _ = std::fs::rename(&old, &exe); return Err(format!("cannot install the new Station ({e})")); }
    }
    #[cfg(not(windows))]
    std::fs::rename(&new, &exe).map_err(|e| { let _ = std::fs::remove_file(&new); format!("cannot replace {} ({e})", exe.display()) })?;
    // the new Station takes over (it waits for this one to close) and this one ends
    std::process::Command::new(&exe).env("SUSHILA_STATION_TAKEOVER", "1").spawn().map_err(|e| format!("installed, but could not start it ({e}); open Sushila Station again"))?;
    app.exit(0);
    Ok(())
}

fn old_path(exe: &std::path::Path) -> std::path::PathBuf {
    let stem = exe.file_stem().and_then(|n| n.to_str()).unwrap_or("SushilaStation");
    exe.with_file_name(format!("{stem}.old.exe"))
}
/// At start: what an upgrade left behind (the renamed old program, an unfinished download).
pub fn clean_leftovers() {
    let Ok(exe) = std::env::current_exe() else { return };
    let _ = std::fs::remove_file(old_path(&exe));
    let _ = std::fs::remove_file(exe.with_file_name(format!("{}.new", exe.file_name().and_then(|n| n.to_str()).unwrap_or(""))));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn signed_text_is_stable() {
        assert_eq!(signed_text(10, "windows-x64", "ab", 5), "sushila-release|app=station|build=10|os=windows-x64|sha256=ab|bytes=5");
        assert!(!verify("x", "not a signature"));
        // made by setup/release_station.py's key (the Sushila signing key) over this exact text
        let sig = "UNcTQwYYXpddql5qj7NY09r94ntSPD3uerSQdRFBwPYBnLgXbOur0rsbz0YRp8J8ZnwNPszY1OkJ6N6b09DNAQ==";
        assert!(verify(&signed_text(10, "windows-x64", "ab", 5), sig));
        assert!(!verify(&signed_text(11, "windows-x64", "ab", 5), sig), "another build must not pass");
    }
}

// Small building blocks: files, downloads (resume + sha256), archives, signatures, programs, this computer.
use std::{path::{Path, PathBuf}, process::Stdio, time::Duration};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use crate::net::{check_url, client};

pub fn err<E: std::fmt::Display>(e: E) -> String { e.to_string() }

pub fn sha256_of(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(err)?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h).map_err(err)?;
    Ok(hex::encode(h.finalize()))
}
pub async fn file_sha256(path: &Path) -> Result<String, String> {
    let p = path.to_path_buf();
    tokio::task::spawn_blocking(move || sha256_of(&p)).await.map_err(err)?
}

/// Ed25519 signature (base64) over the exact text of a signed index.
pub fn verify_signature(public_key_b64: &str, message: &str, signature_b64: &str) -> bool {
    use base64::Engine;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let b64 = base64::engine::general_purpose::STANDARD;
    let (Ok(pk), Ok(sig)) = (b64.decode(public_key_b64.trim()), b64.decode(signature_b64.trim())) else { return false };
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::try_from(pk.as_slice()), <[u8; 64]>::try_from(sig.as_slice())) else { return false };
    let Ok(key) = VerifyingKey::from_bytes(&pk) else { return false };
    key.verify(message.as_bytes(), &Signature::from_bytes(&sig)).is_ok()
}

pub fn safe_rel_path(p: &str) -> bool {
    p.len() < 300 && !p.starts_with('/') && !p.contains('\\') && !(p.len() > 1 && p.as_bytes()[1] == b':')
        && p.split('/').all(|x| !x.is_empty() && x != "." && x != "..")
}
pub fn join_rel(dir: &Path, rel: &str) -> PathBuf { rel.split('/').fold(dir.to_path_buf(), |p, x| p.join(x)) }

pub fn human(b: u64) -> String {
    let b = b as f64;
    if b >= 1e9 { format!("{:.1} GB", b / 1e9) } else if b >= 1e6 { format!("{:.0} MB", b / 1e6) } else { format!("{:.0} KB", b / 1e3) }
}

pub async fn http_text(url: &str, timeout_s: u64) -> Result<String, String> {
    let local = url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost");
    let u = check_url(url, local)?;
    let r = client()?.get(u).timeout(Duration::from_secs(timeout_s)).send().await.map_err(err)?;
    let status = r.status();
    let body = r.text().await.map_err(err)?;
    if !status.is_success() { return Err(format!("HTTP {status}: {}", body.chars().take(200).collect::<String>())); }
    Ok(body)
}

/// Downloads url to dest: resumes a partial download (dest.part), shows progress on stderr, checks the sha256 over the
/// whole file. Only from the sources Host Station allows (net.rs), on every redirect too.
pub async fn download(url: &str, dest: &Path, sha256: Option<&str>, bytes: Option<u64>, label: &str, quiet: bool) -> Result<String, String> {
    let url = check_url(url, false)?.to_string();
    if let Some(d) = dest.parent() { tokio::fs::create_dir_all(d).await.map_err(err)?; }
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let mut start = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    let mut hasher = Sha256::new();
    if start > 0 {
        let p = part.clone();
        hasher = tokio::task::spawn_blocking(move || -> Result<Sha256, String> {
            let mut h = Sha256::new(); let mut f = std::fs::File::open(&p).map_err(err)?; std::io::copy(&mut f, &mut h).map_err(err)?; Ok(h)
        }).await.map_err(err)??;
    }
    let mut req = client()?.get(&url);
    if start > 0 { req = req.header(reqwest::header::RANGE, format!("bytes={start}-")); }
    let resp = req.send().await.map_err(err)?;
    if !resp.status().is_success() { return Err(format!("download failed: HTTP {}", resp.status())); }
    if start > 0 && resp.status().as_u16() != 206 { start = 0; hasher = Sha256::new(); }
    let total = bytes.or_else(|| resp.content_length().map(|n| n + start)).unwrap_or(0);
    let mut file = tokio::fs::OpenOptions::new().create(true).write(true).append(start > 0).truncate(start == 0).open(&part).await.map_err(err)?;
    let (mut done, t0, mut last) = (start, std::time::Instant::now(), std::time::Instant::now());
    let mut stream = resp.bytes_stream();
    let tty = !quiet && std::io::IsTerminal::is_terminal(&std::io::stderr());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("{e} (run the same command again to resume)"))?;
        file.write_all(&chunk).await.map_err(err)?;
        hasher.update(&chunk);
        done += chunk.len() as u64;
        if !quiet && last.elapsed() > Duration::from_millis(if tty { 300 } else { 15000 }) {
            let rate = (done - start) as f64 / t0.elapsed().as_secs_f64().max(0.1);
            let pct = if total > 0 { format!("{:5.1}%", 100.0 * done as f64 / total as f64) } else { String::new() };
            let line = format!("  {label}: {pct} {} of {} ({}/s)", human(done), if total > 0 { human(total) } else { "?".into() }, human(rate as u64));
            if tty { eprint!("\r{line:<100}"); } else { eprintln!("{line}"); }
            last = std::time::Instant::now();
        }
    }
    file.flush().await.map_err(err)?;
    drop(file);
    if tty { eprint!("\r{:<100}\r", ""); }
    let got = hex::encode(hasher.finalize());
    if let Some(want) = sha256.filter(|s| !s.is_empty()) {
        if !got.eq_ignore_ascii_case(want) {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(format!("{label}: sha256 mismatch (expected {want}, got {got}); the file was deleted"));
        }
    }
    tokio::fs::rename(&part, dest).await.map_err(err)?;
    if !quiet { eprintln!("  {label}: {} downloaded and verified", human(done)); }
    Ok(got)
}

/// Unpacks .zip, .tar.gz/.tgz or .sushilapack/.tar into dest; paths that would leave dest, and links in packs, are skipped.
pub async fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let (archive, dest) = (archive.to_path_buf(), dest.to_path_buf());
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&dest).map_err(err)?;
        let f = std::fs::File::open(&archive).map_err(err)?;
        let name = archive.to_string_lossy().to_lowercase();
        if name.ends_with(".zip") {
            let mut z = zip::ZipArchive::new(f).map_err(err)?;
            for i in 0..z.len() {
                let mut e = z.by_index(i).map_err(err)?;
                let Some(rel) = e.enclosed_name() else { continue };
                let out = dest.join(rel);
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
        } else if name.ends_with(".sushilapack") || name.ends_with(".tar") {
            let mut t = tar::Archive::new(f);
            for e in t.entries().map_err(err)? {
                let mut e = e.map_err(err)?;
                if !matches!(e.header().entry_type(), tar::EntryType::Regular | tar::EntryType::Directory) { continue; }
                e.unpack_in(&dest).map_err(err)?;
            }
        } else {
            let mut t = tar::Archive::new(flate2::read::GzDecoder::new(f));
            t.set_preserve_permissions(true);
            for e in t.entries().map_err(err)? { e.map_err(err)?.unpack_in(&dest).map_err(err)?; }
        }
        Ok(())
    }).await.map_err(err)?
}

pub fn set_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(m) = std::fs::metadata(path) { let mut p = m.permissions(); p.set_mode(p.mode() | 0o755); let _ = std::fs::set_permissions(path, p); }
    }
    let _ = path;
}

pub fn command(program: &str, args: &[String]) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(program);
    c.args(args).stdin(Stdio::null());
    #[cfg(windows)]
    { c.creation_flags(0x0800_0000); }  // CREATE_NO_WINDOW
    c
}

/// Runs a program and returns {code, stdout, stderr}; None when it cannot start (not installed).
pub async fn run_capture(program: &str, args: &[&str], timeout_s: u64) -> Option<Value> {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let out = tokio::time::timeout(Duration::from_secs(timeout_s), command(program, &args).output()).await.ok()?.ok()?;
    Some(json!({ "code": out.status.code(), "stdout": String::from_utf8_lossy(&out.stdout), "stderr": String::from_utf8_lossy(&out.stderr) }))
}

/// This computer: OS (linux, macos, windows), CPU architecture, cores, memory.
pub fn host_info() -> Value {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    json!({
        "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "family": std::env::consts::FAMILY,
        "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        "memory_bytes": sys.total_memory(),
    })
}

pub fn now_iso() -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // civil date from days (Howard Hinnant's algorithm), UTC
    let (days, secs) = ((t / 86400) as i64, t % 86400);
    let z = days + 719468; let era = z.div_euclid(146097); let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153; let d = doy - (153 * mp + 2) / 5 + 1; let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60)
}

pub fn random_token() -> String {
    let mut b = [0u8; 24];
    getrandom::getrandom(&mut b).expect("the operating system has no random number source");
    hex::encode(b)
}

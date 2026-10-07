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

/// GET as text. From the internet it is tried up to 5 times (waits 1, 2, 3, 4 s) when the server answers 5xx/429 or
/// the connection fails: a busy server or a storage hiccup should not fail an install.
pub async fn http_text(url: &str, timeout_s: u64) -> Result<String, String> {
    let local = url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost");
    let u = check_url(url, local)?;
    let tries = if local { 1 } else { 5 };
    let mut last = String::new();
    for t in 1..=tries {
        if t > 1 { tokio::time::sleep(Duration::from_secs(t as u64 - 1)).await; }
        let r = match client()?.get(u.clone()).timeout(Duration::from_secs(timeout_s)).send().await { Ok(r) => r, Err(e) => { last = e.to_string(); continue; } };
        let status = r.status();
        let body = match r.text().await { Ok(b) => b, Err(e) => { last = e.to_string(); continue; } };
        if status.is_success() { return Ok(body); }
        last = format!("HTTP {status}: {}", body.chars().take(200).collect::<String>());
        if !(status.is_server_error() || status.as_u16() == 429) { break; }
    }
    Err(last)
}

/// Downloads url to dest: resumes a partial download (dest.part), shows progress on stderr, checks the sha256 over the
/// whole file. Only from the sources Host Station allows (net.rs), on every redirect too.
/// Progress of a background action, shared with the server loop: {label, done, total}.
pub type Prog = std::sync::Arc<std::sync::Mutex<Value>>;

#[allow(dead_code)]  // single-file downloads outside a job use download_p; kept for tests and callers without progress
pub async fn download(url: &str, dest: &Path, sha256: Option<&str>, bytes: Option<u64>, label: &str, quiet: bool) -> Result<String, String> {
    download_p(url, dest, sha256, bytes, label, quiet, None).await
}
/// Retries up to 8 times (waits 2, 4, 8 ... 60 s) when the server answers 5xx/408/429, the connection drops or stalls
/// for 60 s; every retry resumes from the .part file, so nothing already downloaded is fetched again.
pub async fn download_p(url: &str, dest: &Path, sha256: Option<&str>, bytes: Option<u64>, label: &str, quiet: bool, prog: Option<&Prog>) -> Result<String, String> {
    download_in(url, dest, sha256, bytes, label, quiet, prog, None).await
}

/// Several files downloaded as one job (a model pack, the image runtime): one progress bar for the whole job, with the
/// current file and its percentage, and one line at the end instead of one per file.
pub struct Job { pub name: String, pub total: u64, pub files: usize, done: std::sync::atomic::AtomicU64, file: std::sync::atomic::AtomicUsize, id: String, quiet: bool }
impl Job {
    pub fn new(name: &str, total: u64, files: usize, quiet: bool) -> Self {
        Job { name: name.into(), total, files, done: 0.into(), file: 0.into(), id: format!("job-{}-{}", std::process::id(), name), quiet }
    }
    /// A file finished (or was already there): its bytes count as done.
    pub fn file_done(&self, bytes: u64) { self.done.fetch_add(bytes, std::sync::atomic::Ordering::SeqCst); self.file.fetch_add(1, std::sync::atomic::Ordering::SeqCst); }
    pub fn finish(&self) {
        progress_hide(&self.id, !self.quiet && progress_tty());
        if !self.quiet { eprintln!("  {}: {} file{}, {} downloaded and verified", self.name, self.files, if self.files == 1 { "" } else { "s" }, human(self.total)); }
    }
}
fn progress_tty() -> bool { std::io::IsTerminal::is_terminal(&std::io::stderr()) || crate::tui::in_screen() }
/// One progress update: under the server window's screen an event (it draws the bar on its own row), in a terminal
/// a line rewritten in place, otherwise a line in the log.
fn progress_show(id: &str, line: &str, frac: Option<f64>, tty: bool) {
    if crate::tui::in_screen() { eprint!("\x1b]7770;{}\x07", json!({ "id": id, "text": line, "frac": frac })); }
    else if tty { crate::ticker::progress(&format!("{} {line}", crate::ticker::bar(frac, 20))); }
    else { eprintln!("{line}"); }
}
fn progress_hide(id: &str, tty: bool) {
    if crate::tui::in_screen() { eprint!("\x1b]7770;{}\x07", json!({ "id": id, "done": true })); }
    else if tty { crate::ticker::progress_clear(); }
}

/// download_p, as part of a job (or not).
pub async fn download_in(url: &str, dest: &Path, sha256: Option<&str>, bytes: Option<u64>, label: &str, quiet: bool, prog: Option<&Prog>, job: Option<&Job>) -> Result<String, String> {
    const TRIES: u32 = 8;
    let mut tri = 1;
    loop {
        match download_once(url, dest, sha256, bytes, label, quiet, prog, job).await {
            Ok(h) => return Ok(h),
            Err((e, retry)) if retry && tri < TRIES => {
                let wait = (2u64 << (tri - 1)).min(60);
                eprintln!("  {label}: {e}; trying again in {wait} s (try {} of {TRIES}, resuming)", tri + 1);
                tokio::time::sleep(Duration::from_secs(wait)).await;
                tri += 1;
            }
            Err((e, retry)) => return Err(if retry { format!("{e}; gave up after {tri} tries (run the same command again to resume)") } else { e }),
        }
    }
}
async fn download_once(url: &str, dest: &Path, sha256: Option<&str>, bytes: Option<u64>, label: &str, quiet: bool, prog: Option<&Prog>, job: Option<&Job>) -> Result<String, (String, bool)> {
    let fatal = |e: String| (e, false);
    let again = |e: String| (e, true);
    let url = check_url(url, cfg!(test)).map_err(fatal)?.to_string();  // tests: a local flaky server
    if let Some(d) = dest.parent() { tokio::fs::create_dir_all(d).await.map_err(|e| fatal(e.to_string()))?; }
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let mut start = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    let mut hasher = Sha256::new();
    if start > 0 {
        let p = part.clone();
        hasher = tokio::task::spawn_blocking(move || -> Result<Sha256, String> {
            let mut h = Sha256::new(); let mut f = std::fs::File::open(&p).map_err(err)?; std::io::copy(&mut f, &mut h).map_err(err)?; Ok(h)
        }).await.map_err(|e| fatal(e.to_string()))?.map_err(fatal)?;
    }
    let mut req = client().map_err(fatal)?.get(&url);
    if start > 0 { req = req.header(reqwest::header::RANGE, format!("bytes={start}-")); }
    let resp = req.send().await.map_err(|e| again(format!("download failed: {e}")))?;
    let code = resp.status().as_u16();
    if code == 416 { let _ = tokio::fs::remove_file(&part).await; return Err(again("download failed: the partial file did not match; starting over".into())); }
    if !resp.status().is_success() { return Err((format!("download failed: HTTP {}", resp.status()), code >= 500 || code == 408 || code == 429)); }
    if start > 0 && resp.status().as_u16() != 206 { start = 0; hasher = Sha256::new(); }
    let total = bytes.or_else(|| resp.content_length().map(|n| n + start)).unwrap_or(0);
    let mut file = tokio::fs::OpenOptions::new().create(true).write(true).append(start > 0).truncate(start == 0).open(&part).await.map_err(|e| fatal(e.to_string()))?;
    let (mut done, t0, mut last) = (start, std::time::Instant::now(), std::time::Instant::now());
    let mut stream = resp.bytes_stream();
    let tty = !quiet && progress_tty();
    let id = job.map(|j| j.id.clone()).unwrap_or_else(|| format!("dl-{}-{label}", std::process::id()));
    loop {
        let chunk = match tokio::time::timeout(Duration::from_secs(60), stream.next()).await {
            Err(_) => { let _ = file.flush().await; return Err(again(format!("download stalled at {}", human(done)))); }
            Ok(None) => break,
            Ok(Some(Err(e))) => { let _ = file.flush().await; return Err(again(format!("download interrupted at {}: {e}", human(done)))); }
            Ok(Some(Ok(c))) => c,
        };
        file.write_all(&chunk).await.map_err(|e| fatal(e.to_string()))?;
        hasher.update(&chunk);
        done += chunk.len() as u64;
        if let Some(p) = prog { if let Ok(mut g) = p.lock() { *g = json!({ "label": label, "done": done, "total": total }); } }
        if !quiet && last.elapsed() > Duration::from_millis(if tty { 300 } else { 15000 }) {
            let rate = human(((done - start) as f64 / t0.elapsed().as_secs_f64().max(0.1)) as u64);
            let fpct = if total > 0 { format!("{:.0}%", 100.0 * done as f64 / total as f64) } else { human(done) };
            let (line, frac) = match job {
                // the whole job first, then this file
                Some(j) => {
                    let all = j.done.load(std::sync::atomic::Ordering::SeqCst) + done;
                    let f = if j.total > 0 { Some((all as f64 / j.total as f64).min(1.0)) } else { None };
                    (format!("{}: {:.1}% ({} of {})  |  file {} of {}: {fpct}  |  {rate}/s  |  {label}", j.name, 100.0 * f.unwrap_or(0.0), human(all), human(j.total),
                        j.file.load(std::sync::atomic::Ordering::SeqCst) + 1, j.files), f)
                }
                None => {
                    let f = if total > 0 { Some(done as f64 / total as f64) } else { None };
                    (format!("{label}: {:.1}%  {} of {}  ({rate}/s)", 100.0 * f.unwrap_or(0.0), human(done), if total > 0 { human(total) } else { "?".into() }), f)
                }
            };
            progress_show(&id, &format!("  {line}"), frac, tty);
            last = std::time::Instant::now();
        }
    }
    file.flush().await.map_err(|e| fatal(e.to_string()))?;
    drop(file);
    if total > 0 && done < total { return Err(again(format!("download ended early at {} of {}", human(done), human(total)))); }
    if job.is_none() { progress_hide(&id, tty); }
    let got = hex::encode(hasher.finalize());
    if let Some(want) = sha256.filter(|s| !s.is_empty()) {
        if !got.eq_ignore_ascii_case(want) {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(fatal(format!("{label}: sha256 mismatch (expected {want}, got {got}); the file was deleted")));
        }
    }
    tokio::fs::rename(&part, dest).await.map_err(|e| fatal(e.to_string()))?;
    if !quiet && job.is_none() { eprintln!("  {label}: {} downloaded and verified", human(done)); }
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

#[cfg(test)]
mod download_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    /// The failures seen on Windows build 2 (HTTP 500 after a while) and a connection cut mid-file: the download must
    /// retry, resume with a Range request, and end with the right sha256.
    #[tokio::test]
    async fn retries_and_resumes() {
        let body: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let want = hex::encode(Sha256::digest(&body));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let b = body.clone();
        let ranges = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let r2 = ranges.clone();
        tokio::spawn(async move {
            for n in 0.. {
                let (mut s, _) = l.accept().await.unwrap();
                let mut buf = vec![0u8; 4096]; let k = s.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..k]).to_lowercase();
                let start = req.lines().find_map(|x| x.strip_prefix("range: bytes=")).and_then(|x| x.trim_end_matches('-').trim().parse::<usize>().ok()).unwrap_or(0);
                r2.lock().unwrap().push(format!("{n}:{start}"));
                match n {
                    0 => { let _ = s.write_all(b"HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await; }
                    1 => {  // promise the whole file, send 100 KB, cut the connection
                        let _ = s.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", b.len()).as_bytes()).await;
                        let _ = s.write_all(&b[..100_000]).await;
                    }
                    _ => {
                        let rest = &b[start..];
                        let _ = s.write_all(format!("HTTP/1.1 206 Partial Content\r\ncontent-length: {}\r\ncontent-range: bytes {start}-{}/{}\r\nconnection: close\r\n\r\n", rest.len(), b.len() - 1, b.len()).as_bytes()).await;
                        let _ = s.write_all(rest).await;
                    }
                }
                let _ = s.shutdown().await;
            }
        });
        let dir = std::env::temp_dir().join(format!("sushila-dl-test-{}", std::process::id()));
        let dest = dir.join("f.bin");
        let got = download(&format!("http://127.0.0.1:{port}/f.bin"), &dest, Some(&want), Some(body.len() as u64), "test", true).await.unwrap();
        assert_eq!(got, want);
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        let r = ranges.lock().unwrap().clone();
        assert_eq!(r, vec!["0:0", "1:0", "2:100000"], "500, then a cut at 100 KB, then a resume from 100 KB");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

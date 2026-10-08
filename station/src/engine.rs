// The Sushila engine (the `sushila` program) as Sushila Station manages it: the copy that travels inside the app, the
// command-line copy it installs for the user (on the PATH), starting and stopping the server, and the local token
// that lets this app manage it (the engine gives it only to programs on this computer).
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

pub const PORT: u16 = 7874;
const BUNDLED: &[u8] = include_bytes!(env!("SUSHILA_BIN_PATH"));
pub const BUNDLED_SHA: &str = env!("SUSHILA_BIN_SHA");
const EXE: &str = if cfg!(windows) { "sushila.exe" } else { "sushila" };

pub fn base() -> String { format!("http://127.0.0.1:{PORT}") }

/// Where Station keeps its own copy of the engine (named by its checksum: a newer Station brings a newer engine).
fn app_dir() -> PathBuf { dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("Sushila Station") }
fn bundled_copy() -> Option<PathBuf> {
    if BUNDLED.is_empty() { return None; }
    Some(app_dir().join("engine").join(&BUNDLED_SHA[..16]).join(EXE))
}

/// Where "Install the sushila command" puts it for this user (no administrator rights needed on Windows and Linux).
pub fn cli_path() -> PathBuf {
    if cfg!(windows) { dirs::data_local_dir().unwrap_or_default().join("Programs").join("Sushila").join(EXE) }
    else if cfg!(target_os = "macos") { dirs::home_dir().unwrap_or_default().join(".sushila").join("bin").join(EXE) }
    else { dirs::home_dir().unwrap_or_default().join(".local").join("bin").join(EXE) }
}

fn write_exe(dest: &PathBuf) -> Result<(), String> {
    if BUNDLED.is_empty() { return Err("this build of Sushila Station carries no engine".into()); }
    if let Ok(b) = std::fs::read(dest) { if b == BUNDLED { return Ok(()); } }
    std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = dest.with_extension("part");
    std::fs::write(&tmp, BUNDLED).map_err(|e| e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?; }
    // replacing a running program fails on Windows, but a running program can be renamed: the old one goes aside
    // (<name>.old, removed the next time), the new one takes its name and is used from the next start
    if std::fs::rename(&tmp, dest).is_err() {
        let aside = dest.with_extension("old");
        let _ = std::fs::remove_file(&aside);
        if std::fs::rename(dest, &aside).is_err() || std::fs::rename(&tmp, dest).is_err() {
            let _ = std::fs::remove_file(&tmp);
            if !dest.exists() { let _ = std::fs::rename(&aside, dest); return Err(format!("could not write {}", dest.display())); }
        }
    }
    Ok(())
}

/// The engine build this Station carries (SUSHILA_ENGINE_BUILD at build time; 0 if unknown).
pub fn bundled_build() -> u32 { option_env!("SUSHILA_ENGINE_BUILD").and_then(|b| b.parse().ok()).unwrap_or(0) }
/// The build of an engine program, from `sushila --version` ("0.1.1 (build 28)"); 0 for builds before 28.
fn build_of(p: &PathBuf) -> u32 {
    let Ok(o) = hidden(std::process::Command::new(p)).arg("--version").stdin(std::process::Stdio::null()).output() else { return 0 };
    let t = String::from_utf8_lossy(&o.stdout).to_string();
    t.split("(build ").nth(1).and_then(|r| r.split(')').next()).and_then(|n| n.trim().parse().ok()).unwrap_or(0)
}

/// The engine program to run: the installed command if it is there, else Station's own copy, else one on the PATH.
pub fn program() -> Result<PathBuf, String> {
    let cli = cli_path();
    if cli.is_file() {
        // the installed command, brought up to this Station's engine when it is older (a newer one is left alone)
        if !BUNDLED.is_empty() && build_of(&cli) < bundled_build() { let _ = write_exe(&cli); }
        return Ok(cli);
    }
    if let Some(p) = bundled_copy() { write_exe(&p)?; return Ok(p); }
    let path = std::env::var_os("PATH").unwrap_or_default();
    for d in std::env::split_paths(&path) { let p = d.join(EXE); if p.is_file() { return Ok(p); } }
    Err("Sushila is not installed: this Station build carries no engine and none was found".into())
}

/// Installs (or updates) the `sushila` command for this user and puts its folder on the PATH.
pub fn install_cli() -> Result<Value, String> {
    let dest = cli_path();
    write_exe(&dest)?;
    let dir = dest.parent().unwrap().to_path_buf();
    let on_path = add_to_path(&dir)?;
    Ok(json!({ "path": dest.to_string_lossy(), "folder": dir.to_string_lossy(), "onPath": on_path }))
}
pub fn uninstall_cli() -> Result<Value, String> {
    let dest = cli_path();
    if dest.exists() { std::fs::remove_file(&dest).map_err(|e| format!("{e} (stop Sushila first)"))?; }
    Ok(json!({ "removed": dest.to_string_lossy() }))
}

fn add_to_path(dir: &PathBuf) -> Result<bool, String> {
    let d = dir.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        // the user's own Path (HKCU\Environment), read and written whole by PowerShell (setx would cut it at 1024 characters)
        let script = format!("$p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){{$p=''}}; $d='{}'; if(-not (($p -split ';') -contains $d)){{[Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $d).TrimStart(';'), 'User')}}", d.replace('\'', "''"));
        let ok = hidden(std::process::Command::new("powershell")).args(["-NoProfile", "-NonInteractive", "-Command", &script]).status().map(|s| s.success()).unwrap_or(false);
        return Ok(ok);
    }
    #[cfg(not(windows))]
    {
        // a line in the shell profiles, once (macOS zsh and bash; Linux ~/.local/bin is usually there already)
        let home = dirs::home_dir().unwrap_or_default();
        let line = format!("export PATH=\"{d}:$PATH\"  # added by Sushila Station");
        let mut done = false;
        for f in [".zprofile", ".bash_profile", ".profile"] {
            let p = home.join(f);
            if cfg!(target_os = "linux") && f != ".profile" { continue; }
            let cur = std::fs::read_to_string(&p).unwrap_or_default();
            if cur.contains(&d) { done = true; continue; }
            if std::fs::write(&p, format!("{cur}{}{line}\n", if cur.is_empty() || cur.ends_with('\n') { "" } else { "\n" })).is_ok() { done = true; }
        }
        Ok(done)
    }
}

/// A child process without a console window (Windows); unchanged elsewhere.
pub fn hidden(mut c: std::process::Command) -> std::process::Command {
    #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }  // CREATE_NO_WINDOW
    c
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(3)).build().expect("http client")
}

/// {running, version, ready, models} from /health (two seconds at most).
pub async fn health(c: &reqwest::Client) -> Value {
    match c.get(format!("{}/health", base())).timeout(Duration::from_secs(2)).send().await {
        Ok(r) => match r.json::<Value>().await { Ok(v) if v["app"] == "sushila" => { let mut v = v; v["running"] = json!(true); v } _ => json!({ "running": false }) },
        Err(_) => json!({ "running": false }),
    }
}

/// Starts `sushila serve` in the background (no window, no browser), detached from Station: it keeps serving the
/// queue when the window is closed.
pub fn start() -> Result<Value, String> {
    let p = program()?;
    let mut c = hidden(std::process::Command::new(&p));
    c.arg("serve").env("SUSHILA_NO_BROWSER", "1").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000 | 0x0000_0008 | 0x0000_0200); }  // no window, detached, own group
    #[cfg(unix)] { use std::os::unix::process::CommandExt; c.process_group(0); }  // not stopped with Station
    let child = c.spawn().map_err(|e| format!("could not start {}: {e}", p.display()))?;
    Ok(json!({ "pid": child.id(), "program": p.to_string_lossy() }))
}
/// `sushila stop`: the server stops its models and exits (it also ends a server started elsewhere).
pub async fn stop() -> Result<Value, String> {
    let p = program()?;
    let out = tokio::task::spawn_blocking(move || hidden(std::process::Command::new(p)).arg("stop").output()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    Ok(json!({ "ok": out.status.success(), "text": String::from_utf8_lossy(&out.stdout).trim() }))
}

/// This computer's token, from the page the engine serves to programs on this computer (window.SUSHILA_TOKEN).
pub async fn fetch_token(c: &reqwest::Client) -> Result<String, String> {
    let html = c.get(format!("{}/", base())).header("host", format!("localhost:{PORT}")).timeout(Duration::from_secs(5)).send().await
        .map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
    let i = html.find("window.SUSHILA_TOKEN=\"").ok_or("the engine did not give this app its token (is another program using the port?)")? + "window.SUSHILA_TOKEN=\"".len();
    let j = html[i..].find('"').ok_or("bad token")?;
    Ok(html[i..i + j].to_string())
}

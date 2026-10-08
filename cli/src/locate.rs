//! Finding Sushila's application folder: the one folder that holds state.json, logs/, engine/ and model-packs/.
//!
//! Order: --data-dir or SUSHILA_HOME (explicit) -> the folder chosen before (one line in the per-user settings folder, see pointer_file)
//! -> a search of the likely places. A place counts only if it already holds Sushila's things. One found: it is used
//! and remembered. None: the OS default folder is created. Several: in a terminal Sushila asks which one; without a
//! terminal (a service) it takes the most recently used one and says so. `sushila home` shows it; `sushila home <folder>` replaces it.
use std::path::{Path, PathBuf};

/// The OS default for model packs, the engine, settings and logs (big, machine-specific, never synced or roamed):
/// %LOCALAPPDATA%\Sushila, ~/Library/Application Support/Sushila, ~/.local/share/sushila.
pub fn os_default() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")).join(if cfg!(target_os = "linux") { "sushila" } else { "Sushila" })
}
/// Where builds before 27 kept everything: %APPDATA%\ai.sushila.hoststation (roaming), ~/Library/Application
/// Support/ai.sushila.hoststation, ~/.local/share/ai.sushila.hoststation.
pub fn legacy_default() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("ai.sushila.hoststation")
}

/// The server starting with the old default home and no new one yet: the folder is renamed to the new place (the same
/// drive, so it is instant) and remembered. Not done while a Sushila server answers (its files are in use), and a
/// failure (a file open on Windows) keeps the old place. Returns the home to use.
pub fn move_legacy_home(home: PathBuf) -> PathBuf {
    let (old, new) = (legacy_default(), os_default());
    let same = |a: &Path, b: &Path| std::fs::canonicalize(a).ok().zip(std::fs::canonicalize(b).ok()).map(|(x, y)| x == y).unwrap_or(false);
    if !same(&home, &old) || new.exists() { return home; }
    let busy = std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], 7874).into(), std::time::Duration::from_millis(300)).is_ok();
    if busy { return home; }
    if let Some(d) = new.parent() { let _ = std::fs::create_dir_all(d); }
    match std::fs::rename(&old, &new) {
        Ok(()) => { remember(&new); eprintln!("Sushila's home moved from {} to {} (model packs, engine, settings and logs).", old.display(), new.display()); new }
        Err(e) => { eprintln!("note: Sushila's home stays in {} (moving it to {} failed: {e}).", old.display(), new.display()); home }
    }
}

/// Paths kept in state.json (the engine, the image runtime's python, model packs) name the home they were installed
/// in. After the home moved (build 27 moved the roaming home to the local one, or `sushila home`), every string that
/// starts with the old home is rewritten to the new one. Returns whether anything changed.
pub fn rebase_paths(v: &mut serde_json::Value, home: &Path) -> bool {
    let olds: Vec<String> = [legacy_default()].iter().filter(|o| o.as_path() != home && !o.exists()).map(|o| o.to_string_lossy().to_string()).collect();
    if olds.is_empty() { return false; }
    let new = home.to_string_lossy().to_string();
    fn walk(v: &mut serde_json::Value, olds: &[String], new: &str) -> bool {
        match v {
            serde_json::Value::String(s) => {
                for o in olds {
                    // the old home itself, or a path inside it (either separator)
                    if s.as_str() == o || s.starts_with(&format!("{o}\\")) || s.starts_with(&format!("{o}/")) { *s = format!("{new}{}", &s[o.len()..]); return true; }
                }
                false
            }
            serde_json::Value::Array(a) => a.iter_mut().fold(false, |c, x| walk(x, olds, new) | c),
            serde_json::Value::Object(m) => m.values_mut().fold(false, |c, x| walk(x, olds, new) | c),
            _ => false,
        }
    }
    walk(v, &olds, &new)
}

// ---------- where your pictures, songs and videos go: Documents\Sushila (Images, Music, Videos) by default, the OS's
// real Documents folder (so it follows OneDrive's redirection), or any folder chosen in Settings (the one-line file
// <home>/outputs-folder). An install from before keeps <home>/outputs until its owner answers the question once
// (move them to Documents, or keep them where they are).

/// The default folder for your files: Documents/Sushila.
pub fn default_outputs() -> Option<PathBuf> { dirs::document_dir().or_else(|| dirs::home_dir().map(|h| h.join("Documents"))).map(|d| d.join("Sushila")) }
/// The folder chosen in Settings (or by the one question), if any.
pub fn chosen_outputs(home: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(home.join("outputs-folder")).ok()?;
    text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).map(PathBuf::from)
}
pub fn choose_outputs(home: &Path, folder: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(home)?;
    std::fs::write(home.join("outputs-folder"), format!("{}\n", folder.to_string_lossy()))
}
/// Files from before (the old <home>/outputs, not chosen): the question is asked while this is true.
pub fn old_outputs(home: &Path) -> Option<PathBuf> {
    let old = home.join("outputs");
    (chosen_outputs(home).is_none() && std::fs::read_dir(&old).map(|mut d| d.next().is_some()).unwrap_or(false)).then_some(old)
}
/// Can Sushila write there? (Windows' Controlled folder access, ransomware protection, blocks unknown programs from
/// Documents, Pictures, Music and Videos; a read-only or missing drive fails too.) Asked once per folder per run, until
/// writable_forget() (after the owner allowed Sushila in Windows Security, or chose a folder).
static SEEN: std::sync::Mutex<Option<std::collections::HashMap<PathBuf, Result<(), String>>>> = std::sync::Mutex::new(None);
pub fn writable(d: &Path) -> Result<(), String> {
    let mut g = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(Default::default);
    if let Some(r) = m.get(d) { return r.clone(); }
    let r = (|| {
        std::fs::create_dir_all(d)?;
        let probe = d.join(".sushila-write-test");
        std::fs::write(&probe, b"ok")?;
        std::fs::remove_file(&probe)
    })().map_err(|e| blocked_reason(d, &e));
    m.insert(d.to_path_buf(), r.clone());
    r
}
pub fn writable_forget() { *SEEN.lock().unwrap_or_else(|e| e.into_inner()) = None; }
fn blocked_reason(d: &Path, e: &std::io::Error) -> String {
    if cfg!(windows) && e.kind() == std::io::ErrorKind::PermissionDenied {
        format!("Windows blocked Sushila from writing to {} (Controlled folder access). To allow it: Windows Security -> Virus & threat protection -> \
                 Ransomware protection -> Allow an app through Controlled folder access -> add sushila.exe. Or choose another folder in Settings. \
                 Until then your files go to Sushila's own folder.", d.display())
    } else {
        format!("Sushila cannot write to {} ({e}). Choose another folder in Settings; until then your files go to Sushila's own folder.", d.display())
    }
}
/// The folder your pictures, songs and videos go to now: the chosen one, else the old one (until the question is
/// answered), else Documents/Sushila; one that cannot be written falls back to <home>/outputs.
pub fn outputs(home: &Path) -> PathBuf {
    if cfg!(test) { return home.join("outputs"); }
    outputs_status(home).0
}
/// outputs() and, when the wanted folder cannot be written, why (shown in the page and in Station).
pub fn outputs_status(home: &Path) -> (PathBuf, Option<String>) {
    let fallback = home.join("outputs");
    let want = chosen_outputs(home).or_else(|| old_outputs(home)).or_else(default_outputs).unwrap_or_else(|| fallback.clone());
    if want == fallback { return (want, None); }
    match writable(&want) { Ok(()) => (want, None), Err(why) => (fallback, Some(why)) }
}

/// Where the chosen home is remembered: one line with the folder's path, in the per-user settings folder that every
/// user can write without admin rights: Windows %APPDATA%\sushila\home, macOS ~/Library/Application Support/sushila/home,
/// Linux ~/.config/sushila/home (edit it by hand if you like).
pub fn pointer_file() -> Option<PathBuf> { dirs::config_dir().map(|d| d.join("sushila").join("home")) }

/// Remember the home (the only file Sushila keeps outside its home folder).
pub fn remember(p: &Path) {
    if let Some(f) = pointer_file() {
        if let Some(d) = f.parent() { let _ = std::fs::create_dir_all(d); }
        let _ = std::fs::write(&f, format!("{}\n", p.to_string_lossy()));
    }
}
pub fn forget() { if let Some(f) = pointer_file() { let _ = std::fs::remove_file(f); } }
fn remembered() -> Option<PathBuf> {
    let text = std::fs::read_to_string(pointer_file()?).ok()?;
    Some(PathBuf::from(text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#'))?)).filter(|p| p.is_dir())
}
fn interactive() -> bool { std::io::IsTerminal::is_terminal(&std::io::stdin()) && std::io::IsTerminal::is_terminal(&std::io::stderr()) }

/// Model packs in a folder's model-packs/: sub-folders with a sushila-pack.json, and loose .gguf files.
pub fn pack_count(p: &Path) -> usize {
    std::fs::read_dir(p.join("model-packs")).map(|d| d.flatten().filter(|e| {
        let q = e.path();
        q.join("sushila-pack.json").is_file() || q.extension().map(|x| x.eq_ignore_ascii_case("gguf")).unwrap_or(false)
    }).count()).unwrap_or(0)
}
/// A Sushila application folder: it has state.json, an engine/, or model packs.
pub fn is_app_folder(p: &Path) -> bool { p.join("state.json").is_file() || p.join("engine").is_dir() || pack_count(p) > 0 }

fn last_used(p: &Path) -> std::time::SystemTime {
    ["state.json", "logs/sushila.log", "model-packs"].iter().filter_map(|f| std::fs::metadata(p.join(f)).and_then(|m| m.modified()).ok()).max()
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
}

/// Every likely place that already holds Sushila's things, most recently used first.
pub fn candidates() -> Vec<PathBuf> {
    let mut places = vec![os_default(), legacy_default()];
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        places.push(exe_dir.join("sushila-data")); places.push(exe_dir);
    }
    if let Ok(cwd) = std::env::current_dir() { places.push(cwd.join("sushila")); places.push(cwd); }
    if let Some(h) = dirs::home_dir() { for n in ["sushila", "Sushila"] { places.push(h.join(n)); } }
    for d in [dirs::document_dir(), dirs::download_dir()].into_iter().flatten() { for n in ["Sushila", "sushila"] { places.push(d.join(n)); } }
    let mut seen = std::collections::HashSet::new();
    let mut found: Vec<PathBuf> = places.into_iter().filter(|p| is_app_folder(p))
        .filter(|p| seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.clone()))).collect();
    found.sort_by_key(|p| std::cmp::Reverse(last_used(p)));
    found
}

pub fn describe(p: &Path) -> String {
    let n = pack_count(p);
    let when = last_used(p);
    let age = std::time::SystemTime::now().duration_since(when).map(|d| d.as_secs()).unwrap_or(0);
    let ago = if when == std::time::SystemTime::UNIX_EPOCH { "never".into() } else if age < 3600 { format!("{} min ago", age / 60) }
              else if age < 86400 * 2 { format!("{} h ago", age / 3600) } else { format!("{} days ago", age / 86400) };
    format!("{}  ({n} model pack{}, last used {ago})", p.display(), if n == 1 { "" } else { "s" })
}

/// The application folder for this run, and a warning to show when the choice was made without asking.
pub fn resolve(explicit: Option<PathBuf>) -> (PathBuf, Option<String>) {
    if let Some(p) = explicit { return (p, None); }
    if let Ok(h) = std::env::var("SUSHILA_HOME") { if !h.is_empty() { return (PathBuf::from(h), None); } }
    if let Some(p) = remembered() { return (p, None); }
    let found = candidates();
    match found.len() {
        0 => {
            // nothing found (first start, or the pointer file deleted and the home somewhere unusual): ask, never guess
            let d = os_default();
            if interactive() {
                eprint!("\nNo Sushila home found (the folder with model-packs, settings and logs).\nType the folder of your existing home, or press Enter to start a new one in {}: ", d.display());
                let mut s = String::new();
                let _ = std::io::stdin().read_line(&mut s);
                let t = s.trim().trim_matches('"');
                if !t.is_empty() {
                    let p = std::path::absolute(t).unwrap_or_else(|_| PathBuf::from(t));
                    if is_app_folder(&p) { remember(&p); eprintln!("Home: {} (remembered)\n", describe(&p)); return (p, None); }
                    eprintln!("{} has no Sushila files; starting a new home there.", p.display());
                    let _ = std::fs::create_dir_all(&p); remember(&p); return (p, None);
                }
                remember(&d); return (d, None);
            }
            remember(&d);
            (d.clone(), Some(format!("no Sushila home found, so a new one starts in {}. If your models are in another folder, run `sushila home <that folder>`.", d.display())))
        }
        1 => { remember(&found[0]); (found[0].clone(), None) }
        _ => {
            if interactive() {
                eprintln!("\nSushila found more than one folder with its files (models, settings, logs):");
                for (i, p) in found.iter().enumerate() { eprintln!("  {}. {}", i + 1, describe(p)); }
                loop {
                    eprint!("Which one should Sushila use? [1-{}, Enter = 1]: ", found.len());
                    let mut s = String::new();
                    if std::io::stdin().read_line(&mut s).is_err() || s.is_empty() { break; }
                    let s = s.trim();
                    let k = if s.is_empty() { 1 } else { s.parse::<usize>().unwrap_or(0) };
                    if (1..=found.len()).contains(&k) {
                        let p = found[k - 1].clone(); remember(&p);
                        eprintln!("Home: {} (remembered; change it with `sushila home <folder>`).\n", p.display());
                        return (p, None);
                    }
                    eprintln!("Please type a number from 1 to {}.", found.len());
                }
            }
            let p = found[0].clone();
            let others: Vec<String> = found[1..].iter().map(|q| q.display().to_string()).collect();
            (p.clone(), Some(format!("several Sushila folders found; using the most recently used, {} (others: {}). Make one of them the home with `sushila home <folder>`.",
                p.display(), others.join(", "))))
        }
    }
}

#[cfg(test)]
mod rebase_tests {
    #[test]
    fn paths_follow_a_moved_home() {
        let old = super::legacy_default();
        if old.exists() { return; }  // a machine that still has the old home: the rewrite is (rightly) not done
        let o = old.to_string_lossy().to_string();
        let sep = std::path::MAIN_SEPARATOR;
        let new = std::env::temp_dir().join("sushila-rebase-test");
        let mut v = serde_json::json!({ "runtimes": { "image-nunchaku": { "python": format!("{o}{sep}runtime{sep}python{sep}python.exe"), "dir": o.clone() } },
                                        "packs": [{ "dir": format!("{o}/model-packs/x") }], "other": format!("{o}-not-inside"), "n": 3 });
        assert!(super::rebase_paths(&mut v, &new));
        let n = new.to_string_lossy().to_string();
        assert_eq!(v["runtimes"]["image-nunchaku"]["python"], format!("{n}{sep}runtime{sep}python{sep}python.exe"));
        assert_eq!(v["runtimes"]["image-nunchaku"]["dir"], n);
        assert_eq!(v["packs"][0]["dir"], format!("{n}/model-packs/x"));
        assert_eq!(v["other"], format!("{o}-not-inside"));
        assert!(!super::rebase_paths(&mut v, &new));  // nothing left to change
    }
}

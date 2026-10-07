//! Finding Sushila's application folder: the one folder that holds state.json, logs/, engine/ and model-packs/.
//!
//! Order: --data-dir or SUSHILA_HOME (explicit) -> the folder chosen before (one line in the per-user settings folder, see pointer_file)
//! -> a search of the likely places. A place counts only if it already holds Sushila's things. One found: it is used
//! and remembered. None: the OS default folder is created. Several: in a terminal Sushila asks which one; without a
//! terminal (a service) it takes the most recently used one and says so. `sushila home` shows it; `sushila home <folder>` replaces it.
use std::path::{Path, PathBuf};

/// The OS default: %APPDATA%\ai.sushila.hoststation, ~/Library/Application Support/ai.sushila.hoststation,
/// ~/.local/share/ai.sushila.hoststation.
pub fn os_default() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("ai.sushila.hoststation")
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
    let mut places = vec![os_default()];
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

// The ticker: one line at the bottom of the server window that scrolls tips and live facts right to left, like an LED
// message board. Everything else scrolls above it: the terminal's scroll region is all lines but the last (DECSTBM),
// and the line is drawn with save cursor / move / print / restore cursor in one write, so it never splits a log line.
// Typed in the window (plain lines, so typing commands keeps working): Enter pauses or resumes, b goes back one
// message, n forward, all prints the history, ticker off/on hides or shows it.
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::time::{Duration, Instant};

static RUNNING: AtomicBool = AtomicBool::new(false);   // the thread exists
static ON: AtomicBool = AtomicBool::new(false);        // the user wants it (ticker on/off, setting)
static CHILD: AtomicBool = AtomicBool::new(false);     // a typed command runs and writes to the same terminal
static ROWS: AtomicU64 = AtomicU64::new(0);            // rows of the scroll region we set (0: none set)
static UTF8: AtomicBool = AtomicBool::new(true);       // the terminal shows the legend's symbols

/// What the line shows and what b/n/all browse: the history of messages (every command sentence once, then the last 50
/// live updates, each when it changed, with its time).
#[derive(Default)]
struct Ui { history: std::collections::VecDeque<(Option<String>, String)>, statics: usize, paused: bool, cursor: Option<usize>,
            current: Vec<String>, offset: usize, seg: Vec<(usize, String)>, groups: Vec<(String, String)> }
static UI: std::sync::LazyLock<std::sync::Mutex<Ui>> = std::sync::LazyLock::new(Default::default);
const HISTORY: usize = 50;

/// The terminal's size (columns, rows), read again at every redraw so a resized window is followed.
fn size() -> Option<(usize, usize)> { terminal_size::terminal_size_of(std::io::stderr()).map(|(w, h)| (w.0 as usize, h.0 as usize)) }

/// Windows consoles understand escape sequences only with virtual terminal processing on, and show the symbols only
/// with the UTF-8 code page (else the legend uses ASCII).
#[cfg(windows)]
fn enable_vt() -> bool {
    use windows_sys::Win32::System::Console::{GetConsoleMode, GetStdHandle, SetConsoleMode, SetConsoleOutputCP, ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_ERROR_HANDLE};
    unsafe {
        UTF8.store(SetConsoleOutputCP(65001) != 0, SeqCst);
        let h = GetStdHandle(STD_ERROR_HANDLE);
        let mut mode = 0u32;
        if GetConsoleMode(h, &mut mode) == 0 { return false; }
        mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0 || SetConsoleMode(h, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0
    }
}
#[cfg(not(windows))]
fn enable_vt() -> bool {
    // a locale that is set but not UTF-8 (e.g. LANG=C on an old server): ASCII symbols
    let loc = ["LC_ALL", "LC_CTYPE", "LANG"].iter().find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()));
    UTF8.store(loc.map(|l| { let l = l.to_lowercase(); l.contains("utf-8") || l.contains("utf8") }).unwrap_or(true), SeqCst);
    true
}

/// Whether this window can show a ticker at all (a terminal that understands escape sequences, not turned off).
pub fn wanted(json: bool, quiet: bool, setting: &serde_json::Value) -> bool {
    !json && !quiet && std::io::IsTerminal::is_terminal(&std::io::stderr()) && std::env::var("TERM").map(|t| t != "dumb").unwrap_or(true)
        && std::env::var("SUSHILA_TICKER").map(|v| v != "0" && v != "off").unwrap_or(true) && !off_setting(setting)
}
pub fn off_setting(v: &serde_json::Value) -> bool { v == "off" || *v == false }

fn emit(s: &str) { let mut e = std::io::stderr().lock(); let _ = e.write_all(s.as_bytes()); let _ = e.flush(); }

/// Sets the scroll region above the last line and keeps the cursor inside it.
fn setup(rows: usize) {
    // a newline first, so whatever is on the last line moves up instead of being covered
    emit(&format!("\n\x1b7\x1b[1;{}r\x1b8\x1b[{};1H", rows - 1, rows - 1));
    ROWS.store(rows as u64, SeqCst);
}
/// The scroll region back to the whole window and the last line cleared: the terminal is left as it was.
pub fn reset() {
    let rows = ROWS.swap(0, SeqCst);
    if rows == 0 { return; }
    emit(&format!("\x1b7\x1b[r\x1b[{rows};1H\x1b[2K\x1b8"));
}

/// The text shown from `offset` on, `width` characters, the message repeating.
pub fn window(msg: &[char], offset: usize, width: usize) -> String {
    if msg.is_empty() { return " ".repeat(width); }
    (0..width).map(|i| msg[(offset + i) % msg.len()]).collect()
}
/// At most `width` characters, with … when cut.
pub fn fit(s: &str, width: usize) -> String {
    let n = s.chars().count();
    if n <= width { format!("{s}{}", " ".repeat(width - n)) } else { s.chars().take(width.saturating_sub(1)).chain(['…']).collect() }
}
/// The key legend at the start of the line (shorter in narrow windows; ASCII where the symbols cannot be shown).
pub fn legend(cols: usize, utf8: bool) -> &'static str {
    match (cols < 70, utf8) {
        (false, true) => "⏸ Enter=pause ◀ b=back ▶ n=next ☰ all │ ", (true, true) => "Enter=⏸ b=◀ n=▶ │ ",
        (false, false) => "|| Enter=pause < b=back > n=next = all | ", (true, false) => "Enter=|| b=< n=> | ",
    }
}
const SEP: &str = " • ";

/// One task-first sentence per command (several for commands with subcommands), grouped like the commands document;
/// {u} is this server's address. A unit test fails if a clap command has no sentence here.
pub const SENTENCES: [(&str, &str, &str); 70] = [
    ("Getting started", "url", "To see this server's addresses again: type urls here, or sushila url"),
    ("Getting started", "open", "To open the Admin page: go to {u}/admin in your browser (or sushila open admin)"),
    ("Getting started", "open", "To read the documentation: {u}/docs (or sushila open docs)"),
    ("Getting started", "assistant", "To ask anything about Sushila: just type your question here, or sushila assistant"),
    ("Getting started", "selftest", "To check that everything works and the GPU is used: sushila selftest"),
    ("Getting started", "doctor", "To find problems and their fixes: sushila doctor"),
    ("Getting started", "home", "To see where models, settings and logs are kept: sushila home"),
    ("Getting started", "version", "To see the versions of sushila and the engine: sushila version"),
    ("Getting started", "completion", "To get Tab completion in your shell: sushila completion bash|zsh|fish|powershell"),
    ("Models", "search", "To find a model pack: sushila search <words> (--kind chat|code|image|music|video, --fits)"),
    ("Models", "packs", "To list every pack in the catalog: sushila packs (--all for other hardware too)"),
    ("Models", "install", "To add a new model pack: sushila install <pack> (find one with sushila search)"),
    ("Models", "install", "To add your own GGUF model: sushila install <file>.gguf or hf:<owner>/<repo>/<file>.gguf"),
    ("Models", "list", "To list the installed packs: sushila list"),
    ("Models", "show", "To see a pack's files, size and what Accelerated adds: sushila show <pack>"),
    ("Models", "license", "To read a pack's license: sushila license <pack>"),
    ("Models", "verify", "To check every file of the installed packs: sushila verify"),
    ("Models", "remove", "To delete a pack: sushila remove <pack>"),
    ("Models", "export", "To copy a pack to another computer: sushila export <pack> <file.zip>"),
    ("Models", "import", "To install a pack file from another computer: sushila import <file>"),
    ("Models", "convert", "To turn a Hugging Face model into GGUF: sushila convert <owner>/<repo>"),
    ("Models", "precompute", "To build a precomputed landscape (experimental): sushila precompute <pack>"),
    ("Using models", "chat", "To chat in the terminal: sushila chat"),
    ("Using models", "run", "To get one answer, picture, song or video: sushila run <pack> \"<prompt>\""),
    ("Using models", "ask", "To ask about a text or code file: sushila ask <file> \"<question>\""),
    ("Using models", "batch", "To run many prompts from a file: sushila batch <pack> <prompts.txt>"),
    ("Using models", "watch", "To answer every .txt file dropped into a folder: sushila watch <folder>"),
    ("Using models", "embed", "To get an embedding vector: sushila embed <pack> \"<text>\""),
    ("Using models", "example", "To call the API from your code: sushila example <pack> curl|python|js (API: {u}/v1)"),
    ("Using models", "queue", "To see, pause or cancel background jobs: sushila queue"),
    ("Using models", "history", "To see past jobs with prompt, seed and output: sushila history"),
    ("Running server and models", "serve", "To start the server: sushila serve (it is running now in this window)"),
    ("Running server and models", "status", "To see what is installed and running: sushila status"),
    ("Running server and models", "ps", "To see running models with memory and GPU memory: sushila ps"),
    ("Running server and models", "top", "To watch models and the GPU live: sushila top (in another terminal)"),
    ("Running server and models", "start", "To start a model in this server: sushila start <pack>"),
    ("Running server and models", "stop", "To stop one model: sushila stop <pack>"),
    ("Running server and models", "stop", "To stop the server: type stop here, or sushila stop"),
    ("Running server and models", "mode", "To switch Standard or Accelerated: sushila mode <pack> standard|accelerated"),
    ("Running server and models", "idle", "To unload models nobody uses: sushila idle <minutes>"),
    ("Running server and models", "logs", "To read the log: sushila logs (-f follows it, in another terminal)"),
    ("Running server and models", "engine", "To install or update the engine for this GPU: sushila engine install"),
    ("Running server and models", "engine", "To see the engine, the GPU and the folders: sushila engine info"),
    ("Speed and quality", "bench", "To compare speed Standard vs Accelerated: sushila bench <pack>"),
    ("Speed and quality", "eval", "To check math accuracy Standard vs Accelerated: sushila eval <pack>"),
    ("Speed and quality", "reproduce", "To rerun the paper's results: sushila reproduce"),
    ("Speed and quality", "limit", "To set threads, parallel requests, context or GPU layers: sushila limit"),
    ("Settings, sharing and security", "config", "To see or change settings: sushila config list, sushila config set <key> <value>"),
    ("Settings, sharing and security", "password", "To set or change the Admin password: sushila password (lost it? --reset)"),
    ("Settings, sharing and security", "share", "To let other machines use this server: sushila share on, then restart it"),
    ("Settings, sharing and security", "share", "To open it on a phone: sushila share qr (same network, with an access key)"),
    ("Settings, sharing and security", "keys", "To give a machine or program access: sushila keys add <name>"),
    ("Settings, sharing and security", "keys", "To list or revoke access keys: sushila keys list, sushila keys remove <name>"),
    ("Settings, sharing and security", "https", "To serve over HTTPS on your domain: sushila https <domain>"),
    ("Settings, sharing and security", "service", "To start Sushila when the computer starts: sushila service install"),
    ("Settings, sharing and security", "service", "To stop starting it automatically: sushila service remove"),
    ("Settings, sharing and security", "backup", "To back up settings, keys and the queue: sushila backup <file.zip>"),
    ("Settings, sharing and security", "restore", "To restore a backup (server stopped): sushila restore <file.zip>"),
    ("Housekeeping", "update", "To get a newer engine and updated packs: sushila update (--check only lists)"),
    ("Housekeeping", "clean", "To remove leftovers and old engines: sushila clean (--dry-run first)"),
    ("Housekeeping", "du", "To see the disk space each pack uses: sushila du"),
    ("Housekeeping", "report", "To make a bug report without secrets: sushila report"),
    ("Housekeeping", "uninstall", "To remove Sushila: sushila uninstall (--all also deletes the home folder)"),
    ("Housekeeping", "help", "To list every command: sushila --help; one command: sushila <command> --help"),
    ("Getting started", "assistant", "To ask Sushila in the browser: the ☰ menu, Ask Sushila ({u}/#assistant)"),
    ("Using models", "open", "To use the models in the browser: {u}/"),
    ("Running server and models", "status", "This line: Enter pauses, b goes back, n forward, all lists every message"),
    ("Running server and models", "stop", "To hide this line: type ticker off (ticker on shows it again)"),
    ("Housekeeping", "home", "To use another home folder: sushila home <folder> (takes effect at the next start)"),
    ("Getting started", "packs", "To see what fits this computer: sushila search --fits"),
];
pub const GROUPS: [&str; 7] = ["Getting started", "Models", "Using models", "Running server and models", "Speed and quality", "Settings, sharing and security", "Housekeeping"];
/// The sentences with this server's address filled in, in table order: (group, text).
pub fn tips(port: u16) -> Vec<(String, String)> {
    let u = format!("http://localhost:{port}");
    SENTENCES.iter().map(|(g, _, t)| (g.to_string(), t.replace("{u}", &u))).collect()
}
/// The static sentences with the live items interleaved: one live item after every `every` sentences, in turn.
pub fn interleave(tips: &[String], live: &[String], every: usize) -> Vec<String> {
    let mut out = vec![]; let mut k = 0;
    for (i, t) in tips.iter().enumerate() {
        if i % every == 0 && !live.is_empty() { out.push(live[k % live.len()].clone()); k += 1; }
        out.push(t.clone());
    }
    out
}

/// Live items: running models and their mode, the queue, the GPU, requests served. The bool says whether the item goes
/// into the history when it changes (not counters that change at every request).
fn live(dir: &std::path::Path, last_jobs: &mut std::collections::HashMap<String, String>) -> Vec<(String, bool)> {
    let st = crate::webserver::read_state(dir);
    let mut v = vec![];
    let running: Vec<String> = st["running"].as_object().map(|m| m.iter().map(|(id, r)| format!("{id} ({}{})", if r["mode"] == "turbo" { "Accelerated" } else { "Standard" }, if r["ready"] == true { "" } else { ", loading" })).collect()).unwrap_or_default();
    v.push((if running.is_empty() { "no model running (sushila start <pack>)".into() } else { format!("running: {}", running.join(", ")) }, true));
    let q = crate::webserver::read_queue(dir);
    let jobs = q["jobs"].as_array().cloned().unwrap_or_default();
    for j in &jobs {
        let (id, status) = (j["id"].as_str().unwrap_or("").to_string(), j["status"].as_str().unwrap_or("").to_string());
        if last_jobs.get(&id).map(|s| s == "running").unwrap_or(false) && status != "running" {
            v.push((format!("{} job {} ({})", j["kind"].as_str().unwrap_or(""), if status == "ready" { "finished" } else { &status }, j["model"].as_str().unwrap_or("")), true));
        }
        last_jobs.insert(id, status);
    }
    if let Some(j) = jobs.iter().find(|j| j["status"] == "running") { v.push((format!("queue: {} {} {}", j["kind"].as_str().unwrap_or("job"), j["model"].as_str().unwrap_or(""), j["progress"].as_str().unwrap_or("")), false)); }
    let waiting = jobs.iter().filter(|j| j["status"] == "queued").count();
    if waiting > 0 { v.push((format!("{waiting} job{} waiting", if waiting == 1 { "" } else { "s" }), true)); }
    if q["paused"] == true { v.push(("queue paused (sushila queue resume)".into(), true)); }
    if let Ok(o) = std::process::Command::new("nvidia-smi").args(["--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"]).stderr(std::process::Stdio::null()).output() {
        if let Some(l) = String::from_utf8_lossy(&o.stdout).lines().next() {
            let f: Vec<&str> = l.split(',').map(str::trim).collect();
            if f.len() == 3 { if let (Ok(u), Ok(t)) = (f[1].parse::<f64>(), f[2].parse::<f64>()) { v.push((format!("GPU {}: {:.0} of {:.0} GB used", f[0], u / 1024.0, t / 1024.0), true)); } }
        }
    }
    let n = crate::webserver::requests_served();
    if n > 0 { v.push((format!("{n} request{} served", if n == 1 { "" } else { "s" }), false)); }
    v
}
fn remember(ui: &mut Ui, time: Option<String>, text: String) {
    if ui.history.iter().any(|(_, t)| *t == text) { return; }
    if time.is_none() { ui.statics += 1; }
    ui.history.push_back((time, text));
    if ui.history.len() > ui.statics + HISTORY {
        // the oldest live update goes; the command sentences stay
        ui.history.remove(ui.statics);
        if let Some(c) = ui.cursor.as_mut() { if *c > ui.statics { *c -= 1; } }
    }
}
/// The scrolling text of the current messages, and where each starts.
fn rebuild(ui: &mut Ui) -> Vec<char> {
    let (mut s, mut seg) = (String::new(), vec![]);
    for m in &ui.current { seg.push((s.chars().count(), m.clone())); s += m; s += SEP; }
    ui.seg = seg;
    s.chars().collect()
}

/// What the line shows now (without the reverse-video escape codes): the legend, then the scrolling text, or the paused
/// or browsed message in full.
fn line(ui: &Ui, msg: &[char], cols: usize) -> String {
    let utf8 = UTF8.load(SeqCst);
    let lg = legend(cols, utf8);
    let room = cols.saturating_sub(1 + lg.chars().count());
    let body = match ui.cursor {
        Some(c) => { let (t, m) = &ui.history[c.min(ui.history.len().saturating_sub(1))];
            fit(&format!("{} {}/{} {}{}", if utf8 { "◀" } else { "<" }, c + 1, ui.history.len(), t.as_ref().map(|t| format!("[{t}] ")).unwrap_or_default(), m), room) }
        None if ui.paused => fit(&format!("{} paused  {}", if utf8 { "⏸" } else { "||" }, current_message(ui)), room),
        None => window(msg, ui.offset, room),
    };
    format!("{lg}{body}")
}
/// The message at the left of the scrolling text.
fn current_message(ui: &Ui) -> String { ui.seg.iter().rev().find(|(s, _)| *s <= ui.offset).or(ui.seg.first()).map(|x| x.1.clone()).unwrap_or_default() }

/// Starts the ticker thread (once). It moves about 9 characters a second and refreshes the live facts every 5 s.
pub fn start(dir: std::path::PathBuf, port: u16) {
    if !enable_vt() || RUNNING.swap(true, SeqCst) { return; }
    ON.store(true, SeqCst);
    std::thread::spawn(move || {
        let groups = tips(port);
        let tips: Vec<String> = groups.iter().map(|x| x.1.clone()).collect();
        UI.lock().unwrap().groups = groups;
        let mut jobs = Default::default();
        let mut last = Instant::now() - Duration::from_secs(60);
        let mut msg: Vec<char> = vec![];
        loop {
            if last.elapsed() > Duration::from_secs(5) {
                last = Instant::now();
                // `sushila config set ticker off` while the server runs
                if off_setting(&crate::webserver::read_state(&dir)["settings"]["ticker"]) { ON.store(false, SeqCst); }
                let items = live(&dir, &mut jobs);
                let mut ui = UI.lock().unwrap();
                if ui.history.is_empty() { for t in &tips { remember(&mut ui, None, t.clone()); } }
                let now = crate::util::now_iso()[11..19].to_string();
                for (t, h) in &items { if *h { remember(&mut ui, Some(now.clone()), t.clone()); } }
                // the live items between the sentences, one every 4, so they come round every half minute or so
                ui.current = interleave(&tips, &items.into_iter().map(|x| x.0).collect::<Vec<_>>(), 4);
                msg = rebuild(&mut ui);
                if ui.offset >= msg.len() { ui.offset = 0; }
            }
            std::thread::sleep(Duration::from_millis(110));
            if !ON.load(SeqCst) { reset(); continue; }
            if CHILD.load(SeqCst) { continue; }
            let Some((cols, rows)) = size() else { continue };
            if cols < 40 || rows < 5 { reset(); continue; }
            if ROWS.load(SeqCst) != rows as u64 { reset(); setup(rows); }
            let text = { let mut ui = UI.lock().unwrap(); if !ui.paused && ui.cursor.is_none() { ui.offset = (ui.offset + 1) % msg.len().max(1); } line(&ui, &msg, cols) };
            emit(&format!("\x1b7\x1b[{rows};1H\x1b[7m{text}\x1b[0m\x1b8"));
        }
    });
}

/// The window's short controls: "" (Enter) pause/resume, b back, n next, all history. Returns false for anything else.
pub fn control(word: &str) -> bool {
    if !["", "b", "n", "all"].contains(&word) { return false; }
    if !RUNNING.load(SeqCst) || !ON.load(SeqCst) {
        if !word.is_empty() { eprintln!("the ticker is off here (ticker on shows it, where the window supports it)"); }
        return true;
    }
    let mut ui = UI.lock().unwrap();
    let last = ui.history.len().saturating_sub(1);
    match word {
        "" => { if ui.paused || ui.cursor.is_some() { ui.paused = false; ui.cursor = None; } else { ui.paused = true; } }
        "b" => {
            // from the message on the line now (its place in the history), one back
            let here = ui.cursor.or_else(|| { let m = current_message(&ui); ui.history.iter().position(|(_, t)| *t == m) }).unwrap_or(last + 1);
            ui.paused = true; ui.cursor = Some(here.saturating_sub(1).min(last));
        }
        "n" => match ui.cursor {
            Some(c) => ui.cursor = Some((c + 1).min(last)),
            // scrolling: jump to the next message
            None => { let o = ui.offset; if let Some(s) = ui.seg.iter().find(|(s, _)| *s > o).or(ui.seg.first()).map(|x| x.0) { ui.offset = s; } }
        },
        _ => {
            let mut s = String::from("Every sushila command (the ticker's messages):\n");
            for g in GROUPS { s += &format!("{g}:\n"); for (gg, t) in &ui.groups { if gg == g { s += &format!("  {t}\n"); } } }
            let live: Vec<String> = ui.history.iter().filter_map(|(t, m)| t.as_ref().map(|t| format!("  [{t}] {m}\n"))).collect();
            if !live.is_empty() { s += "Live updates (newest last):\n"; s += &live.concat(); }
            drop(ui); eprint!("{s}"); return true;
        }
    }
    true
}
/// `ticker on` / `ticker off` typed in the window.
pub fn set_on(on: bool) { ON.store(on, SeqCst); if !on { reset(); } }
/// While a typed command runs (it writes to the same terminal), the line stays still.
pub fn pause(p: bool) { CHILD.store(p, SeqCst); }
pub fn active() -> bool { RUNNING.load(SeqCst) }
/// Stops drawing and leaves the terminal clean (end of serve, errors, panics).
pub struct Guard;
impl Drop for Guard { fn drop(&mut self) { set_on(false); } }
/// After the server process died without cleaning up (the supervisor): the whole window scrolls again, last line cleared.
pub fn hard_reset() { if let Some((_, rows)) = size() { emit(&format!("\x1b7\x1b[r\x1b[{rows};1H\x1b[2K\x1b8")); } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn scrolls() {
        let m: Vec<char> = "abc • ".chars().collect();
        assert_eq!(window(&m, 0, 8), "abc • ab"); assert_eq!(window(&m, 4, 3), "• a"); assert_eq!(window(&[], 0, 3), "   ");
        assert!(tips(8797).iter().any(|t| t.1.contains("http://localhost:8797/admin")));
        assert_eq!(interleave(&["a".into(), "b".into(), "c".into()], &["L1".into(), "L2".into()], 2), vec!["L1", "a", "b", "L2", "c"]);
        assert!(off_setting(&serde_json::json!("off")) && off_setting(&serde_json::json!(false)) && !off_setting(&serde_json::json!("on")) && !off_setting(&serde_json::Value::Null));
        assert_eq!(fit("abcdef", 4), "abc…"); assert_eq!(fit("ab", 4), "ab  ");
        assert!(legend(100, true).starts_with("⏸ Enter=pause") && legend(60, true) == "Enter=⏸ b=◀ n=▶ │ " && legend(100, false).is_ascii() && legend(50, false).is_ascii());
    }
    #[test] fn browsing() {
        let mut ui = Ui::default();
        for i in 0..3 { remember(&mut ui, None, format!("s{i}")); }
        for i in 0..60 { remember(&mut ui, Some("12:00:00".into()), format!("m{i}")); }
        remember(&mut ui, Some("12:00:01".into()), "m59".into());
        assert_eq!(ui.history.len(), 3 + HISTORY); assert_eq!(ui.history[0].1, "s0"); assert_eq!(ui.history[3].1, "m10");
        ui.current = vec!["live".into(), "tip".into()]; let msg = rebuild(&mut ui);
        ui.offset = 8; assert_eq!(current_message(&ui), "tip"); ui.offset = 2; assert_eq!(current_message(&ui), "live");
        ui.offset = 8; ui.paused = true; let l = line(&ui, &msg, 100); assert!(l.contains("paused  tip") && l.chars().count() == 99, "{l}");
        ui.cursor = Some(4); assert!(line(&ui, &msg, 100).contains("5/53 [12:00:00] m11"), "{}", line(&ui, &msg, 100));
    }
    #[test] fn every_command_has_a_sentence() {
        use clap::CommandFactory;
        for c in crate::Cli::command().get_subcommands() {
            let n = c.get_name();
            assert!(SENTENCES.iter().any(|s| s.1 == n), "the ticker has no sentence for `sushila {n}` (add one to SENTENCES)");
        }
        for s in SENTENCES { assert!(s.2.len() <= 100 && GROUPS.contains(&s.0), "{}", s.2); assert!(s.1 == "help" || crate::Cli::command().get_subcommands().any(|c| c.get_name() == s.1), "{} is not a command", s.1); }
    }
}

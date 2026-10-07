// The ticker: one line at the bottom of the server window that scrolls tips and live facts right to left, like an LED
// message board. Everything else scrolls above it: the terminal's scroll region is all lines but the last (DECSTBM),
// and the line is drawn with save cursor / move / print / restore cursor in one write, so it never splits a log line.
// It has no keys of its own (typed lines are commands or questions); ticker off/on hides or shows it.
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::time::{Duration, Instant};

static RUNNING: AtomicBool = AtomicBool::new(false);   // the thread exists
static ON: AtomicBool = AtomicBool::new(false);        // the user wants it (ticker on/off, setting)
static CHILD: AtomicBool = AtomicBool::new(false);     // a typed command runs and writes to the same terminal
static ROWS: AtomicU64 = AtomicU64::new(0);            // rows of the scroll region we set (0: none set)
static UTF8: AtomicBool = AtomicBool::new(true);       // the terminal shows symbols such as • (else ASCII)

/// What the line shows: the current messages (command sentences with live facts in between) and the scroll position.
#[derive(Default)]
struct Ui { current: Vec<String>, offset: usize }
static UI: std::sync::LazyLock<std::sync::Mutex<Ui>> = std::sync::LazyLock::new(Default::default);

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
/// The server window ready for typing: a big blinking cursor that is always shown, and (Windows console) QuickEdit on,
/// so text can be selected with the mouse and copied (Enter or right-click) and pasted (right-click or Ctrl+V).
#[cfg(windows)]
fn console_input() {
    use windows_sys::Win32::System::Console::{GetConsoleMode, GetStdHandle, SetConsoleMode, SetConsoleCursorInfo, CONSOLE_CURSOR_INFO,
        ENABLE_EXTENDED_FLAGS, ENABLE_INSERT_MODE, ENABLE_QUICK_EDIT_MODE, STD_ERROR_HANDLE, STD_INPUT_HANDLE};
    unsafe {
        let i = GetStdHandle(STD_INPUT_HANDLE);
        let mut mode = 0u32;
        if GetConsoleMode(i, &mut mode) != 0 { SetConsoleMode(i, mode | ENABLE_EXTENDED_FLAGS | ENABLE_QUICK_EDIT_MODE | ENABLE_INSERT_MODE); }
        let info = CONSOLE_CURSOR_INFO { dwSize: 100, bVisible: 1 };
        SetConsoleCursorInfo(GetStdHandle(STD_ERROR_HANDLE), &info);
    }
}
#[cfg(not(windows))]
fn console_input() {}
/// Before the screen (tui.rs) takes the window: escape sequences, UTF-8, QuickEdit and the cursor (Windows).
pub fn console_prepare() { console_input(); let _ = enable_vt(); }

/// The ticker's text for the screen, which draws it itself: refreshed every 5 s, one character further at each call.
pub struct Feed { dir: std::path::PathBuf, jobs: std::collections::HashMap<String, String>, msg: Vec<char>, offset: usize, last: Option<Instant> }
impl Feed {
    pub fn new(dir: std::path::PathBuf) -> Self { Feed { dir, jobs: Default::default(), msg: vec![], offset: 0, last: None } }
    pub fn next(&mut self, port: u16, width: usize) -> String {
        if self.last.map(|l| l.elapsed() > Duration::from_secs(5)).unwrap_or(true) {
            self.last = Some(Instant::now());
            let tips: Vec<String> = tips(port).into_iter().map(|x| x.1).collect();
            let items: Vec<String> = live(&self.dir, &mut self.jobs).into_iter().map(|x| x.0).collect();
            self.msg = rebuild(&Ui { current: interleave(&tips, &items, 4), offset: 0 });
            if self.offset >= self.msg.len() { self.offset = 0; }
        }
        self.offset = (self.offset + 1) % self.msg.len().max(1);
        window(&self.msg, self.offset, width)
    }
}
pub fn console_setup() {
    if !std::io::IsTerminal::is_terminal(&std::io::stderr()) { return; }
    console_input();
    // cursor shown, as a blinking block (DECSCUSR 1; terminals that do not know it ignore it)
    if enable_vt() { emit("\x1b[?25h\x1b[1 q"); }
}
/// The prompt of the server window, so it is always clear where typing goes.
pub fn prompt() { if std::io::IsTerminal::is_terminal(&std::io::stderr()) { emit(if enable_vt() { "\x1b[1;36msushila>\x1b[0m " } else { "sushila> " }); } }

/// A bar that fills as the download goes ("[#######.............]"); without a known size, stars that come and go.
pub fn bar(frac: Option<f64>, width: usize) -> String {
    let utf8 = UTF8.load(SeqCst);
    let (full, empty) = if utf8 { ('█', '░') } else { ('#', '.') };
    match frac {
        Some(f) => { let n = ((f.clamp(0.0, 1.0) * width as f64).round() as usize).min(width); format!("[{}{}]", full.to_string().repeat(n), empty.to_string().repeat(width - n)) }
        None => {
            // a group of stars that grows, travels and shrinks, one step every 0.3 s
            let t = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0) / 300) as usize;
            let k = t % (2 * width); let pos = if k < width { k } else { 2 * width - k - 1 };
            let len = 1 + (t / 3) % 5;
            format!("[{}]", (0..width).map(|i| if i + len > pos && i <= pos { '*' } else { ' ' }).collect::<String>())
        }
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
    !crate::tui::in_screen() && !json && !quiet && std::io::IsTerminal::is_terminal(&std::io::stderr()) && std::env::var("TERM").map(|t| t != "dumb").unwrap_or(true)
        && std::env::var("SUSHILA_TICKER").map(|v| v != "0" && v != "off").unwrap_or(true) && !off_setting(setting)
}
pub fn off_setting(v: &serde_json::Value) -> bool { v == "off" || *v == false }

fn emit(s: &str) { let mut e = std::io::stderr().lock(); let _ = e.write_all(s.as_bytes()); let _ = e.flush(); }

/// Sets the scroll region above the last line and keeps the cursor inside it.
fn setup(rows: usize) {
    // a newline first (only the first time), so whatever is on the last line moves up instead of being covered
    static FIRST: AtomicBool = AtomicBool::new(true);
    let nl = if FIRST.swap(false, SeqCst) { "\n" } else { "" };
    emit(&format!("{nl}\x1b7\x1b[1;{}r\x1b8\x1b[{};1H", rows - 1, rows - 1));
    ROWS.store(rows as u64, SeqCst);
}
/// A progress line rewritten in place (\r), cut to one row of this window: a line wider than the window wraps, every
/// rewrite then leaves a row behind, and under the ticker the wrapped part covers the ticker line.
pub fn progress(line: &str) {
    if crate::tui::in_screen() { eprint!("\r{line}"); return; }  // the screen fits it to the window
    match size() { Some((c, _)) if c > 10 => eprint!("\r{}", fit_middle(line, c - 2)), _ => eprint!("\r{line:<100}") }
}
/// Exactly `width` characters; a longer line loses its middle (the name), so the numbers at the end stay readable.
pub fn fit_middle(s: &str, width: usize) -> String {
    let c: Vec<char> = s.chars().collect();
    if c.len() <= width { return fit(s, width); }
    let head = (width / 3).min(c.len());
    c[..head].iter().chain(['…'].iter()).chain(c[c.len() - (width - head - 1)..].iter()).collect()
}
pub fn progress_clear() {
    if crate::tui::in_screen() { eprint!("\r"); return; }
    match size() { Some((c, _)) if c > 10 => eprint!("\r{}\r", " ".repeat(c - 2)), _ => eprint!("\r{:<100}\r", "") }
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
const SEP: &str = " • ";

/// One task-first sentence per command (several for commands with subcommands), grouped like the commands document;
/// {u} is this server's address. A unit test fails if a clap command has no sentence here.
pub const SENTENCES: [(&str, &str, &str); 71] = [
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
    ("Getting started", "help", "To see the important commands here: type ? (or man, or help)"),
    ("Getting started", "help", "To copy the last answer: type copy here (copy urls: the addresses; any text: select it, right-click)"),
    ("Running server and models", "stop", "To hide this line: type ticker off (ticker on shows it again)"),
    ("Housekeeping", "home", "To use another home folder: sushila home <folder> (takes effect at the next start)"),
    ("Getting started", "packs", "To see what fits this computer: sushila search --fits"),
];
#[allow(dead_code)]  // the groups of SENTENCES, checked by a test
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
/// The scrolling text of the current messages.
fn rebuild(ui: &Ui) -> Vec<char> {
    let sep = if UTF8.load(SeqCst) { SEP } else { " | " };
    ui.current.iter().flat_map(|m| m.chars().chain(sep.chars())).collect()
}

/// Starts the ticker thread (once). It moves about 9 characters a second and refreshes the live facts every 5 s.
pub fn start(dir: std::path::PathBuf, port: u16) {
    if !enable_vt() || RUNNING.swap(true, SeqCst) { return; }
    ON.store(true, SeqCst);
    std::thread::spawn(move || {
        let tips: Vec<String> = tips(port).into_iter().map(|x| x.1).collect();
        let mut jobs = Default::default();
        let mut last = Instant::now() - Duration::from_secs(60);
        let mut msg: Vec<char> = vec![];
        let (mut seen, mut again) = (0usize, Instant::now());
        loop {
            if last.elapsed() > Duration::from_secs(5) {
                last = Instant::now();
                // `sushila config set ticker off` while the server runs
                if off_setting(&crate::webserver::read_state(&dir)["settings"]["ticker"]) { ON.store(false, SeqCst); }
                let items = live(&dir, &mut jobs);
                let mut ui = UI.lock().unwrap();
                // the live items between the sentences, one every 4, so they come round every half minute or so
                ui.current = interleave(&tips, &items.into_iter().map(|x| x.0).collect::<Vec<_>>(), 4);
                msg = rebuild(&ui);
                if ui.offset >= msg.len() { ui.offset = 0; }
            }
            std::thread::sleep(Duration::from_millis(110));
            if !ON.load(SeqCst) { reset(); continue; }
            if CHILD.load(SeqCst) { continue; }
            let Some((cols, rows)) = size() else { continue };
            if cols < 40 || rows < 5 { reset(); continue; }
            // a new size must be read twice in a row (a window being dragged), then the region follows it
            if ROWS.load(SeqCst) != rows as u64 { if seen == rows { reset(); setup(rows); } else { seen = rows; continue; } }
            // every 2 s the scroll region is set again: a program that reset it (a password prompt, a child process)
            // would otherwise let the log run over the ticker line
            if again.elapsed() > Duration::from_secs(2) { again = Instant::now(); emit(&format!("\x1b7\x1b[1;{}r\x1b8", rows - 1)); }
            let text = { let mut ui = UI.lock().unwrap(); ui.offset = (ui.offset + 1) % msg.len().max(1); window(&msg, ui.offset, cols - 1) };
            // the cursor is hidden while the line is drawn and shown again where the typing is, so it never flickers
            emit(&format!("\x1b[?25l\x1b7\x1b[{rows};1H\x1b[7m{text}\x1b[0m\x1b8\x1b[?25h"));
        }
    });
}

/// `ticker on` / `ticker off` typed in the window.
pub fn set_on(on: bool) { ON.store(on, SeqCst); if !on { reset(); } }
/// While a typed command runs (it writes to the same terminal), the line stays still.
pub fn pause(p: bool) { CHILD.store(p, SeqCst); }
pub fn active() -> bool { RUNNING.load(SeqCst) }
/// Stops drawing and leaves the terminal clean (end of serve, errors, panics).
pub struct Guard;
impl Drop for Guard { fn drop(&mut self) { set_on(false); if RUNNING.load(SeqCst) { emit("\x1b[?25h\x1b[0 q"); } } }
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
        assert_eq!(fit_middle("abcdefghij 42%", 10), "abc…ij 42%");
        assert_eq!(bar(Some(0.5), 10).chars().filter(|&c| c == '█' || c == '#').count(), 5); assert_eq!(bar(None, 10).chars().count(), 12); assert_eq!(fit_middle("ab", 4), "ab  ");
    }
    #[test] fn joins() {
        let ui = Ui { current: vec!["live".into(), "tip".into()], offset: 0 };
        assert_eq!(rebuild(&ui).iter().collect::<String>(), format!("live{SEP}tip{SEP}"));
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

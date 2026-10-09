// sushila: Sushila.cpp from the command line, the same commands on Windows, macOS and Linux.
//
//   sushila engine install            Sushila.cpp for this computer's GPU (CUDA, Vulkan, Metal; CPU only as a fallback)
//   sushila packs                     the model packs in the catalog (installed ones marked)
//   sushila install <pack>|<file>     download (or take a .sushilapack file), check the Sushila signature and every sha256
//   sushila serve [<pack>...]         the inference page + OpenAI-compatible API on http://127.0.0.1:7874, models, the queue
//   sushila run <pack> "<prompt>"     one answer, picture, video or song, printed or saved (for scripts and tests)
//   sushila status | stop | list | verify | remove <pack> | service install | selftest
//   sushila doctor | bench | chat | assistant | search | show | ps | top | ...   (sushila --help lists them; cmds.rs)
//
// The web page it serves (web/sushila_page.js) is the whole user interface: inference, and managing this computer's
// Sushila (packs, engine, queue, logs) through the server, which alone changes anything (one source of truth).
mod net;
#[allow(dead_code)]
mod webserver;
mod core;
mod jobs;
mod util;
mod locate;
mod cmds;
mod assistant;
mod window;
mod ticker;
mod tui;
mod diag;
mod library;
mod share;
mod tunnel;

use std::{path::PathBuf, process::ExitCode, time::Duration};
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use crate::core::*;
use crate::util::*;

#[derive(Parser)]
#[command(name = "sushila", version = VERSION_LINE, about = "Sushila.cpp from the command line: the same commands on Windows, macOS and Linux",
          after_help = "Examples:\n  sushila install qwen3-4b-instruct-2507\n  sushila serve                      # then open http://127.0.0.1:7874\n  sushila run qwen2.5-0.5b-q4km \"Write a haiku about GPUs\"\n  sushila selftest                   # engine + smallest model + one answer: exit code 0 = works")]
struct Cli {
    /// Use this home folder for this command (default: the remembered home, see `sushila home`; or $SUSHILA_HOME)
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
    /// The model-packs folder (default: model-packs inside the home folder; or $SUSHILA_PACKS)
    #[arg(long, global = true)]
    packs_dir: Option<PathBuf>,
    /// Machine-readable JSON output
    #[arg(long, global = true)]
    json: bool,
    /// Less progress output
    #[arg(long, short, global = true)]
    quiet: bool,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Sushila.cpp itself: `engine install [--build cpu|vulkan|cuda]`, `engine info`
    Engine { #[command(subcommand)] act: EngineCmd },
    /// The model packs in the catalog
    Packs { /// also packs that do not fit this computer
        #[arg(long)] all: bool },
    /// Installed packs
    List,
    /// Install model packs: by id (sushila packs), from a .sushilapack/.zip file, your own .gguf file, or hf:<owner>/<repo>/<file>.gguf[@revision]
    Install { #[arg(required = true)] packs: Vec<String> },
    /// Remove an installed pack
    Remove { pack: String },
    /// Check installed packs file by file (sha256)
    Verify { pack: Option<String> },
    /// Serve the inference page and API, start models, run the queue (Ctrl+C or `sushila stop` to end)
    Serve {
        /// Packs to start now (default: the installed ones, up to --max)
        packs: Vec<String>,
        #[arg(long)] port: Option<u16>,
        /// 127.0.0.1 (this computer only, default) or 0.0.0.0 (the network: access keys required)
        #[arg(long)] host: Option<String>,
        /// Reachable from other machines and the internet (= --host 0.0.0.0): http://<this machine's IP>:<port>/; keys required unless --open
        #[arg(long)] public: bool,
        /// Standard mode (the plain model) instead of Accelerated
        #[arg(long)] standard: bool,
        /// Start at most this many installed packs when none are named
        #[arg(long, default_value_t = 1)] max: usize,
        /// With --host 0.0.0.0: anyone who can reach the port may chat and generate without a key (trusted networks only)
        #[arg(long)] open: bool,
    },
    /// One generation: text is printed; images, videos and songs are saved
    Run {
        pack: String,
        prompt: String,
        /// Output file (default: <pack>-<time>.<ext> here; text is printed)
        #[arg(long, short)] out: Option<PathBuf>,
        #[arg(long)] standard: bool,
        /// Image size, e.g. 1024x1024
        #[arg(long)] size: Option<String>,
        #[arg(long)] seed: Option<i64>,
        /// Music: lyrics ("[Instrumental]" or "[auto]"); the prompt is the style
        #[arg(long)] lyrics: Option<String>,
        /// Music: seconds; video: frames come from --frames
        #[arg(long)] duration: Option<f64>,
        /// Video: width x height and frames, e.g. 1280x704 and 121
        #[arg(long)] frames: Option<u32>,
        #[arg(long)] max_tokens: Option<u64>,
    },
    /// What is installed and running
    Status,
    /// Start a model in the running server: `sushila start <pack> [--standard]`
    Start { pack: String, #[arg(long)] standard: bool },
    /// Stop a model (`sushila stop <pack>`), or the whole server (`sushila stop`)
    Stop { pack: Option<String> },
    /// The shared log of every action (logs/sushila.log): `sushila logs [-f] [-n 40]`
    Logs { #[arg(short, long)] follow: bool, #[arg(short, default_value_t = 40)] n: usize },
    /// The addresses: Inference, Admin (this computer only), Documentation, the API, and the network address when shared
    Url,
    /// Access keys for other machines (when serving on the network): `keys add <name>`, `keys list`, `keys remove <name>`
    Keys { #[command(subcommand)] act: KeysCmd },
    /// Start `sushila serve` when the computer starts: `service install [--packs a,b] [--host 0.0.0.0]`, `service remove`
    Service { #[command(subcommand)] act: ServiceCmd },
    /// Sushila's home folder (model-packs, settings, logs, engine): `home` shows it and any other homes found,
    /// `home <folder>` makes that folder the home (replaces the remembered one), `home --reset` forgets it (search again)
    #[command(alias = "location")]
    Home { folder: Option<PathBuf>, #[arg(long)] reset: bool },
    /// End-to-end check: engine, the smallest model, one answer (exit code 0 = everything works)
    Selftest { /// default: the small default model (fast), or the 4B default model if it is already installed
        #[arg(long)] pack: Option<String> },
    /// Checks this computer: GPU, driver, engine build, disk, port, home folder, pack checksums (with the fix for each)
    Doctor,
    /// Speed on this computer, Standard vs Accelerated (tokens/s, or seconds per image/song/video); saved under <home>/bench/
    Bench { pack: String, #[arg(long)] prompt: Option<String>, #[arg(long, default_value_t = 3)] runs: usize,
            /// text: tokens per answer
            #[arg(long, default_value_t = 256)] max_tokens: u64 },
    /// Chat in the terminal (/exit ends, /clear forgets, /save <file> saves); default: the running or largest text pack
    Chat { pack: Option<String>, #[arg(long)] standard: bool },
    /// Ask Sushila how Sushila works (answers from its documentation): `assistant` (interactive) or `assistant "question"`
    Assistant { question: Option<String> },
    /// Finds packs in the catalog: `search <words> [--kind chat|code|image|music|video] [--fits]`
    Search { text: Option<String>, #[arg(long)] kind: Option<String>, #[arg(long)] fits: bool },
    /// Everything about a pack: files with sha256, license, size, what Accelerated does, installed or not
    Show { pack: String },
    /// A pack's license (name, link, and its license files)
    License { pack: String },
    /// Running models: mode, port, slots, uptime, memory, GPU memory
    Ps,
    /// Live view: running models, GPU use and memory, last tokens/s (Ctrl+C ends)
    Top { #[arg(long, default_value_t = 2)] interval: u64, /// print once and exit
          #[arg(long)] once: bool },
    /// Standard or Accelerated for a pack: switches it now if it runs, else at its next start
    Mode { pack: String, /// standard or accelerated
           mode: String },
    /// Unload models idle longer than this many minutes (they load again on the next request): `idle 30`, `idle off`
    Idle { minutes: String },
    /// Engine limits used at the next model start: `limit --threads N --parallel N --context N --gpu-layers N` (no flags: show)
    Limit { #[arg(long)] threads: Option<i64>, #[arg(long)] parallel: Option<i64>, #[arg(long)] context: Option<i64>, #[arg(long, allow_hyphen_values = true)] gpu_layers: Option<i64> },
    /// Settings: `config list`, `config get <key>`, `config set <key> <value>`; keys: port, enginePort, threads, contextSize, gpuLayers,
    /// parallel, idleMinutes, keepCopy, catalogUrl, ticker (on/off: the scrolling line at the bottom of the server window)
    Config { #[command(subcommand)] act: ConfigCmd },
    /// The background queue of the running server: `queue [list]`, `queue pause|resume [<id>]`, `queue cancel <id>`
    Queue { #[command(subcommand)] act: Option<QueueCmd> },
    /// Past queue jobs with prompt, settings, seed, time and output: `history`, `history show <id>`
    History { #[command(subcommand)] act: Option<HistoryCmd> },
    /// One prompt per line: `batch <pack> <prompts.txt> [--out <folder>]` writes each output and index.json
    Batch { pack: String, prompts: PathBuf, #[arg(long)] out: Option<PathBuf>, #[arg(long)] standard: bool },
    /// Watches a folder: each new .txt file is a prompt; the output is written next to it, the prompt renamed .txt.done
    Watch { folder: PathBuf, #[arg(long)] pack: Option<String>, /// handle the files there now and exit
            #[arg(long)] once: bool },
    /// Answers a question about a text, markdown or code file (long files are read in parts)
    Ask { file: PathBuf, question: String, #[arg(long)] pack: Option<String> },
    /// Embedding vector of a text (or a file) from a text pack (/v1/embeddings)
    Embed { pack: String, /// the text, or a file name
            input: String },
    /// Grade-school math accuracy (20 built-in questions) in Standard and Accelerated
    Eval { pack: String, #[arg(long, default_value_t = 20)] n: usize },
    /// A working API request for a pack: `example <pack> [curl|python|js]`
    Example { pack: String, lang: Option<String> },
    /// Opens the page in the browser: `open`, `open admin`, `open docs`, `open assistant`
    Open { page: Option<String> },
    /// Other machines: `share on [--open]` (serve on the network, keys needed unless --open), `share off`, `share qr` (QR code of the address)
    Share { #[command(subcommand)] act: ShareCmd },
    /// HTTPS for a domain: writes a Caddyfile (reverse proxy to this server) and prints the commands
    Https { domain: String },
    /// Newer signed engine and changed packs: `update --check` lists them, `update` installs them
    Update { #[arg(long)] check: bool },
    /// Removes leftovers: unfinished downloads, old engine versions, outputs of removed jobs (`--dry-run` only lists)
    Clean { #[arg(long)] dry_run: bool },
    /// Disk use per pack, engine, logs and outputs
    Du,
    /// A pack as one file for another computer: `export <pack> <file.zip|.tar|.sushilapack>`
    Export { pack: String, file: PathBuf },
    /// Installs an exported pack file (every file's sha256 is checked before anything is adopted)
    Import { file: PathBuf },
    /// Settings, access keys (hashes only) and queue history in one zip (never the packs)
    Backup { file: PathBuf },
    /// Restores a backup made with `sushila backup` (stop the server first)
    Restore { file: PathBuf },
    /// A zip for bug reports: versions, GPU, settings, recent log lines, crashes (no keys or tokens)
    Report { file: Option<PathBuf> },
    /// Versions of sushila and the engine; `--verify` prints this program's sha256 and checks it against a signed list
    Version { #[arg(long)] verify: bool },
    /// Shell completion: `completion bash|zsh|fish|powershell` (e.g. sushila completion bash > ~/.local/share/bash-completion/completions/sushila)
    Completion { shell: clap_complete::Shell },
    /// The commands that reproduce the paper's results: `reproduce` lists them, `reproduce <name>` prints one
    Reproduce { result: Option<String> },
    /// Converts a Hugging Face model (repo or folder) to GGUF with llama.cpp's converter and adds it as your own model
    Convert { source: String, #[arg(long)] out: Option<PathBuf>, /// f16, bf16, q8_0, f32 or auto
              #[arg(long, default_value = "q8_0")] outtype: String },
    /// EXPERIMENTAL: builds a text pack's precomputed landscape with the repository's day-0 pipeline (scripts/day0_landscape.sh)
    Precompute { pack: String },
    /// Removes the start-at-login service and the home pointer; `--all` also deletes the home folder (lists it and asks first)
    Uninstall { #[arg(long)] all: bool, #[arg(long)] yes: bool },
}
#[derive(Subcommand)]
enum EngineCmd { Install { /// cpu, vulkan, cuda, or a full key like linux-x86_64-vulkan
        #[arg(long)] build: Option<String> }, Info }
#[derive(Subcommand)]
enum KeysCmd { Add { name: String }, List, Remove { name: String } }
#[derive(Subcommand)]
enum QueueCmd { List, Pause { id: Option<String> }, Resume { id: Option<String> }, Cancel { id: String } }
#[derive(Subcommand)]
enum ConfigCmd { List, Get { key: String }, Set { key: String, #[arg(allow_hyphen_values = true)] value: String } }
#[derive(Subcommand)]
enum HistoryCmd { Show { id: String } }
#[derive(Subcommand)]
enum ShareCmd { On { /// no access key needed (trusted networks only)
        #[arg(long)] open: bool }, Off, Qr }
#[derive(Subcommand)]
enum ServiceCmd { Install { #[arg(long)] packs: Option<String>, #[arg(long)] host: Option<String>, #[arg(long)] port: Option<u16>, #[arg(long)] public: bool }, Remove }

#[tokio::main]
async fn main() -> ExitCode {
    let _ = net::AGENT.set(format!("sushila/{}", env!("CARGO_PKG_VERSION")));
    // sushila://start (the page's Start button, a bookmark): opened like a double-click
    let mut argv: Vec<String> = std::env::args().collect();
    if argv.get(1).map(|a| a.to_ascii_lowercase().starts_with("sushila://")).unwrap_or(false) { argv.truncate(1); }
    let mut cli = Cli::parse_from(argv);
    // started without a command (e.g. double-clicked in Explorer or Finder): serve, and open the page in the browser
    let double_click = cli.cmd.is_none();
    // no command (double-click): serve. Both the supervisor and its worker child (SUSHILA_WORKER=1, started with the same
    // empty arguments) must turn "no command" into `serve`, or the worker finds no command and crashes in a loop
    if double_click {
        if std::env::var("SUSHILA_WORKER").is_err() {
            eprintln!("Sushila {}: starting the server; the page opens in your browser. Close this window (or Ctrl+C) to stop.\nCommands: sushila --help", env!("CARGO_PKG_VERSION"));
        }
        cli.cmd = Some(Cmd::Serve { packs: vec![], port: None, host: None, public: false, standard: false, max: 1, open: false });
    }
    // double-click: the worker opens the browser once its server answers (serve() knows the real port; see SUSHILA_DOUBLE_CLICK)
    if double_click && std::env::var("SUSHILA_WORKER").is_err() { std::env::set_var("SUSHILA_DOUBLE_CLICK", "1"); }
    // the application folder: explicit, remembered, or found by searching (asks when several exist); the worker child
    // of `serve` gets it through SUSHILA_HOME, so it is never asked twice
    // `location <folder>` / `location --reset` change the choice itself, so they run before any search or question
    if let Some(Cmd::Home { folder, reset }) = &cli.cmd {
        if *reset { locate::forget(); println!("forgotten: the next start searches again (and asks if it finds several)"); return ExitCode::SUCCESS; }
        if let Some(f) = folder {
            let f = std::path::absolute(f).unwrap_or(f.clone());
            if let Err(e) = std::fs::create_dir_all(&f) { eprintln!("error: {e}"); return ExitCode::from(1); }
            locate::remember(&f);
            println!("Sushila now uses {} (the remembered home is replaced; it takes effect at the next start, so stop a running server first: `sushila stop`)", locate::describe(&f));
            return ExitCode::SUCCESS;
        }
    }
    let explicit_home = cli.data_dir.is_some() || std::env::var("SUSHILA_HOME").map(|h| !h.is_empty()).unwrap_or(false);
    let (data, warning) = locate::resolve(cli.data_dir.clone());
    // the server starting from the old roaming home (before build 27) moves it to the new place, once
    let data = if !explicit_home && matches!(cli.cmd, Some(Cmd::Serve { .. })) && std::env::var("SUSHILA_WORKER").is_err() { locate::move_legacy_home(data) } else { data };
    if let Some(w) = &warning { if !cli.quiet { eprintln!("note: {w}"); } }
    std::env::set_var("SUSHILA_HOME", &data);
    if let Some(p) = &cli.packs_dir { std::env::set_var("SUSHILA_PACKS", std::path::absolute(p).unwrap_or(p.clone())); }
    // `sushila serve` is a small supervisor: the real server runs as its child (SUSHILA_WORKER=1) and is restarted at
    // once if it crashes; why it crashed goes to crashes.json and the log (Admin tab -> Logs).
    if matches!(cli.cmd, Some(Cmd::Serve { .. })) && std::env::var("SUSHILA_WORKER").is_err() {
        return supervise(data, cli.quiet).await;
    }
    if std::env::var("SUSHILA_WORKER").is_ok() {
        if !tui::in_screen() { name_own_console(); }
        let panic_file = data.join("logs").join("panic.txt");
        std::panic::set_hook(Box::new(move |info| {
            let bt = std::backtrace::Backtrace::force_capture();
            let _ = std::fs::write(&panic_file, format!("{info}\n\n{bt}"));
            ticker::set_on(false);
            eprintln!("sushila crashed: {info}");
        }));
    }
    let mut ctx = match Ctx::load(data, cli.quiet) { Ok(c) => c, Err(e) => { eprintln!("error: {e}"); return ExitCode::from(1); } };
    match dispatch(&cli, &mut ctx).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            if cli.json { println!("{}", json!({ "ok": false, "error": e })); } else { eprintln!("error: {e}"); }
            // a serve worker that failed before it was serving (engine download, port busy): the supervisor must not retry
            if std::env::var("SUSHILA_WORKER").is_ok() && !SERVING.load(std::sync::atomic::Ordering::SeqCst) { ExitCode::from(START_FAILED) } else { ExitCode::from(1) }
        }
    }
}

/// The test-build number (shown by /health): Sushila Station replaces a running engine older than the one it carries.
pub const BUILD: u32 = 30;
/// `sushila --version`: "0.1.1 (build 30)" (keep the number equal to BUILD; Station reads it)
const VERSION_LINE: &str = concat!(env!("CARGO_PKG_VERSION"), " (build 30)");

/// Exit code of a serve worker that could not start (the error is printed); set once the web server listens.
const START_FAILED: u8 = 3;
static SERVING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Double-click: the window closes when the program ends, so keep it open until the person has read the message.
fn hold_window() {
    if std::env::var("SUSHILA_DOUBLE_CLICK").is_ok() && std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        eprint!("\nPress Enter to close this window. ");
        let mut l = String::new(); let _ = std::io::stdin().read_line(&mut l);
    }
}

/// Runs `sushila serve` as a child and restarts it when it crashes (not when it stops normally: `sushila stop`, Ctrl+C).
/// A start-up error (port busy, another server owns the folder) is reported, not retried.
async fn supervise(data: PathBuf, quiet: bool) -> ExitCode {
    let exe = match std::env::current_exe() { Ok(e) => e, Err(e) => { eprintln!("error: {e}"); return ExitCode::from(1); } };
    let args: Vec<String> = std::env::args().skip(1).collect();
    let _ = std::fs::create_dir_all(data.join("logs"));
    let _ = core::LOG_FILE.set(data.join("logs").join("sushila.log")); let _ = core::SOURCE.set("supervisor".into());
    let stopping = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    { let s = stopping.clone(); tokio::spawn(async move { loop { if tokio::signal::ctrl_c().await.is_err() { return; } s.store(true, std::sync::atomic::Ordering::SeqCst); } }); }
    // a terminal: the screen (tui.rs) draws the window and runs the server under it
    if tui::wanted(quiet) { if let Some(code) = tui::supervise(data.clone(), exe.clone(), args.clone()) { return code; } }
    let mut recent: Vec<std::time::Instant> = vec![];
    let mut restarts = 0u32;
    loop {
        let t0 = std::time::Instant::now();
        let mut c = tokio::process::Command::new(&exe);
        c.args(&args).env("SUSHILA_WORKER", "1");
        if !has_console_window() { hidden_async(&mut c); }  // started without a terminal (Sushila Station): no window
        if restarts > 0 { c.env("SUSHILA_NO_BROWSER", "1").env_remove("SUSHILA_TEST_PANIC_AFTER"); }
        let status = match c.status().await { Ok(s) => s, Err(e) => { eprintln!("error: could not start the server: {e}"); return ExitCode::from(1); } };
        let up = t0.elapsed();
        // a server that died (killed, crashed) could not reset its ticker line: done here
        if !status.success() && ticker::wanted(false, quiet, &read_json(&data.join("state.json")).map(|s| s["settings"]["ticker"].clone()).unwrap_or_default()) { ticker::hard_reset(); }
        if status.success() || stopping.load(std::sync::atomic::Ordering::SeqCst) { return ExitCode::SUCCESS; }
        // did not start (engine download failed, port busy...): the error is already printed; retrying would loop
        if status.code() == Some(START_FAILED as i32) || (restarts == 0 && up < Duration::from_secs(8) && status.code() == Some(1)) {
            eprintln!("Sushila did not start. Fix the problem above and start it again (downloads resume where they stopped).");
            hold_window(); return ExitCode::from(1);
        }
        let msg = server_crashed(&data, &status, up);
        recent.retain(|t| t.elapsed() < Duration::from_secs(300)); recent.push(std::time::Instant::now());
        let wait = if recent.len() > 5 { 60 } else { 1 };
        core::log(quiet, &format!("{msg}; restarting in {wait} s (details: Admin tab -> Logs -> Crashes)"));
        restarts += 1;
        for _ in 0..wait * 10 { if stopping.load(std::sync::atomic::Ordering::SeqCst) { return ExitCode::SUCCESS; } tokio::time::sleep(Duration::from_millis(100)).await; }
    }
}

/// Windows: sushila:// links start this program (the page's "Start Sushila" button when the server is down). Written
/// for this user only (HKEY_CURRENT_USER, no administrator rights), pointing at this exe; nothing on other systems.
fn register_link() {
    #[cfg(windows)]
    {
        let Ok(exe) = std::env::current_exe() else { return };
        let exe = exe.to_string_lossy().to_string();
        let run = |args: &[&str]| { let _ = hidden(&mut std::process::Command::new("reg")).args(args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status(); };
        run(&["add", r"HKCU\Software\Classes\sushila", "/ve", "/d", "URL:Sushila", "/f"]);
        run(&["add", r"HKCU\Software\Classes\sushila", "/v", "URL Protocol", "/d", "", "/f"]);
        run(&["add", r"HKCU\Software\Classes\sushila\shell\open\command", "/ve", "/d", &format!("\"{exe}\" \"%1\""), "/f"]);
    }
}

/// After the server stopped unexpectedly: why (exit code, signal, panic) goes to crashes.json, engines it left are
/// stopped; returns the message for the window.
fn server_crashed(data: &std::path::Path, status: &std::process::ExitStatus, up: Duration) -> String {
    let reason = match status.code() { Some(c) => format!("exit code {c}"), None => "stopped by the operating system".into() };
    #[cfg(unix)]
    let reason = { use std::os::unix::process::ExitStatusExt; match status.signal() { Some(sig) => format!("killed by signal {sig}{}", match sig { 9 => " (SIGKILL: often out of memory)", 11 => " (SIGSEGV: memory fault)", 6 => " (SIGABRT)", _ => "" }), None => reason } };
    let pf = data.join("logs").join("panic.txt");
    let panic = std::fs::read_to_string(&pf).ok().filter(|_| std::fs::metadata(&pf).and_then(|m| m.modified()).map(|m| m.elapsed().map(|e| e <= up + Duration::from_secs(2)).unwrap_or(false)).unwrap_or(false));
    let _ = std::fs::remove_file(&pf);
    let killed = core::kill_orphans(data);
    core::record_crash(data, json!({ "time": now_iso(), "what": "server", "reason": reason, "panic": panic.as_deref().map(|p| p.chars().take(4000).collect::<String>()),
        "uptimeSeconds": up.as_secs(), "logTail": core::tail_lines(&data.join("logs").join("sushila.log"), 30), "stoppedEngines": killed }));
    format!("the server stopped unexpectedly ({reason}{})", panic.as_deref().map(|p| format!(": {}", p.lines().next().unwrap_or(""))).unwrap_or_default())
}

fn out(json_mode: bool, v: Value, text: impl FnOnce() -> String) {
    if json_mode { println!("{}", serde_json::to_string_pretty(&v).unwrap()); } else { println!("{}", text()); }
}

/// The running server on this computer (the owner), if any: its port.
async fn owner_port(ctx: &Ctx) -> Option<u16> {
    let port = ctx.setting("port").as_u64().unwrap_or(7874) as u16;
    http_text(&format!("http://127.0.0.1:{port}/api/state"), 2).await.ok().map(|_| port)
}
/// Sends a request to the owner and follows it to the end (progress on stderr). The same path the page's Admin tab uses.
async fn remote(ctx: &Ctx, port: u16, body: Value) -> Result<(), String> {
    let token = ctx.state["token"].as_str().unwrap_or("").to_string();
    let c = reqwest::Client::new();
    let r = c.post(format!("http://127.0.0.1:{port}/api/control")).header("x-sushila-token", &token).header("x-sushila-admin", webserver::cli_token(&ctx.data)).json(&body).send().await.map_err(err)?;
    if !r.status().is_success() { return Err(format!("the server refused: {} {}", r.status(), r.text().await.unwrap_or_default())); }
    let id = r.json::<Value>().await.map_err(err)?["id"].as_str().unwrap_or("").to_string();
    if !ctx.quiet { eprintln!("sent to the running server ({}): task {id}", format!("http://127.0.0.1:{port}")); }
    let tty = std::io::IsTerminal::is_terminal(&std::io::stderr()) || tui::in_screen();
    let mut unseen = 0;  // a task the server never shows (lost, or the server restarted): give up after about a minute
    loop {
        tokio::time::sleep(Duration::from_millis(700)).await;
        let st: Value = match c.get(format!("http://127.0.0.1:{port}/api/state")).timeout(Duration::from_secs(10)).send().await { Ok(r) => r.json().await.unwrap_or(Value::Null), Err(_) => Value::Null };
        let Some(t) = st["tasks"].as_array().and_then(|a| a.iter().find(|t| t["id"] == id.as_str())).cloned() else {
            unseen += 1;
            if unseen > 85 { return Err(format!("the server no longer reports task {id} (it may have restarted); check with `sushila status`")); }
            continue
        };
        unseen = 0;
        match t["status"].as_str() {
            Some("done") => { if tty && !ctx.quiet { crate::ticker::progress_clear(); } return Ok(()); }
            Some("failed") => { if tty && !ctx.quiet { eprintln!(); } return Err(t["error"].as_str().unwrap_or("failed").to_string()); }
            // under the server window's screen the server shows its own bar for this task
            _ => if !ctx.quiet && !tui::in_screen() && t["total"].as_u64().unwrap_or(0) > 0 {
                let f = t["done"].as_f64().unwrap_or(0.0) / t["total"].as_f64().unwrap_or(1.0);
                let line = format!("  {}: {} {:.1}% of {}", t["label"].as_str().unwrap_or(""), crate::ticker::bar(Some(f), 20), 100.0 * f, human(t["total"].as_u64().unwrap_or(0)));
                if tty { crate::ticker::progress(&line); }
            },
        }
    }
}
/// Local changes (no server running) hold the owner lock, so a server cannot start in the middle of them.
fn local_lock(ctx: &Ctx) -> Result<std::fs::File, String> {
    let f = std::fs::OpenOptions::new().create(true).write(true).open(ctx.data.join("owner.lock")).map_err(err)?;
    f.try_lock().map_err(|_| "a server owns this data folder but is not answering; try again in a moment (`sushila status`)".to_string())?;
    Ok(f)
}

async fn dispatch(cli: &Cli, ctx: &mut Ctx) -> Result<(), String> {
    let j = cli.json;
    // one source of truth: while a server runs, changes go through it
    if let Some(port) = owner_port(ctx).await {
        let body = match cli.cmd.as_ref().unwrap() {
            Cmd::Engine { act: EngineCmd::Install { build } } => Some(json!({ "action": "engine-install", "build": build })),
            Cmd::Install { packs } if packs.len() == 1 && packs[0].starts_with("hf:") => Some(json!({ "action": "install-hf", "spec": packs[0] })),
            Cmd::Install { packs } if packs.len() == 1 => Some(if packs[0].ends_with(".sushilapack") || PathBuf::from(&packs[0]).is_file()
                { json!({ "action": "install-file", "path": std::fs::canonicalize(&packs[0]).map_err(err)?.to_string_lossy() }) } else { json!({ "action": "install", "pack": packs[0] }) }),
            Cmd::Remove { pack } => Some(json!({ "action": "remove", "pack": pack })),
            Cmd::Start { pack, standard } => Some(json!({ "action": "start", "pack": pack, "mode": if *standard { json!("regular") } else { Value::Null } })),
            Cmd::Stop { pack: Some(p) } => Some(json!({ "action": "stop", "pack": p })),
            _ => None,
        };
        if let Some(Cmd::Install { packs }) = &cli.cmd { if packs.len() > 1 {
            for p in packs { remote(ctx, port, json!({ "action": "install", "pack": p, "source": "cli" })).await?; }
            out(j, json!({ "ok": true, "installed": packs }), || format!("installed: {}", packs.join(", "))); return Ok(());
        } }
        if let Some(mut b) = body {
            b["source"] = json!("cli");
            remote(ctx, port, b).await?;
            out(j, json!({ "ok": true }), || "done".into());
            return Ok(());
        }
    } else if matches!(cli.cmd.as_ref().unwrap(), Cmd::Engine { act: EngineCmd::Install { .. } } | Cmd::Install { .. } | Cmd::Remove { .. }) {
        let _lock = local_lock(ctx)?;
        return local(cli, ctx).await;
    } else if matches!(cli.cmd.as_ref().unwrap(), Cmd::Start { .. }) {
        return Err("no server is running: start one with `sushila serve <pack>`".into());
    }
    local(cli, ctx).await
}

async fn local(cli: &Cli, ctx: &mut Ctx) -> Result<(), String> {
    let j = cli.json;
    match cli.cmd.as_ref().unwrap() {
        Cmd::Engine { act: EngineCmd::Install { build } } => {
            ctx.load_catalog().await?;
            let key = build.as_ref().map(|b| { let pk = ctx.platform_key(); match b.as_str() { "cpu" => pk, "vulkan" | "cuda" => format!("{pk}-{b}"), k => k.to_string() } });
            ctx.install_engine(key).await?;
            out(j, ctx.state["engine"].clone(), || format!("Sushila.cpp {} ({}) in {}", ctx.state["engine"]["version"].as_str().unwrap_or(""), Ctx::gpu_label(ctx.state["engine"]["key"].as_str().unwrap_or("")), ctx.state["engine"]["dir"].as_str().unwrap_or("")));
        }
        Cmd::Engine { act: EngineCmd::Info } => {
            let gpu = ctx.nvidia_gpu().await; let other = ctx.other_gpu().await;
            let v = json!({ "sushila": env!("CARGO_PKG_VERSION"), "engine": ctx.state["engine"], "platform": ctx.platform_key(), "nvidia": gpu, "otherGpu": other, "otherGpuMemoryGB": ctx.other_gpu_memory_gb().await, "dataDir": ctx.data.to_string_lossy(), "packsDir": ctx.packs_dir.to_string_lossy(), "cpus": ctx.info["cpus"], "memory": ctx.info["memory_bytes"] });
            out(j, v.clone(), || {
                let e = &ctx.state["engine"];
                format!("sushila {}\nengine:   {}\nplatform: {}\nGPU:      {}\ndata:     {}\npacks:    {}  (drop pack folders here)",
                    env!("CARGO_PKG_VERSION"),
                    if e.is_object() { format!("Sushila.cpp {} ({}) {}", e["version"].as_str().unwrap_or(""), Ctx::gpu_label(e["key"].as_str().unwrap_or("")), e["dir"].as_str().unwrap_or("")) } else { "not installed (sushila engine install)".into() },
                    ctx.platform_key(),
                    gpu.map(|g| format!("{} ({} GB, compute {})", g["name"].as_str().unwrap_or(""), g["memoryGB"], g["compute"])).or(other).unwrap_or_else(|| "none found (CPU)".into()),
                    ctx.data.display(), ctx.packs_dir.display())
            });
        }
        Cmd::Packs { all } => {
            ctx.load_catalog().await?;
            let packs = ctx.catalog.as_ref().unwrap()["packs"].as_array().cloned().unwrap_or_default();
            let mut rows = vec![];
            for p in packs.iter().filter(|p| p["hidden"] != true) {
                let fits = ctx.pack_fits(p).await;
                if !fits && !*all { continue; }
                let bytes: u64 = p["files"].as_array().map(|a| a.iter().map(|f| f["bytes"].as_u64().unwrap_or(0)).sum()).unwrap_or(0);
                let id = p["id"].as_str().unwrap_or("");
                rows.push(json!({ "id": id, "name": p["name"], "kind": p.get("kind").cloned().unwrap_or(json!("text")), "bytes": bytes, "installed": ctx.packs().contains_key(id), "fits": fits, "license": p["license"] }));
            }
            out(j, json!(rows), || {
                let mut s = format!("{:<34} {:<6} {:>8}  {}\n", "PACK", "KIND", "SIZE", "NAME");
                for r in &rows { s += &format!("{:<34} {:<6} {:>8}  {}{}{}\n", r["id"].as_str().unwrap_or(""), r["kind"].as_str().unwrap_or(""), human(r["bytes"].as_u64().unwrap_or(0)), r["name"].as_str().unwrap_or(""),
                    if r["installed"] == true { "  [installed]" } else { "" }, if r["fits"] == false { "  [needs other hardware]" } else { "" }); }
                s + "\nInstall with: sushila install <pack>"
            });
        }
        Cmd::List => {
            let rows: Vec<Value> = ctx.packs().values().map(|p| json!({ "id": p["id"], "name": p["name"], "kind": p["kind"], "bytes": p["bytes"], "dir": p["dir"], "accelerated": can_turbo(p) })).collect();
            out(j, json!(rows), || if rows.is_empty() { "No packs installed. See `sushila packs`.".into() } else {
                rows.iter().map(|r| format!("{:<34} {:<6} {:>8}  {}{}", r["id"].as_str().unwrap_or(""), r["kind"].as_str().unwrap_or(""), human(r["bytes"].as_u64().unwrap_or(0)), r["name"].as_str().unwrap_or(""), if r["accelerated"] == true { "  (Accelerated available)" } else { "" })).collect::<Vec<_>>().join("\n") });
        }
        Cmd::Install { packs } => {
            let mut done = vec![];
            for p in packs {
                let path = PathBuf::from(p);
                if p.starts_with("hf:") {
                    if !ctx.engine_ok() { ctx.install_engine(None).await?; }
                    let d = core::download_hf_gguf(&ctx.packs_dir, p, ctx.quiet, None).await?;
                    done.push(ctx.adopt_folder_now(&d).await?);
                } else if path.is_file() && p.to_lowercase().ends_with(".gguf") {
                    if !ctx.engine_ok() { ctx.install_engine(None).await?; }
                    let d = ctx.take_gguf(&path)?;
                    done.push(ctx.adopt_folder_now(&d).await?);
                } else if p.ends_with(".sushilapack") || path.is_file() { done.push(ctx.install_pack_file(&path).await?); }
                else { ctx.load_catalog().await?; let id = ctx.best_variant(p).await; ctx.install_pack(&id).await?; done.push(id); }
            }
            out(j, json!({ "ok": true, "installed": done }), || format!("installed: {}\nNext: sushila serve   (or: sushila run {} \"Hello\")", done.join(", "), done[0]));
        }
        Cmd::Remove { pack } => { ctx.remove_pack(pack)?; out(j, json!({ "ok": true }), || format!("{pack} removed")); }
        Cmd::Verify { pack } => {
            let ids: Vec<String> = match pack { Some(p) => vec![p.clone()], None => ctx.packs().keys().cloned().collect() };
            let mut bad_all = json!({});
            for id in &ids { let bad = ctx.verify_pack(id)?; if !bad.is_empty() { bad_all[id] = json!(bad); } if !j { println!("{id}: {}", if bad.is_empty() { "ok (every file matches its sha256)".into() } else { format!("PROBLEM: {}", bad.join(", ")) }); } }
            if j { println!("{}", json!({ "ok": bad_all.as_object().unwrap().is_empty(), "problems": bad_all })); }
            if !bad_all.as_object().unwrap().is_empty() { return Err("some files are missing or changed: install the pack again".into()); }
        }
        Cmd::Status => {
            let st = ctx.state.clone();
            let mut running = vec![];
            for (id, r) in st["running"].as_object().cloned().unwrap_or_default() {
                let port = r["port"].as_u64().unwrap_or(0);
                let up = http_text(&format!("http://127.0.0.1:{port}/health"), 2).await.is_ok() || http_text(&format!("http://127.0.0.1:{port}/"), 2).await.is_ok();
                running.push(json!({ "id": id, "port": port, "mode": r["mode"], "up": up }));
            }
            let port = ctx.setting("port").as_u64().unwrap_or(7874);
            let serving = http_text(&format!("http://127.0.0.1:{port}/api/state"), 2).await.is_ok();
            let v = json!({ "engine": st["engine"], "packs": ctx.packs().keys().collect::<Vec<_>>(), "running": running, "serving": serving, "page": format!("http://127.0.0.1:{port}/"), "dataDir": ctx.data.to_string_lossy() });
            out(j, v.clone(), || format!("engine:  {}\npacks:   {}\nserving: {}\nrunning: {}",
                if st["engine"].is_object() { format!("Sushila.cpp {} ({})", st["engine"]["version"].as_str().unwrap_or(""), Ctx::gpu_label(st["engine"]["key"].as_str().unwrap_or(""))) } else { "not installed".into() },
                v["packs"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).filter(|s| !s.is_empty()).unwrap_or("none".into()),
                if serving { format!("yes, http://127.0.0.1:{port}/") } else { "no (sushila serve)".into() },
                if running.is_empty() { "nothing".into() } else { running.iter().map(|r| format!("{} on port {} ({}{})", r["id"].as_str().unwrap_or(""), r["port"], if r["mode"] == "turbo" { "Accelerated" } else { "Standard" }, if r["up"] == true { "" } else { ", not answering" })).collect::<Vec<_>>().join("; ") }));
        }
        Cmd::Start { .. } | Cmd::Stop { pack: Some(_) } => return Err("no server is running (`sushila serve`)".into()),
        Cmd::Logs { follow, n } => {
            let p = ctx.data.join("logs").join("sushila.log");
            let text = std::fs::read_to_string(&p).unwrap_or_default();
            let lines: Vec<&str> = text.lines().collect();
            for l in &lines[lines.len().saturating_sub(*n)..] { println!("{l}"); }
            if *follow { let mut off = text.len(); loop { tokio::time::sleep(Duration::from_millis(500)).await; let t = std::fs::read(&p).unwrap_or_default(); if t.len() > off { print!("{}", String::from_utf8_lossy(&t[off..])); off = t.len(); } else if t.len() < off { off = 0; } } }
        }
        Cmd::Stop { pack: None } => {
            let port = ctx.setting("port").as_u64().unwrap_or(7874);
            let token = ctx.state["token"].as_str().unwrap_or("").to_string();
            let r = reqwest::Client::new().post(format!("http://127.0.0.1:{port}/api/shutdown")).header("x-sushila-token", token).header("x-sushila-admin", webserver::cli_token(&ctx.data)).send().await;
            match r { Ok(r) if r.status().is_success() => out(j, json!({ "ok": true }), || "stopping sushila serve".into()),
                      _ => { std::fs::write(ctx.data.join("shutdown-request.json"), "{}").map_err(err)?; out(j, json!({ "ok": true, "note": "no server answered; a stop request was left for it" }), || "no server answered on this computer".into()) } }
        }
        Cmd::Url => {
            let port = ctx.setting("port").as_u64().unwrap_or(7874);
            let network = ctx.state["share"]["enabled"].as_bool().unwrap_or(false);
            let u = urls(port as u16, network);
            out(j, json!({ "url": u["inference"], "urls": u }), || url_banner(&u).replace(" is running", "").replace(" Type a command (e.g. install, ps, status), a question, or ? for help. Stop: Ctrl+C, type stop, or close this window\n", "").replace(" Copy: select with the mouse, then right-click (or Enter); paste: right-click or Ctrl+V; copy = copy the last answer\n", ""));
        }
        Cmd::Keys { act } => keys(ctx, act, j).await?,
        Cmd::Home { .. } => {
            let others: Vec<String> = locate::candidates().into_iter().filter(|p| std::fs::canonicalize(p).ok() != std::fs::canonicalize(&ctx.data).ok()).map(|p| locate::describe(&p)).collect();
            out(j, json!({ "home": ctx.data.to_string_lossy(), "dataDir": ctx.data.to_string_lossy(), "packsDir": ctx.packs_dir.to_string_lossy(), "remembered": locate::pointer_file().filter(|f| f.is_file()).map(|f| f.to_string_lossy().to_string()), "others": others }),
                || format!("home: {}\nmodel packs: {}\nremembered in: {}{}", locate::describe(&ctx.data), ctx.packs_dir.display(), locate::pointer_file().map(|f| f.display().to_string()).unwrap_or_default(),
                    if others.is_empty() { String::new() } else { format!("\nother Sushila folders found:\n  {}\nmake one of them the home: `sushila home <folder>`", others.join("\n  ")) }));
        }
        Cmd::Service { act } => service(ctx, act, j)?,
        Cmd::Run { pack, prompt, out: file, standard, size, seed, lyrics, duration, frames, max_tokens } => {
            let p = ctx.packs().get(pack).cloned().ok_or(format!("{pack} is not installed: sushila install {pack}"))?;
            let kind = p["kind"].as_str().unwrap_or("text").to_string();
            let mut params = json!({ "prompt": prompt });
            if let Some(s) = size { params["size"] = json!(s); if kind == "video" { if let Some((w, h)) = s.split_once('x') { params["width"] = json!(w.parse::<u32>().unwrap_or(832)); params["height"] = json!(h.parse::<u32>().unwrap_or(480)); } } }
            if let Some(s) = seed { params["seed"] = json!(s); }
            if kind == "music" { params["style"] = json!(prompt); params["lyrics"] = json!(lyrics.clone().unwrap_or("[Instrumental]".into())); params["duration"] = json!(duration.unwrap_or(60.0)); }
            if let Some(f) = frames { params["video_frames"] = json!(f); }
            if let Some(m) = max_tokens { params["max_tokens"] = json!(m); }
            let existing = ctx.state["running"][pack]["port"].as_u64();
            let port = match existing { Some(p) if http_text(&format!("http://127.0.0.1:{p}/health"), 2).await.is_ok() => p as u16,
                                        _ => { ctx.state["running"].as_object_mut().unwrap().remove(pack.as_str()); ctx.start_model(pack, Some(if *standard { "regular" } else { if can_turbo(&p) { "turbo" } else { "regular" } })).await? } };
            let accel = if !*standard { turbo_request(&p) } else { None };
            let t0 = std::time::Instant::now();
            let quiet = ctx.quiet;
            let res = jobs::run(&kind, pack, port, &params, accel, |what| { if !quiet { eprint!("\r  {what}… {} s   ", t0.elapsed().as_secs()); } }).await;
            if !quiet { eprintln!(); }
            if existing.is_none() { ctx.stop_model(pack).await; }
            let o = res?;
            let secs = t0.elapsed().as_secs_f64();
            if kind == "text" && file.is_none() {
                let text = String::from_utf8_lossy(&o.bytes).to_string();
                out(j, json!({ "ok": true, "text": text, "seconds": secs }), || text.clone());
            } else {
                let path = file.clone().unwrap_or_else(|| PathBuf::from(format!("{pack}-{}.{}", now_iso().replace([':', '-'], "").replace('T', "-").trim_end_matches('Z'), o.ext)));
                std::fs::write(&path, &o.bytes).map_err(err)?;
                out(j, json!({ "ok": true, "file": path.to_string_lossy(), "bytes": o.bytes.len(), "mime": o.mime, "seconds": secs }), || format!("saved {} ({}, {:.1} s)", path.display(), human(o.bytes.len() as u64), secs));
            }
        }
        Cmd::Serve { packs, port, host, public, standard, max, open } => serve(ctx, packs, *port, if *public { Some("0.0.0.0".into()) } else { host.clone() }, *standard, *max, *open, j).await?,
        Cmd::Selftest { pack } => {
            let pack = &pack.clone().unwrap_or_else(|| if ctx.packs().contains_key(BIGGER_DEFAULT) { BIGGER_DEFAULT.into() } else { DEFAULT_MODEL.into() });
            let t0 = std::time::Instant::now();
            let mut steps: Vec<String> = vec![];
            ctx.load_catalog().await?; steps.push("catalog reachable and parsed".into());
            if !ctx.engine_ok() { ctx.install_engine(None).await?; }
            steps.push("engine installed (signed build, sha256 checked)".into());
            ctx.install_pack(pack).await?; steps.push("pack installed (signed index, every sha256 checked)".into());
            let bad = ctx.verify_pack(pack)?; if !bad.is_empty() { return Err(format!("verify: {}", bad.join(", "))); }
            steps.push("pack verified".into());
            std::env::set_var("SUSHILA_ENGINE_LOG_LEVEL", "4");  // so the GPU check below can read "offloaded N/M layers to GPU"
            ctx.stop_model(pack).await;
            let port = ctx.start_model(pack, None).await?; steps.push("model started and healthy".into());
            let t1 = std::time::Instant::now();
            let r = jobs::run("text", pack, port, &json!({ "prompt": "Reply with one word: hello", "max_tokens": 32, "temperature": 0 }), None, |_| {}).await;
            let gen_s = t1.elapsed().as_secs_f64();
            ctx.stop_model(pack).await;
            let text = String::from_utf8_lossy(&r?.bytes).to_string();
            if text.trim().is_empty() { return Err("the model answered with nothing".into()); }
            steps.push("answer generated".into());
            // GPU check: a computer with a GPU must run on it, or users never see the speed
            let key = ctx.state["engine"]["key"].as_str().unwrap_or("").to_string();
            let mac_gpu = ctx.platform_key().starts_with("macos-aarch64");
            let found = if let Some(g) = ctx.nvidia_gpu().await { Some(g["name"].as_str().unwrap_or("NVIDIA GPU").to_string()) } else if let Some(g) = ctx.other_gpu().await { Some(g) } else if mac_gpu { Some("Apple GPU".into()) } else { None };
            let on_gpu_build = key.ends_with("-cuda") || key.ends_with("-vulkan") || mac_gpu;
            let log_text = std::fs::read_to_string(ctx.data.join("logs").join(format!("{pack}.log"))).unwrap_or_default();
            let layers = log_text.lines().rev().find_map(|l| { let i = l.find("offloaded ")?; if !l.contains("layers to GPU") { return None; }
                let f = l[i + 10..].split_whitespace().next()?; let (a, b) = f.split_once('/')?; Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?)) });
            if let Some(g) = &found {
                if !on_gpu_build { return Err(format!("GPU check: this computer has a GPU ({g}) but the CPU engine ({key}) is installed; run `sushila engine install` (it picks the build for this GPU: CUDA on NVIDIA, Vulkan on AMD/Intel, Metal on Apple) and run the test again")); }
                match layers {
                    Some((a, b)) if a < b => return Err(format!("GPU check: only {a} of {b} layers ran on the GPU ({g}); the model should fit entirely")),
                    Some((a, b)) => steps.push(format!("GPU used: {a}/{b} layers on {g}")),
                    None => steps.push(format!("GPU engine on {g} (layer count not reported)")),
                }
            } else { steps.push("no GPU found: CPU engine (expected)".into()); }
            let v = json!({ "ok": true, "platform": ctx.platform_key(), "engine": ctx.state["engine"]["key"], "gpu": found, "gpuLayers": layers.map(|(a, b)| format!("{a}/{b}")), "pack": pack, "answer": text.trim(), "answer_seconds": gen_s, "total_seconds": t0.elapsed().as_secs_f64(), "steps": steps });
            out(j, v.clone(), || format!("{}\nanswer: {}\nPASS on {} with {} ({:.1} s)", steps.iter().map(|s| format!("ok  {s}")).collect::<Vec<_>>().join("\n"), text.trim(), ctx.platform_key(), Ctx::gpu_label(ctx.state["engine"]["key"].as_str().unwrap_or("")), t0.elapsed().as_secs_f64()));
        }
        other => return cmds::run(other, ctx, j).await,
    }
    Ok(())
}

/// Access keys: with a server running, the change goes to it (it owns state.json and would otherwise write over a
/// change made here); without one, it is made here under the owner lock. Only the key's SHA-256 is stored.
async fn keys(ctx: &mut Ctx, act: &KeysCmd, j: bool) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    if !ctx.state["share"]["keys"].is_array() { ctx.state["share"]["keys"] = json!([]); }
    let server = owner_port(ctx).await;
    match act {
        KeysCmd::Add { name } => {
            let key = format!("sk-sushila-{}", random_token());
            let sha = hex::encode(Sha256::digest(key.as_bytes()));
            if let Some(p) = server { remote(ctx, p, json!({ "action": "share", "values": { "addKey": { "name": name, "sha256": sha } }, "source": "cli" })).await?; }
            else { let _l = local_lock(ctx)?; ctx.state["share"]["keys"].as_array_mut().unwrap().push(json!({ "name": name, "sha256": sha, "created": now_iso() })); ctx.save()?; }
            out(j, json!({ "name": name, "key": key }), || format!("access key for {name} (shown once; only its sha256 is stored):\n{key}\nUse it as: Authorization: Bearer {key}"));
        }
        KeysCmd::List => { let names: Vec<Value> = ctx.state["share"]["keys"].as_array().unwrap().iter().map(|k| json!({ "name": k["name"], "created": k["created"] })).collect();
            out(j, json!(names), || names.iter().map(|k| format!("{}  {}", k["name"].as_str().unwrap_or(""), k["created"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n")); }
        KeysCmd::Remove { name } => {
            if let Some(p) = server { remote(ctx, p, json!({ "action": "share", "values": { "removeKey": name }, "source": "cli" })).await?; }
            else { let _l = local_lock(ctx)?; ctx.state["share"]["keys"].as_array_mut().unwrap().retain(|k| k["name"] != name.as_str()); ctx.save()?; }
            out(j, json!({ "ok": true }), || format!("{name} removed"));
        }
    }
    Ok(())
}

/// Start at boot/login with the operating system's own service manager: systemd (Linux), launchd (macOS), Task Scheduler (Windows).
fn service(ctx: &mut Ctx, act: &ServiceCmd, j: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(err)?.to_string_lossy().to_string();
    let os = ctx.info["os"].as_str().unwrap_or("linux").to_string();
    let home = dirs::home_dir().ok_or("no home folder")?;
    let data = ctx.data.to_string_lossy().to_string();
    let run = |c: &str, a: &[&str]| std::process::Command::new(c).args(a).status().map(|s| s.success()).unwrap_or(false);
    match act {
        ServiceCmd::Install { packs, host, port, public } => {
            let mut args = vec!["--data-dir".to_string(), data.clone(), "serve".into()];
            if let Some(p) = packs { args.extend(p.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty())); }
            if let Some(h) = host { args.extend(["--host".into(), h.clone()]); }
            if *public { args.push("--public".into()); }
            if let Some(p) = port { args.extend(["--port".into(), p.to_string()]); }
            let how = match os.as_str() {
                "linux" => {
                    let dir = home.join(".config/systemd/user"); std::fs::create_dir_all(&dir).map_err(err)?;
                    let quoted: Vec<String> = std::iter::once(exe.clone()).chain(args.iter().cloned()).map(|a| format!("\"{a}\"")).collect();
                    std::fs::write(dir.join("sushila.service"), format!("[Unit]\nDescription=Sushila.cpp (sushila serve)\nAfter=network-online.target\n\n[Service]\nExecStart={}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n", quoted.join(" "))).map_err(err)?;
                    let ok = run("systemctl", &["--user", "daemon-reload"]) && run("systemctl", &["--user", "enable", "--now", "sushila.service"]);
                    let _ = run("loginctl", &["enable-linger"]);  // keep running without a login session (servers)
                    if !ok { return Err("systemctl --user failed; the unit is in ~/.config/systemd/user/sushila.service".into()); }
                    "systemd user service sushila.service (systemctl --user status sushila)"
                }
                "macos" => {
                    let dir = home.join("Library/LaunchAgents"); std::fs::create_dir_all(&dir).map_err(err)?;
                    let plist = dir.join("ai.sushila.serve.plist");
                    let items: String = std::iter::once(exe.clone()).chain(args.iter().cloned()).map(|a| format!("<string>{}</string>", a.replace('&', "&amp;").replace('<', "&lt;"))).collect();
                    std::fs::write(&plist, format!(r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>ai.sushila.serve</string><key>ProgramArguments</key><array>{items}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardErrorPath</key><string>{data}/logs/serve.log</string></dict></plist>"#)).map_err(err)?;
                    let _ = run("launchctl", &["unload", &plist.to_string_lossy()]);
                    if !run("launchctl", &["load", "-w", &plist.to_string_lossy()]) { return Err("launchctl load failed".into()); }
                    "launchd agent ai.sushila.serve (starts at login)"
                }
                _ => {
                    let line = std::iter::once(format!("\"{exe}\"")).chain(args.iter().map(|a| format!("\"{a}\""))).collect::<Vec<_>>().join(" ");
                    if !run("schtasks", &["/Create", "/F", "/TN", "Sushila", "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", &line]) { return Err("schtasks failed".into()); }
                    let _ = run("schtasks", &["/Run", "/TN", "Sushila"]);
                    "Windows Task Scheduler task \"Sushila\" (starts at logon)"
                }
            };
            out(j, json!({ "ok": true, "service": how }), || format!("installed: {how}"));
        }
        ServiceCmd::Remove => {
            match os.as_str() {
                "linux" => { let _ = run("systemctl", &["--user", "disable", "--now", "sushila.service"]); let _ = std::fs::remove_file(home.join(".config/systemd/user/sushila.service")); }
                "macos" => { let p = home.join("Library/LaunchAgents/ai.sushila.serve.plist"); let _ = run("launchctl", &["unload", &p.to_string_lossy()]); let _ = std::fs::remove_file(p); }
                _ => { let _ = run("schtasks", &["/Delete", "/F", "/TN", "Sushila"]); }
            }
            out(j, json!({ "ok": true }), || "service removed".into());
        }
    }
    Ok(())
}

// ---------- serve: the owner. One per computer: it alone changes state.json, runs models, downloads and the queue;
// Host Station and the sushila commands ask it through /api/control. Every step goes to logs/sushila.log.
fn open_browser(url: &str) {
    let _ = if cfg!(windows) { hidden(&mut std::process::Command::new("cmd")).args(["/c", "start", "", url]).spawn() }
            else if cfg!(target_os = "macos") { std::process::Command::new("open").arg(url).spawn() }
            else { std::process::Command::new("xdg-open").arg(url).spawn() };
}
/// The addresses people need, printed whenever the server starts (console window or terminal) and by `sushila url`.
/// The Admin tab answers only on this computer (localhost); other machines reach the Inference page and the API.
fn urls(port: u16, network: bool) -> Value {
    let home = std::env::var("SUSHILA_HOME").unwrap_or_default();
    let lan = if network { local_ip() } else { None };
    json!({ "inference": format!("http://localhost:{port}/"), "admin": format!("http://localhost:{port}/admin"),
            "docs": format!("http://localhost:{port}/docs"), "api": format!("http://localhost:{port}/v1"), "network": lan.map(|ip| format!("http://{ip}:{port}/")), "home": home })
}
/// What `?`, `man` or `help` prints in the server's window: the commands people need most (all work from any terminal).
fn quick_help() -> &'static str {
    "\nImportant commands (type them in any terminal; `sushila --help` lists all of them, the Documentation page explains each):
  sushila search <words>            model packs you can install (sushila packs: all of them)
  sushila install <pack>            download and verify a model pack, e.g. sushila install qwen3-4b-instruct-2507
  sushila list                      installed packs (sushila show <pack>: details)
  sushila chat [<pack>]             chat in the terminal
  sushila run <pack> \"<prompt>\"     one answer, image, song or video from the command line
  sushila assistant \"<question>\"    ask Sushila how Sushila works
  sushila status | ps               what is installed and running
  sushila mode <pack> standard|accelerated
  sushila bench <pack>              speed on this computer, Standard vs Accelerated
  sushila doctor                    check GPU, driver, engine, disk, port (with fixes)
  sushila share on | qr             let other machines (a phone) use it
  sushila logs -f                   follow the log (in another terminal)
  sushila stop                      stop the server
Typed in the server window: any of these commands (without \"sushila\" if you like; changes ask first), or a question for the assistant (e.g. how do I add a coding model?).
  ?  this list    urls  the addresses again    stop  stop the server    clear  empty the window
  copy  copy the last answer to the clipboard (copy urls: the addresses)
  Up/Down  earlier lines    Esc  clear the line    !<command>  a command of the system shell (e.g. !dir, !ls)
Scroll up with the mouse wheel or the scroll bar: everything stays in the window.
Copy any text: select it with the mouse, then right-click (or Enter); paste: right-click or Ctrl+V (Windows console: also the window menu, Edit).
While a line is being processed the input line shows \"processing request...\" (Ctrl+C cancels a command).\n"
}
fn url_banner(u: &Value) -> String {
    let mut b = format!("\n==============================================================\n Sushila {} is running\n   Inference:      {}\n   Admin:          {}   (this computer only)\n   Documentation:  {}\n   API (OpenAI):   {}\n",
        env!("CARGO_PKG_VERSION"), u["inference"].as_str().unwrap_or(""), u["admin"].as_str().unwrap_or(""), u["docs"].as_str().unwrap_or(""), u["api"].as_str().unwrap_or(""));
    if let Some(n) = u["network"].as_str() { b += &format!("   Other machines: {n}   (Inference page and API; needs an access key unless --open)\n"); }
    if let Some(h) = u["home"].as_str().filter(|h| !h.is_empty()) { b += &format!("   Home folder:    {h}   (model-packs, settings, logs; change: sushila home <folder>)\n"); }
    b + " Type a command (e.g. install, ps, status), a question, or ? for help. Stop: Ctrl+C, type stop, or close this window\n Copy: select with the mouse, then right-click (or Enter); paste: right-click or Ctrl+V; copy = copy the last answer\n==============================================================\n"
}
fn local_ip() -> Option<String> { let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?; s.connect("8.8.8.8:80").ok()?; Some(s.local_addr().ok()?.ip().to_string()) }
fn read_json(p: &std::path::Path) -> Option<Value> { std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()) }

enum Done {
    Engine(String, Result<core::EnginePlan, String>),                       // task id
    Pack(String, Result<(Option<core::EnginePlan>, Option<(String, Value)>, core::PackPlan), String>),  // + runtime record
    Ready(String, u32, Result<(), String>),                                  // pack id, the process it was for
    Job(String, Result<jobs::Output, String>),                               // queue job id
    Found(String, PathBuf, Result<Value, String>),                           // a pack folder dropped into model-packs, checked
    Hf(String, Result<(), String>),                                          // a GGUF downloaded from Hugging Face (the scan adopts it)
}

struct Owner {
    tasks: Vec<Value>,                                   // newest last; mirrored in state.public.tasks
    prog: std::collections::HashMap<String, Prog>,       // live progress of downloads
    tx: tokio::sync::mpsc::UnboundedSender<Done>,
    starting: std::collections::HashMap<String, (u32, Vec<String>)>,  // packs loading: their process and the tasks waiting for them
    after_engine: Vec<String>,                           // packs to start again once a fallback engine is installed
    busy_model: Option<String>,                          // the model of the queue's current job (never stopped to make room)
    checking: std::collections::HashSet<PathBuf>,        // pack folders being verified
    rejected: std::collections::HashMap<PathBuf, std::time::SystemTime>,  // folders that failed (checked again when they change)
}
impl Owner {
    fn task(&mut self, id: &str, action: &str, target: &str, source: &str) -> Prog {
        self.tasks.push(json!({ "id": id, "action": action, "target": target, "source": source, "status": "running", "started": now_iso(), "label": "", "done": 0, "total": 0, "error": "" }));
        if self.tasks.len() > 50 { self.tasks.remove(0); }
        let p: Prog = std::sync::Arc::new(std::sync::Mutex::new(json!({})));
        self.prog.insert(id.to_string(), p.clone());
        p
    }
    fn finish(&mut self, id: &str, r: &Result<(), String>) {
        self.prog.remove(id);
        if let Some(t) = self.tasks.iter_mut().find(|t| t["id"] == id) {
            t["status"] = json!(if r.is_ok() { "done" } else { "failed" }); t["finished"] = json!(now_iso());
            if let Err(e) = r { t["error"] = json!(e.chars().take(600).collect::<String>()); }
        }
    }
    fn publish(&mut self, ctx: &mut Ctx) -> bool {
        for (id, p) in &self.prog { if let Some(t) = self.tasks.iter_mut().find(|t| t["id"] == id.as_str()) {
            let g = p.lock().unwrap().clone(); if g.is_object() { for k in ["label", "done", "total"] { if let Some(v) = g.get(k) { t[k] = v.clone(); } } } } }
        let v = json!(self.tasks);
        if ctx.state["tasks"] != v { ctx.state["tasks"] = v; true } else { false }
    }
    /// Starts a model in the background: the process now, readiness reported through the channel.
    /// Every request to start a pack that is already loading waits for that same load (none is left unanswered).
    async fn start(&mut self, ctx: &mut Ctx, id: &str, mode: Option<&str>, task: Option<String>) -> Result<(), String> {
        if let Some((_, waiting)) = self.starting.get_mut(id) { waiting.extend(task); return Ok(()); }
        let s = ctx.spawn_model(id, mode).await?;
        if s.already { if let Some(t) = task { self.finish(&t, &Ok(())); } return Ok(()); }
        self.starting.insert(id.to_string(), (s.pid, task.into_iter().collect()));
        let (tx, procs, pack, pid) = (self.tx.clone(), ctx.procs.clone(), id.to_string(), s.pid);
        tokio::spawn(async move { let r = core::wait_ready(procs, &s).await; let _ = tx.send(Done::Ready(pack, pid, r)); });
        Ok(())
    }
    /// A pack stopped while it loads: the tasks waiting for it end ("stopped before it was ready"); its readiness result,
    /// when it comes, belongs to a process that is gone and is ignored.
    fn cancel_start(&mut self, id: &str) {
        if let Some((_, waiting)) = self.starting.remove(id) { for t in waiting { self.finish(&t, &Err("stopped before it was ready".into())); } }
    }
}

/// One model pack at a time: starting one stops the others (the terminal's Sushila helper needs no model; a chat model
/// that happens to run answers its free-form questions).
/// The one admission rule, for every start (page, commands, queue): a model that is working (the queue's current job,
/// or requests being answered) is never stopped to make room; the start waits or is refused, with the reason.
async fn make_room(ctx: &mut Ctx, o: &mut Owner, pack: &str) -> Result<(), String> {
    let running: Vec<String> = ctx.state["running"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    if let Some(busy) = running.iter().find(|id| id.as_str() != pack && (o.busy_model.as_deref() == Some(id.as_str()) || webserver::in_flight(id) > 0)) {
        return Err(format!("{busy} is busy (a queued job or a request is running); {pack} starts when it is done, or stop {busy} first"));
    }
    for id in &running {
        if id == pack { continue; }
        ctx.log(&format!("stopping {id}: one model pack at a time ({pack} starts)"));
        ctx.stop_model(id).await; o.cancel_start(id);
    }
    Ok(())
}

/// settings.keepPopular: the popular model packs (catalog "popular", one per kind) are installed in the background, one
/// at a time, and kept installed: each that fits this computer, with 10 GB to spare on the disk. A pack that failed is
/// tried again after 6 hours. Checked every minute while the server runs; switching it off stops new downloads.
/// Also settings.installQueue: the packs chosen on the Admin page ("Choose model packs", Install selected), installed
/// the same way, one at a time, and taken off the queue once installed (or when they cannot be).
async fn keep_popular(ctx: &mut Ctx, o: &mut Owner, failed: &mut std::collections::HashMap<String, std::time::Instant>) {
    let queue: Vec<String> = ctx.setting("installQueue").as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
    if ctx.setting("keepPopular") != true && queue.is_empty() { return; }
    if o.tasks.iter().any(|t| t["status"] == "running" && (t["action"] == "install" || t["action"] == "engine-install")) { return; }
    // an unreachable catalog is tried again after 5 minutes, not on every tick (each try can take a while)
    static CATALOG_FAILED: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    if ctx.catalog.is_none() && CATALOG_FAILED.lock().unwrap().map(|t| t.elapsed() < Duration::from_secs(300)).unwrap_or(false) { return; }
    if ctx.load_catalog().await.is_err() { *CATALOG_FAILED.lock().unwrap() = Some(std::time::Instant::now()); return; }
    // the chosen packs first: drop the installed ones (and ones that failed), install the next
    let mut left = vec![];
    for id in &queue {
        let best = ctx.best_variant(id).await;
        if ctx.packs().contains_key(&best) || ctx.packs().contains_key(id.as_str()) { continue; }
        if failed.get(&best).map(|t| t.elapsed() < Duration::from_secs(6 * 3600)).unwrap_or(false) && o.tasks.iter().any(|t| t["target"] == id.as_str() && t["status"] == "failed") {
            ctx.log(&format!("install queue: {id} could not be installed (see Recent actions); taken off the queue")); continue;
        }
        left.push(id.clone());
    }
    if left != queue { ctx.state["settings"]["installQueue"] = json!(left); let _ = ctx.save(); }
    if let Some(id) = left.first().cloned() {
        let best = ctx.best_variant(&id).await;
        if !failed.get(&best).map(|t| t.elapsed() < Duration::from_secs(6 * 3600)).unwrap_or(false) {
            ctx.log(&format!("install queue: installing {id} in the background ({} chosen, one at a time)", left.len()));
            failed.insert(best, std::time::Instant::now());
            let tid = format!("chosen-{id}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
            control(ctx, o, json!({ "id": tid, "action": "install", "pack": id, "source": "chosen model packs" })).await;
            return;
        }
    }
    if ctx.setting("keepPopular") != true { return; }
    for id in core::popular_packs(ctx.catalog.as_ref().unwrap()) {
        let best = ctx.best_variant(&id).await;
        if ctx.packs().contains_key(&best) || ctx.packs().contains_key(&id) { continue; }
        if failed.get(&best).map(|t| t.elapsed() < Duration::from_secs(6 * 3600)).unwrap_or(false) { continue; }
        let Some(p) = ctx.catalog.as_ref().unwrap()["packs"].as_array().and_then(|a| a.iter().find(|p| p["id"] == best.as_str())).cloned() else { continue };
        if !ctx.pack_fits(&p).await { continue; }
        let need: u64 = p["files"].as_array().map(|a| a.iter().map(|f| f["bytes"].as_u64().unwrap_or(0)).sum()).unwrap_or(0);
        let free = core::free_disk(&ctx.packs_dir);
        if free.map(|f| f < need + 10_000_000_000).unwrap_or(false) {
            failed.insert(best.clone(), std::time::Instant::now());
            ctx.log(&format!("keep popular packs ready: {best} needs {:.1} GB; only {:.1} GB free on the disk (skipped)", need as f64 / 1e9, free.unwrap_or(0) as f64 / 1e9));
            continue;
        }
        ctx.log(&format!("keep popular packs ready: installing {best} in the background"));
        let tid = format!("popular-{best}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
        failed.insert(best.clone(), std::time::Instant::now());  // until it succeeds (installed packs are skipped above)
        control(ctx, o, json!({ "id": tid, "action": "install", "pack": id, "source": "keep popular packs ready" })).await;
        return;
    }
}

/// Finished queue jobs (ready, failed, cancelled) are kept 30 days, at most the 200 newest; older ones leave the queue
/// with their output file. Jobs still to do are never touched.
fn prune_queue(q: &mut Value, data: &std::path::Path) {
    let Some(jobs) = q["jobs"].as_array_mut() else { return };
    let done = |j: &Value| ["ready", "failed", "cancelled"].contains(&j["status"].as_str().unwrap_or(""));
    let cutoff = std::time::SystemTime::now().checked_sub(Duration::from_secs(30 * 86400)).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let mut finished: Vec<(u64, String)> = jobs.iter().filter(|j| done(j)).map(|j| (j["finished"].as_str().and_then(cmds::iso_secs).unwrap_or(0), j["id"].as_str().unwrap_or("").to_string())).collect();
    finished.sort_by(|a, b| b.0.cmp(&a.0));
    let drop: std::collections::HashSet<String> = finished.iter().enumerate().filter(|(i, (t, _))| *i >= 200 || *t < cutoff).map(|(_, (_, id))| id.clone()).collect();
    if drop.is_empty() { return; }
    jobs.retain(|j| {
        let gone = drop.contains(j["id"].as_str().unwrap_or(""));
        if gone { if let Some(f) = j["output"]["file"].as_str().filter(|f| !f.contains(['/', '\\']) && f.starts_with("job-")) { let _ = std::fs::remove_file(crate::locate::outputs(data).join(f)); } }
        !gone
    });
}

async fn control(ctx: &mut Ctx, o: &mut Owner, r: Value) {
    let (id, action) = (r["id"].as_str().unwrap_or("task").to_string(), r["action"].as_str().unwrap_or("").to_string());
    let pack = r["pack"].as_str().unwrap_or("").to_string();
    let source = r["source"].as_str().unwrap_or("api").to_string();
    ctx.log(&format!("request from {source}: {action} {pack}"));
    let prog = o.task(&id, &action, &pack, &source);
    let res: Result<bool, String> = async {  // Ok(true): finished now; Ok(false): continues in the background
        match action.as_str() {
            "engine-install" => {
                ctx.catalog = None;
                let key = r["build"].as_str().map(|b| { let pk = ctx.platform_key(); match b { "cpu" => pk, "vulkan" | "cuda" => format!("{pk}-{b}"), k => k.to_string() } });
                match ctx.prepare_engine(key).await? {
                    None => Ok(true),
                    Some(p) => { let tx = o.tx.clone(); let t = id.clone();
                        tokio::spawn(async move { let r = Ctx::fetch_engine(&p, Some(&prog)).await.map(|_| p); let _ = tx.send(Done::Engine(t, r)); }); Ok(false) }
                }
            }
            "install" => {
                if !core::safe_id_dots(&pack) { return Err("a pack id is required".into()); }
                // one install of a pack at a time (two would share its temporary folder and partial files)
                if o.tasks.iter().any(|t| t["id"] != id.as_str() && t["status"] == "running" && t["action"] == "install" && t["target"] == pack.as_str()) {
                    return Err(format!("{pack} is already being installed"));
                }
                ctx.load_catalog().await?;
                let id2 = ctx.best_variant(&pack).await;
                let eng = if ctx.engine_ok() { None } else { ctx.prepare_engine(None).await? };
                let Some(p) = ctx.prepare_pack(&id2).await? else { return Ok(true) };
                // the image runtime (when the pack needs it), the engine and the pack: all fetched in the background
                let rt = if p.pack["serve"]["engine"] == "image-nunchaku" && !ctx.state["runtimes"]["image-nunchaku"].is_object() { Some(ctx.prepare_runtime("image-nunchaku")?) } else { None };
                let tx = o.tx.clone(); let t = id.clone();
                tokio::spawn(async move {
                    let r = async {
                        let rt_rec = match &rt { Some(plan) => Some((plan.name.clone(), Ctx::fetch_runtime(plan).await?)), None => None };
                        if let Some(e) = &eng { Ctx::fetch_engine(e, Some(&prog)).await?; }
                        Ctx::fetch_pack(&p, Some(&prog)).await?;
                        Ok((eng, rt_rec, p))
                    }.await;
                    let _ = tx.send(Done::Pack(t, r));
                });
                Ok(false)
            }
            "install-file" => {
                let p = PathBuf::from(r["path"].as_str().unwrap_or(""));
                if p.extension().map(|x| x.eq_ignore_ascii_case("gguf")).unwrap_or(false) {
                    // the user's own model: into model-packs; the folder scan checks it and adopts it
                    let d = ctx.take_gguf(&p)?; ctx.log(&format!("{} copied to {}", p.display(), d.display())); Ok(true)
                } else { let got = ctx.install_pack_file(&p).await?; ctx.log(&format!("{got} installed from {}", p.display())); Ok(true) }
            }
            "install-hf" => {
                let spec = r["spec"].as_str().unwrap_or("").to_string();
                let (tx, t, pd, q) = (o.tx.clone(), id.clone(), ctx.packs_dir.clone(), ctx.quiet);
                tokio::spawn(async move { let r = core::download_hf_gguf(&pd, &spec, q, Some(&prog)).await.map(|_| ()); let _ = tx.send(Done::Hf(t, r)); });
                Ok(false)
            }
            // hashing a whole pack takes a while: on a blocking thread, so the owner loop keeps answering
            "verify" => {
                let rec = ctx.packs().get(&pack).cloned().ok_or(format!("{pack} is not installed"))?;
                let bad = tokio::task::spawn_blocking(move || core::verify_files(&rec)).await.map_err(err)?;
                if bad.is_empty() { Ok(true) } else { Err(format!("missing or changed: {}", bad.join(", "))) }
            }
            "catalog" => { ctx.catalog = None; ctx.write_catalog_cache().await?; Ok(true) }
            "remove" => { if ctx.state["running"][&pack].is_object() { ctx.stop_model(&pack).await; } ctx.remove_pack(&pack)?; Ok(true) }
            "start" => {
                if !ctx.packs().contains_key(&pack) { return Err(format!("{pack} is not installed")); }
                // a mode chosen with the start (the inference page lists each pack per mode) is remembered as its choice
                if let Some(m) = r["mode"].as_str().filter(|m| *m == "turbo" || *m == "regular") { ctx.state["packs"][&pack]["preferredMode"] = json!(m); ctx.save()?; }
                if ctx.state["running"][&pack].is_object() && r["mode"].as_str().map(|m| ctx.state["running"][&pack]["mode"] != m).unwrap_or(false) { ctx.stop_model(&pack).await; o.cancel_start(&pack); }
                make_room(ctx, o, &pack).await?;
                o.start(ctx, &pack, r["mode"].as_str(), Some(id.clone())).await?; Ok(ctx.state["running"][&pack]["ready"] == true)
            }
            "stop" => { ctx.stop_model(&pack).await; o.cancel_start(&pack); Ok(true) }
            "settings" => {
                for k in ["threads", "contextSize", "gpuLayers", "parallel", "keepCopy", "enginePort", "port", "idleMinutes", "keepPopular", "internetUrlAtStart"] {
                    if let Some(v) = r["values"].get(k) { if v.is_number() || v.is_boolean() { ctx.state["settings"][k] = v.clone(); } }
                }
                // "Install selected" on the Admin page: these pack ids join the install queue (keep_popular installs them)
                if let Some(a) = r["values"]["queueInstall"].as_array() {
                    let mut q: Vec<Value> = ctx.setting("installQueue").as_array().cloned().unwrap_or_default();
                    for v in a { if let Some(id) = v.as_str().filter(|i| core::safe_id_dots(i)) { if !q.iter().any(|x| x == id) { q.push(json!(id)); } } }
                    ctx.state["settings"]["installQueue"] = json!(q);
                }
                if r["values"]["clearQueue"] == true { ctx.state["settings"]["installQueue"] = json!([]); }
                if let Some(t) = r["values"]["ticker"].as_str() { if t != "on" && t != "off" { return Err("ticker is on or off".into()); } ctx.state["settings"]["ticker"] = json!(t); }
                if let Some(u) = r["values"]["catalogUrl"].as_str() { crate::net::check_url(u, false)?; ctx.state["settings"]["catalogUrl"] = json!(u); ctx.catalog = None; }
                ctx.save()?; Ok(true)
            }
            "share" => { cmds::apply_share(&mut ctx.state, &r["values"])?; ctx.save()?; Ok(true) }
            // Standard / Accelerated: remembered for the pack's next start, and applied now if it runs in the other mode
            "mode" => {
                let m = r["mode"].as_str().filter(|m| *m == "turbo" || *m == "regular").ok_or("mode is turbo or regular")?.to_string();
                if !ctx.packs().contains_key(&pack) { return Err(format!("{pack} is not installed")); }
                ctx.state["packs"][&pack]["preferredMode"] = json!(m); ctx.save()?;
                if ctx.state["running"][&pack].is_object() && ctx.state["running"][&pack]["mode"] != m.as_str() {
                    ctx.stop_model(&pack).await; o.cancel_start(&pack);
                    o.start(ctx, &pack, Some(&m), Some(id.clone())).await?; Ok(false)
                } else { Ok(true) }
            }
            a => Err(format!("unknown action {a}")),
        }
    }.await;
    match res {
        Ok(true) => { o.finish(&id, &Ok(())); ctx.log(&format!("{action} {pack}: done")); }
        Ok(false) => {}
        Err(e) => { ctx.log(&format!("{action} {pack}: failed: {e}")); o.finish(&id, &Err(e)); }
    }
}

async fn serve(ctx: &mut Ctx, packs: &[String], port: Option<u16>, host: Option<String>, standard: bool, max: usize, open: bool, j: bool) -> Result<(), String> {
    let _ = core::SOURCE.set("server".into());
    let lock = std::fs::OpenOptions::new().create(true).write(true).open(ctx.data.join("owner.lock")).map_err(err)?;
    // Seamless restart / upgrade: another Sushila owns this home folder. It is asked to hand over (it stops its models
    // cleanly and writes what ran to resume.json), and this one carries on: the same models in the same modes, the
    // queue, the link to the app.
    if lock.try_lock().is_err() {
        eprintln!("Another Sushila is running with this home folder: it hands over to this one (its models, queue and link carry on here)...");
        let _ = write_atomic(&ctx.data.join("shutdown-request.json"), b"{}");
        let mut taken = false;
        for _ in 0..180 { tokio::time::sleep(Duration::from_millis(500)).await; if lock.try_lock().is_ok() { taken = true; break; } }
        if !taken { return Err("another Sushila owns this home folder and did not hand over within 90 s; stop it (`sushila stop`) or see `sushila status`".into()); }
        let _ = std::fs::remove_file(ctx.data.join("shutdown-request.json"));
        *ctx = Ctx::load(ctx.data.clone(), ctx.quiet)?;  // what the other one saved on its way out
        ctx.log("took over from the Sushila that ran before");
    }
    if !ctx.engine_ok() { ctx.install_engine(None).await?; }
    if let Some(p) = port { ctx.state["settings"]["port"] = json!(p); }
    let port = ctx.setting("port").as_u64().unwrap_or(7874) as u16;
    // `sushila share on` remembers serving on the network (share.listen; share.open: without keys)
    let listen = host.is_none() && ctx.state["share"]["listen"] == true;
    let open = open || (listen && ctx.state["share"]["open"] == true);
    let bind = host.unwrap_or_else(|| if listen { "0.0.0.0".into() } else { "127.0.0.1".into() });
    let network = bind != "127.0.0.1" && bind != "localhost";
    ctx.state["share"]["open"] = json!(network && open);
    if network && open { eprintln!("--open: anyone who can reach port {port} can use the models without a key. Use it on trusted networks only."); }
    if network {
        ctx.state["share"]["enabled"] = json!(true);
        if ctx.state["share"]["hosts"].as_array().map(|a| a.is_empty()).unwrap_or(true) { ctx.state["share"]["hosts"] = json!(["*"]); }
        if !open && ctx.state["share"]["keys"].as_array().map(|a| a.is_empty()).unwrap_or(true) { eprintln!("Other machines need an access key: `sushila keys add <name>` (or serve with --open on a trusted network)."); }
    }
    register_link();
    // engines from an earlier session (closed window, crash, older version) still hold GPU memory: stopped first
    let strays = core::kill_strays(&ctx.data);
    if !strays.is_empty() { ctx.log(&format!("stopped engines left running from an earlier session (they held GPU memory): {}", strays.join(", "))); }
    ctx.state["running"] = json!({});
    ctx.state["tasks"] = json!([]);
    ctx.state["owner"] = json!({ "pid": std::process::id(), "since": now_iso(), "by": "sushila serve", "port": port });
    for f in ["shutdown-request.json", "mode-request.json"] { let _ = std::fs::remove_file(ctx.data.join(f)); }
    ctx.save()?;
    let (addr, stop_tx) = webserver::start(ctx.data.clone(), port, if bind == "localhost" { "127.0.0.1" } else { &bind }).await
        .map_err(|e| format!("{e} (is another server already running? `sushila status`)"))?;
    SERVING.store(true, std::sync::atomic::Ordering::SeqCst);
    ctx.log(&format!("serving on {addr} (data {})", ctx.data.display()));
    let u = urls(port, network);
    if !j { eprintln!("{}", url_banner(&u)); }
    // started by a double-click: open the page in the browser when the server is ready (on its real port), once
    if std::env::var("SUSHILA_DOUBLE_CLICK").is_ok() && std::env::var("SUSHILA_NO_BROWSER").is_err() {
        let page = format!("http://localhost:{port}/");
        tokio::spawn(async move {
            for _ in 0..600 {
                tokio::time::sleep(Duration::from_secs(2)).await;
                if http_text(&format!("http://127.0.0.1:{port}/api/state"), 2).await.ok().map(|s| s.contains("\"ready\":true")).unwrap_or(false) { open_browser(&page); return; }
            }
        });
    }
    // the link to the app (settings.internetUrlAtStart): asked at the first start by the window (window.rs, its own
    // input thread, so nothing waits for the answer); made once the engine answers and the answer is yes
    tokio::spawn(tunnel::at_start(ctx.data.clone(), port));
    // there is no admin password any more: a hash left by an older Sushila is removed (once)
    if ctx.data.join("adminpassword").exists() && std::fs::remove_file(ctx.data.join("adminpassword")).is_ok() { ctx.log("the Admin tab has no password any more: the old adminpassword file was removed"); }
    // the server's own window: typed commands run, questions go to the assistant, near-misses are suggested (window.rs);
    if !j && (std::io::IsTerminal::is_terminal(&std::io::stdin()) || tui::in_screen()) {
        let w = window::Window { exe: std::env::current_exe().map_err(err)?, data: ctx.data.clone(), port, rt: tokio::runtime::Handle::current(), last: Default::default() };
        let banner = url_banner(&u);
        ticker::console_setup();
        std::thread::spawn(move || window::read_loop(w, banner));
    }
    // the ticker line at the bottom of this window (off: --json, --quiet, not a terminal, TERM=dumb, SUSHILA_TICKER=0, setting ticker off)
    let _ticker = ticker::Guard;
    if ticker::wanted(j, ctx.quiet, &ctx.setting("ticker")) { ticker::start(ctx.data.clone(), port); }
    if let Err(e) = ctx.write_catalog_cache().await { ctx.log(&format!("catalog: {e}")); }
    let page = if network { format!("http://localhost:{port}/ here; http://{}:{port}/ on the network; http://<public IP>:{port}/ from the internet if the firewall allows port {port} (use HTTPS in front for real internet use)", local_ip().unwrap_or_else(|| "<this machine's address>".into())) } else { format!("http://localhost:{port}/") };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Done>();
    let mut o = Owner { tasks: vec![], prog: Default::default(), tx, starting: Default::default(), after_engine: vec![], busy_model: None, checking: Default::default(), rejected: Default::default() };
    let mut last_scan = std::time::Instant::now() - Duration::from_secs(10);
    // at start: what ran before a restart or handover in the last 30 minutes (resume.json: packs and modes); else the
    // chat model (Qwen3 4B or the small default) if installed, else the first installed pack
    let resume: Vec<(String, Option<String>)> = read_json(&ctx.data.join("resume.json")).filter(|r| r["at"].as_str().and_then(cmds::iso_secs).map(|t| cmds::now_secs().saturating_sub(t) < 1800).unwrap_or(false))
        .and_then(|r| r["running"].as_array().cloned()).unwrap_or_default().iter()
        .filter_map(|x| x["pack"].as_str().filter(|p| ctx.packs().contains_key(*p)).map(|p| (p.to_string(), x["mode"].as_str().map(String::from)))).collect();
    let _ = std::fs::remove_file(ctx.data.join("resume.json"));
    let modes: std::collections::HashMap<String, Option<String>> = if packs.is_empty() { resume.iter().cloned().collect() } else { Default::default() };
    if !modes.is_empty() { ctx.log(&format!("resuming: {}", resume.iter().map(|(p, m)| format!("{p} ({})", m.as_deref().unwrap_or("default"))).collect::<Vec<_>>().join(", "))); }
    let mut ids: Vec<String> = if !modes.is_empty() { resume.iter().map(|(p, _)| p.clone()).collect() }
        else if packs.is_empty() { ctx.assistant_pack().map(|a| vec![a]).unwrap_or_else(|| ctx.packs().keys().take(max).cloned().collect()) } else { packs.to_vec() };
    if ids.is_empty() {
        ctx.load_catalog().await?;
        let (id, why) = ctx.default_pack().await;
        ctx.log(&format!("no packs installed: {why}"));
        // a stop (sushila stop, Station) during this first download ends the server at once; the download resumes at the
        // next start. Before, the stop waited until the whole pack was downloaded.
        let stop_file = ctx.data.join("shutdown-request.json");
        let stop_asked = async { while !stop_file.exists() { tokio::time::sleep(Duration::from_millis(400)).await; } };
        tokio::select! {
            r = async { let id = ctx.best_variant(&id).await; ctx.install_pack(&id).await.map(|_| id) } => ids.push(r?),
            // the request is left in place: the main loop below sees it on its first pass and stops the usual way
            _ = stop_asked => ctx.log("stop requested during the first download (it continues at the next start)"),
        }
    }
    for id in &ids {
        let mode = if standard { Some("regular".to_string()) } else { modes.get(id).cloned().flatten() };
        if let Err(e) = o.start(ctx, id, mode.as_deref(), None).await { ctx.log(&format!("{id}: {e}")); }
    }
    out(j, json!({ "ok": true, "page": page, "urls": u, "api": format!("{addr}/v1"), "models": ids }), || format!(
        "Models: {} (loading in the background: `sushila status`)\n  page:  {page}\n  API:   header x-sushila-token: <token> here, or Authorization: Bearer <key> from other machines\n  log:   {}\n",
        ids.join(", "), ctx.data.join("logs").join("sushila.log").display()));
    // the queue: one job at a time, like the desktop app
    let qpath = ctx.data.join("queue.json");
    let mut q = read_json(&qpath).unwrap_or(json!({ "paused": false, "jobs": [] }));
    prune_queue(&mut q, &ctx.data);
    for jb in q["jobs"].as_array_mut().into_iter().flatten() { if jb["status"] == "running" { jb["status"] = json!("queued"); jb["progress"] = json!("continues after a restart"); } }
    let save_q = |q: &Value, p: &std::path::Path| { let _ = write_atomic(p, serde_json::to_string(q).unwrap_or_default().as_bytes()); };
    save_q(&q, &qpath);
    let mut current: Option<(String, tokio::task::JoinHandle<()>, std::time::Instant)> = None;
    let progress = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let ctrl_c = tokio::signal::ctrl_c(); tokio::pin!(ctrl_c);
    // `kill`, a service manager's stop, or a closed terminal (SIGTERM / SIGHUP): the same clean stop as Ctrl+C, so the
    // engines end with the server (Windows: the job object does this)
    let stop_signal = async {
        #[cfg(unix)] {
            use tokio::signal::unix::{signal, SignalKind};
            match (signal(SignalKind::terminate()), signal(SignalKind::hangup())) {
                (Ok(mut t), Ok(mut h)) => { tokio::select! { _ = t.recv() => {}, _ = h.recv() => {} } }
                _ => std::future::pending::<()>().await,
            }
        }
        #[cfg(not(unix))] std::future::pending::<()>().await
    };
    tokio::pin!(stop_signal);
    // for the crash-recovery test only: SUSHILA_TEST_PANIC_AFTER=<seconds> makes the server panic on purpose
    if let Some(secs) = std::env::var("SUSHILA_TEST_PANIC_AFTER").ok().and_then(|v| v.parse::<u64>().ok()) {
        std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(secs)); std::process::abort(); });
        tokio::spawn(async move { tokio::time::sleep(Duration::from_secs(secs.saturating_sub(1))).await; panic!("test panic (SUSHILA_TEST_PANIC_AFTER)"); });
    }
    let mut last_pub = std::time::Instant::now();
    let mut last_idle = std::time::Instant::now();
    let mut last_popular = std::time::Instant::now() - Duration::from_secs(50);  // first check ~10 s after the start
    let mut popular_failed: std::collections::HashMap<String, std::time::Instant> = Default::default();
    let mut crash_counts: std::collections::HashMap<String, Vec<std::time::Instant>> = Default::default();
    loop {
        let mut changed = false;
        tokio::select! {
            _ = &mut ctrl_c => break,
            _ = &mut stop_signal => { ctx.log("stop signal received: stopping cleanly"); break; }
            d = rx.recv() => if let Some(d) = d {
                match d {
                    Done::Engine(t, r) => {
                        let r = r.and_then(|p| ctx.apply_engine(&p));
                        if let Err(e) = &r { ctx.log(&format!("engine install failed: {e}")); }
                        o.finish(&t, &r);
                        // packs that waited for a fallback engine: started again (their waiting tasks follow that start)
                        for id in std::mem::take(&mut o.after_engine) {
                            let waiting = o.starting.remove(&id).map(|(_, w)| w).unwrap_or_default();
                            if r.is_ok() { if let Err(e) = o.start(ctx, &id, None, None).await { for t in &waiting { o.finish(t, &Err(e.clone())); } } else if let Some(e) = o.starting.get_mut(&id) { e.1.extend(waiting); } }
                            else { for t in waiting { o.finish(&t, &Err(r.clone().err().unwrap_or_default())); } }
                        }
                    }
                    Done::Pack(t, r) => {
                        let r = r.and_then(|(e, rt, p)| { if let Some((n, rec)) = rt { ctx.apply_runtime(&n, rec)?; } if let Some(e) = e { ctx.apply_engine(&e)?; } ctx.apply_pack(&p) });
                        if let Err(e) = &r { ctx.log(&format!("install failed: {e}")); } o.finish(&t, &r);
                    }
                    Done::Ready(id, pid, r) => {
                        // only the result for the pack's current start counts (a stopped or replaced start is ignored)
                        if o.starting.get(&id).map(|(p, _)| *p != pid).unwrap_or(true) { continue; }
                        let (_, waiting) = o.starting.remove(&id).unwrap_or_default();
                        match r {
                            Ok(()) => { let _ = ctx.model_ready(&id); webserver::mark_idle(&id, false); for t in waiting { o.finish(&t, &Ok(())); } }
                            Err(e) => {
                                ctx.log(&format!("{e}")); ctx.model_failed(&id).await;
                                ctx.log(&format!("why: {}", diag::one_line(&diag::diagnose(&ctx.data, &id))));
                                match ctx.fallback_for(&id, &e).await {
                                    // another engine build: downloaded in the background (Done::Engine), then the pack starts again
                                    Some(next) => match ctx.prepare_engine(Some(next)).await {
                                        Ok(Some(p)) => {
                                            let tid = format!("fallback-{}", webserver::new_id());
                                            let prog = o.task(&tid, "engine-install", &p.key.clone(), "engine fallback");
                                            o.after_engine.push(id.clone()); for t in waiting { o.starting.entry(id.clone()).or_insert((0, vec![])).1.push(t); }
                                            let tx = o.tx.clone(); let t2 = tid.clone();
                                            tokio::spawn(async move { let r = Ctx::fetch_engine(&p, Some(&prog)).await.map(|_| p); let _ = tx.send(Done::Engine(t2, r)); });
                                        }
                                        Ok(None) => { let _ = o.start(ctx, &id, None, None).await; for t in waiting { o.starting.entry(id.clone()).or_insert((0, vec![])).1.push(t); } }
                                        Err(e2) => { for t in waiting { o.finish(&t, &Err(e2.clone())); } }
                                    },
                                    None => { for t in waiting { o.finish(&t, &Err(e.clone())); } }
                                }
                            }
                        }
                    }
                    Done::Hf(t, r) => { if let Err(e) = &r { ctx.log(&format!("Hugging Face download failed: {e}")); } o.finish(&t, &r); last_scan = std::time::Instant::now() - Duration::from_secs(10); }
                    Done::Found(id, dir, res) => {
                        o.checking.remove(&dir);
                        let t = format!("found-{}", dir.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default());
                        match res {
                            Ok(rec) if rec["custom"] == true => match ctx.adopt_custom(&dir, rec).await {
                                Ok(core::Adopted::Registered(_)) => o.finish(&t, &Ok(())),
                                Ok(core::Adopted::AlreadyHave(cid)) => { let e = format!("this file is the model of {cid}, which is already installed"); ctx.log(&format!("{}: {e}", dir.display())); o.rejected.insert(dir.clone(), std::time::UNIX_EPOCH); o.finish(&t, &Err(e)); }
                                Ok(core::Adopted::Precomputed(plan)) => {
                                    let (tx, t2) = (o.tx.clone(), t.clone()); let prog = o.task(&format!("{t}-pre"), "precomputed files", &plan.id, "model-packs folder");
                                    o.finish(&t, &Ok(()));
                                    tokio::spawn(async move { let r = Ctx::fetch_pack(&plan, Some(&prog)).await.map(|_| (None, None, plan)); let _ = tx.send(Done::Pack(format!("{t2}-pre"), r)); });
                                }
                                Err(e) => { ctx.log(&format!("{}: {e}", dir.display())); o.finish(&t, &Err(e)); }
                            },
                            Ok(rec) => {
                                ctx.state["packs"][&id] = rec; let _ = ctx.save();
                                ctx.log(&format!("new pack in {}: {id} verified and available", ctx.packs_dir.display()));
                                o.finish(&t, &Ok(()));
                            }
                            Err(e) => {
                                ctx.log(&format!("pack folder {} not loaded: {e}", dir.display()));
                                o.rejected.insert(dir.clone(), std::fs::metadata(dir.join("sushila-pack.json")).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH));
                                o.finish(&t, &Err(e));
                            }
                        }
                    }
                    Done::Job(jid, res) => {
                        if current.as_ref().map(|c| c.0 == jid).unwrap_or(false) {
                            let (_, _, t0) = current.take().unwrap();
                            if let Some(jb) = q["jobs"].as_array_mut().unwrap().iter_mut().find(|x| x["id"] == jid.as_str()) {
                                // the result is marked as AI-made (library::mark_ai) with the job's model and prompt
                                let mark_pack = jb["model"].as_str().unwrap_or("").to_string();
                                let mark_remote = jb["owner"].as_str().map(|w| w != "local").unwrap_or(false);  // queued from another device
                                let mark_prompt = jb["params"]["prompt"].as_str().or(jb["params"]["style"].as_str()).or(jb["title"].as_str()).unwrap_or("").to_string();
                                match res.and_then(|o2| {
                                    // a picture, song or video goes to your files (Images/Music/Videos/<date>/<time>-<words>.<ext>, like
                                    // everything else you make, and is never removed by the queue); anything else stays a queue file
                                    let kind = match o2.ext.as_str() { "png" | "jpg" | "jpeg" | "webp" => Some("image"), "mp3" | "wav" | "flac" | "ogg" => Some("music"), "webm" | "mp4" => Some("video"), _ => None };
                                    let out = crate::locate::outputs(&ctx.data);
                                    let file = if let Some(k) = kind {
                                        let pp = &jb["params"];
                                        // what was asked, plus what the model decided (a song's written lyrics, bpm, key, ...)
                                        let mut details = library::prompt_details(pp);
                                        if let (Some(d), Some(i)) = (details.as_object_mut(), o2.info.as_object()) { for (k, v) in i { if k != "output_format" { d.insert(format!("model_{k}"), v.clone()); } } }
                                        let lyrics = o2.info["lyrics"].as_str().filter(|l| !l.trim().is_empty()).map(|l| json!(l)).unwrap_or(pp["lyrics"].clone());
                                        let meta = json!({ "pack": mark_pack, "prompt": mark_prompt, "remote": mark_remote, "source": "queue", "lyrics": lyrics, "duration": pp["duration"],
                                            "seed": pp["seed"], "frames": pp["video_frames"], "size": pp["width"].as_u64().map(|w| format!("{w}x{}", pp["height"].as_u64().unwrap_or(0))),
                                            "details": details });
                                        let p = library::save(&ctx.data, k, &o2.ext, &o2.bytes, &mark_prompt, meta).ok_or_else(|| format!("could not save the result in {}", out.display()))?;
                                        p.strip_prefix(&out).map(|r| r.to_string_lossy().replace('\\', "/")).map_err(err)?
                                    } else {
                                        let file = format!("{jid}.{}", o2.ext); std::fs::create_dir_all(&out).map_err(err)?;
                                        std::fs::write(out.join(&file), library::mark_ai(&o2.bytes, &o2.ext, &mark_pack, &mark_prompt, mark_remote)).map_err(err)?; file
                                    };
                                    Ok(json!({ "file": file, "mime": o2.mime, "bytes": o2.bytes.len() })) }) {
                                    Ok(outv) => { jb["output"] = outv; jb["status"] = json!("ready"); jb["progress"] = json!(format!("ready in {} s", t0.elapsed().as_secs()));
                                                  ctx.log(&format!("queue: {} is ready", jb["title"].as_str().filter(|t| !t.is_empty()).unwrap_or(jb["kind"].as_str().unwrap_or("job")))); }
                                    Err(e) => { jb["status"] = json!("failed"); jb["error"] = json!(e.chars().take(300).collect::<String>()); jb["progress"] = json!(""); ctx.log(&format!("queue: job failed: {e}")); }
                                }
                                jb["finished"] = json!(now_iso());
                            }
                            changed = true;
                        }
                    }
                }
            },
            _ = tokio::time::sleep(Duration::from_millis(400)) => {}
        }
        if ctx.data.join("shutdown-request.json").exists() { let _ = std::fs::remove_file(ctx.data.join("shutdown-request.json")); ctx.log("stop requested"); break; }
        // control requests (Host Station, the sushila commands): oldest first
        o.busy_model = current.as_ref().and_then(|c| q["jobs"].as_array().and_then(|a| a.iter().find(|x| x["id"] == c.0.as_str())).and_then(|x| x["model"].as_str().map(String::from)));
        for r in take_requests(&ctx.data, "control-in") { control(ctx, &mut o, r).await; }
        // the model-packs folder: new pack folders are verified and become available; removed ones disappear (no restart)
        if last_scan.elapsed() > Duration::from_secs(3) {
            last_scan = std::time::Instant::now();
            let sc = ctx.scan_packs();
            o.rejected.retain(|d, _| d.exists());  // a bad folder that was deleted is no longer listed
            for (id, dir) in sc.new {
                if o.checking.contains(&dir) { continue; }
                let stamp = std::fs::metadata(dir.join("sushila-pack.json")).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                if o.rejected.get(&dir) == Some(&stamp) { continue; }  // failed before and unchanged
                o.checking.insert(dir.clone());
                let t = format!("found-{}", dir.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default());
                let prog = o.task(&t, "check new pack", &id, "model-packs folder");
                ctx.log(&format!("new folder in {}: checking {id}", ctx.packs_dir.display()));
                let (tx, data, d2) = (o.tx.clone(), ctx.data.clone(), dir.clone());
                tokio::task::spawn_blocking(move || { let r = core::verify_pack_folder(&data, &d2, Some(&prog)); let _ = tx.send(Done::Found(id, d2, r)); });
            }
            for (id, dir) in sc.moved {
                ctx.log(&format!("{id}: found in {} (its folder moved); using it there", dir.display()));
                ctx.state["packs"][&id]["dir"] = json!(dir.to_string_lossy()); let _ = ctx.save();
            }
            for id in sc.gone {
                ctx.log(&format!("{id}: its folder was removed from {}; no longer available", ctx.packs_dir.display()));
                if ctx.state["running"][&id].is_object() { ctx.stop_model(&id).await; }
                if let Some(m) = ctx.state["packs"].as_object_mut() { m.remove(&id); }
                let _ = ctx.save();
            }
            let probs = json!(sc.problems.into_iter().chain(o.rejected.keys().map(|d| json!({ "folder": d.file_name().map(|f| f.to_string_lossy().to_string()), "problem": "did not pass the checks (see Logs)" }))).collect::<Vec<_>>());
            if ctx.state["packProblems"] != probs { ctx.state["packProblems"] = probs; let _ = ctx.save(); }
        }
        // Standard / Accelerated switch from the page
        if let Some(m) = read_json(&ctx.data.join("mode-request.json")) {
            let _ = std::fs::remove_file(ctx.data.join("mode-request.json"));
            if let (Some(id), Some(mode)) = (m["model"].as_str(), m["mode"].as_str()) {
                if ctx.packs().contains_key(id) && ctx.state["running"][id]["mode"] != mode {
                    ctx.log(&format!("{id}: switching to {}", if mode == "turbo" { "Accelerated" } else { "Standard" }));
                    ctx.stop_model(id).await; o.cancel_start(id);
                    if let Err(e) = o.start(ctx, id, Some(mode), None).await { ctx.log(&format!("{id}: {e}")); }
                }
            }
        }
        if last_popular.elapsed() > Duration::from_secs(if ctx.setting("installQueue").as_array().map(|a| !a.is_empty()).unwrap_or(false) { 5 } else { 60 }) { last_popular = std::time::Instant::now(); keep_popular(ctx, &mut o, &mut popular_failed).await; }
        // idle models are unloaded (settings.idleMinutes); a request for one loads it again (webserver::reload_idle)
        let idle = ctx.setting("idleMinutes").as_u64().unwrap_or(0);
        if idle > 0 && last_idle.elapsed() > Duration::from_secs(5) {
            last_idle = std::time::Instant::now();
            let busy = current.as_ref().and_then(|c| q["jobs"].as_array().and_then(|a| a.iter().find(|x| x["id"] == c.0.as_str())).and_then(|x| x["model"].as_str().map(String::from)));
            for (id, r) in ctx.state["running"].as_object().cloned().unwrap_or_default() {
                if r["ready"] != true || o.starting.contains_key(&id) || busy.as_deref() == Some(id.as_str()) || webserver::in_flight(&id) > 0 { continue; }
                // the last use: a request through this server, the engine's own log (CLI jobs talk to it directly), or the start
                let log_t = std::fs::metadata(ctx.data.join("logs").join(format!("{id}.log"))).and_then(|m| m.modified()).ok();
                let start_t = r["startedAt"].as_str().and_then(cmds::iso_secs).map(|s| std::time::UNIX_EPOCH + Duration::from_secs(s));
                let last = [webserver::last_use(&id), log_t, start_t].into_iter().flatten().max();
                if last.and_then(|t| t.elapsed().ok()).map(|e| e > Duration::from_secs(idle * 60)).unwrap_or(false) {
                    ctx.log(&format!("{id}: idle for {idle} min: unloaded (it loads again on the next request)"));
                    ctx.stop_model(&id).await;
                    webserver::mark_idle(&id, true);
                }
            }
        }
        // models that exited on their own
        let dead: Vec<(String, std::process::ExitStatus)> = { let mut g = ctx.procs.lock().await; g.iter_mut().filter_map(|(id, c)| c.try_wait().ok().flatten().map(|s| (id.clone(), s))).collect() };
        for (id, status) in dead {
            let code = status.code();
            if o.starting.contains_key(&id) { continue; }
            // a model's engine crashed: record why, restart it (at most 3 times in 10 minutes)
            let mode = ctx.state["running"][&id]["mode"].as_str().map(String::from);
            let log = ctx.data.join("logs").join(format!("{id}.log"));
            let r = crash_counts.entry(id.clone()).or_default(); r.retain(|t: &std::time::Instant| t.elapsed() < Duration::from_secs(600)); r.push(std::time::Instant::now());
            let again = r.len() <= 3;
            core::record_crash(&ctx.data, json!({ "time": now_iso(), "what": "model", "pack": id, "reason": code.map(|c| format!("exit code {c}")).unwrap_or("stopped by the operating system".into()),
                "logTail": core::tail_lines(&log, 25), "restarted": again }));
            // the reason in words, and the last line this run wrote (often the error itself)
            let last = std::fs::read_to_string(&log).ok().and_then(|t| t.rsplit("----- start ").next().and_then(|r| r.lines().skip(1).collect::<Vec<_>>().into_iter().rev().find(|l| !l.trim().is_empty()).map(|l| l.chars().take(200).collect::<String>())));
            let why = core::exit_reason(status);
            ctx.log(&format!("{id} stopped unexpectedly{}; {}{} (see {})", if why.is_empty() { " (killed)".to_string() } else { why },
                if again { "restarting it" } else { "not restarted: 3 crashes in 10 minutes" }, last.map(|l| format!("; its last line: {l}")).unwrap_or_default(), log.display()));
            ctx.log(&format!("why: {}", diag::one_line(&diag::diagnose(&ctx.data, &id))));
            ctx.stop_model(&id).await;
            if again { if let Err(e) = o.start(ctx, &id, mode.as_deref(), None).await { ctx.log(&format!("{id}: {e}")); } }
        }
        // queue requests from pages: add / pause / resume / cancel / remove
        for r in take_requests(&ctx.data, "queue-in") {
            let id = r["id"].as_str().unwrap_or("").to_string();
            let act = r["action"].as_str().unwrap_or("").to_string();
            if act == "add" {
                if !q["jobs"].as_array().unwrap().iter().any(|x| x["id"] == id.as_str()) {
                    q["jobs"].as_array_mut().unwrap().push(json!({ "id": id, "owner": r["owner"], "kind": r["kind"], "model": r["model"], "title": r["title"], "params": r["params"], "status": "queued", "created": now_iso(), "progress": "" }));
                    ctx.log(&format!("queue: added {} for {}", r["kind"].as_str().unwrap_or("job"), r["model"].as_str().unwrap_or("")));
                }
            } else if id == "all" { q["paused"] = json!(act == "pause"); }
            else {
                let is_cur = current.as_ref().map(|c| c.0 == id).unwrap_or(false);
                if let Some(jb) = q["jobs"].as_array_mut().unwrap().iter_mut().find(|x| x["id"] == id.as_str()) {
                    let st = jb["status"].as_str().unwrap_or("").to_string();
                    match act.as_str() {
                        "pause" if st == "queued" || st == "running" => { if is_cur { if let Some((_, h, _)) = current.take() { h.abort(); } } jb["status"] = json!("paused"); jb["progress"] = json!("paused: starts over when continued"); }
                        "resume" if ["paused", "failed", "cancelled"].contains(&st.as_str()) => { jb["status"] = json!("queued"); jb["error"] = json!(""); jb["progress"] = json!(""); }
                        "cancel" if ["queued", "paused", "running"].contains(&st.as_str()) => { if is_cur { if let Some((_, h, _)) = current.take() { h.abort(); } } jb["status"] = json!("cancelled"); jb["progress"] = json!("cancelled"); }
                        _ => {}
                    }
                }
                if act == "remove" && !current.as_ref().map(|c| c.0 == id).unwrap_or(false) {
                    if let Some(f) = q["jobs"].as_array().unwrap().iter().find(|x| x["id"] == id.as_str()).and_then(|x| x["output"]["file"].as_str().map(String::from)).filter(|f| !f.contains(['/', '\\'])) { let _ = std::fs::remove_file(crate::locate::outputs(&ctx.data).join(f)); }  // your files (Images/...) stay
                    q["jobs"].as_array_mut().unwrap().retain(|x| x["id"] != id.as_str());
                }
            }
            changed = true;
        }
        // the running job's progress
        if let Some((id, _, _)) = current.as_ref() {
            let p = progress.lock().unwrap().clone();
            if let Some(jb) = q["jobs"].as_array_mut().unwrap().iter_mut().find(|x| x["id"] == id.as_str()) { if !p.is_empty() && jb["progress"] != p.as_str() { jb["progress"] = json!(p); changed = true; } }
        }
        // the next job: its model is started in the background first
        if current.is_none() && q["paused"] != true {
            if let Some(jb) = q["jobs"].as_array().unwrap().iter().find(|x| x["status"] == "queued").cloned() {
                let (jid, model, kind) = (jb["id"].as_str().unwrap_or("").to_string(), jb["model"].as_str().unwrap_or("").to_string(), jb["kind"].as_str().unwrap_or("text").to_string());
                let entry_err = |q: &mut Value, e: String| { if let Some(x) = q["jobs"].as_array_mut().unwrap().iter_mut().find(|x| x["id"] == jid.as_str()) { x["status"] = json!("failed"); x["error"] = json!(e); } };
                if !ctx.packs().contains_key(&model) { entry_err(&mut q, format!("{model} is not installed on this computer")); changed = true; }
                else if ctx.state["running"][&model]["ready"] == true {
                    let port = ctx.state["running"][&model]["port"].as_u64().unwrap_or(0) as u16;
                    let accel = if ctx.state["running"][&model]["mode"] == "turbo" { turbo_request(&ctx.state["packs"][&model]) } else { None };
                    let (params, pr, tx, t, jid2) = (jb["params"].clone(), progress.clone(), o.tx.clone(), std::time::Instant::now(), jid.clone());
                    *pr.lock().unwrap() = String::new();
                    let h = tokio::spawn(async move { let r = jobs::run(&kind, &model, port, &params, accel, move |w| { *pr.lock().unwrap() = format!("{w}… {} s", t.elapsed().as_secs()); }).await; let _ = tx.send(Done::Job(jid2, r)); });
                    if let Some(x) = q["jobs"].as_array_mut().unwrap().iter_mut().find(|x| x["id"] == jid.as_str()) { x["status"] = json!("running"); x["started"] = json!(now_iso()); x["error"] = json!(""); }
                    current = Some((jid, h, std::time::Instant::now()));
                    changed = true;
                } else if !ctx.state["running"][&model].is_object() && !o.starting.contains_key(&model) {
                    // the same admission rule as every start: the job waits while another model is working
                    match make_room(ctx, &mut o, &model).await {
                        Err(why) => { if let Some(x) = q["jobs"].as_array_mut().unwrap().iter_mut().find(|x| x["id"] == jid.as_str()) { let w = json!(format!("waiting: {why}")); if x["progress"] != w { x["progress"] = w; changed = true; } } }
                        Ok(()) => {
                            if let Some(x) = q["jobs"].as_array_mut().unwrap().iter_mut().find(|x| x["id"] == jid.as_str()) { x["progress"] = json!("starting the model…"); }
                            if let Err(e) = o.start(ctx, &model, None, None).await { entry_err(&mut q, e); }
                            changed = true;
                        }
                    }
                }
            }
        }
        if changed { prune_queue(&mut q, &ctx.data); save_q(&q, &qpath); }
        if (o.publish(ctx) && last_pub.elapsed() > Duration::from_millis(700)) || last_pub.elapsed() > Duration::from_secs(5) { let _ = ctx.save(); last_pub = std::time::Instant::now(); }
    }
    if let Some((_, h, _)) = current.take() { h.abort(); }
    for jb in q["jobs"].as_array_mut().into_iter().flatten() { if jb["status"] == "running" { jb["status"] = json!("queued"); jb["progress"] = json!("continues after a restart"); } }
    save_q(&q, &qpath);
    // what runs now, for the next start (a restart or a handover resumes it)
    let running: Vec<Value> = ctx.state["running"].as_object().map(|m| m.iter().map(|(id, r)| json!({ "pack": id, "mode": r["mode"] })).collect()).unwrap_or_default();
    let _ = write_atomic(&ctx.data.join("resume.json"), json!({ "at": now_iso(), "running": running }).to_string().as_bytes());
    let _ = tokio::time::timeout(Duration::from_secs(5), tunnel::stop(&ctx.data)).await;  // the link then answers "not answering: how to restart" (offline: at most 5 s)
    ctx.stop_all().await;
    ctx.state["owner"] = Value::Null; ctx.state["tasks"] = json!([]);
    let _ = ctx.save();
    let _ = stop_tx.send(());
    tokio::time::sleep(Duration::from_millis(300)).await;
    ctx.log("stopped");
    drop(lock);
    Ok(())
}

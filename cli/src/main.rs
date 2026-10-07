// sushila: Sushila.cpp from the command line, the same commands on Windows, macOS and Linux.
//
//   sushila engine install            Sushila.cpp for this computer's GPU (CUDA, Vulkan, Metal; CPU only as a fallback)
//   sushila packs                     the model packs in the catalog (installed ones marked)
//   sushila install <pack>|<file>     download (or take a .sushilapack file), check the Sushila signature and every sha256
//   sushila serve [<pack>...]         the inference page + OpenAI-compatible API on http://127.0.0.1:8765, models, the queue
//   sushila run <pack> "<prompt>"     one answer, picture, video or song, printed or saved (for scripts and tests)
//   sushila status | stop | list | verify | remove <pack> | service install | selftest
//
// The web page it serves (web/sushila_page.js) is the whole user interface: inference, and managing this computer's
// Sushila (packs, engine, queue, logs) through the server, which alone changes anything (one source of truth).
mod net;
#[allow(dead_code)]
mod webserver;
mod core;
mod jobs;
mod util;

use std::{path::PathBuf, process::ExitCode, time::Duration};
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use crate::core::*;
use crate::util::*;

#[derive(Parser)]
#[command(name = "sushila", version, about = "Sushila.cpp from the command line: the same commands on Windows, macOS and Linux",
          after_help = "Examples:\n  sushila install qwen3-4b-instruct-2507\n  sushila serve                      # then open http://127.0.0.1:8765\n  sushila run qwen2.5-0.5b-q4km \"Write a haiku about GPUs\"\n  sushila selftest                   # engine + smallest model + one answer: exit code 0 = works")]
struct Cli {
    /// Data folder (default: the one Sushila Host Station uses; or $SUSHILA_HOME)
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,
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
    /// Install model packs by id, or from .sushilapack files
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
    /// The address of the inference page (opens with just the address on this computer)
    Url,
    /// Access keys for other machines (when serving on the network): `keys add <name>`, `keys list`, `keys remove <name>`
    Keys { #[command(subcommand)] act: KeysCmd },
    /// Start `sushila serve` when the computer starts: `service install [--packs a,b] [--host 0.0.0.0]`, `service remove`
    Service { #[command(subcommand)] act: ServiceCmd },
    /// The Admin tab's password: `sushila password` sets it, or changes it (asks the current one first); lost it? `--reset` (this computer only)
    Password { #[arg(long)] reset: bool },
    /// End-to-end check: engine, the smallest model, one answer (exit code 0 = everything works)
    Selftest { #[arg(long, default_value = DEFAULT_MODEL)] pack: String },
}
#[derive(Subcommand)]
enum EngineCmd { Install { /// cpu, vulkan, cuda, or a full key like linux-x86_64-vulkan
        #[arg(long)] build: Option<String> }, Info }
#[derive(Subcommand)]
enum KeysCmd { Add { name: String }, List, Remove { name: String } }
#[derive(Subcommand)]
enum ServiceCmd { Install { #[arg(long)] packs: Option<String>, #[arg(long)] host: Option<String>, #[arg(long)] port: Option<u16>, #[arg(long)] public: bool }, Remove }

#[tokio::main]
async fn main() -> ExitCode {
    let _ = net::AGENT.set(format!("sushila/{}", env!("CARGO_PKG_VERSION")));
    let mut cli = Cli::parse();
    // started without a command (e.g. double-clicked in Explorer or Finder): serve, and open the page in the browser
    let double_click = cli.cmd.is_none();
    if double_click && std::env::var("SUSHILA_WORKER").is_err() {
        eprintln!("Sushila {}: starting the server; the page opens in your browser. Close this window (or Ctrl+C) to stop.\nCommands: sushila --help", env!("CARGO_PKG_VERSION"));
        cli.cmd = Some(Cmd::Serve { packs: vec![], port: None, host: None, public: false, standard: false, max: 1, open: false });
    }
    if double_click && std::env::var("SUSHILA_NO_BROWSER").is_err() && std::env::var("SUSHILA_WORKER").is_ok() {
        tokio::spawn(async {
            for _ in 0..600 {
                tokio::time::sleep(Duration::from_secs(2)).await;
                if http_text("http://127.0.0.1:8765/api/state", 2).await.ok().map(|s| s.contains("\"ready\":true")).unwrap_or(false) { open_browser("http://localhost:8765/"); return; }
            }
        });
    }
    let data = cli.data_dir.clone().unwrap_or_else(default_data_dir);
    // `sushila serve` is a small supervisor: the real server runs as its child (SUSHILA_WORKER=1) and is restarted at
    // once if it crashes; why it crashed goes to crashes.json and the log (Admin tab -> Logs).
    if matches!(cli.cmd, Some(Cmd::Serve { .. })) && std::env::var("SUSHILA_WORKER").is_err() {
        return supervise(data, cli.quiet).await;
    }
    if std::env::var("SUSHILA_WORKER").is_ok() {
        let panic_file = data.join("logs").join("panic.txt");
        std::panic::set_hook(Box::new(move |info| {
            let bt = std::backtrace::Backtrace::force_capture();
            let _ = std::fs::write(&panic_file, format!("{info}\n\n{bt}"));
            eprintln!("sushila crashed: {info}");
        }));
    }
    let mut ctx = match Ctx::load(data, cli.quiet) { Ok(c) => c, Err(e) => { eprintln!("error: {e}"); return ExitCode::from(1); } };
    match dispatch(&cli, &mut ctx).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => { if cli.json { println!("{}", json!({ "ok": false, "error": e })); } else { eprintln!("error: {e}"); } ExitCode::from(1) }
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
    let mut recent: Vec<std::time::Instant> = vec![];
    let mut restarts = 0u32;
    loop {
        let t0 = std::time::Instant::now();
        let mut c = tokio::process::Command::new(&exe);
        c.args(&args).env("SUSHILA_WORKER", "1");
        if restarts > 0 { c.env("SUSHILA_NO_BROWSER", "1").env_remove("SUSHILA_TEST_PANIC_AFTER"); }
        let status = match c.status().await { Ok(s) => s, Err(e) => { eprintln!("error: could not start the server: {e}"); return ExitCode::from(1); } };
        let up = t0.elapsed();
        if status.success() || stopping.load(std::sync::atomic::Ordering::SeqCst) { return ExitCode::SUCCESS; }
        if restarts == 0 && up < Duration::from_secs(8) && status.code() == Some(1) { return ExitCode::from(1); }  // did not start: the error is already printed
        let mut reason = match status.code() { Some(c) => format!("exit code {c}"), None => "stopped by the operating system".into() };
        #[cfg(unix)]
        { use std::os::unix::process::ExitStatusExt; if let Some(sig) = status.signal() { reason = format!("killed by signal {sig}{}", match sig { 9 => " (SIGKILL: often out of memory)", 11 => " (SIGSEGV: memory fault)", 6 => " (SIGABRT)", _ => "" }); } }
        let pf = data.join("logs").join("panic.txt");
        let panic = std::fs::read_to_string(&pf).ok().filter(|_| std::fs::metadata(&pf).and_then(|m| m.modified()).map(|m| m.elapsed().map(|e| e <= up + Duration::from_secs(2)).unwrap_or(false)).unwrap_or(false));
        let _ = std::fs::remove_file(&pf);
        let killed = core::kill_orphans(&data);
        core::record_crash(&data, json!({ "time": now_iso(), "what": "server", "reason": reason, "panic": panic.as_deref().map(|p| p.chars().take(4000).collect::<String>()),
            "uptimeSeconds": up.as_secs(), "logTail": core::tail_lines(&data.join("logs").join("sushila.log"), 30), "stoppedEngines": killed }));
        recent.retain(|t| t.elapsed() < Duration::from_secs(300)); recent.push(std::time::Instant::now());
        let wait = if recent.len() > 5 { 60 } else { 1 };
        core::log(quiet, &format!("the server stopped unexpectedly ({reason}{}); restarting in {wait} s (details: Admin tab -> Logs -> Crashes)",
            panic.as_deref().map(|p| format!(": {}", p.lines().next().unwrap_or(""))).unwrap_or_default()));
        restarts += 1;
        for _ in 0..wait * 10 { if stopping.load(std::sync::atomic::Ordering::SeqCst) { return ExitCode::SUCCESS; } tokio::time::sleep(Duration::from_millis(100)).await; }
    }
}

fn out(json_mode: bool, v: Value, text: impl FnOnce() -> String) {
    if json_mode { println!("{}", serde_json::to_string_pretty(&v).unwrap()); } else { println!("{}", text()); }
}

/// The running server on this computer (the owner), if any: its port.
async fn owner_port(ctx: &Ctx) -> Option<u16> {
    let port = ctx.setting("port").as_u64().unwrap_or(8765) as u16;
    http_text(&format!("http://127.0.0.1:{port}/api/state"), 2).await.ok().map(|_| port)
}
/// Sends a request to the owner and follows it to the end (progress on stderr). The same path Host Station uses.
async fn remote(ctx: &Ctx, port: u16, body: Value) -> Result<(), String> {
    let token = ctx.state["token"].as_str().unwrap_or("").to_string();
    let c = reqwest::Client::new();
    let r = c.post(format!("http://127.0.0.1:{port}/api/control")).header("x-sushila-token", &token).header("x-sushila-admin", webserver::cli_token(&ctx.data)).json(&body).send().await.map_err(err)?;
    if !r.status().is_success() { return Err(format!("the server refused: {} {}", r.status(), r.text().await.unwrap_or_default())); }
    let id = r.json::<Value>().await.map_err(err)?["id"].as_str().unwrap_or("").to_string();
    if !ctx.quiet { eprintln!("sent to the running server ({}): task {id}", format!("http://127.0.0.1:{port}")); }
    let tty = std::io::IsTerminal::is_terminal(&std::io::stderr());
    loop {
        tokio::time::sleep(Duration::from_millis(700)).await;
        let st: Value = c.get(format!("http://127.0.0.1:{port}/api/state")).send().await.map_err(err)?.json().await.map_err(err)?;
        let Some(t) = st["tasks"].as_array().and_then(|a| a.iter().find(|t| t["id"] == id.as_str())).cloned() else { continue };
        match t["status"].as_str() {
            Some("done") => { if tty && !ctx.quiet { eprint!("\r{:<100}\r", ""); } return Ok(()); }
            Some("failed") => { if tty && !ctx.quiet { eprintln!(); } return Err(t["error"].as_str().unwrap_or("failed").to_string()); }
            _ => if !ctx.quiet && t["total"].as_u64().unwrap_or(0) > 0 {
                let line = format!("  {}: {:.1}% of {}", t["label"].as_str().unwrap_or(""), 100.0 * t["done"].as_f64().unwrap_or(0.0) / t["total"].as_f64().unwrap_or(1.0), human(t["total"].as_u64().unwrap_or(0)));
                if tty { eprint!("\r{line:<100}"); }
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
            let v = json!({ "sushila": env!("CARGO_PKG_VERSION"), "engine": ctx.state["engine"], "platform": ctx.platform_key(), "nvidia": gpu, "otherGpu": other, "dataDir": ctx.data.to_string_lossy(), "cpus": ctx.info["cpus"], "memory": ctx.info["memory_bytes"] });
            out(j, v.clone(), || {
                let e = &ctx.state["engine"];
                format!("sushila {}\nengine:   {}\nplatform: {}\nGPU:      {}\ndata:     {}",
                    env!("CARGO_PKG_VERSION"),
                    if e.is_object() { format!("Sushila.cpp {} ({}) {}", e["version"].as_str().unwrap_or(""), Ctx::gpu_label(e["key"].as_str().unwrap_or("")), e["dir"].as_str().unwrap_or("")) } else { "not installed (sushila engine install)".into() },
                    ctx.platform_key(),
                    gpu.map(|g| format!("{} ({} GB, compute {})", g["name"].as_str().unwrap_or(""), g["memoryGB"], g["compute"])).or(other).unwrap_or_else(|| "none found (CPU)".into()),
                    ctx.data.display())
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
                if p.ends_with(".sushilapack") || path.is_file() { done.push(ctx.install_pack_file(&path).await?); }
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
            let port = ctx.setting("port").as_u64().unwrap_or(8765);
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
            let port = ctx.setting("port").as_u64().unwrap_or(8765);
            let token = ctx.state["token"].as_str().unwrap_or("").to_string();
            let r = reqwest::Client::new().post(format!("http://127.0.0.1:{port}/api/shutdown")).header("x-sushila-token", token).header("x-sushila-admin", webserver::cli_token(&ctx.data)).send().await;
            match r { Ok(r) if r.status().is_success() => out(j, json!({ "ok": true }), || "stopping sushila serve".into()),
                      _ => { std::fs::write(ctx.data.join("shutdown-request.json"), "{}").map_err(err)?; out(j, json!({ "ok": true, "note": "no server answered; a stop request was left for it" }), || "no server answered on this computer".into()) } }
        }
        Cmd::Url => {
            let port = ctx.setting("port").as_u64().unwrap_or(8765);
            ctx.save()?;
            let u = format!("http://localhost:{port}/");
            out(j, json!({ "url": u }), || u.clone());
        }
        Cmd::Keys { act } => keys(ctx, act, j)?,
        Cmd::Password { reset } => {
            let f = ctx.data.join("adminpassword");
            if *reset {
                // the way back for an owner who lost the password: only on this computer, as the user who owns the data folder
                let _ = std::fs::remove_file(&f);
                ctx.log("admin password reset from the command line");
                if std::io::IsTerminal::is_terminal(&std::io::stdin()) { ask_password(ctx, true)?; out(j, json!({ "ok": true }), || "admin password reset and a new one saved".into()); }
                else { out(j, json!({ "ok": true }), || format!("admin password removed ({}); set a new one with `sushila password` or on the Admin tab of this computer", f.display())); }
            } else {
                if webserver::password_set(&ctx.data) {
                    // changing it needs the current one (lost it? `sushila password --reset`)
                    if !std::io::IsTerminal::is_terminal(&std::io::stdin()) { return Err("run this in a terminal".into()); }
                    let cur = rpassword::prompt_password("Current admin password: ").map_err(err)?;
                    if !webserver::check_password(&ctx.data, &cur) { std::thread::sleep(Duration::from_secs(1)); ctx.log("admin password change refused: wrong current password"); return Err("wrong current password (lost it? `sushila password --reset`)".into()); }
                }
                ask_password(ctx, true)?;
                ctx.log("admin password changed from the command line");
                out(j, json!({ "ok": true }), || "admin password saved (as an Argon2 hash in the adminpassword file)".into());
            }
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
            let t0 = std::time::Instant::now();
            let mut steps = vec![];
            ctx.load_catalog().await?; steps.push("catalog reachable and parsed");
            if !ctx.engine_ok() { ctx.install_engine(None).await?; }
            steps.push("engine installed (signed build, sha256 checked)");
            ctx.install_pack(pack).await?; steps.push("pack installed (signed index, every sha256 checked)");
            let bad = ctx.verify_pack(pack)?; if !bad.is_empty() { return Err(format!("verify: {}", bad.join(", "))); }
            steps.push("pack verified");
            let port = ctx.start_model(pack, None).await?; steps.push("model started and healthy");
            let t1 = std::time::Instant::now();
            let r = jobs::run("text", pack, port, &json!({ "prompt": "Reply with one word: hello", "max_tokens": 32, "temperature": 0 }), None, |_| {}).await;
            let gen_s = t1.elapsed().as_secs_f64();
            ctx.stop_model(pack).await;
            let text = String::from_utf8_lossy(&r?.bytes).to_string();
            if text.trim().is_empty() { return Err("the model answered with nothing".into()); }
            steps.push("answer generated");
            let v = json!({ "ok": true, "platform": ctx.platform_key(), "engine": ctx.state["engine"]["key"], "pack": pack, "answer": text.trim(), "answer_seconds": gen_s, "total_seconds": t0.elapsed().as_secs_f64(), "steps": steps });
            out(j, v.clone(), || format!("{}\nanswer: {}\nPASS on {} with {} ({:.1} s)", steps.iter().map(|s| format!("ok  {s}")).collect::<Vec<_>>().join("\n"), text.trim(), ctx.platform_key(), Ctx::gpu_label(ctx.state["engine"]["key"].as_str().unwrap_or("")), t0.elapsed().as_secs_f64()));
        }
    }
    Ok(())
}

fn keys(ctx: &mut Ctx, act: &KeysCmd, j: bool) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    if !ctx.state["share"]["keys"].is_array() { ctx.state["share"]["keys"] = json!([]); }
    match act {
        KeysCmd::Add { name } => {
            let key = format!("sk-sushila-{}", random_token());
            ctx.state["share"]["keys"].as_array_mut().unwrap().push(json!({ "name": name, "sha256": hex::encode(Sha256::digest(key.as_bytes())), "created": now_iso() }));
            ctx.save()?;
            out(j, json!({ "name": name, "key": key }), || format!("access key for {name} (shown once; only its sha256 is stored):\n{key}\nUse it as: Authorization: Bearer {key}"));
        }
        KeysCmd::List => { let names: Vec<Value> = ctx.state["share"]["keys"].as_array().unwrap().iter().map(|k| json!({ "name": k["name"], "created": k["created"] })).collect();
            out(j, json!(names), || names.iter().map(|k| format!("{}  {}", k["name"].as_str().unwrap_or(""), k["created"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n")); }
        KeysCmd::Remove { name } => { ctx.state["share"]["keys"].as_array_mut().unwrap().retain(|k| k["name"] != name.as_str()); ctx.save()?; out(j, json!({ "ok": true }), || format!("{name} removed")); }
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
/// Asks for the Admin tab's password in the terminal (twice, not shown) and saves its hash.
fn ask_password(ctx: &Ctx, change: bool) -> Result<(), String> {
    if !std::io::IsTerminal::is_terminal(&std::io::stdin()) { return Err("no terminal to ask in: set it on the Admin tab of http://localhost:8765/ instead".into()); }
    eprintln!("{} the admin password for the Admin tab of the web page (at least 8 characters).\nLost it later? Delete {} and restart: it is asked again.",
        if change { "Choose" } else { "First start: choose" }, ctx.data.join("adminpassword").display());
    for _ in 0..3 {
        let a = rpassword::prompt_password("Admin password: ").map_err(err)?;
        let b = rpassword::prompt_password("Again: ").map_err(err)?;
        if a != b { eprintln!("The two do not match; try again."); continue; }
        match webserver::set_password(&ctx.data, &a) { Ok(()) => return Ok(()), Err(e) => eprintln!("{e}") }
    }
    Err("no admin password set".into())
}
fn open_browser(url: &str) {
    let _ = if cfg!(windows) { std::process::Command::new("cmd").args(["/c", "start", "", url]).spawn() }
            else if cfg!(target_os = "macos") { std::process::Command::new("open").arg(url).spawn() }
            else { std::process::Command::new("xdg-open").arg(url).spawn() };
}
fn local_ip() -> Option<String> { let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?; s.connect("8.8.8.8:80").ok()?; Some(s.local_addr().ok()?.ip().to_string()) }
fn read_json(p: &std::path::Path) -> Option<Value> { std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()) }

enum Done {
    Engine(String, Result<core::EnginePlan, String>),                       // task id
    Pack(String, Result<(Option<core::EnginePlan>, core::PackPlan), String>),
    Ready(Option<String>, String, Result<(), String>),                       // task id, pack id
    Job(String, Result<jobs::Output, String>),                               // queue job id
}

struct Owner {
    tasks: Vec<Value>,                                   // newest last; mirrored in state.public.tasks
    prog: std::collections::HashMap<String, Prog>,       // live progress of downloads
    tx: tokio::sync::mpsc::UnboundedSender<Done>,
    starting: std::collections::HashSet<String>,         // packs loading in the background
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
    async fn start(&mut self, ctx: &mut Ctx, id: &str, mode: Option<&str>, task: Option<String>) -> Result<(), String> {
        if self.starting.contains(id) { return Ok(()); }
        let s = ctx.spawn_model(id, mode).await?;
        if s.already { if let Some(t) = task { self.finish(&t, &Ok(())); } return Ok(()); }
        self.starting.insert(id.to_string());
        let (tx, procs, pid) = (self.tx.clone(), ctx.procs.clone(), id.to_string());
        tokio::spawn(async move { let r = core::wait_ready(procs, &s).await; let _ = tx.send(Done::Ready(task, pid, r)); });
        Ok(())
    }
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
                ctx.load_catalog().await?;
                let id2 = ctx.best_variant(&pack).await;
                let eng = if ctx.engine_ok() { None } else { ctx.prepare_engine(None).await? };
                let Some(p) = ctx.prepare_pack(&id2).await? else { return Ok(true) };
                if p.pack["serve"]["engine"] == "image-nunchaku" && !ctx.state["runtimes"]["image-nunchaku"].is_object() { ctx.install_runtime("image-nunchaku").await?; }
                let tx = o.tx.clone(); let t = id.clone();
                tokio::spawn(async move {
                    let r = async { if let Some(e) = &eng { Ctx::fetch_engine(e, Some(&prog)).await?; } Ctx::fetch_pack(&p, Some(&prog)).await?; Ok((eng, p)) }.await;
                    let _ = tx.send(Done::Pack(t, r));
                });
                Ok(false)
            }
            "install-file" => { let p = PathBuf::from(r["path"].as_str().unwrap_or("")); let got = ctx.install_pack_file(&p).await?; ctx.log(&format!("{got} installed from {}", p.display())); Ok(true) }
            "verify" => { let bad = ctx.verify_pack(&pack)?; if bad.is_empty() { Ok(true) } else { Err(format!("missing or changed: {}", bad.join(", "))) } }
            "catalog" => { ctx.catalog = None; ctx.write_catalog_cache().await?; Ok(true) }
            "remove" => { if ctx.state["running"][&pack].is_object() { ctx.stop_model(&pack).await; } ctx.remove_pack(&pack)?; Ok(true) }
            "start" => { o.start(ctx, &pack, r["mode"].as_str(), Some(id.clone())).await?; Ok(ctx.state["running"][&pack]["ready"] == true) }
            "stop" => { ctx.stop_model(&pack).await; o.starting.remove(&pack); Ok(true) }
            "settings" => {
                for k in ["threads", "contextSize", "gpuLayers", "parallel", "keepCopy", "enginePort"] {
                    if let Some(v) = r["values"].get(k) { if v.is_number() || v.is_boolean() { ctx.state["settings"][k] = v.clone(); } }
                }
                ctx.save()?; Ok(true)
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
    if lock.try_lock().is_err() { return Err("another `sushila serve` (or Sushila Host Station's server) already owns this data folder: `sushila status`".into()); }
    if !ctx.engine_ok() { ctx.install_engine(None).await?; }
    if let Some(p) = port { ctx.state["settings"]["port"] = json!(p); }
    let port = ctx.setting("port").as_u64().unwrap_or(8765) as u16;
    let bind = host.unwrap_or_else(|| "127.0.0.1".into());
    let network = bind != "127.0.0.1" && bind != "localhost";
    ctx.state["share"]["open"] = json!(network && open);
    if network && open { eprintln!("--open: anyone who can reach port {port} can use the models without a key. Use it on trusted networks only."); }
    if network {
        ctx.state["share"]["enabled"] = json!(true);
        if ctx.state["share"]["hosts"].as_array().map(|a| a.is_empty()).unwrap_or(true) { ctx.state["share"]["hosts"] = json!(["*"]); }
        if !open && ctx.state["share"]["keys"].as_array().map(|a| a.is_empty()).unwrap_or(true) { eprintln!("Other machines need an access key: `sushila keys add <name>` (or serve with --open on a trusted network)."); }
    }
    ctx.state["running"] = json!({});
    ctx.state["tasks"] = json!([]);
    ctx.state["owner"] = json!({ "pid": std::process::id(), "since": now_iso(), "by": "sushila serve", "port": port });
    for f in ["shutdown-request.json", "mode-request.json"] { let _ = std::fs::remove_file(ctx.data.join(f)); }
    ctx.save()?;
    let (addr, stop_tx) = webserver::start(ctx.data.clone(), port, if bind == "localhost" { "127.0.0.1" } else { &bind }).await
        .map_err(|e| format!("{e} (is another server already running? `sushila status`)"))?;
    ctx.log(&format!("serving on {addr} (data {})", ctx.data.display()));
    if !webserver::password_set(&ctx.data) {
        if std::io::IsTerminal::is_terminal(&std::io::stdin()) { if let Err(e) = ask_password(ctx, false) { ctx.log(&format!("admin password: {e}")); } }
        else { ctx.log(&format!("no admin password yet: open http://localhost:{port}/#admin on this computer to set it")); }
    }
    if let Err(e) = ctx.write_catalog_cache().await { ctx.log(&format!("catalog: {e}")); }
    let page = if network { format!("http://localhost:{port}/ here; http://{}:{port}/ on the network; http://<public IP>:{port}/ from the internet if the firewall allows port {port} (use HTTPS in front for real internet use)", local_ip().unwrap_or_else(|| "<this machine's address>".into())) } else { format!("http://localhost:{port}/") };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Done>();
    let mut o = Owner { tasks: vec![], prog: Default::default(), tx, starting: Default::default() };
    let mut ids: Vec<String> = if packs.is_empty() { ctx.packs().keys().take(max).cloned().collect() } else { packs.to_vec() };
    if ids.is_empty() { ctx.log("no packs installed: installing the default model"); ctx.load_catalog().await?; let id = ctx.best_variant(DEFAULT_MODEL).await; ctx.install_pack(&id).await?; ids.push(id); }
    for id in &ids { if let Err(e) = o.start(ctx, id, if standard { Some("regular") } else { None }, None).await { ctx.log(&format!("{id}: {e}")); } }
    out(j, json!({ "ok": true, "page": page, "api": format!("{addr}/v1"), "models": ids }), || format!(
        "\nSushila is serving {} (loading in the background: `sushila status`)\n  page:  {page}\n  API:   {addr}/v1  (OpenAI-compatible; header x-sushila-token: <token>, or Authorization: Bearer <key> from other machines)\n  log:   {}\n  stop:  Ctrl+C, or `sushila stop`\n",
        ids.join(", "), ctx.data.join("logs").join("sushila.log").display()));
    // the queue: one job at a time, like the desktop app
    let qpath = ctx.data.join("queue.json");
    let mut q = read_json(&qpath).unwrap_or(json!({ "paused": false, "jobs": [] }));
    for jb in q["jobs"].as_array_mut().into_iter().flatten() { if jb["status"] == "running" { jb["status"] = json!("queued"); jb["progress"] = json!("continues after a restart"); } }
    let save_q = |q: &Value, p: &std::path::Path| { let tmp = p.with_extension("json.tmp"); let _ = std::fs::write(&tmp, serde_json::to_string_pretty(q).unwrap()); let _ = std::fs::rename(&tmp, p); };
    save_q(&q, &qpath);
    let mut current: Option<(String, tokio::task::JoinHandle<()>, std::time::Instant)> = None;
    let progress = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let ctrl_c = tokio::signal::ctrl_c(); tokio::pin!(ctrl_c);
    // for the crash-recovery test only: SUSHILA_TEST_PANIC_AFTER=<seconds> makes the server panic on purpose
    if let Some(secs) = std::env::var("SUSHILA_TEST_PANIC_AFTER").ok().and_then(|v| v.parse::<u64>().ok()) {
        std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(secs)); std::process::abort(); });
        tokio::spawn(async move { tokio::time::sleep(Duration::from_secs(secs.saturating_sub(1))).await; panic!("test panic (SUSHILA_TEST_PANIC_AFTER)"); });
    }
    let mut last_pub = std::time::Instant::now();
    let mut crash_counts: std::collections::HashMap<String, Vec<std::time::Instant>> = Default::default();
    loop {
        let mut changed = false;
        tokio::select! {
            _ = &mut ctrl_c => break,
            d = rx.recv() => if let Some(d) = d {
                match d {
                    Done::Engine(t, r) => { let r = r.and_then(|p| ctx.apply_engine(&p)); if let Err(e) = &r { ctx.log(&format!("engine install failed: {e}")); } o.finish(&t, &r); }
                    Done::Pack(t, r) => {
                        let r = r.and_then(|(e, p)| { if let Some(e) = e { ctx.apply_engine(&e)?; } ctx.apply_pack(&p) });
                        if let Err(e) = &r { ctx.log(&format!("install failed: {e}")); } o.finish(&t, &r);
                    }
                    Done::Ready(t, id, r) => {
                        o.starting.remove(&id);
                        match r {
                            Ok(()) => { let _ = ctx.model_ready(&id); if let Some(t) = t { o.finish(&t, &Ok(())); } }
                            Err(e) => {
                                ctx.log(&format!("{e}")); ctx.model_failed(&id).await;
                                if let Some(next) = ctx.fallback_for(&id, &e).await {
                                    match ctx.install_engine(Some(next)).await { Ok(()) => { let _ = o.start(ctx, &id, None, t.clone()).await; } Err(e2) => { if let Some(t) = t { o.finish(&t, &Err(e2)); } } }
                                } else if let Some(t) = t { o.finish(&t, &Err(e)); }
                            }
                        }
                    }
                    Done::Job(jid, res) => {
                        if current.as_ref().map(|c| c.0 == jid).unwrap_or(false) {
                            let (_, _, t0) = current.take().unwrap();
                            if let Some(jb) = q["jobs"].as_array_mut().unwrap().iter_mut().find(|x| x["id"] == jid.as_str()) {
                                match res.and_then(|o2| { let file = format!("{jid}.{}", o2.ext); std::fs::create_dir_all(ctx.data.join("outputs")).map_err(err)?;
                                                          std::fs::write(ctx.data.join("outputs").join(&file), &o2.bytes).map_err(err)?; Ok(json!({ "file": file, "mime": o2.mime, "bytes": o2.bytes.len() })) }) {
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
        let cdir = ctx.data.join("control-in");
        let mut cf: Vec<PathBuf> = std::fs::read_dir(&cdir).map(|d| d.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().map(|x| x == "json").unwrap_or(false)).collect()).unwrap_or_default();
        cf.sort();
        for f in cf { let r = read_json(&f); let _ = std::fs::remove_file(&f); if let Some(r) = r { control(ctx, &mut o, r).await; } }
        // Standard / Accelerated switch from the page
        if let Some(m) = read_json(&ctx.data.join("mode-request.json")) {
            let _ = std::fs::remove_file(ctx.data.join("mode-request.json"));
            if let (Some(id), Some(mode)) = (m["model"].as_str(), m["mode"].as_str()) {
                if ctx.packs().contains_key(id) && ctx.state["running"][id]["mode"] != mode {
                    ctx.log(&format!("{id}: switching to {}", if mode == "turbo" { "Accelerated" } else { "Standard" }));
                    ctx.stop_model(id).await; o.starting.remove(id);
                    if let Err(e) = o.start(ctx, id, Some(mode), None).await { ctx.log(&format!("{id}: {e}")); }
                }
            }
        }
        // models that exited on their own
        let dead: Vec<(String, Option<i32>)> = { let mut g = ctx.procs.lock().await; g.iter_mut().filter_map(|(id, c)| c.try_wait().ok().flatten().map(|s| (id.clone(), s.code()))).collect() };
        for (id, code) in dead {
            if o.starting.contains(&id) { continue; }
            // a model's engine crashed: record why, restart it (at most 3 times in 10 minutes)
            let mode = ctx.state["running"][&id]["mode"].as_str().map(String::from);
            let log = ctx.data.join("logs").join(format!("{id}.log"));
            let r = crash_counts.entry(id.clone()).or_default(); r.retain(|t: &std::time::Instant| t.elapsed() < Duration::from_secs(600)); r.push(std::time::Instant::now());
            let again = r.len() <= 3;
            core::record_crash(&ctx.data, json!({ "time": now_iso(), "what": "model", "pack": id, "reason": code.map(|c| format!("exit code {c}")).unwrap_or("stopped by the operating system".into()),
                "logTail": core::tail_lines(&log, 25), "restarted": again }));
            ctx.log(&format!("{id} stopped unexpectedly ({}); {} (see {})", code.map(|c| format!("exit code {c}")).unwrap_or("killed".into()),
                if again { "restarting it" } else { "not restarted: 3 crashes in 10 minutes" }, log.display()));
            ctx.stop_model(&id).await;
            if again { if let Err(e) = o.start(ctx, &id, mode.as_deref(), None).await { ctx.log(&format!("{id}: {e}")); } }
        }
        // queue requests from pages: add / pause / resume / cancel / remove
        let inbox = ctx.data.join("queue-in");
        let mut files: Vec<PathBuf> = std::fs::read_dir(&inbox).map(|d| d.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().map(|x| x == "json").unwrap_or(false)).collect()).unwrap_or_default();
        files.sort();
        for f in files {
            let r = read_json(&f); let _ = std::fs::remove_file(&f);
            let Some(r) = r else { continue };
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
                    if let Some(f) = q["jobs"].as_array().unwrap().iter().find(|x| x["id"] == id.as_str()).and_then(|x| x["output"]["file"].as_str().map(String::from)) { let _ = std::fs::remove_file(ctx.data.join("outputs").join(f)); }
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
                } else if !ctx.state["running"][&model].is_object() && !o.starting.contains(&model) {
                    if let Some(x) = q["jobs"].as_array_mut().unwrap().iter_mut().find(|x| x["id"] == jid.as_str()) { x["progress"] = json!("starting the model…"); }
                    if let Err(e) = o.start(ctx, &model, None, None).await { entry_err(&mut q, e); }
                    changed = true;
                }
            }
        }
        if changed { save_q(&q, &qpath); }
        if (o.publish(ctx) && last_pub.elapsed() > Duration::from_millis(700)) || last_pub.elapsed() > Duration::from_secs(5) { let _ = ctx.save(); last_pub = std::time::Instant::now(); }
    }
    if let Some((_, h, _)) = current.take() { h.abort(); }
    for jb in q["jobs"].as_array_mut().into_iter().flatten() { if jb["status"] == "running" { jb["status"] = json!("queued"); jb["progress"] = json!("continues after a restart"); } }
    save_q(&q, &qpath);
    ctx.stop_all().await;
    ctx.state["owner"] = Value::Null; ctx.state["tasks"] = json!([]);
    let _ = ctx.save();
    let _ = stop_tx.send(());
    tokio::time::sleep(Duration::from_millis(300)).await;
    ctx.log("stopped");
    drop(lock);
    Ok(())
}

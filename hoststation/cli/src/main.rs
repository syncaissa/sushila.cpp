// sushila: Sushila.cpp from the command line, the same commands on Windows, macOS and Linux.
//
//   sushila engine install            Sushila.cpp for this computer's GPU (CUDA, Vulkan, Metal; CPU only as a fallback)
//   sushila packs                     the model packs in the catalog (installed ones marked)
//   sushila install <pack>|<file>     download (or take a .sushilapack file), check the Sushila signature and every sha256
//   sushila serve [<pack>...]         the inference page + OpenAI-compatible API on http://127.0.0.1:8765, models, the queue
//   sushila run <pack> "<prompt>"     one answer, picture, video or song, printed or saved (for scripts and tests)
//   sushila status | stop | list | verify | remove <pack> | service install | selftest
//
// It shares its data folder with Sushila Host Station (the desktop app): packs installed with either appear in both.
#[path = "../../src-tauri/src/net.rs"]
mod net;
#[path = "../../src-tauri/src/webserver.rs"]
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
    cmd: Cmd,
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
        /// Standard mode (the plain model) instead of Accelerated
        #[arg(long)] standard: bool,
        /// Start at most this many installed packs when none are named
        #[arg(long, default_value_t = 1)] max: usize,
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
    /// Stop `sushila serve` on this computer
    Stop,
    /// The address of the inference page with this computer's access token
    Url,
    /// Access keys for other machines (when serving on the network): `keys add <name>`, `keys list`, `keys remove <name>`
    Keys { #[command(subcommand)] act: KeysCmd },
    /// Start `sushila serve` when the computer starts: `service install [--packs a,b] [--host 0.0.0.0]`, `service remove`
    Service { #[command(subcommand)] act: ServiceCmd },
    /// End-to-end check: engine, the smallest model, one answer (exit code 0 = everything works)
    Selftest { #[arg(long, default_value = DEFAULT_MODEL)] pack: String },
}
#[derive(Subcommand)]
enum EngineCmd { Install { /// cpu, vulkan, cuda, or a full key like linux-x86_64-vulkan
        #[arg(long)] build: Option<String> }, Info }
#[derive(Subcommand)]
enum KeysCmd { Add { name: String }, List, Remove { name: String } }
#[derive(Subcommand)]
enum ServiceCmd { Install { #[arg(long)] packs: Option<String>, #[arg(long)] host: Option<String>, #[arg(long)] port: Option<u16> }, Remove }

#[tokio::main]
async fn main() -> ExitCode {
    let _ = net::AGENT.set(format!("sushila/{}", env!("CARGO_PKG_VERSION")));
    let cli = Cli::parse();
    let data = cli.data_dir.clone().unwrap_or_else(default_data_dir);
    let mut ctx = match Ctx::load(data, cli.quiet) { Ok(c) => c, Err(e) => { eprintln!("error: {e}"); return ExitCode::from(1); } };
    match dispatch(&cli, &mut ctx).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => { if cli.json { println!("{}", json!({ "ok": false, "error": e })); } else { eprintln!("error: {e}"); } ExitCode::from(1) }
    }
}

fn out(json_mode: bool, v: Value, text: impl FnOnce() -> String) {
    if json_mode { println!("{}", serde_json::to_string_pretty(&v).unwrap()); } else { println!("{}", text()); }
}

async fn dispatch(cli: &Cli, ctx: &mut Ctx) -> Result<(), String> {
    let j = cli.json;
    match &cli.cmd {
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
        Cmd::Stop => {
            let port = ctx.setting("port").as_u64().unwrap_or(8765);
            let token = ctx.state["token"].as_str().unwrap_or("").to_string();
            let r = reqwest::Client::new().post(format!("http://127.0.0.1:{port}/api/shutdown")).header("x-sushila-token", token).send().await;
            match r { Ok(r) if r.status().is_success() => out(j, json!({ "ok": true }), || "stopping sushila serve".into()),
                      _ => { std::fs::write(ctx.data.join("shutdown-request.json"), "{}").map_err(err)?; out(j, json!({ "ok": true, "note": "no server answered; a stop request was left for it" }), || "no server answered on this computer".into()) } }
        }
        Cmd::Url => {
            let port = ctx.setting("port").as_u64().unwrap_or(8765);
            ctx.save()?;
            let u = format!("http://127.0.0.1:{port}/?t={}", ctx.state["token"].as_str().unwrap_or(""));
            out(j, json!({ "url": u }), || u.clone());
        }
        Cmd::Keys { act } => keys(ctx, act, j)?,
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
        Cmd::Serve { packs, port, host, standard, max } => serve(ctx, packs, *port, host.clone(), *standard, *max, j).await?,
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
        ServiceCmd::Install { packs, host, port } => {
            let mut args = vec!["--data-dir".to_string(), data.clone(), "serve".into()];
            if let Some(p) = packs { args.extend(p.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty())); }
            if let Some(h) = host { args.extend(["--host".into(), h.clone()]); }
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

// ---------- serve: the web page, models, mode switches, the queue
fn read_json(p: &std::path::Path) -> Option<Value> { std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()) }

async fn serve(ctx: &mut Ctx, packs: &[String], port: Option<u16>, host: Option<String>, standard: bool, max: usize, j: bool) -> Result<(), String> {
    if !ctx.engine_ok() { ctx.install_engine(None).await?; }
    if let Some(p) = port { ctx.state["settings"]["port"] = json!(p); }
    let port = ctx.setting("port").as_u64().unwrap_or(8765) as u16;
    let bind = host.unwrap_or_else(|| "127.0.0.1".into());
    let network = bind != "127.0.0.1" && bind != "localhost";
    if network {
        ctx.state["share"]["enabled"] = json!(true);
        if ctx.state["share"]["hosts"].as_array().map(|a| a.is_empty()).unwrap_or(true) { ctx.state["share"]["hosts"] = json!(["*"]); }
        if ctx.state["share"]["keys"].as_array().map(|a| a.is_empty()).unwrap_or(true) {
            eprintln!("Serving on the network needs access keys for other machines: create one with `sushila keys add <name>`.");
        }
    }
    ctx.state["running"] = json!({});  // a fresh start: models from an earlier run are gone
    for f in ["shutdown-request.json", "mode-request.json"] { let _ = std::fs::remove_file(ctx.data.join(f)); }
    ctx.save()?;
    let (addr, stop_tx) = webserver::start(ctx.data.clone(), port, if bind == "localhost" { "127.0.0.1" } else { &bind }).await
        .map_err(|e| format!("{e} (is Sushila Host Station or another `sushila serve` already running? `sushila status`)"))?;
    let page = format!("http://127.0.0.1:{port}/?t={}", ctx.state["token"].as_str().unwrap_or(""));
    let mut ids: Vec<String> = if packs.is_empty() { ctx.packs().keys().take(max).cloned().collect() } else { packs.to_vec() };
    if ids.is_empty() { ctx.log("no packs installed: installing the default model"); ctx.load_catalog().await?; let id = ctx.best_variant(DEFAULT_MODEL).await; ctx.install_pack(&id).await?; ids.push(id); }
    for id in &ids { ctx.start_model(id, if standard { Some("regular") } else { None }).await?; }
    out(j, json!({ "ok": true, "page": page, "api": format!("{addr}/v1"), "models": ids }), || format!(
        "\nSushila is serving {}\n  page:  {page}\n  API:   {addr}/v1  (OpenAI-compatible; header x-sushila-token: <token>, or Authorization: Bearer <key> from other machines)\n  stop:  Ctrl+C, or `sushila stop`\n", ids.join(", ")));
    // the queue: one job at a time, like the desktop app
    let qpath = ctx.data.join("queue.json");
    let mut q = read_json(&qpath).unwrap_or(json!({ "paused": false, "jobs": [] }));
    for jb in q["jobs"].as_array_mut().into_iter().flatten() { if jb["status"] == "running" { jb["status"] = json!("queued"); jb["progress"] = json!("continues after a restart"); } }
    let save_q = |q: &Value, p: &std::path::Path| { let _ = std::fs::write(p, serde_json::to_string_pretty(q).unwrap()); };
    save_q(&q, &qpath);
    let mut current: Option<(String, tokio::task::JoinHandle<Result<jobs::Output, String>>, std::time::Instant)> = None;
    let progress = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let ctrl_c = tokio::signal::ctrl_c(); tokio::pin!(ctrl_c);
    loop {
        tokio::select! { _ = &mut ctrl_c => break, _ = tokio::time::sleep(Duration::from_millis(500)) => {} }
        if ctx.data.join("shutdown-request.json").exists() { let _ = std::fs::remove_file(ctx.data.join("shutdown-request.json")); ctx.log("stop requested"); break; }
        // mode switch from the page (Standard / Accelerated)
        if let Some(m) = read_json(&ctx.data.join("mode-request.json")) {
            let _ = std::fs::remove_file(ctx.data.join("mode-request.json"));
            if let (Some(id), Some(mode)) = (m["model"].as_str(), m["mode"].as_str()) {
                if ctx.packs().contains_key(id) && ctx.state["running"][id]["mode"] != mode {
                    ctx.stop_model(id).await;
                    if let Err(e) = ctx.start_model(id, Some(mode)).await { ctx.log(&format!("{id}: {e}")); }
                }
            }
        }
        // models that exited on their own
        let dead: Vec<String> = { let mut g = ctx.procs.lock().await; g.iter_mut().filter_map(|(id, c)| c.try_wait().ok().flatten().map(|_| id.clone())).collect() };
        for id in dead { ctx.log(&format!("{id} stopped (see {})", ctx.data.join("logs").join(format!("{id}.log")).display())); ctx.stop_model(&id).await; }
        // requests from pages: add / pause / resume / cancel / remove
        let inbox = ctx.data.join("queue-in");
        let mut files: Vec<PathBuf> = std::fs::read_dir(&inbox).map(|d| d.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().map(|x| x == "json").unwrap_or(false)).collect()).unwrap_or_default();
        files.sort();
        let mut changed = false;
        for f in files {
            let r = read_json(&f); let _ = std::fs::remove_file(&f);
            let Some(r) = r else { continue };
            let id = r["id"].as_str().unwrap_or("").to_string();
            let jobs_arr = q["jobs"].as_array_mut().unwrap();
            match r["action"].as_str().unwrap_or("") {
                "add" => if !jobs_arr.iter().any(|x| x["id"] == id.as_str()) {
                    jobs_arr.push(json!({ "id": id, "owner": r["owner"], "kind": r["kind"], "model": r["model"], "title": r["title"], "params": r["params"], "status": "queued", "created": now_iso(), "progress": "" })); },
                act => {
                    if id == "all" { q["paused"] = json!(act == "pause"); }
                    else if let Some(jb) = q["jobs"].as_array_mut().unwrap().iter_mut().find(|x| x["id"] == id.as_str()) {
                        let st = jb["status"].as_str().unwrap_or("").to_string();
                        let is_cur = current.as_ref().map(|c| c.0 == id).unwrap_or(false);
                        match act {
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
            }
            changed = true;
        }
        // the running job
        if let Some((id, h, t0)) = current.as_ref() {
            if let Some(jb) = q["jobs"].as_array_mut().unwrap().iter_mut().find(|x| x["id"] == id.as_str()) { let p = progress.lock().unwrap().clone(); if !p.is_empty() && jb["progress"] != p.as_str() { jb["progress"] = json!(p); changed = true; } }
            if h.is_finished() {
                let (id, h, t0) = { let _ = t0; current.take().unwrap() };
                let res = h.await.unwrap_or_else(|e| Err(e.to_string()));
                if let Some(jb) = q["jobs"].as_array_mut().unwrap().iter_mut().find(|x| x["id"] == id.as_str()) {
                    match res {
                        Ok(o) => {
                            let file = format!("{id}.{}", o.ext); let _ = std::fs::create_dir_all(ctx.data.join("outputs"));
                            match std::fs::write(ctx.data.join("outputs").join(&file), &o.bytes) {
                                Ok(()) => { jb["output"] = json!({ "file": file, "mime": o.mime, "bytes": o.bytes.len() }); jb["status"] = json!("ready"); jb["progress"] = json!(format!("ready in {} s", t0.elapsed().as_secs())); ctx.log(&format!("queue: {} is ready", jb["title"].as_str().filter(|t| !t.is_empty()).unwrap_or(jb["kind"].as_str().unwrap_or("job")))); }
                                Err(e) => { jb["status"] = json!("failed"); jb["error"] = json!(e.to_string()); }
                            }
                        }
                        Err(e) => { jb["status"] = json!("failed"); jb["error"] = json!(e.chars().take(300).collect::<String>()); jb["progress"] = json!(""); }
                    }
                    jb["finished"] = json!(now_iso());
                }
                changed = true;
            }
        }
        if current.is_none() && q["paused"] != true {
            let next = q["jobs"].as_array().unwrap().iter().find(|x| x["status"] == "queued").cloned();
            if let Some(jb) = next {
                let (id, model, kind) = (jb["id"].as_str().unwrap_or("").to_string(), jb["model"].as_str().unwrap_or("").to_string(), jb["kind"].as_str().unwrap_or("text").to_string());
                let started = if ctx.packs().contains_key(&model) { ctx.start_model(&model, None).await.map_err(|e| e) } else { Err(format!("{model} is not installed on this computer")) };
                let entry = q["jobs"].as_array_mut().unwrap().iter_mut().find(|x| x["id"] == id.as_str()).unwrap();
                match started {
                    Ok(port) => {
                        entry["status"] = json!("running"); entry["started"] = json!(now_iso()); entry["error"] = json!("");
                        let accel = if ctx.state["running"][&model]["mode"] == "turbo" { turbo_request(&ctx.state["packs"][&model]) } else { None };
                        let params = jb["params"].clone(); let pr = progress.clone(); let t = std::time::Instant::now();
                        *pr.lock().unwrap() = String::new();
                        let h = tokio::spawn(async move { jobs::run(&kind, &model, port, &params, accel, move |w| { *pr.lock().unwrap() = format!("{w}… {} s", t.elapsed().as_secs()); }).await });
                        current = Some((id, h, std::time::Instant::now()));
                    }
                    Err(e) => { entry["status"] = json!("failed"); entry["error"] = json!(e); }
                }
                changed = true;
            }
        }
        if changed { save_q(&q, &qpath); }
    }
    if let Some((_, h, _)) = current.take() { h.abort(); }
    for jb in q["jobs"].as_array_mut().into_iter().flatten() { if jb["status"] == "running" { jb["status"] = json!("queued"); jb["progress"] = json!("continues after a restart"); } }
    save_q(&q, &qpath);
    ctx.stop_all().await;
    let _ = stop_tx.send(());
    tokio::time::sleep(Duration::from_millis(300)).await;
    ctx.log("stopped");
    Ok(())
}

// The everyday commands beyond install/serve/run: measuring, checking, chatting, managing settings, files and sharing.
// They reuse the server's APIs when a server runs (it alone changes state.json), and otherwise work on the home folder
// directly while holding the owner lock.
use std::{path::{Path, PathBuf}, time::Duration};
use serde_json::{json, Value};
use crate::core::*;
use crate::util::*;
use crate::{jobs, out, owner_port, remote, local_lock, read_json, Cmd};

// ---------- shared helpers

/// The owner's view of what runs and what is installed (state.json, which the server rewrites).
fn refresh(ctx: &mut Ctx) {
    if let Some(s) = read_json(&ctx.data.join("state.json")) { for k in ["running", "packs", "share"] { if s[k].is_object() { ctx.state[k] = s[k].clone(); } } if let Some(o) = s["settings"].as_object() { for (k, v) in o { ctx.state["settings"][k] = v.clone(); } } }
}
fn token(ctx: &Ctx) -> String { ctx.state["token"].as_str().unwrap_or("").to_string() }
fn client() -> reqwest::Client { reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().expect("http client") }
fn tty_in() -> bool { std::io::IsTerminal::is_terminal(&std::io::stdin()) }
fn pack_rec(ctx: &Ctx, pack: &str) -> Result<Value, String> { ctx.packs().get(pack).cloned().ok_or(format!("{pack} is not installed: sushila install {pack}")) }
fn kind_of(p: &Value) -> String { p["kind"].as_str().unwrap_or("text").to_string() }
fn mode_name(m: &str) -> &'static str { if m == "turbo" { "Accelerated" } else { "Standard" } }
pub fn stamp() -> String { now_iso().replace([':', '-'], "").replace('T', "-").trim_end_matches('Z').to_string() }

/// Seconds since 1970 of "YYYY-MM-DDTHH:MM:SSZ" (the inverse of now_iso).
pub fn iso_secs(s: &str) -> Option<u64> {
    let n = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, m, d, hh, mm, ss) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400); let yoe = y2 - era * 400; let mp = (m + 9) % 12;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + d - 1;
    let days = era * 146097 + doe - 719468;
    u64::try_from(days * 86400 + hh * 3600 + mm * 60 + ss).ok()
}
pub fn now_secs() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }
fn ago(secs: u64) -> String { if secs < 120 { format!("{secs} s") } else if secs < 7200 { format!("{} min", secs / 60) } else if secs < 172800 { format!("{:.1} h", secs as f64 / 3600.0) } else { format!("{} days", secs / 86400) } }

/// Bytes in a folder (links not followed).
pub fn dir_size(p: &Path) -> u64 {
    let Ok(m) = std::fs::symlink_metadata(p) else { return 0 };
    if !m.is_dir() { return m.len(); }
    std::fs::read_dir(p).map(|d| d.flatten().map(|e| dir_size(&e.path())).sum()).unwrap_or(0)
}

/// The pack's engine running in `mode` ("turbo"/"regular"; None: as it runs, else its preferred mode). With a server,
/// the server starts or switches it; else it is started here. Returns (engine port, started here: stop it when done).
pub async fn engine(ctx: &mut Ctx, pack: &str, mode: Option<&str>) -> Result<(u16, bool), String> {
    pack_rec(ctx, pack)?;
    if let Some(sp) = owner_port(ctx).await {
        refresh(ctx);
        let r = ctx.state["running"][pack].clone();
        let mode_ok = mode.map(|m| r["mode"] == m).unwrap_or(true);
        if r.is_object() && !mode_ok { remote(ctx, sp, json!({ "action": "stop", "pack": pack, "source": "cli" })).await?; }
        else if r.is_object() && r["ready"] != true {
            for _ in 0..600 { tokio::time::sleep(Duration::from_millis(500)).await; refresh(ctx); if ctx.state["running"][pack]["ready"] == true || !ctx.state["running"][pack].is_object() { break; } }
        }
        refresh(ctx);
        if !(ctx.state["running"][pack]["ready"] == true && mode_ok) {
            remote(ctx, sp, json!({ "action": "start", "pack": pack, "mode": mode, "source": "cli" })).await?;
            refresh(ctx);
        }
        let port = ctx.state["running"][pack]["port"].as_u64().ok_or(format!("the server did not start {pack}"))?;
        return Ok((port as u16, false));
    }
    let existing = ctx.state["running"][pack].clone();
    if let Some(p) = existing["port"].as_u64() { if mode.map(|m| existing["mode"] == m).unwrap_or(true) && http_text(&format!("http://127.0.0.1:{p}/health"), 2).await.is_ok() { return Ok((p as u16, false)); } }
    ctx.state["running"].as_object_mut().unwrap().remove(pack);  // left over from a server that stopped
    Ok((ctx.start_model(pack, mode).await?, true))
}

/// Where text requests go: the server (its token, counted in its metrics) when one runs, else the engine.
pub async fn text_base(ctx: &mut Ctx, pack: &str, mode: Option<&str>) -> Result<(String, bool), String> {
    let (port, here) = engine(ctx, pack, mode).await?;
    Ok(match owner_port(ctx).await { Some(sp) => (format!("http://127.0.0.1:{sp}"), here), None => (format!("http://127.0.0.1:{port}"), here) })
}

/// One chat completion; streams tokens into `each` when given. Returns the text and the engine's answer (timings, usage).
/// Where streamed tokens go (Send: the server's assistant route runs it inside a request handler).
pub type Each<'a> = Option<&'a mut (dyn FnMut(&str) + Send + 'a)>;
pub async fn chat(base: &str, tok: &str, model: &str, messages: &Value, max_tokens: u64, temperature: f64, mut each: Each<'_>) -> Result<(String, Value), String> {
    let stream = each.is_some();
    let r = client().post(format!("{base}/v1/chat/completions")).header("x-sushila-token", tok).timeout(Duration::from_secs(1800))
        .json(&json!({ "model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature, "seed": 42, "stream": stream,
            // sampled answers get a mild repetition penalty (small models loop otherwise); greedy runs (bench, eval) stay plain
            "repeat_penalty": if temperature > 0.0 { 1.1 } else { 1.0 } })).send().await.map_err(err)?;
    if !r.status().is_success() { let s = r.status(); return Err(format!("{s}: {}", r.text().await.unwrap_or_default().chars().take(300).collect::<String>())); }
    if !stream { let j: Value = r.json().await.map_err(err)?; return Ok((j["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string(), j)); }
    let (mut text, mut last, mut buf) = (String::new(), Value::Null, String::new());
    let mut s = r.bytes_stream();
    while let Some(chunk) = futures_util::StreamExt::next(&mut s).await {
        buf += &String::from_utf8_lossy(&chunk.map_err(err)?);
        while let Some(i) = buf.find('\n') {
            let line = buf[..i].trim().to_string(); buf.drain(..=i);
            let Some(d) = line.strip_prefix("data:").map(str::trim) else { continue };
            if d == "[DONE]" { continue; }
            let Ok(v) = serde_json::from_str::<Value>(d) else { continue };
            if let Some(t) = v["choices"][0]["delta"]["content"].as_str() { text += t; if let Some(f) = each.as_mut() { f(t); } }
            if v.get("timings").is_some() || v.get("usage").map(|u| !u.is_null()).unwrap_or(false) { last = v; }
        }
    }
    Ok((text, last))
}
/// Tokens per second of an answer: the engine's own timing, else tokens / wall time.
fn tps(j: &Value, secs: f64) -> f64 {
    j["timings"]["predicted_per_second"].as_f64().filter(|x| *x > 0.0).unwrap_or_else(|| j["usage"]["completion_tokens"].as_f64().unwrap_or(0.0) / secs.max(1e-3))
}
fn median(v: &mut [f64]) -> f64 { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); if v.is_empty() { 0.0 } else { v[v.len() / 2] } }

/// Settings changed through the server (it owns state.json) or, without one, here under the owner lock.
async fn set_settings(ctx: &mut Ctx, values: Value) -> Result<&'static str, String> {
    if let Some(sp) = owner_port(ctx).await { remote(ctx, sp, json!({ "action": "settings", "values": values, "source": "cli" })).await?; return Ok("saved in the running server"); }
    let _l = local_lock(ctx)?;
    for (k, v) in values.as_object().cloned().unwrap_or_default() { ctx.state["settings"][k] = v; }
    ctx.save()?; Ok("saved")
}
async fn set_share(ctx: &mut Ctx, values: Value) -> Result<(), String> {
    if let Some(sp) = owner_port(ctx).await { return remote(ctx, sp, json!({ "action": "share", "values": values, "source": "cli" })).await; }
    let _l = local_lock(ctx)?;
    apply_share(&mut ctx.state, &values)?;
    ctx.save()
}
/// share.enabled (other machines may call, with a key), share.listen (serve on all addresses), share.open (no key),
/// addHost (a host name a reverse proxy uses, e.g. for HTTPS).
pub fn apply_share(state: &mut Value, v: &Value) -> Result<(), String> {
    for k in ["enabled", "listen", "open"] { if let Some(b) = v[k].as_bool() { state["share"][k] = json!(b); } }
    if !state["share"]["hosts"].is_array() { state["share"]["hosts"] = json!([]); }
    // tunnel host names of earlier runs (an unclean end leaves one behind): removed before the new one is added
    if let Some(sfx) = v["removeHostSuffix"].as_str().filter(|x| *x == ".trycloudflare.com") {
        if let Some(a) = state["share"]["hosts"].as_array_mut() { a.retain(|x| !x.as_str().unwrap_or("").ends_with(sfx)); }
    }
    if let Some(h) = v["addHost"].as_str() {
        let h = h.trim().to_ascii_lowercase();
        if h.is_empty() || h.len() > 253 || !h.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') { return Err(format!("not a host name: {h}")); }
        if !state["share"]["hosts"].as_array().unwrap().iter().any(|x| x == h.as_str()) { state["share"]["hosts"].as_array_mut().unwrap().push(json!(h)); }
    }
    // the temporary internet URL (tunnel.rs): its host name and access key come and go with the tunnel
    if let Some(h) = v["removeHost"].as_str() { state["share"]["hosts"].as_array_mut().unwrap().retain(|x| x != h); }
    if let Some(p) = v["removeKeyPrefix"].as_str().filter(|p| p.len() >= 8) { if let Some(a) = state["share"]["keys"].as_array_mut() { a.retain(|k| !k["name"].as_str().unwrap_or("").starts_with(p)); } }
    if let Some(k) = v.get("addKey").filter(|k| k["name"].is_string() && k["sha256"].as_str().map(|s| s.len() == 64).unwrap_or(false)) {
        if !state["share"]["keys"].is_array() { state["share"]["keys"] = json!([]); }
        state["share"]["keys"].as_array_mut().unwrap().push(json!({ "name": k["name"], "sha256": k["sha256"], "created": crate::util::now_iso() }));
    }
    if let Some(n) = v["removeKey"].as_str() { if let Some(a) = state["share"]["keys"].as_array_mut() { a.retain(|k| k["name"] != n); } }
    // serving on the network: any host name (the LAN address, a phone's view of it); keys still decide who may call
    if v["listen"] == true && !state["share"]["hosts"].as_array().unwrap().iter().any(|x| x == "*") { state["share"]["hosts"].as_array_mut().unwrap().push(json!("*")); }
    if v["enabled"] == false { state["share"]["listen"] = json!(false); state["share"]["open"] = json!(false); }
    Ok(())
}

/// The settings `config` and `limit` change: (key, what it is, minimum, maximum). Numbers are whole numbers.
pub const SETTINGS: [(&str, &str, i64, i64); 9] = [
    ("port", "the server's port (next start)", 1, 65535), ("enginePort", "the first internal port for model engines", 1024, 65535),
    ("threads", "CPU threads per model (0 = automatic)", 0, 1024), ("contextSize", "context tokens per parallel slot (next model start)", 256, 1 << 20),
    ("gpuLayers", "layers on the GPU (-1 = all that fit)", -1, 999), ("parallel", "parallel requests per text model (0 = automatic)", 0, 64),
    ("idleMinutes", "unload models idle this long (0 = never)", 0, 10080), ("keepCopy", "keep a copy of installed pack files (true/false)", 0, 1),
    ("keepPopular", "download the popular model packs in the background and keep them installed (true/false)", 0, 1)];
pub fn parse_setting(key: &str, val: &str) -> Result<Value, String> {
    if key == "catalogUrl" { let u = crate::net::check_url(val, false)?; return Ok(json!(u.to_string())); }
    if key == "ticker" { return match val { "on" | "true" | "1" => Ok(json!("on")), "off" | "false" | "0" => Ok(json!("off")), _ => Err("ticker is on or off".into()) }; }
    let (_, _, lo, hi) = SETTINGS.iter().find(|s| s.0 == key).ok_or(format!("unknown setting {key}; `sushila config list` shows them"))?;
    if key == "keepPopular" { return match val { "true" | "1" | "yes" | "on" => Ok(json!(true)), "false" | "0" | "no" | "off" => Ok(json!(false)), _ => Err("keepPopular is true or false".into()) }; }
    if key == "keepCopy" { return match val { "true" | "1" | "yes" => Ok(json!(true)), "false" | "0" | "no" => Ok(json!(false)), _ => Err("keepCopy is true or false".into()) }; }
    let n: i64 = val.parse().map_err(|_| format!("{key} must be a whole number"))?;
    if n < *lo || n > *hi { return Err(format!("{key} must be between {lo} and {hi}")); }
    Ok(json!(n))
}

// ---------- the API snippet and the QR code (pure, tested)

/// A working request for a pack's kind. auth: the header line ("x-sushila-token: …" here, "Authorization: Bearer …" elsewhere).
pub fn snippet(lang: &str, base: &str, model: &str, kind: &str, auth: (&str, &str)) -> String {
    let (path, body) = match kind {
        "image" => ("/v1/images/generations", json!({ "model": model, "prompt": "A lighthouse at dawn, watercolor", "size": "1024x1024", "n": 1 })),
        "music" | "video" => ("/api/queue", json!({ "kind": kind, "model": model, "title": "example", "params": if kind == "music" { json!({ "style": "calm piano", "lyrics": "[Instrumental]", "duration": 30 }) } else { json!({ "prompt": "A cat walking on a beach", "width": 832, "height": 480, "video_frames": 49 }) } })),
        _ => ("/v1/chat/completions", json!({ "model": model, "messages": [{ "role": "user", "content": "Write a haiku about GPUs" }], "max_tokens": 200 })),
    };
    let url = format!("{base}{path}");
    let bj = serde_json::to_string(&body).unwrap();
    let (hk, hv) = auth;
    match lang {
        "python" => if path.starts_with("/v1/chat") { let keyed = hk.eq_ignore_ascii_case("authorization");
                        format!("# pip install openai\nfrom openai import OpenAI\nclient = OpenAI(base_url=\"{base}/v1\", api_key=\"{}\"{})\nr = client.chat.completions.create(model=\"{model}\", messages=[{{\"role\": \"user\", \"content\": \"Write a haiku about GPUs\"}}])\nprint(r.choices[0].message.content)\n",
                        if keyed { hv.trim_start_matches("Bearer ") } else { "none" }, if keyed { String::new() } else { format!(", default_headers={{\"{hk}\": \"{hv}\"}}") }) }
                    else { format!("import json, urllib.request\nreq = urllib.request.Request(\"{url}\", data=json.dumps({bj}).encode(), headers={{\"content-type\": \"application/json\", \"{hk}\": \"{hv}\"}})\nprint(json.load(urllib.request.urlopen(req)))\n") },
        "js" => format!("const r = await fetch(\"{url}\", {{ method: \"POST\", headers: {{ \"content-type\": \"application/json\", \"{hk}\": \"{hv}\" }},\n  body: JSON.stringify({bj}) }});\nconsole.log(await r.json());\n"),
        _ => format!("curl {url} \\\n  -H \"content-type: application/json\" -H \"{hk}: {hv}\" \\\n  -d '{bj}'\n"),
    }
}

/// The address as a QR code made of Unicode half blocks (two rows per line), with the quiet zone.
pub fn qr_text(data: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(data.as_bytes()).map_err(err)?;
    Ok(code.render::<qrcode::render::unicode::Dense1x2>().dark_color(qrcode::render::unicode::Dense1x2::Light).light_color(qrcode::render::unicode::Dense1x2::Dark).quiet_zone(true).build())
}

// ---------- reproduce: the paper's results and their commands (docs/REPLICATE_ALL.md)
pub const GUIDE: &str = "https://github.com/syncaissa/sushila.cpp/blob/main/docs/REPLICATE_ALL.md";
pub const REPRODUCE: [(&str, &str, &str); 17] = [
    ("llama3.3-70b", "Llama-3.3-70B vs Ollama (Tables 17, 19; Figure 1), 1x A100 80GB", "bash scripts/reproduce/retest.sh llama3.3-70b"),
    ("llama3.3-70b-first", "first 70B run: heads after 1,000-6,000 answers, robustness (Tables 14, 18)", "cd scripts/bench70b && W=/workspace/day0 bash run_all.sh"),
    ("qwen3-32b", "Qwen3-32B (Tables 17, 19), 1x A100 80GB", "bash scripts/reproduce/retest.sh qwen3-32b"),
    ("qwen3-30b-a3b", "Qwen3-30B-A3B (Tables 17, 19)", "bash scripts/reproduce/retest.sh qwen3-30b-a3b"),
    ("deepseek-r1-distill-llama-70b", "DeepSeek-R1-Distill-Llama-70B (Tables 17, 19)", "bash scripts/reproduce/retest.sh deepseek-r1-distill-llama-70b"),
    ("gemma3-27b", "Gemma 3 27B (Tables 17, 19)", "bash scripts/reproduce/retest.sh gemma3-27b"),
    ("qwen3-coder-30b-a3b", "Qwen3-Coder-30B-A3B (Table 19)", "bash scripts/reproduce/retest.sh qwen3-coder-30b-a3b"),
    ("kimi-dev-72b", "Kimi-Dev-72B (Table 19)", "bash scripts/reproduce/retest.sh kimi-dev-72b"),
    ("load", "throughput with 1, 4, 16, 64 users (Table 22)", "LOAD=1 bash scripts/reproduce/retest.sh <model>"),
    ("zimage", "Z-Image-Turbo seconds per image, standard vs Accelerated (Table 23), RTX 4090", "W=/workspace/zimg bash scripts/image/bench_zimage.sh"),
    ("zimage-production", "Z-Image at production settings, bf16 vs 4-bit (Table 26), L40S", "W=/workspace/zprod bash scripts/image/bench_zimage_production.sh"),
    ("wan", "Wan 2.2 TI2V-5B 720p cache plan (Table 24, video row)", "sushila engine install && sushila install wan2.2-ti2v-5b && bash scripts/video/run_wan_720p.sh"),
    ("yue", "YuE lab song (Table 25), RTX 4090", "W=/workspace/yue bash scripts/music/yue/reproduce_yue.sh && W=/workspace/yue NSEG=2 bash scripts/music/yue/run_yue_replay.sh"),
    ("yue-full", "YuE full 134 s song (Table 25)", "NSEG=7 W=/workspace/yue7 bash scripts/music/yue/reproduce_yue.sh && NSEG=7 W=/workspace/yue7 bash scripts/music/yue/run_yue_replay.sh"),
    ("ace-step", "ACE-Step 1.5 faster sampler, 60 s songs", "W=/workspace/music REPO=$PWD bash scripts/music/run_music_spec.sh && W=/workspace/music REPO=$PWD bash scripts/music/run_music_eval.sh"),
    ("day0", "the day-0 landscape pipeline on Qwen2.5-0.5B (Table 30), 2 CPU cores, ~19 min", "scripts/day0_landscape.sh qwen2.5-0.5b-q4km"),
    ("qwen3-235b-a22b", "Qwen3-235B-A22B, out of scope (Table 3, last row), 2x A100", "cd scripts/precompute && W=/workspace/sushila bash run_model.sh models/qwen3-235b-a22b.env"),
];

// ---------- eval: 20 grade-school math questions written for Sushila (MIT license, like the rest of this program)
pub const MATH: [(&str, i64); 20] = [
    ("Mia has 12 apples. She gives 5 to her brother and buys 9 more. How many apples does she have now?", 16),
    ("A bus carries 48 people. At the first stop 13 get off and 7 get on. How many people are on the bus?", 42),
    ("Pencils cost 3 dollars each. How much do 14 pencils cost, in dollars?", 42),
    ("A farmer has 6 rows of 9 tomato plants. How many tomato plants are there?", 54),
    ("Tom reads 25 pages a day. How many pages does he read in 2 weeks?", 350),
    ("A box holds 8 cookies. How many boxes are needed for 100 cookies?", 13),
    ("Sara earns 15 dollars an hour and works 7 hours. She spends 30 dollars. How many dollars does she have left?", 75),
    ("There are 3 classes with 27 students each. 9 students are absent. How many students are present?", 72),
    ("A rope is 90 meters long. It is cut into pieces of 6 meters. How many pieces are there?", 15),
    ("Leo had 200 stickers. He gave a quarter of them to his friend. How many stickers does he have now?", 150),
    ("A shirt costs 40 dollars and is on sale for 25 percent off. What is the sale price in dollars?", 30),
    ("Anna is 4 years older than Ben. Ben is 11. How old will Anna be in 5 years?", 20),
    ("A train travels 60 kilometers per hour for 3 hours and then 40 kilometers per hour for 2 hours. How many kilometers does it travel?", 260),
    ("A baker makes 144 rolls and puts them in bags of 12. He sells 9 bags. How many bags are left?", 3),
    ("Each of 5 friends pays 18 dollars for a gift that costs 75 dollars. How many dollars are left over?", 15),
    ("A garden is 12 meters long and 8 meters wide. What is its area in square meters?", 96),
    ("Jake saves 7 dollars every week. How many weeks does he need to save 84 dollars?", 12),
    ("A library has 320 books. It lends out 85 and receives 40 new ones. How many books does it have?", 275),
    ("A pizza is cut into 8 slices. 3 pizzas are shared equally by 6 children. How many slices does each child get?", 4),
    ("Emma ran 2 kilometers on Monday, twice as far on Tuesday, and 3 kilometers on Wednesday. How many kilometers did she run in total?", 9),
];
/// The last number in an answer ("Answer: 1,234" -> 1234).
pub fn last_number(t: &str) -> Option<i64> {
    let t = t.replace(',', "");
    let tail = t.rsplit("Answer").next().unwrap_or(&t);
    let nums: Vec<i64> = tail.split(|c: char| !(c.is_ascii_digit() || c == '-' || c == '.')).filter_map(|w| w.trim_matches('.').parse::<f64>().ok()).filter(|f| f.fract() == 0.0).map(|f| f as i64).collect();
    nums.last().copied().or_else(|| t.split(|c: char| !c.is_ascii_digit()).filter_map(|w| w.parse().ok()).last())
}

// ---------- the commands
pub async fn run(cmd: &Cmd, ctx: &mut Ctx, j: bool) -> Result<(), String> {
    match cmd {
        Cmd::Bench { pack, prompt, runs, max_tokens } => bench(ctx, pack, prompt.as_deref(), *runs, *max_tokens, j).await,
        Cmd::Doctor => doctor(ctx, j).await,
        Cmd::Chat { pack, standard } => chat_cmd(ctx, pack.clone(), *standard, j).await,
        Cmd::Ps => ps(ctx, j).await,
        Cmd::Show { pack } => show(ctx, pack, j).await,
        Cmd::Update { check } => update(ctx, *check, j).await,
        Cmd::Queue { act } => queue(ctx, act.as_ref(), j).await,
        Cmd::Clean { dry_run } => clean(ctx, *dry_run, j).await,
        Cmd::Du => { du(ctx, j); Ok(()) }
        Cmd::Config { act } => config(ctx, act, j).await,
        Cmd::Export { pack, file } => export(ctx, pack, file, j),
        Cmd::Import { file } => import(ctx, file, j).await,
        Cmd::Backup { file } => backup(ctx, file, j),
        Cmd::Restore { file } => restore(ctx, file, j).await,
        Cmd::Search { text, kind, fits } => search(ctx, text.as_deref(), kind.as_deref(), *fits, j).await,
        Cmd::Open { page } => open(ctx, page.as_deref(), j).await,
        Cmd::Example { pack, lang } => example(ctx, pack, lang.as_deref(), j),
        Cmd::Top { interval, once } => top(ctx, *interval, *once, j).await,
        Cmd::Completion { shell } => {
            let mut c = <crate::Cli as clap::CommandFactory>::command(); let mut buf = vec![];
            clap_complete::generate(*shell, &mut c, "sushila", &mut buf);
            use std::io::Write; let _ = std::io::stdout().write_all(&buf);  // a closed pipe (| head) is not an error
            Ok(())
        }
        Cmd::Version { verify } => version(ctx, *verify, j).await,
        Cmd::Report { file } => report(ctx, file.clone(), j).await,
        Cmd::Reproduce { result } => reproduce(result.as_deref(), j),
        Cmd::Batch { pack, prompts, out: o, standard } => batch(ctx, pack, prompts, o.clone(), *standard, j).await,
        Cmd::History { act } => history(ctx, act.as_ref(), j),
        Cmd::Watch { folder, pack, once } => watch(ctx, folder, pack.clone(), *once, j).await,
        Cmd::Share { act } => share(ctx, act, j).await,
        Cmd::Mode { pack, mode } => set_mode(ctx, pack, mode, j).await,
        Cmd::Idle { minutes } => {
            let m: u64 = if minutes == "off" || minutes == "0" { 0 } else { minutes.parse().map_err(|_| "use `sushila idle <minutes>` or `sushila idle off`".to_string())? };
            if m > 10080 { return Err("at most 10080 minutes (a week)".into()); }
            let how = set_settings(ctx, json!({ "idleMinutes": m })).await?;
            out(j, json!({ "ok": true, "idleMinutes": m }), || if m == 0 { format!("models stay loaded ({how})") } else { format!("models idle for {m} min are unloaded and load again on the next request ({how}; the running server applies it at once)") });
            Ok(())
        }
        Cmd::Limit { threads, parallel, context, gpu_layers } => {
            let mut v = json!({});
            for (k, x) in [("threads", *threads), ("parallel", *parallel), ("contextSize", *context), ("gpuLayers", *gpu_layers)] { if let Some(x) = x { v[k] = parse_setting(k, &x.to_string())?; } }
            if v.as_object().unwrap().is_empty() {
                let cur = json!({ "threads": ctx.setting("threads"), "parallel": ctx.setting("parallel"), "contextSize": ctx.setting("contextSize"), "gpuLayers": ctx.setting("gpuLayers") });
                out(j, cur.clone(), || format!("threads {}  parallel {}  context {}  gpu-layers {}   (0 / -1 = automatic; change: sushila limit --threads N --parallel N --context N --gpu-layers N)", cur["threads"], cur["parallel"], cur["contextSize"], cur["gpuLayers"]));
                return Ok(());
            }
            let how = set_settings(ctx, v.clone()).await?;
            out(j, json!({ "ok": true, "set": v }), || format!("{how}: {v}; applied when a model starts next (sushila stop <pack>; sushila start <pack>)"));
            Ok(())
        }
        Cmd::Convert { source, out: o, outtype } => convert(ctx, source, o.clone(), outtype, j).await,
        Cmd::Precompute { pack } => precompute(ctx, pack, j).await,
        Cmd::Eval { pack, n } => eval(ctx, pack, *n, j).await,
        Cmd::Ask { file, question, pack } => ask(ctx, file, question, pack.clone(), j).await,
        Cmd::Embed { pack, input } => embed(ctx, pack, input, j).await,
        Cmd::License { pack } => license(ctx, pack, j).await,
        Cmd::Https { domain } => https(ctx, domain, j).await,
        Cmd::Uninstall { all, yes } => uninstall(ctx, *all, *yes, j).await,
        Cmd::Assistant { question } => assistant(ctx, question.clone(), j).await,
        _ => Err("not a command of this module".into()),
    }
}

// 1 bench
async fn bench(ctx: &mut Ctx, pack: &str, prompt: Option<&str>, runs: usize, max_tokens: u64, j: bool) -> Result<(), String> {
    let p = pack_rec(ctx, pack)?;
    let kind = kind_of(&p);
    let modes: Vec<&str> = if can_turbo(&p) { vec!["regular", "turbo"] } else { vec!["regular"] };
    refresh(ctx);
    let before = ctx.state["running"][pack]["mode"].as_str().map(String::from);
    let runs = runs.max(1);
    let mut res = json!({});
    for m in &modes {
        let (port, here) = engine(ctx, pack, Some(m)).await?;
        if !ctx.quiet { eprintln!("{pack}: {} on port {port}", mode_name(m)); }
        let mut vals = vec![];
        let r: Result<(), String> = async {
            if kind == "text" {
                let base = format!("http://127.0.0.1:{port}");
                let q = prompt.unwrap_or("Explain in about 200 words how a refrigerator keeps food cold.");
                let msgs = json!([{ "role": "user", "content": q }]);
                chat(&base, "", pack, &msgs, 16, 0.0, None).await?;  // warm-up
                for i in 0..runs {
                    let t0 = std::time::Instant::now();
                    let (_, a) = chat(&base, "", pack, &msgs, max_tokens, 0.0, None).await?;
                    let v = tps(&a, t0.elapsed().as_secs_f64());
                    if !ctx.quiet { eprintln!("  run {}: {v:.1} tokens/s", i + 1); }
                    vals.push(v);
                }
            } else {
                let mut params = json!({ "prompt": prompt.unwrap_or(match kind.as_str() { "music" => "calm piano", "video" => "A red fox running through snow", _ => "A lighthouse at dawn, watercolor" }), "seed": 42 });
                if kind == "music" { params["style"] = params["prompt"].clone(); params["lyrics"] = json!("[Instrumental]"); params["duration"] = json!(30.0); }
                let accel = if *m == "turbo" { turbo_request(&p) } else { None };
                for i in 0..runs {
                    let t0 = std::time::Instant::now();
                    jobs::run(&kind, pack, port, &params, accel.clone(), |_| {}).await?;
                    let s = t0.elapsed().as_secs_f64();
                    if !ctx.quiet { eprintln!("  run {}: {s:.1} s", i + 1); }
                    vals.push(s);
                }
            }
            Ok(())
        }.await;
        if here { ctx.stop_model(pack).await; }
        r?;
        let med = median(&mut vals.clone());
        res[*m] = json!({ "median": med, "runs": vals, "unit": if kind == "text" { "tokens/s" } else { "s" } });
    }
    if let (Some(b), Some(_)) = (before.as_deref(), owner_port(ctx).await) { if Some(b) != modes.last().copied() { let _ = engine(ctx, pack, Some(b)).await; } }
    let speedup = if res["turbo"].is_object() { let (s, t) = (res["regular"]["median"].as_f64().unwrap_or(0.0), res["turbo"]["median"].as_f64().unwrap_or(0.0));
        Some(if kind == "text" { t / s.max(1e-9) } else { s / t.max(1e-9) }) } else { None };
    let gpu = ctx.nvidia_gpu().await.map(|g| g["name"].clone()).unwrap_or(json!(ctx.other_gpu().await));
    let v = json!({ "pack": pack, "kind": kind, "time": now_iso(), "platform": ctx.platform_key(), "engine": ctx.state["engine"]["key"], "gpu": gpu, "standard": res["regular"], "accelerated": res["turbo"], "speedup": speedup, "runs": runs, "maxTokens": max_tokens, "prompt": prompt });
    let dir = ctx.data.join("bench"); std::fs::create_dir_all(&dir).map_err(err)?;
    let f = dir.join(format!("{pack}-{}.json", stamp()));
    std::fs::write(&f, serde_json::to_string_pretty(&v).unwrap()).map_err(err)?;
    let unit = if kind == "text" { "tokens/s" } else { "s" };
    out(j, json!({ "ok": true, "file": f.to_string_lossy(), "result": v }), || format!("{pack} on {}:\n  Standard:    {:.2} {unit}\n  Accelerated: {}\n  speedup:     {}\nsaved {}",
        ctx.platform_key(), res["regular"]["median"].as_f64().unwrap_or(0.0), res["turbo"]["median"].as_f64().map(|x| format!("{x:.2} {unit}")).unwrap_or("not available for this pack".into()),
        speedup.map(|s| format!("{s:.2}x")).unwrap_or("-".into()), f.display()));
    Ok(())
}

// 2 doctor
async fn doctor(ctx: &mut Ctx, j: bool) -> Result<(), String> {
    let mut rows: Vec<Value> = vec![];
    let mut add = |status: &str, check: &str, detail: String, fix: &str| rows.push(json!({ "status": status, "check": check, "detail": detail, "fix": fix }));
    let os = ctx.info["os"].as_str().unwrap_or("").to_string();
    let mac = ctx.platform_key() == "macos-aarch64";
    let nv = ctx.nvidia_gpu().await;
    let other = ctx.other_gpu().await;
    let lspci_nv = os == "linux" && run_capture("lspci", &[], 10).await.map(|r| r["stdout"].as_str().unwrap_or("").to_lowercase().lines().any(|l| l.contains("nvidia") && (l.contains("vga") || l.contains("3d")))).unwrap_or(false);
    match (&nv, &other) {
        (Some(g), _) => add("OK", "GPU", format!("{} ({} GB, compute {})", g["name"].as_str().unwrap_or(""), g["memoryGB"], g["compute"]), ""),
        (None, Some(o)) => add("OK", "GPU", format!("{o} (Vulkan)"), ""),
        _ if mac => add("OK", "GPU", "Apple silicon (Metal)".into(), ""),
        _ => add("WARN", "GPU", "none found: models run on the CPU (slower)".into(), "a GPU with 8 GB or more helps; small packs still work"),
    }
    if lspci_nv && nv.is_none() { add("FAIL", "NVIDIA driver", "an NVIDIA GPU is in the computer but nvidia-smi does not answer".into(), "install the NVIDIA driver (570 or newer), reboot, then: sushila engine install"); }
    else if nv.is_some() { add("OK", "NVIDIA driver", "nvidia-smi answers".into(), ""); }
    let key = ctx.state["engine"]["key"].as_str().unwrap_or("").to_string();
    if !ctx.engine_ok() { add("FAIL", "engine", "Sushila.cpp is not installed".into(), "sushila engine install"); }
    else {
        let want = if nv.is_some() { "-cuda" } else if other.is_some() { "-vulkan" } else { "" };
        let fb = ctx.state["engineFallback"].clone();
        if !want.is_empty() && !key.ends_with(want) { add("WARN", "engine build", format!("{key} ({}) although the GPU wants {}{}", Ctx::gpu_label(&key), want.trim_start_matches('-'), if fb.is_object() { format!("; it fell back on {} after {} did not start", fb["at"].as_str().unwrap_or(""), fb["model"].as_str().unwrap_or("")) } else { String::new() }), "sushila engine install   (then sushila selftest)"); }
        else { add("OK", "engine build", format!("Sushila.cpp {} {key} ({})", ctx.state["engine"]["version"].as_str().unwrap_or(""), Ctx::gpu_label(&key)), ""); }
        let server = ctx.state["engine"]["server"].as_str().unwrap_or("").to_string();
        let mut c = tokio::process::Command::new(&server); c.arg("--version").stdin(std::process::Stdio::null());
        if os == "linux" { if let Some(d) = ctx.state["engine"]["dir"].as_str() { c.env("LD_LIBRARY_PATH", d); } }
        match tokio::time::timeout(Duration::from_secs(30), c.output()).await {
            Ok(Ok(o)) if o.status.success() || !o.stderr.is_empty() => add("OK", "engine runs", String::from_utf8_lossy(&o.stderr).lines().chain(String::from_utf8_lossy(&o.stdout).lines()).find(|l| l.contains("version")).unwrap_or("starts").trim().to_string(), ""),
            _ => add("FAIL", "engine runs", format!("{server} does not start"), "sushila engine install"),
        }
        match ctx.load_catalog().await.map(|c| c["engine"]["version"].as_str().unwrap_or("").to_string()) {
            Ok(v) if v != ctx.state["engine"]["version"].as_str().unwrap_or("") => add("WARN", "engine version", format!("{} installed, {v} published", ctx.state["engine"]["version"].as_str().unwrap_or("")), "sushila update"),
            Ok(_) => add("OK", "engine version", "the newest published".into(), ""),
            Err(e) => add("WARN", "catalog", e, "check the internet connection (installed packs work offline)"),
        }
    }
    // disk
    let canon = std::fs::canonicalize(&ctx.data).unwrap_or(ctx.data.clone());
    let disks = sysinfo::Disks::new_with_refreshed_list();
    if let Some(d) = disks.list().iter().filter(|d| canon.starts_with(d.mount_point())).max_by_key(|d| d.mount_point().as_os_str().len()) {
        let free = d.available_space();
        let (st, fix) = if free < 2_000_000_000 { ("FAIL", "free disk space, or move the home: sushila home <folder on a bigger disk>") } else if free < 10_000_000_000 { ("WARN", "big packs need 5-50 GB; sushila clean frees leftovers") } else { ("OK", "") };
        add(st, "disk", format!("{} free on {}", human(free), d.mount_point().display()), fix);
    }
    // home writable
    let probe = ctx.data.join(".doctor-write-test");
    match std::fs::write(&probe, "x") { Ok(()) => { let _ = std::fs::remove_file(&probe); add("OK", "home folder", format!("{} is writable", ctx.data.display()), ""); }
        Err(e) => add("FAIL", "home folder", format!("{} is not writable: {e}", ctx.data.display()), "sushila home <a folder you own>") }
    // port
    let port = ctx.setting("port").as_u64().unwrap_or(7874) as u16;
    if owner_port(ctx).await.is_some() { add("OK", "port", format!("{port}: this Sushila's server answers"), ""); }
    else if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() { add("OK", "port", format!("{port} is free"), ""); }
    else { add("FAIL", "port", format!("{port} is used by another program"), "sushila config set port 8800   (or sushila serve --port 8800)"); }
    if ctx.state["share"]["enabled"] == true || ctx.state["share"]["listen"] == true {
        let hint = match os.as_str() { "windows" => format!("allow it in Windows Defender Firewall: netsh advfirewall firewall add rule name=Sushila dir=in action=allow protocol=TCP localport={port}"),
            "macos" => "System Settings -> Network -> Firewall: allow incoming connections for sushila".into(), _ => format!("if a firewall runs: sudo ufw allow {port}/tcp") };
        add("WARN", "firewall", format!("sharing is on: other machines need port {port} open"), &hint);
        if ctx.state["share"]["open"] != true && ctx.state["share"]["keys"].as_array().map(|a| a.is_empty()).unwrap_or(true) { add("WARN", "access keys", "sharing is on but there is no access key".into(), "sushila keys add <name>"); }
    }
    // packs: every file against its sha256 (cached by size and date, like the server's check)
    let ids: Vec<String> = ctx.packs().keys().cloned().collect();
    if ids.is_empty() { add("WARN", "packs", "none installed".into(), "sushila search; sushila install <pack>"); }
    for id in ids {
        let p = ctx.packs()[&id].clone();
        let dir = PathBuf::from(p["dir"].as_str().unwrap_or(""));
        let mut bad = vec![];
        for f in p["files"].as_array().cloned().unwrap_or_default() {
            let path = join_rel(&dir, f["path"].as_str().unwrap_or(""));
            let got = if path.exists() { sha256_cached(&ctx.data, &path).unwrap_or_default() } else { "missing".into() };
            if f["sha256"].as_str().map(|s| s != got).unwrap_or(false) || got == "missing" { bad.push(format!("{} ({})", f["path"].as_str().unwrap_or(""), if got == "missing" { "missing" } else { "changed" })); }
        }
        let signed = p["custom"] != true;
        if bad.is_empty() { add("OK", "pack", format!("{id}: every file matches its sha256{}", if signed { " (signed by Sushila)" } else { " (your own model, not signed)" }), ""); }
        else { add("FAIL", "pack", format!("{id}: {}", bad.join(", ")), &format!("sushila remove {id}; sushila install {id}")); }
    }
    let fails = rows.iter().filter(|r| r["status"] == "FAIL").count();
    out(j, json!({ "ok": fails == 0, "checks": rows }), || rows.iter().map(|r| format!("{:<5} {:<15} {}{}", r["status"].as_str().unwrap_or(""), r["check"].as_str().unwrap_or(""), r["detail"].as_str().unwrap_or(""),
        r["fix"].as_str().filter(|f| !f.is_empty()).map(|f| format!("\n      fix: {f}")).unwrap_or_default())).collect::<Vec<_>>().join("\n"));
    if fails > 0 { return Err(format!("{fails} check(s) failed")); }
    Ok(())
}

/// The text pack to use when none is named: the one running, else the largest installed that fits, else the default.
async fn default_text_pack(ctx: &mut Ctx) -> String {
    refresh(ctx);
    let mem = ctx.nvidia_gpu().await.and_then(|g| g["memoryGB"].as_f64()).unwrap_or(ctx.info["memory_bytes"].as_f64().unwrap_or(0.0) / 1e9 * 0.6);
    let st = if owner_port(ctx).await.is_some() { ctx.state.clone() } else { let mut s = ctx.state.clone(); s["running"] = json!({}); s };
    crate::assistant::pick_model(&st, mem).unwrap_or(DEFAULT_MODEL.to_string())
}

// 3 chat
async fn chat_cmd(ctx: &mut Ctx, pack: Option<String>, standard: bool, j: bool) -> Result<(), String> {
    let pack = match pack { Some(p) => p, None => default_text_pack(ctx).await };
    let p = pack_rec(ctx, &pack)?;
    if kind_of(&p) != "text" { return Err(format!("{pack} is not a text model: use sushila run {pack} \"...\"")); }
    let (base, here) = text_base(ctx, &pack, if standard { Some("regular") } else { None }).await?;
    let tok = token(ctx);
    let mut hist: Vec<Value> = vec![];
    if tty_in() { eprintln!("Chat with {pack} (/exit to end, /clear to forget, /save <file> to save)"); }
    let mut line = String::new();
    loop {
        if tty_in() { eprint!("\n> "); }
        line.clear();
        if std::io::stdin().read_line(&mut line).map_err(err)? == 0 { break; }
        let q = line.trim().to_string();
        if q.is_empty() { continue; }
        if q == "/exit" || q == "/quit" { break; }
        if q == "/clear" { hist.clear(); eprintln!("(history cleared)"); continue; }
        if let Some(f) = q.strip_prefix("/save") {
            let f = f.trim(); let f = if f.is_empty() { format!("chat-{}.md", stamp()) } else { f.to_string() };
            let md: String = hist.iter().map(|m| format!("**{}**: {}\n\n", m["role"].as_str().unwrap_or(""), m["content"].as_str().unwrap_or(""))).collect();
            std::fs::write(&f, md).map_err(err)?; eprintln!("(saved {f})"); continue;
        }
        hist.push(json!({ "role": "user", "content": q }));
        let mut print = |t: &str| { if !j { use std::io::Write; print!("{t}"); let _ = std::io::stdout().flush(); } };
        let t0 = std::time::Instant::now();
        let r = chat(&base, &tok, &pack, &json!(hist), 2048, 0.7, Some(&mut print)).await;
        match r {
            Ok((text, a)) => { if j { println!("{}", json!({ "answer": text, "tokensPerSecond": tps(&a, t0.elapsed().as_secs_f64()) })); } else { println!(); }
                               hist.push(json!({ "role": "assistant", "content": text })); }
            Err(e) => { hist.pop(); eprintln!("error: {e}"); }
        }
    }
    if here { ctx.stop_model(&pack).await; }
    Ok(())
}

/// GPU memory per process id, from nvidia-smi (MiB).
async fn gpu_mem_by_pid() -> std::collections::HashMap<u32, u64> {
    let mut m = std::collections::HashMap::new();
    if let Some(r) = run_capture("nvidia-smi", &["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], 10).await {
        for l in r["stdout"].as_str().unwrap_or("").lines() { let v: Vec<&str> = l.split(',').map(str::trim).collect(); if v.len() == 2 { if let (Ok(p), Ok(mb)) = (v[0].parse(), v[1].parse()) { m.insert(p, mb); } } }
    }
    m
}
async fn ps_rows(ctx: &mut Ctx) -> Vec<Value> {
    refresh(ctx);
    let gpu = gpu_mem_by_pid().await;
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut rows = vec![];
    for (id, r) in ctx.state["running"].as_object().cloned().unwrap_or_default() {
        let port = r["port"].as_u64().unwrap_or(0);
        let pid = r["enginePid"].as_u64().unwrap_or(0) as u32;
        let up = http_text(&format!("http://127.0.0.1:{port}/health"), 2).await.is_ok() || http_text(&format!("http://127.0.0.1:{port}/"), 2).await.is_ok();
        let mem = sys.process(sysinfo::Pid::from_u32(pid)).map(|p| p.memory());
        let started = r["startedAt"].as_str().and_then(iso_secs);
        rows.push(json!({ "pack": id, "mode": mode_name(r["mode"].as_str().unwrap_or("")), "port": port, "slots": r["slots"], "ready": r["ready"], "answering": up, "pid": pid,
            "uptimeSeconds": started.map(|s| now_secs().saturating_sub(s)), "memoryBytes": mem, "gpuMemoryMiB": gpu.get(&pid) }));
    }
    rows
}
fn ps_table(rows: &[Value]) -> String {
    if rows.is_empty() { return "no models running (sushila start <pack>, or sushila serve)".into(); }
    let mut s = format!("{:<30} {:<12} {:>6} {:>5} {:>9} {:>9} {:>9}\n", "PACK", "MODE", "PORT", "SLOTS", "UPTIME", "MEMORY", "GPU MEM");
    for r in rows { s += &format!("{:<30} {:<12} {:>6} {:>5} {:>9} {:>9} {:>9}{}\n", r["pack"].as_str().unwrap_or(""), r["mode"].as_str().unwrap_or(""), r["port"], r["slots"].as_u64().map(|x| x.to_string()).unwrap_or("-".into()),
        r["uptimeSeconds"].as_u64().map(ago).unwrap_or("-".into()), r["memoryBytes"].as_u64().map(human).unwrap_or("-".into()), r["gpuMemoryMiB"].as_u64().map(|m| human(m * 1_048_576)).unwrap_or("-".into()),
        if r["answering"] == true { "" } else if r["ready"] == true { "  (not answering)" } else { "  (loading)" }); }
    s.trim_end().to_string()
}
// 4 ps
async fn ps(ctx: &mut Ctx, j: bool) -> Result<(), String> { let rows = ps_rows(ctx).await; out(j, json!(rows), || ps_table(&rows)); Ok(()) }

// 5 show
async fn show(ctx: &mut Ctx, pack: &str, j: bool) -> Result<(), String> {
    let inst = ctx.packs().get(pack).cloned();
    let cat = match ctx.load_catalog().await { Ok(c) => c["packs"].as_array().and_then(|a| a.iter().find(|p| p["id"] == pack).cloned()), Err(_) => None };
    let p = inst.clone().or(cat.clone()).ok_or(format!("{pack} is neither installed nor in the catalog (sushila search)"))?;
    let meta = inst.as_ref().and_then(|i| read_json(&PathBuf::from(i["dir"].as_str().unwrap_or("")).join("sushila-pack.json")));
    let serve = cat.as_ref().map(|c| c["serve"].clone()).or(meta.as_ref().map(|m| m["serve"].clone())).unwrap_or(json!({}));
    let turbo_args = inst.as_ref().map(|i| i["turboArgs"].clone()).unwrap_or(serve["turboArgs"].clone());
    let artifacts = p["artifacts"].clone();
    let treq = inst.as_ref().map(|i| i["turboRequest"].clone()).unwrap_or(serve["turboRequest"].clone());
    let files: Vec<Value> = p["files"].as_array().cloned().unwrap_or_default().into_iter().map(|f| json!({ "path": f["path"], "bytes": f["bytes"], "sha256": f["sha256"], "role": f["role"] })).collect();
    let bytes: u64 = files.iter().map(|f| f["bytes"].as_u64().unwrap_or(0)).sum();
    let mut accel = vec![];
    if let Some(a) = artifacts.as_array() { for x in a { accel.push(format!("precomputed: {}", x.as_str().unwrap_or(""))); } }
    if let Some(a) = turbo_args.as_array().filter(|a| !a.is_empty()) { accel.push(format!("engine options: {}", a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" "))); }
    if treq.is_object() { accel.push(format!("cache plan: {treq}")); }
    let can = inst.as_ref().map(can_turbo).unwrap_or(!accel.is_empty());
    let v = json!({ "id": pack, "name": p["name"], "kind": p.get("kind").cloned().unwrap_or(json!("text")), "license": p["license"], "licenseUrl": cat.as_ref().map(|c| c["licenseUrl"].clone()),
        "description": cat.as_ref().map(|c| c["description"].clone()), "bytes": bytes, "installed": inst.is_some(), "dir": inst.as_ref().map(|i| i["dir"].clone()), "custom": p["custom"] == true,
        "accelerated": can, "accelerates": accel, "files": files });
    out(j, v.clone(), || {
        let mut s = format!("{} ({pack})\nkind:        {}\nlicense:     {}{}\nsize:        {}\ninstalled:   {}\n", p["name"].as_str().unwrap_or(pack), v["kind"].as_str().unwrap_or("text"), p["license"].as_str().unwrap_or("?"),
            v["licenseUrl"].as_str().map(|u| format!("  {u}")).unwrap_or_default(), human(bytes), inst.as_ref().map(|i| format!("yes, {}", i["dir"].as_str().unwrap_or(""))).unwrap_or("no (sushila install ".to_string() + pack + ")"));
        if let Some(d) = v["description"].as_str() { s += &format!("about:       {d}\n"); }
        s += &format!("Accelerated: {}\n", if can { accel.join("; ") } else { "not available (Standard only)".into() });
        s += "files:\n";
        for f in v["files"].as_array().unwrap() { s += &format!("  {:<56} {:>9}  {}\n", f["path"].as_str().unwrap_or(""), human(f["bytes"].as_u64().unwrap_or(0)), f["sha256"].as_str().unwrap_or("(not recorded)")); }
        s.trim_end().to_string()
    });
    Ok(())
}

// 6 update
async fn update(ctx: &mut Ctx, check: bool, j: bool) -> Result<(), String> {
    ctx.load_catalog().await?;
    let cat = ctx.catalog.clone().unwrap();
    let have = ctx.state["engine"]["version"].as_str().unwrap_or("").to_string();
    let newest = cat["engine"]["version"].as_str().unwrap_or("").to_string();
    let want_key = ctx.engine_key().await;
    let engine_new = !ctx.engine_ok() || have != newest;
    let mut changed = vec![];
    for (id, p) in ctx.packs().clone() {
        if p["custom"] == true { continue; }
        let Some(c) = cat["packs"].as_array().and_then(|a| a.iter().find(|x| x["id"] == id.as_str()).cloned()) else { continue };
        let have: std::collections::BTreeSet<String> = p["files"].as_array().map(|a| a.iter().map(|f| format!("{}:{}", f["path"].as_str().unwrap_or(""), f["sha256"].as_str().unwrap_or(""))).collect()).unwrap_or_default();
        let want: std::collections::BTreeSet<String> = c["files"].as_array().map(|a| a.iter().map(|f| format!("{}:{}", f["path"].as_str().unwrap_or(""), f["sha256"].as_str().unwrap_or(""))).collect()).unwrap_or_default();
        if have != want { changed.push(id); }
    }
    let v = json!({ "engine": { "installed": have, "published": newest, "build": want_key, "update": engine_new }, "packs": changed });
    if check || (!engine_new && changed.is_empty()) {
        out(j, v.clone(), || format!("engine: {}\npacks:  {}", if engine_new { format!("{have} -> {newest} ({want_key})") } else { format!("{have}, the newest") },
            if changed.is_empty() { "all current".into() } else { format!("changed in the catalog: {} (sushila update installs them)", changed.join(", ")) }));
        return Ok(());
    }
    if let Some(sp) = owner_port(ctx).await {
        if engine_new { remote(ctx, sp, json!({ "action": "engine-install", "source": "cli" })).await?; }
        for id in &changed { remote(ctx, sp, json!({ "action": "remove", "pack": id, "source": "cli" })).await?; remote(ctx, sp, json!({ "action": "install", "pack": id, "source": "cli" })).await?; }
    } else {
        let _l = local_lock(ctx)?;
        if engine_new { ctx.install_engine(None).await?; }
        for id in &changed {
            // unchanged files are linked from the old folder, so only what changed is downloaded
            let old = ctx.packs()[id].clone();
            ctx.state["packs"].as_object_mut().unwrap().remove(id);
            let Some(plan) = ctx.prepare_pack(id).await? else { continue };
            let odir = PathBuf::from(old["dir"].as_str().unwrap_or(""));
            for f in plan.pack["files"].as_array().cloned().unwrap_or_default() {
                let rel = f["path"].as_str().unwrap_or("");
                if old["files"].as_array().map(|a| a.iter().any(|o| o["path"] == rel && o["sha256"] == f["sha256"])).unwrap_or(false) {
                    let to = join_rel(&plan.dir, rel); if let Some(d) = to.parent() { let _ = std::fs::create_dir_all(d); }
                    if std::fs::hard_link(join_rel(&odir, rel), &to).is_err() { let _ = std::fs::copy(join_rel(&odir, rel), &to); }
                }
            }
            Ctx::fetch_pack(&plan, None).await?;
            ctx.apply_pack(&plan)?;
        }
    }
    out(j, json!({ "ok": true, "updated": v }), || format!("updated: {}{}", if engine_new { format!("engine {newest}; ") } else { String::new() }, if changed.is_empty() { "no packs".into() } else { changed.join(", ") }));
    Ok(())
}

// 7 queue
async fn queue(ctx: &mut Ctx, act: Option<&crate::QueueCmd>, j: bool) -> Result<(), String> {
    let sp = owner_port(ctx).await.ok_or("no server is running (sushila serve); past jobs: sushila history")?;
    let tok = token(ctx);
    let post = |id: String, a: &'static str| { let tok = tok.clone(); async move {
        let r = client().post(format!("http://127.0.0.1:{sp}/api/queue/{id}/{a}")).header("x-sushila-token", tok).send().await.map_err(err)?;
        if r.status().is_success() { Ok(()) } else { Err(format!("{}: {}", r.status(), r.text().await.unwrap_or_default())) } } };
    match act {
        None | Some(crate::QueueCmd::List) => {
            let q: Value = client().get(format!("http://127.0.0.1:{sp}/api/queue")).header("x-sushila-token", &tok).send().await.map_err(err)?.json().await.map_err(err)?;
            let jobs = q["jobs"].as_array().cloned().unwrap_or_default();
            out(j, q.clone(), || { let mut s = format!("queue {}\n", if q["paused"] == true { "PAUSED (sushila queue resume)" } else { "running" });
                if jobs.is_empty() { s += "no jobs"; }
                for jb in &jobs { s += &format!("{:<26} {:<6} {:<28} {:<10} {}\n", jb["id"].as_str().unwrap_or(""), jb["kind"].as_str().unwrap_or(""), jb["model"].as_str().unwrap_or(""), jb["status"].as_str().unwrap_or(""),
                    jb["title"].as_str().filter(|t| !t.is_empty()).or(jb["progress"].as_str()).unwrap_or("")); }
                s.trim_end().to_string() });
        }
        Some(crate::QueueCmd::Pause { id }) => { post(id.clone().unwrap_or("all".into()), "pause").await?; out(j, json!({ "ok": true }), || format!("paused {}", id.as_deref().unwrap_or("the queue"))); }
        Some(crate::QueueCmd::Resume { id }) => { post(id.clone().unwrap_or("all".into()), "resume").await?; out(j, json!({ "ok": true }), || format!("resumed {}", id.as_deref().unwrap_or("the queue"))); }
        Some(crate::QueueCmd::Cancel { id }) => { post(id.clone(), "cancel").await?; out(j, json!({ "ok": true }), || format!("cancelled {id}")); }
    }
    Ok(())
}

// 8 clean
async fn clean(ctx: &mut Ctx, dry: bool, j: bool) -> Result<(), String> {
    let serving = owner_port(ctx).await.is_some();
    // without a server, the owner lock: no install can start while this runs
    let _lock = if serving || dry { None } else { Some(local_lock(ctx)?) };
    let mut items: Vec<(PathBuf, u64, String)> = vec![];
    // unfinished pack installs and copies (while a server runs they may be in progress: left alone)
    if !serving {
        for e in std::fs::read_dir(&ctx.packs_dir).into_iter().flatten().flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if [".installing-", ".downloading-", ".copying-"].iter().any(|p| n.starts_with(p)) { items.push((e.path(), dir_size(&e.path()), "unfinished install".into())); }
        }
        for d in ["staging", "downloads"] { let p = ctx.data.join(d); if p.exists() && dir_size(&p) > 0 { items.push((p, 0, "unfinished downloads".into())); } }
    }
    // engine builds other than the one in use (compared by their real paths); while a server runs, none (a fallback
    // build may be the one its models use)
    if !serving {
        let cur = ctx.state["engine"]["dir"].as_str().and_then(|d| std::fs::canonicalize(d).ok());
        for e in std::fs::read_dir(ctx.data.join("engine")).into_iter().flatten().flatten() {
            if e.path().is_dir() && std::fs::canonicalize(e.path()).ok() != cur { items.push((e.path(), 0, "old engine version".into())); }
        }
    }
    // queue outputs (outputs/job-*.<ext>, files at the top only) that no queue job refers to; the Library (images/,
    // music/, video/, its index, shared links and the trash) is never touched here
    let q = read_json(&ctx.data.join("queue.json")).unwrap_or(json!({}));
    let used: std::collections::HashSet<String> = q["jobs"].as_array().map(|a| a.iter().filter_map(|x| x["output"]["file"].as_str().map(String::from)).collect()).unwrap_or_default();
    for e in std::fs::read_dir(ctx.data.join("outputs")).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if e.file_type().map(|t| t.is_file()).unwrap_or(false) && n.starts_with("job-") && !used.contains(&n) { items.push((e.path(), 0, "output of a removed queue job".into())); }
    }
    for it in items.iter_mut() { if it.1 == 0 { it.1 = dir_size(&it.0); } }
    // the sha256 cache: entries of files that no longer exist
    let vp = ctx.data.join("verified.json");
    let mut cache: serde_json::Map<String, Value> = read_json(&vp).and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let before = cache.len(); cache.retain(|k, _| Path::new(k).exists());
    let stale = before - cache.len();
    let total: u64 = items.iter().map(|i| i.1).sum();
    if !dry {
        for (p, _, _) in &items { let _ = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) }; }
        if stale > 0 { let _ = std::fs::write(&vp, serde_json::to_string(&Value::Object(cache)).unwrap_or_default()); }
        ctx.log(&format!("clean: {} removed ({} items)", human(total), items.len()));
    }
    let rows: Vec<Value> = items.iter().map(|(p, b, w)| json!({ "path": p.to_string_lossy(), "bytes": b, "what": w })).collect();
    out(j, json!({ "ok": true, "dryRun": dry, "bytes": total, "items": rows, "staleCacheEntries": stale, "skippedDownloads": serving }), || {
        let mut s: String = items.iter().map(|(p, b, w)| format!("{} {:>9}  {}  ({w})\n", if dry { "would remove" } else { "removed" }, human(*b), p.display())).collect();
        if stale > 0 { s += &format!("{stale} stale sha256 cache entries {}\n", if dry { "would be dropped" } else { "dropped" }); }
        if serving { s += "a server is running: unfinished downloads are left alone (they may be in progress)\n"; }
        s + &format!("{}: {}", if dry { "would free" } else { "freed" }, human(total))
    });
    Ok(())
}

// 9 du
fn du(ctx: &Ctx, j: bool) {
    let mut rows: Vec<(String, u64)> = vec![];
    for (id, p) in ctx.packs() { rows.push((format!("pack {id}"), dir_size(Path::new(p["dir"].as_str().unwrap_or(""))))); }
    let packs_total: u64 = rows.iter().map(|r| r.1).sum();
    for (n, d) in [("engine", "engine"), ("image runtime", "runtime"), ("logs", "logs"), ("queue outputs", "outputs"), ("downloads", "downloads"), ("bench results", "bench")] { rows.push((n.into(), dir_size(&ctx.data.join(d)))); }
    let total = dir_size(&ctx.data) + if ctx.packs_dir.starts_with(&ctx.data) { 0 } else { packs_total };
    let other = total.saturating_sub(rows.iter().map(|r| r.1).sum());
    rows.push(("other".into(), other));
    out(j, json!({ "total": total, "home": ctx.data.to_string_lossy(), "items": rows.iter().map(|(n, b)| json!({ "what": n, "bytes": b })).collect::<Vec<_>>() }),
        || rows.iter().map(|(n, b)| format!("{:>9}  {n}", human(*b))).collect::<Vec<_>>().join("\n") + &format!("\n{:>9}  total ({})", human(total), ctx.data.display()));
}

// 10 config
async fn config(ctx: &mut Ctx, act: &crate::ConfigCmd, j: bool) -> Result<(), String> {
    refresh(ctx);
    match act {
        crate::ConfigCmd::List => {
            let v: Value = SETTINGS.iter().map(|s| (s.0.to_string(), ctx.setting(s.0))).chain([("catalogUrl".to_string(), ctx.setting("catalogUrl")), ("ticker".to_string(), json!(if crate::ticker::on_setting(&ctx.setting("ticker")) { "on" } else { "off" }))]).collect::<serde_json::Map<_, _>>().into();
            out(j, v.clone(), || SETTINGS.iter().map(|s| format!("{:<12} {:<8} {}", s.0, ctx.setting(s.0).to_string(), s.1)).chain([format!("{:<12} {}", "catalogUrl", ctx.setting("catalogUrl")), format!("{:<12} {:<8} the scrolling line of tips at the bottom of the server window (off unless set on)", "ticker", if crate::ticker::on_setting(&ctx.setting("ticker")) { "on" } else { "off" })]).collect::<Vec<_>>().join("\n"));
        }
        crate::ConfigCmd::Get { key } => {
            if key != "catalogUrl" && key != "ticker" && !SETTINGS.iter().any(|s| s.0 == key) { return Err(format!("unknown setting {key}; `sushila config list` shows them")); }
            let v = ctx.setting(key); out(j, json!({ key.as_str(): v }), || v.as_str().map(String::from).unwrap_or(v.to_string()));
        }
        crate::ConfigCmd::Set { key, value } => {
            let v = parse_setting(key, value)?;
            let how = set_settings(ctx, json!({ key.as_str(): v })).await?;
            out(j, json!({ "ok": true, key.as_str(): v }), || format!("{key} = {v} ({how}){}", if key == "port" { "; takes effect at the next sushila serve" } else if ["contextSize", "gpuLayers", "parallel", "threads"].contains(&key.as_str()) { "; applied when a model starts next" } else { "" }));
        }
    }
    Ok(())
}

// 11 export / import
fn export(ctx: &Ctx, pack: &str, file: &Path, j: bool) -> Result<(), String> {
    let p = pack_rec(ctx, pack)?;
    let dir = PathBuf::from(p["dir"].as_str().unwrap_or(""));
    // the pack's description with every file's sha256 (for your own models too), so import can check each file
    let mut meta = read_json(&dir.join("sushila-pack.json")).ok_or("the pack has no sushila-pack.json")?;
    if meta["custom"] == true { meta["files"] = p["files"].clone(); }
    let name = file.to_string_lossy().to_lowercase();
    let mut names: Vec<String> = p["files"].as_array().map(|a| a.iter().filter_map(|f| f["path"].as_str().map(String::from)).collect()).unwrap_or_default();
    names.retain(|n| n != "sushila-pack.json");
    let meta_s = serde_json::to_string_pretty(&meta).unwrap();
    if name.ends_with(".zip") {
        use std::io::Write;
        let f = std::fs::File::create(file).map_err(err)?;
        let mut z = zip::ZipWriter::new(f);
        let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).large_file(true);
        z.start_file(format!("{pack}/sushila-pack.json"), opt).map_err(err)?; z.write_all(meta_s.as_bytes()).map_err(err)?;
        for n in &names { z.start_file(format!("{pack}/{n}"), opt).map_err(err)?; std::io::copy(&mut std::fs::File::open(join_rel(&dir, n)).map_err(err)?, &mut z).map_err(err)?; }
        z.finish().map_err(err)?;
    } else if name.ends_with(".tar") || name.ends_with(".sushilapack") {
        let mut t = tar::Builder::new(std::fs::File::create(file).map_err(err)?);
        let mut h = tar::Header::new_gnu(); h.set_size(meta_s.len() as u64); h.set_mode(0o644); h.set_cksum();
        t.append_data(&mut h, format!("{pack}/sushila-pack.json"), meta_s.as_bytes()).map_err(err)?;
        for n in &names { t.append_path_with_name(join_rel(&dir, n), format!("{pack}/{n}")).map_err(err)?; }
        t.finish().map_err(err)?;
    } else { return Err("the file must end in .zip, .tar or .sushilapack".into()); }
    let bytes = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    out(j, json!({ "ok": true, "file": file.to_string_lossy(), "bytes": bytes, "files": names.len() + 1 }), || format!("{pack} exported to {} ({}, {} files); install it elsewhere with: sushila import {}", file.display(), human(bytes), names.len() + 1, file.display()));
    Ok(())
}
async fn import(ctx: &mut Ctx, file: &Path, j: bool) -> Result<(), String> {
    if !file.is_file() { return Err(format!("{} is not a file", file.display())); }
    let staging = ctx.data.join("staging").join(format!("import-{}", &random_token()[..8]));
    extract_archive(file, &staging).await?;
    let res: Result<String, String> = async {
        let mut root = staging.clone();
        if !root.join("sushila-pack.json").exists() { let subs: Vec<PathBuf> = std::fs::read_dir(&staging).map(|d| d.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default(); if subs.len() == 1 { root = subs[0].clone(); } }
        let meta = read_json(&root.join("sushila-pack.json")).ok_or("this file is not a Sushila model pack (no sushila-pack.json)")?;
        let id = meta["id"].as_str().unwrap_or("").to_string();
        if !safe_id_dots(&id) { return Err("the pack id is not valid".into()); }
        if ctx.packs().contains_key(&id) { return Err(format!("{id} is already installed (sushila remove {id} first)")); }
        // every file's sha256 before anything is adopted
        for f in meta["files"].as_array().cloned().unwrap_or_default() {
            let p = f["path"].as_str().unwrap_or("");
            if !safe_rel_path(p) { return Err(format!("unsafe path {p}")); }
            let want = f["sha256"].as_str().ok_or(format!("{p}: no sha256 recorded; refusing it"))?;
            let got = file_sha256(&join_rel(&root, p)).await.unwrap_or_else(|_| "missing".into());
            if got != want { return Err(format!("{p} is {}; nothing was installed", if got == "missing" { "missing" } else { "damaged or changed" })); }
        }
        if meta["custom"] != true {
            // signed packs: the same checks as any pack file (signature, signed index)
            if let Some(sp) = owner_port(ctx).await { remote(ctx, sp, json!({ "action": "install-file", "path": std::fs::canonicalize(file).map_err(err)?.to_string_lossy(), "source": "cli" })).await?; return Ok(id); }
            let _l = local_lock(ctx)?; return ctx.install_pack_file(file).await;
        }
        let dest = ctx.packs_dir.join(&id);
        if dest.exists() { return Err(format!("{} already exists", dest.display())); }
        std::fs::rename(&root, &dest).map_err(err)?;
        if owner_port(ctx).await.is_some() { return Ok(id); }  // the server's folder scan adopts it
        let _l = local_lock(ctx)?;
        ctx.adopt_folder_now(&dest).await
    }.await;
    let _ = std::fs::remove_dir_all(&staging);
    let id = res?;
    out(j, json!({ "ok": true, "installed": id }), || format!("{id} imported (every file's sha256 checked)"));
    Ok(())
}

// 12 backup / restore
fn backup(ctx: &Ctx, file: &Path, j: bool) -> Result<(), String> {
    use std::io::Write;
    let st = read_json(&ctx.data.join("state.json")).unwrap_or(ctx.state.clone());
    let b = json!({ "app": "sushila", "version": env!("CARGO_PKG_VERSION"), "created": now_iso(), "settings": st["settings"], "share": st["share"],
        "preferredModes": st["packs"].as_object().map(|m| m.iter().filter_map(|(k, p)| p["preferredMode"].as_str().map(|x| (k.clone(), json!(x)))).collect::<serde_json::Map<_, _>>()) });
    let mut z = zip::ZipWriter::new(std::fs::File::create(file).map_err(err)?);
    let opt = zip::write::SimpleFileOptions::default();
    z.start_file("backup.json", opt).map_err(err)?; z.write_all(serde_json::to_string_pretty(&b).unwrap().as_bytes()).map_err(err)?;
    let mut parts = vec!["backup.json"];
    for f in ["queue.json"] { if let Ok(d) = std::fs::read(ctx.data.join(f)) { z.start_file(f, opt).map_err(err)?; z.write_all(&d).map_err(err)?; parts.push(f); } }
    z.finish().map_err(err)?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600)); }
    out(j, json!({ "ok": true, "file": file.to_string_lossy(), "contains": parts }), || format!("backup written to {} ({}); keys are stored as hashes; no model packs (reinstall them)", file.display(), parts.join(", ")));
    Ok(())
}
async fn restore(ctx: &mut Ctx, file: &Path, j: bool) -> Result<(), String> {
    if owner_port(ctx).await.is_some() { return Err("stop the server first (sushila stop): it would overwrite the restored settings".into()); }
    let _l = local_lock(ctx)?;
    let mut z = zip::ZipArchive::new(std::fs::File::open(file).map_err(err)?).map_err(err)?;
    let mut read = |n: &str| -> Option<Vec<u8>> { let mut e = z.by_name(n).ok()?; let mut v = vec![]; std::io::Read::read_to_end(&mut e, &mut v).ok()?; Some(v) };
    let b: Value = serde_json::from_slice(&read("backup.json").ok_or("not a Sushila backup (no backup.json)")?).map_err(err)?;
    if b["app"] != "sushila" { return Err("not a Sushila backup".into()); }
    let mut done = vec![];
    if let Some(s) = b["settings"].as_object() { for (k, v) in s { ctx.state["settings"][k] = v.clone(); } done.push("settings"); }
    if b["share"].is_object() { ctx.state["share"] = b["share"].clone(); done.push("sharing and access keys"); }
    if let Some(m) = b["preferredModes"].as_object() { for (k, v) in m { if ctx.state["packs"][k].is_object() { ctx.state["packs"][k]["preferredMode"] = v.clone(); } } }
    ctx.save()?;
    if let Some(q) = read("queue.json") { serde_json::from_slice::<Value>(&q).map_err(err)?; std::fs::write(ctx.data.join("queue.json"), q).map_err(err)?; done.push("queue history"); }
    ctx.log(&format!("restored from {}: {}", file.display(), done.join(", ")));
    out(j, json!({ "ok": true, "restored": done }), || format!("restored: {}", done.join(", ")));
    Ok(())
}

// 13 search
async fn search(ctx: &mut Ctx, text: Option<&str>, kind: Option<&str>, fits: bool, j: bool) -> Result<(), String> {
    ctx.load_catalog().await?;
    let packs = ctx.catalog.as_ref().unwrap()["packs"].as_array().cloned().unwrap_or_default();
    let t = text.unwrap_or("").to_lowercase();
    let mut rows = vec![];
    for p in packs.iter().filter(|p| p["hidden"] != true) {
        let k = p.get("kind").and_then(|k| k.as_str()).unwrap_or("text");
        let id = p["id"].as_str().unwrap_or("");
        let code = id.contains("coder") || p["category"].as_str().unwrap_or("").to_lowercase().contains("code");
        let kk = if k == "text" { if code { "code" } else { "chat" } } else { k };
        if let Some(w) = kind { if !(w == kk || (w == "text" && k == "text")) { continue; } }
        let hay = format!("{} {} {} {}", id, p["name"].as_str().unwrap_or(""), p["description"].as_str().unwrap_or(""), p["category"].as_str().unwrap_or("")).to_lowercase();
        if !t.split_whitespace().all(|w| hay.contains(w)) { continue; }
        let f = ctx.pack_fits(p).await;
        if fits && !f { continue; }
        let bytes: u64 = p["files"].as_array().map(|a| a.iter().map(|f| f["bytes"].as_u64().unwrap_or(0)).sum()).unwrap_or(0);
        rows.push(json!({ "id": id, "name": p["name"], "kind": kk, "bytes": bytes, "fits": f, "installed": ctx.packs().contains_key(id), "license": p["license"], "description": p["description"] }));
    }
    out(j, json!(rows), || if rows.is_empty() { "nothing found (sushila packs --all lists everything)".into() } else {
        rows.iter().map(|r| format!("{:<34} {:<5} {:>8}  {}{}{}", r["id"].as_str().unwrap_or(""), r["kind"].as_str().unwrap_or(""), human(r["bytes"].as_u64().unwrap_or(0)), r["name"].as_str().unwrap_or(""),
            if r["installed"] == true { "  [installed]" } else { "" }, if r["fits"] == false { "  [needs other hardware]" } else { "" })).collect::<Vec<_>>().join("\n") + "\nInstall with: sushila install <pack>" });
    Ok(())
}

// 14 open
async fn open(ctx: &mut Ctx, page: Option<&str>, j: bool) -> Result<(), String> {
    let port = ctx.setting("port").as_u64().unwrap_or(7874);
    let path = match page { None | Some("inference") | Some("use") => "/", Some("admin") => "/admin", Some("docs") => "/docs", Some("assistant") => "/#assistant", Some(o) => return Err(format!("unknown page {o}: open, open admin, open docs, open assistant")) };
    let url = format!("http://localhost:{port}{path}");
    let up = owner_port(ctx).await.is_some();
    if up { crate::open_browser(&url); }
    out(j, json!({ "ok": up, "url": url }), || if up { format!("opening {url}") } else { format!("no server is running: start it with `sushila serve`, then open {url}") });
    Ok(())
}

// 15 example
fn example(ctx: &Ctx, pack: &str, lang: Option<&str>, j: bool) -> Result<(), String> {
    let p = pack_rec(ctx, pack)?;
    let lang = lang.unwrap_or("curl");
    if !["curl", "python", "js"].contains(&lang) { return Err("curl, python or js".into()); }
    let port = ctx.setting("port").as_u64().unwrap_or(7874);
    let here = snippet(lang, &format!("http://localhost:{port}"), pack, &kind_of(&p), ("x-sushila-token", &token(ctx)));
    let lan = crate::local_ip().unwrap_or("<this computer's address>".into());
    let there = snippet(lang, &format!("http://{lan}:{port}"), pack, &kind_of(&p), ("Authorization", "Bearer <access key from: sushila keys add <name>>"));
    out(j, json!({ "thisComputer": here, "otherMachines": there }), || format!("# on this computer (the token is this home's local token: keep it private)\n{here}\n# from other machines (needs `sushila share on` or `sushila serve --public`, and an access key)\n{there}"));
    Ok(())
}

// 16 top
async fn top(ctx: &mut Ctx, interval: u64, once: bool, j: bool) -> Result<(), String> {
    let tty = std::io::IsTerminal::is_terminal(&std::io::stdout());
    loop {
        let rows = ps_rows(ctx).await;
        let g = run_capture("nvidia-smi", &["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], 10).await
            .filter(|r| r["code"] == 0).map(|r| r["stdout"].as_str().unwrap_or("").lines().map(|l| { let v: Vec<&str> = l.split(',').map(str::trim).collect(); json!({ "name": v.first(), "utilization": v.get(1).and_then(|x| x.parse::<f64>().ok()), "usedMiB": v.get(2).and_then(|x| x.parse::<f64>().ok()), "totalMiB": v.get(3).and_then(|x| x.parse::<f64>().ok()) }) }).collect::<Vec<_>>()).unwrap_or_default();
        // the last generation speed each engine printed ("... tokens per second")
        let speeds: Vec<Value> = rows.iter().map(|r| { let id = r["pack"].as_str().unwrap_or("");
            let t = tail_lines(&ctx.data.join("logs").join(format!("{id}.log")), 200);
            let v = t.lines().rev().find(|l| l.contains("eval time") && !l.contains("prompt eval") && l.contains("tokens per second")).and_then(|l| l.split(',').next_back()?.split_whitespace().next()?.parse::<f64>().ok());
            json!({ "pack": id, "tokensPerSecond": v }) }).collect();
        if j { println!("{}", json!({ "time": now_iso(), "models": rows, "gpus": g, "speeds": speeds })); }
        else {
            let mut s = format!("Sushila top  {}  (Ctrl+C ends)\n\n{}\n\n", now_iso(), ps_table(&rows));
            for x in &g { s += &format!("GPU {}: {:.0}% busy, {} of {} used\n", x["name"].as_str().unwrap_or(""), x["utilization"].as_f64().unwrap_or(0.0), human((x["usedMiB"].as_f64().unwrap_or(0.0) * 1_048_576.0) as u64), human((x["totalMiB"].as_f64().unwrap_or(0.0) * 1_048_576.0) as u64)); }
            for x in &speeds { if let Some(v) = x["tokensPerSecond"].as_f64() { s += &format!("{}: last answer {v:.1} tokens/s\n", x["pack"].as_str().unwrap_or("")); } }
            if tty && !once { print!("\x1b[2J\x1b[H"); }
            println!("{s}");
        }
        if once { return Ok(()); }
        tokio::select! { _ = tokio::signal::ctrl_c() => return Ok(()), _ = tokio::time::sleep(Duration::from_secs(interval.max(1))) => {} }
    }
}

// 18 version
async fn version(ctx: &mut Ctx, verify: bool, j: bool) -> Result<(), String> {
    let e = ctx.state["engine"].clone();
    let mut v = json!({ "sushila": env!("CARGO_PKG_VERSION"), "engine": e["version"], "engineBuild": e["key"], "platform": ctx.platform_key(), "os": std::env::consts::OS, "arch": std::env::consts::ARCH });
    if verify {
        let exe = std::env::current_exe().map_err(err)?;
        let sha = file_sha256(&exe).await?;
        v["executable"] = json!(exe.to_string_lossy()); v["sha256"] = json!(sha);
        // a signed list of sushila builds in the catalog ("cli": {index: {text, signature}}), when one is published
        let cat = ctx.load_catalog().await.ok().cloned();
        let listed = match cat { Some(c) if c["cli"]["index"].is_object() => { let idx = ctx.signed_index(&c["cli"]["index"], "the list of sushila builds")?;
            Some(idx["builds"].as_object().map(|b| b.values().any(|x| x["sha256"] == sha.as_str())).unwrap_or(false)) }, _ => None };
        v["signedList"] = json!(listed);
    }
    out(j, v.clone(), || { let mut s = format!("sushila {}\nengine   {}\nplatform {}", env!("CARGO_PKG_VERSION"), if e.is_object() { format!("Sushila.cpp {} ({})", e["version"].as_str().unwrap_or(""), e["key"].as_str().unwrap_or("")) } else { "not installed".into() }, ctx.platform_key());
        if verify { s += &format!("\nsha256   {}  {}\n{}", v["sha256"].as_str().unwrap_or(""), v["executable"].as_str().unwrap_or(""), match v["signedList"].as_bool() {
            Some(true) => "MATCHES the signed list of sushila builds".into(), Some(false) => "NOT in the signed list of sushila builds: download it again from sushila.ai or the GitHub release".into(),
            None => "no signed list of sushila builds is published yet: compare the sha256 with the one in the download table (downloads/README.md, GitHub release)".to_string() }); }
        s });
    if v["signedList"] == false { return Err("this program does not match the signed list".into()); }
    Ok(())
}

// 19 report
async fn report(ctx: &mut Ctx, file: Option<PathBuf>, j: bool) -> Result<(), String> {
    use std::io::Write;
    let file = file.unwrap_or_else(|| ctx.data.join("reports").join(format!("sushila-report-{}.zip", stamp())));
    if let Some(d) = file.parent() { std::fs::create_dir_all(d).map_err(err)?; }
    let st = read_json(&ctx.data.join("state.json")).unwrap_or(ctx.state.clone());
    let secrets: Vec<String> = [st["token"].as_str().map(String::from), Some(crate::webserver::cli_token(&ctx.data)), std::fs::read_to_string(ctx.data.join("adminpassword")).ok().map(|s| s.trim().to_string())]
        .into_iter().flatten().filter(|s| s.len() >= 16).collect();
    let scrub = |t: String| secrets.iter().fold(t, |t, s| t.replace(s.as_str(), "<removed>"));
    let gpu = ctx.nvidia_gpu().await; let other = ctx.other_gpu().await;
    let smi = run_capture("nvidia-smi", &[], 15).await.map(|r| r["stdout"].as_str().unwrap_or("").to_string()).unwrap_or("nvidia-smi: not available".into());
    let packs: Vec<Value> = st["packs"].as_object().map(|m| m.values().map(|p| json!({ "id": p["id"], "kind": p["kind"], "bytes": p["bytes"], "custom": p["custom"], "installedAt": p["installedAt"] })).collect()).unwrap_or_default();
    let info = json!({ "created": now_iso(), "sushila": env!("CARGO_PKG_VERSION"), "platform": ctx.platform_key(), "host": ctx.info, "engine": st["engine"]["version"], "engineBuild": st["engine"]["key"], "engineFallback": st["engineFallback"],
        "nvidia": gpu, "otherGpu": other, "settings": st["settings"], "share": { "enabled": st["share"]["enabled"], "listen": st["share"]["listen"], "open": st["share"]["open"], "hosts": st["share"]["hosts"], "keys": st["share"]["keys"].as_array().map(|a| a.len()) },
        "packs": packs, "running": st["running"].as_object().map(|m| m.keys().cloned().collect::<Vec<_>>()) });
    let mut z = zip::ZipWriter::new(std::fs::File::create(&file).map_err(err)?);
    let opt = zip::write::SimpleFileOptions::default();
    let mut put = |n: &str, d: String| -> Result<(), String> { z.start_file(n, opt).map_err(err)?; z.write_all(scrub(d).as_bytes()).map_err(err) };
    put("info.json", serde_json::to_string_pretty(&info).unwrap())?;
    put("nvidia-smi.txt", smi)?;
    put("sushila.log", tail_lines(&ctx.data.join("logs").join("sushila.log"), 300))?;
    put("crashes.json", std::fs::read_to_string(ctx.data.join("crashes.json")).unwrap_or("[]".into()))?;
    for id in st["running"].as_object().map(|m| m.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() { put(&format!("{id}.log"), tail_lines(&ctx.data.join("logs").join(format!("{id}.log")), 100))?; }
    z.finish().map_err(err)?;
    out(j, json!({ "ok": true, "file": file.to_string_lossy() }), || format!("{}\n(versions, GPU, settings, the last 300 log lines and crashes; no access keys, tokens or password hashes)", file.display()));
    Ok(())
}

// 20 reproduce
fn reproduce(result: Option<&str>, j: bool) -> Result<(), String> {
    match result {
        None => out(j, json!({ "guide": GUIDE, "results": REPRODUCE.iter().map(|(n, w, c)| json!({ "name": n, "what": w, "command": c })).collect::<Vec<_>>() }), || {
            REPRODUCE.iter().map(|(n, w, _)| format!("{n:<30} {w}")).collect::<Vec<_>>().join("\n") + &format!("\n\nsushila reproduce <name> prints the command (run it in a clone of the repository). Every table and figure: {GUIDE}") }),
        Some(r) => {
            let (n, w, c) = REPRODUCE.iter().find(|x| x.0 == r).ok_or(format!("unknown result {r}; `sushila reproduce` lists them"))?;
            out(j, json!({ "name": n, "what": w, "command": c, "guide": GUIDE }), || format!("# {w}\n# in a clone of https://github.com/syncaissa/sushila.cpp\n{c}\n# hardware, time, expected numbers and the pass rule: {GUIDE}"));
        }
    }
    Ok(())
}

// 21 batch
async fn batch(ctx: &mut Ctx, pack: &str, prompts: &Path, out_dir: Option<PathBuf>, standard: bool, j: bool) -> Result<(), String> {
    let p = pack_rec(ctx, pack)?;
    let kind = kind_of(&p);
    let lines: Vec<String> = std::fs::read_to_string(prompts).map_err(|e| format!("{}: {e}", prompts.display()))?.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty() && !l.starts_with('#')).collect();
    if lines.is_empty() { return Err("no prompts in the file (one per line; # starts a comment)".into()); }
    let dir = out_dir.unwrap_or_else(|| prompts.with_extension("").with_file_name(format!("{}-out", prompts.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or("batch".into()))));
    std::fs::create_dir_all(&dir).map_err(err)?;
    let mode = if standard { "regular" } else if can_turbo(&p) { "turbo" } else { "regular" };
    let (port, here) = engine(ctx, pack, Some(mode)).await?;
    let accel = if mode == "turbo" { turbo_request(&p) } else { None };
    let mut index = vec![];
    let r: Result<(), String> = async {
        for (i, prompt) in lines.iter().enumerate() {
            let seed = 1000 + i as i64;
            let mut params = json!({ "prompt": prompt });
            if kind != "text" { params["seed"] = json!(seed); }
            if kind == "music" { params["style"] = json!(prompt); params["lyrics"] = json!("[Instrumental]"); params["duration"] = json!(60.0); }
            let t0 = std::time::Instant::now();
            let res = jobs::run(&kind, pack, port, &params, accel.clone(), |_| {}).await;
            let secs = t0.elapsed().as_secs_f64();
            match res {
                Ok(o) => { let f = format!("{:04}.{}", i + 1, o.ext); std::fs::write(dir.join(&f), &o.bytes).map_err(err)?;
                    if !ctx.quiet { eprintln!("{}/{}: {f} ({secs:.1} s)", i + 1, lines.len()); }
                    index.push(json!({ "n": i + 1, "prompt": prompt, "file": f, "seed": if kind != "text" { json!(seed) } else { Value::Null }, "mode": mode_name(mode), "settings": params, "seconds": secs })); }
                Err(e) => { if !ctx.quiet { eprintln!("{}/{}: failed: {e}", i + 1, lines.len()); } index.push(json!({ "n": i + 1, "prompt": prompt, "error": e, "seconds": secs })); }
            }
            std::fs::write(dir.join("index.json"), serde_json::to_string_pretty(&json!({ "pack": pack, "kind": kind, "items": index })).unwrap()).map_err(err)?;
        }
        Ok(())
    }.await;
    if here { ctx.stop_model(pack).await; }
    r?;
    let failed = index.iter().filter(|x| x.get("error").is_some()).count();
    out(j, json!({ "ok": failed == 0, "dir": dir.to_string_lossy(), "done": index.len() - failed, "failed": failed }), || format!("{} of {} done in {} (index.json lists prompt, seed, settings and seconds)", index.len() - failed, index.len(), dir.display()));
    Ok(())
}

// 22 history
fn history(ctx: &Ctx, act: Option<&crate::HistoryCmd>, j: bool) -> Result<(), String> {
    let q = read_json(&ctx.data.join("queue.json")).unwrap_or(json!({ "jobs": [] }));
    let jobs = q["jobs"].as_array().cloned().unwrap_or_default();
    let outp = |jb: &Value| jb["output"]["file"].as_str().map(|f| ctx.data.join("outputs").join(f).to_string_lossy().to_string());
    match act {
        None => { let rows: Vec<Value> = jobs.iter().rev().map(|jb| json!({ "id": jb["id"], "kind": jb["kind"], "model": jb["model"], "status": jb["status"], "created": jb["created"], "title": jb["title"], "prompt": jb["params"]["prompt"].as_str().or(jb["params"]["style"].as_str()), "output": outp(jb) })).collect();
            out(j, json!(rows), || if rows.is_empty() { "no jobs yet".into() } else { rows.iter().map(|r| format!("{:<26} {:<20} {:<6} {:<9} {}", r["id"].as_str().unwrap_or(""), r["created"].as_str().unwrap_or(""), r["kind"].as_str().unwrap_or(""), r["status"].as_str().unwrap_or(""),
                r["prompt"].as_str().or(r["title"].as_str()).unwrap_or("").chars().take(60).collect::<String>())).collect::<Vec<_>>().join("\n") + "\nsushila history show <id> for one job" }); }
        Some(crate::HistoryCmd::Show { id }) => {
            let jb = jobs.iter().find(|x| x["id"] == id.as_str()).ok_or(format!("no job {id}"))?;
            let v = json!({ "id": jb["id"], "kind": jb["kind"], "model": jb["model"], "status": jb["status"], "created": jb["created"], "started": jb["started"], "finished": jb["finished"], "params": jb["params"], "seed": jb["params"]["seed"], "error": jb["error"], "output": outp(jb), "progress": jb["progress"] });
            out(j, v.clone(), || serde_json::to_string_pretty(&v).unwrap());
        }
    }
    Ok(())
}

// 23 watch
async fn watch(ctx: &mut Ctx, folder: &Path, pack: Option<String>, once: bool, j: bool) -> Result<(), String> {
    if !folder.is_dir() { return Err(format!("{} is not a folder", folder.display())); }
    let pack = match pack { Some(p) => p, None => default_text_pack(ctx).await };
    let p = pack_rec(ctx, &pack)?;
    let kind = kind_of(&p);
    let (port, here) = engine(ctx, &pack, None).await?;
    let accel = if ctx.state["running"][&pack]["mode"] == "turbo" { turbo_request(&p) } else { None };
    if !j { eprintln!("watching {} with {pack}: each new .txt file is a prompt; the output is written next to it and the prompt renamed to .txt.done (Ctrl+C ends)", folder.display()); }
    let mut done = 0;
    let r: Result<(), String> = async { loop {
        let mut files: Vec<PathBuf> = std::fs::read_dir(folder).map_err(err)?.flatten().map(|e| e.path()).filter(|p| p.extension().map(|x| x == "txt").unwrap_or(false)).collect();
        files.sort();
        for f in files {
            // a file still being written waits for the next round
            if std::fs::metadata(&f).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() < 2).unwrap_or(true) && !once { continue; }
            let prompt = std::fs::read_to_string(&f).map_err(err)?.trim().to_string();
            if prompt.is_empty() { continue; }
            let mut params = json!({ "prompt": prompt });
            if kind == "music" { params["style"] = json!(prompt); params["lyrics"] = json!("[Instrumental]"); }
            let t0 = std::time::Instant::now();
            let stem = f.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or("out".into());
            match jobs::run(&kind, &pack, port, &params, accel.clone(), |_| {}).await {
                Ok(o) => { let of = f.with_file_name(format!("{stem}.out.{}", o.ext)); std::fs::write(&of, &o.bytes).map_err(err)?;
                    if j { println!("{}", json!({ "prompt": f.to_string_lossy(), "output": of.to_string_lossy(), "seconds": t0.elapsed().as_secs_f64() })); } else { eprintln!("{} -> {} ({:.1} s)", f.display(), of.display(), t0.elapsed().as_secs_f64()); } }
                Err(e) => { std::fs::write(f.with_file_name(format!("{stem}.error.txt")), &e).map_err(err)?; eprintln!("{}: failed: {e}", f.display()); }
            }
            std::fs::rename(&f, f.with_extension("txt.done")).map_err(err)?;
            done += 1;
        }
        if once { return Ok(()); }
        tokio::select! { _ = tokio::signal::ctrl_c() => return Ok(()), _ = tokio::time::sleep(Duration::from_secs(2)) => {} }
    } }.await;
    if here { ctx.stop_model(&pack).await; }
    r?;
    if !j { eprintln!("{done} prompt(s) done"); }
    Ok(())
}

// 24 share
async fn share(ctx: &mut Ctx, act: &crate::ShareCmd, j: bool) -> Result<(), String> {
    let port = ctx.setting("port").as_u64().unwrap_or(7874);
    let lan = crate::local_ip().map(|ip| format!("http://{ip}:{port}/"));
    let serving = owner_port(ctx).await.is_some();
    match act {
        crate::ShareCmd::On { open } => {
            set_share(ctx, json!({ "enabled": true, "listen": true, "open": *open })).await?;
            refresh(ctx);
            let keys = ctx.state["share"]["keys"].as_array().map(|a| a.len()).unwrap_or(0);
            out(j, json!({ "ok": true, "url": lan, "open": open, "keys": keys }), || format!("sharing on{}: other machines use {}\n{}{}", if *open { " WITHOUT keys (--open: trusted networks only)" } else { "" }, lan.clone().unwrap_or("http://<this computer's address>:".to_string() + &port.to_string() + "/"),
                if *open || keys > 0 { String::new() } else { "They need an access key: sushila keys add <name>\n".into() },
                if serving { "The running server listens only on this computer until it restarts: sushila stop; sushila serve" } else { "Takes effect at the next sushila serve (it then listens on all addresses)" }));
        }
        crate::ShareCmd::Off => {
            set_share(ctx, json!({ "enabled": false, "listen": false, "open": false })).await?;
            out(j, json!({ "ok": true }), || format!("sharing off: only this computer can use Sushila{}", if serving { " (other machines are refused at once; restart to stop listening on the network)" } else { "" }));
        }
        crate::ShareCmd::Qr => {
            let u = lan.ok_or("no network address found for this computer")?;
            let q = qr_text(&u)?;
            out(j, json!({ "url": u, "qr": q }), || format!("{q}\n{u}{}", if ctx.state["share"]["listen"] == true || ctx.state["share"]["enabled"] == true { "" } else { "\n(sharing is off: sushila share on)" }));
        }
    }
    Ok(())
}

// 25 mode
async fn set_mode(ctx: &mut Ctx, pack: &str, m: &str, j: bool) -> Result<(), String> {
    let p = pack_rec(ctx, pack)?;
    let mode = match m { "standard" | "regular" => "regular", "accelerated" | "turbo" => "turbo", _ => return Err("standard or accelerated".into()) };
    if mode == "turbo" && !can_turbo(&p) { return Err(format!("{pack} has no Accelerated mode (no precomputed files for it)")); }
    if let Some(sp) = owner_port(ctx).await {
        remote(ctx, sp, json!({ "action": "mode", "pack": pack, "mode": mode, "source": "cli" })).await?;
        refresh(ctx);
        let running = ctx.state["running"][pack].is_object();
        out(j, json!({ "ok": true, "mode": mode_name(mode), "running": running }), || format!("{pack}: {} {}", mode_name(mode), if running { "(running now)" } else { "(used at its next start)" }));
    } else {
        let _l = local_lock(ctx)?;
        ctx.state["packs"][pack]["preferredMode"] = json!(mode); ctx.save()?;
        out(j, json!({ "ok": true, "mode": mode_name(mode), "running": false }), || format!("{pack}: {} at its next start", mode_name(mode)));
    }
    Ok(())
}

// 28 convert
async fn convert(ctx: &mut Ctx, source: &str, outf: Option<PathBuf>, outtype: &str, j: bool) -> Result<(), String> {
    const COMMIT: &str = "6f767fe960c3b97cf37fac4626c86400561ca1e4";  // llama.cpp b11232, the version Sushila.cpp builds on
    if !["f16", "bf16", "q8_0", "f32", "auto"].contains(&outtype) { return Err("--outtype f16, bf16, q8_0, f32 or auto".into()); }
    let python = std::env::var("SUSHILA_PYTHON").unwrap_or_else(|_| if cfg!(windows) { "python".into() } else { "python3".into() });
    let tools = ctx.data.join("tools").join("llama.cpp");
    let script = std::env::var("SUSHILA_LLAMA_CPP").map(PathBuf::from).unwrap_or(tools.clone()).join("convert_hf_to_gguf.py");
    let steps = format!("1. Python 3.10+ with the converter's packages:  {python} -m pip install -r {}\n2. llama.cpp at b11232:  git clone https://github.com/ggml-org/llama.cpp {} && git -C {} checkout {COMMIT}\n3. {python} {} <model folder> --outfile model.gguf --outtype {outtype}\n4. sushila install model.gguf   (your own model, Standard mode)",
        tools.join("requirements/requirements-convert_hf_to_gguf.txt").display(), tools.display(), tools.display(), script.display());
    let py_ok = run_capture(&python, &["--version"], 20).await.map(|r| r["code"] == 0).unwrap_or(false);
    if !py_ok { return Err(format!("{python} was not found. Converting needs Python and llama.cpp's converter:\n{steps}")); }
    if !script.exists() {
        // llama.cpp at the pinned commit, once (git, a shallow fetch of that one commit)
        if run_capture("git", &["--version"], 20).await.map(|r| r["code"] != 0).unwrap_or(true) { return Err(format!("git was not found, so llama.cpp's converter cannot be fetched. Steps:\n{steps}")); }
        if !ctx.quiet { eprintln!("fetching llama.cpp's converter at {COMMIT} into {}", tools.display()); }
        std::fs::create_dir_all(&tools).map_err(err)?;
        let t = tools.to_string_lossy().to_string();
        for a in [vec!["init", "-q", &t], vec!["-C", &t, "fetch", "-q", "--depth", "1", "https://github.com/ggml-org/llama.cpp", COMMIT], vec!["-C", &t, "checkout", "-q", "FETCH_HEAD"]] {
            let r = run_capture("git", &a, 1800).await.ok_or("git did not run")?;
            if r["code"] != 0 { return Err(format!("git {}: {}", a.join(" "), r["stderr"].as_str().unwrap_or(""))); }
        }
    }
    let gguf_py = script.parent().unwrap().join("gguf-py");
    let check = run_capture(&python, &["-c", &format!("import sys; sys.path.insert(0, r'{}'); import torch, transformers, numpy, sentencepiece, gguf", gguf_py.display())], 120).await.ok_or("python did not run")?;
    if check["code"] != 0 {
        return Err(format!("the converter's Python packages are missing ({}). Install them (Sushila does not install Python packages itself):\n  {python} -m pip install -r {}\nthen run this command again.\nAll steps:\n{steps}",
            check["stderr"].as_str().unwrap_or("").lines().last().unwrap_or(""), script.parent().unwrap().join("requirements/requirements-convert_hf_to_gguf.txt").display()));
    }
    // the source: a local folder, or a Hugging Face repository downloaded with huggingface_hub
    let folder = if Path::new(source).is_dir() { PathBuf::from(source) } else {
        let repo = source.trim_start_matches("hf:").trim_start_matches("https://huggingface.co/");
        if !repo.chars().all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c)) || repo.split('/').count() != 2 { return Err(format!("{source} is neither a folder nor a Hugging Face repository like Qwen/Qwen2.5-0.5B-Instruct")); }
        let dest = ctx.data.join("tools").join("hf").join(repo.replace('/', "--"));
        if !ctx.quiet { eprintln!("downloading {repo} (safetensors, config, tokenizer) into {}", dest.display()); }
        let code = format!("from huggingface_hub import snapshot_download; snapshot_download('{repo}', local_dir=r'{}', allow_patterns=['*.json','*.safetensors','*.model','*.txt','*.tiktoken','*.py'])", dest.display());
        let r = run_capture(&python, &["-c", &code], 7200).await.ok_or("python did not run")?;
        if r["code"] != 0 { return Err(format!("download failed (pip install huggingface_hub; gated models need `hf auth login`): {}", r["stderr"].as_str().unwrap_or("").lines().last().unwrap_or(""))); }
        dest
    };
    let name = folder.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or("model".into()).replace("--", "-");
    let outf = outf.unwrap_or_else(|| ctx.data.join("tools").join(format!("{}-{outtype}.gguf", name.to_lowercase())));
    if !ctx.quiet { eprintln!("converting {} -> {} ({outtype})", folder.display(), outf.display()); }
    let mut c = tokio::process::Command::new(&python);
    c.arg(&script).arg(&folder).arg("--outfile").arg(&outf).arg("--outtype").arg(outtype).env("PYTHONPATH", &gguf_py);
    if ctx.quiet || j { c.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()); }
    let st = c.status().await.map_err(err)?;
    if !st.success() { return Err(format!("the converter failed ({st}); this model's architecture may be newer than llama.cpp b11232")); }
    // adopted like `sushila install <file>.gguf`: your own model, Standard mode (or our pack, if it is byte for byte one)
    let id = if let Some(sp) = owner_port(ctx).await { remote(ctx, sp, json!({ "action": "install-file", "path": std::fs::canonicalize(&outf).map_err(err)?.to_string_lossy(), "source": "cli" })).await?; outf.file_stem().unwrap().to_string_lossy().to_string() }
        else { let _l = local_lock(ctx)?; if !ctx.engine_ok() { ctx.install_engine(None).await?; } let d = ctx.take_gguf(&outf)?; ctx.adopt_folder_now(&d).await? };
    out(j, json!({ "ok": true, "gguf": outf.to_string_lossy(), "pack": id }), || format!("converted to {} and added as your own model {id} (Standard mode; not verified by Sushila)", outf.display()));
    Ok(())
}

// 29 precompute (experimental)
async fn precompute(ctx: &mut Ctx, pack: &str, j: bool) -> Result<(), String> {
    let p = pack_rec(ctx, pack)?;
    if kind_of(&p) != "text" { return Err("precompute builds output-layer landscapes for text packs only".into()); }
    let mut roots: Vec<PathBuf> = std::env::var("SUSHILA_REPO").ok().map(PathBuf::from).into_iter().collect();
    for b in [std::env::current_dir().ok(), std::env::current_exe().ok()].into_iter().flatten() { roots.extend(b.ancestors().map(Path::to_path_buf)); }
    let script = roots.iter().map(|r| r.join("scripts").join("day0_landscape.sh")).find(|s| s.is_file());
    let what = "EXPERIMENTAL: the day-0 landscape pipeline (license check, pinned model file, calibration text, landscape build, per-domain selection, gate on a disjoint test set, manifest). Linux or macOS with bash, python3 and the repository's tools built (scripts/build.sh); about 19 min for a 0.5B model on 2 CPU cores, hours for 70B.";
    let Some(script) = script else {
        out(j, json!({ "ok": false, "experimental": true, "found": false, "needs": what }), || format!("{what}\nThe repository's scripts were not found. Steps:\n  git clone https://github.com/syncaissa/sushila.cpp && cd sushila.cpp\n  bash scripts/build.sh\n  SUSHILA_REPO=$PWD sushila precompute {pack}     (or: scripts/day0_landscape.sh {pack})"));
        return Ok(());
    };
    if cfg!(windows) { return Err(format!("{what}\nIt needs bash: run it in WSL ({} {pack})", script.display())); }
    let outdir = ctx.data.join("day0");
    if !ctx.quiet { eprintln!("{what}\nrunning {} {pack} (results in {})", script.display(), outdir.display()); }
    let mut c = tokio::process::Command::new("bash");
    c.arg(&script).arg(pack).env("DAY0_DIR", &outdir);
    let st = c.status().await.map_err(err)?;
    out(j, json!({ "ok": st.success(), "experimental": true, "script": script.to_string_lossy(), "out": outdir.join(pack).to_string_lossy() }), || format!("{} (see {})", if st.success() { "landscape built and gated" } else { "the pipeline stopped" }, outdir.join(pack).display()));
    if !st.success() { return Err(format!("day0_landscape.sh ended with {st}")); }
    Ok(())
}

// 30 eval
async fn eval(ctx: &mut Ctx, pack: &str, n: usize, j: bool) -> Result<(), String> {
    let p = pack_rec(ctx, pack)?;
    if kind_of(&p) != "text" { return Err("eval needs a text pack".into()); }
    let n = n.clamp(1, MATH.len());
    let modes: Vec<&str> = if can_turbo(&p) { vec!["regular", "turbo"] } else { vec!["regular"] };
    let mut res = json!({});
    for m in &modes {
        let (port, here) = engine(ctx, pack, Some(m)).await?;
        let base = format!("http://127.0.0.1:{port}");
        let mut right = 0; let mut items = vec![];
        let r: Result<(), String> = async {
            for (q, a) in MATH.iter().take(n) {
                let msgs = json!([{ "role": "user", "content": format!("{q}\nSolve it step by step, then write the final number on the last line as: Answer: <number>") }]);
                let (t, _) = chat(&base, "", pack, &msgs, 400, 0.0, None).await?;
                let got = last_number(&t);
                if got == Some(*a) { right += 1; }
                items.push(json!({ "question": q, "expected": a, "got": got }));
            }
            Ok(())
        }.await;
        if here { ctx.stop_model(pack).await; }
        r?;
        if !ctx.quiet { eprintln!("{}: {right}/{n}", mode_name(m)); }
        res[*m] = json!({ "correct": right, "total": n, "accuracy": right as f64 / n as f64, "items": items });
    }
    out(j, json!({ "pack": pack, "standard": res["regular"], "accelerated": res["turbo"], "note": "20 grade-school math questions written for Sushila (MIT); temperature 0" }), || format!("{pack}, {n} grade-school math questions (temperature 0):\n  Standard:    {}/{n}\n  Accelerated: {}",
        res["regular"]["correct"], res["turbo"]["correct"].as_u64().map(|c| format!("{c}/{n}")).unwrap_or("not available for this pack".into())));
    Ok(())
}

// 31 ask
async fn ask(ctx: &mut Ctx, file: &Path, question: &str, pack: Option<String>, j: bool) -> Result<(), String> {
    if file.extension().map(|e| e.eq_ignore_ascii_case("pdf")).unwrap_or(false) { return Err("PDF files are not read directly: convert it to text first (pdftotext file.pdf file.txt), then sushila ask file.txt \"...\"".into()); }
    let bytes = std::fs::read(file).map_err(|e| format!("{}: {e}", file.display()))?;
    if bytes.iter().take(8192).any(|b| *b == 0) { return Err("this looks like a binary file; ask reads text, markdown and code".into()); }
    let text = String::from_utf8_lossy(&bytes).to_string();
    let pack = match pack { Some(p) => p, None => default_text_pack(ctx).await };
    if kind_of(&pack_rec(ctx, &pack)?) != "text" { return Err(format!("{pack} is not a text model")); }
    let (base, here) = text_base(ctx, &pack, None).await?;
    let tok = token(ctx);
    let ctx_tokens = ctx.setting("contextSize").as_u64().unwrap_or(4096);
    let chunk = (((ctx_tokens.saturating_sub(900)) as f64) * 3.0) as usize;
    let chars: Vec<char> = text.chars().collect();
    let pieces: Vec<String> = chars.chunks(chunk.max(1000)).map(|c| c.iter().collect()).collect();
    let r: Result<String, String> = async {
        if pieces.len() == 1 {
            let m = json!([{ "role": "system", "content": "Answer the question from the file below. If the file does not say, say so." }, { "role": "user", "content": format!("File {}:\n{}\n\nQuestion: {question}", file.display(), pieces[0]) }]);
            return Ok(chat(&base, &tok, &pack, &m, 800, 0.2, None).await?.0);
        }
        // too long for one request: notes from each part, then one answer from the notes
        let mut notes = vec![];
        for (i, p) in pieces.iter().enumerate() {
            if !ctx.quiet { eprintln!("reading part {} of {}", i + 1, pieces.len()); }
            let m = json!([{ "role": "user", "content": format!("Part {} of a file:\n{p}\n\nWrite short notes of everything in this part that helps answer: {question}\nIf nothing helps, write NONE.", i + 1) }]);
            let t = chat(&base, &tok, &pack, &m, 300, 0.2, None).await?.0;
            if !t.trim().eq_ignore_ascii_case("none") { notes.push(format!("Part {}: {}", i + 1, t.trim())); }
        }
        let joined: String = notes.join("\n").chars().take(chunk).collect();
        let m = json!([{ "role": "user", "content": format!("Notes taken from the parts of {}:\n{joined}\n\nAnswer from these notes: {question}", file.display()) }]);
        Ok(chat(&base, &tok, &pack, &m, 800, 0.2, None).await?.0)
    }.await;
    if here { ctx.stop_model(&pack).await; }
    let a = r?;
    out(j, json!({ "answer": a, "model": pack, "parts": pieces.len() }), || format!("{}\n\n({pack}, {} part{})", a.trim(), pieces.len(), if pieces.len() == 1 { "" } else { "s" }));
    Ok(())
}

/// A text engine of our own for one job (not recorded in state.json, so it never collides with the server's models):
/// e.g. with --embeddings, which turns chat off.
async fn private_engine(ctx: &Ctx, pack: &str, extra: &[&str]) -> Result<(tokio::process::Child, u16), String> {
    let p = pack_rec(ctx, pack)?;
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map(|a| a.port()).map_err(err)?;
    let dir = PathBuf::from(p["dir"].as_str().unwrap_or(""));
    let ngl = ctx.setting("gpuLayers").as_i64().unwrap_or(-1);
    let mut args: Vec<String> = vec!["-m".into(), join_rel(&dir, p["model"].as_str().unwrap_or("")).to_string_lossy().into(), "--host".into(), "127.0.0.1".into(), "--port".into(), port.to_string(),
        "-c".into(), "4096".into(), "-ngl".into(), if ngl < 0 { "auto".into() } else { ngl.to_string() }];
    args.extend(extra.iter().map(|s| s.to_string()));
    let log = std::fs::File::create(ctx.data.join("logs").join(format!("{pack}-private.log"))).map_err(err)?;
    let mut c = command(ctx.state["engine"]["server"].as_str().ok_or("the engine is not installed (sushila engine install)")?, &args);
    c.current_dir(&dir).stdout(log.try_clone().map_err(err)?).stderr(log).kill_on_drop(true).env("SUSHILA", "0");
    if ctx.info["os"] == "linux" { if let Some(d) = ctx.state["engine"]["dir"].as_str() { c.env("LD_LIBRARY_PATH", d); } }
    let mut child = c.spawn().map_err(err)?;
    for _ in 0..600 {
        if http_text(&format!("http://127.0.0.1:{port}/health"), 2).await.is_ok() { return Ok((child, port)); }
        if child.try_wait().ok().flatten().is_some() { return Err(format!("the engine stopped while loading; see {}", ctx.data.join("logs").join(format!("{pack}-private.log")).display())); }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("the engine did not become ready in 5 minutes".into())
}

// 32 embed
async fn embed(ctx: &mut Ctx, pack: &str, input: &str, j: bool) -> Result<(), String> {
    let p = pack_rec(ctx, pack)?;
    if kind_of(&p) != "text" { return Err("embeddings come from text packs".into()); }
    let text = if Path::new(input).is_file() { std::fs::read_to_string(input).map_err(err)? } else { input.to_string() };
    let body = json!({ "model": pack, "input": text });
    let get = |base: String, tok: String| { let body = body.clone(); async move {
        let r = client().post(format!("{base}/v1/embeddings")).header("x-sushila-token", tok).json(&body).timeout(Duration::from_secs(600)).send().await.map_err(err)?;
        let st = r.status(); let t = r.text().await.unwrap_or_default();
        if st.is_success() { serde_json::from_str::<Value>(&t).map_err(err) } else { Err(format!("{st}: {}", t.chars().take(300).collect::<String>())) } } };
    // the running model, if it was started with embeddings; else a private engine with --embeddings (chat stays untouched)
    refresh(ctx);
    let mut how = "the running model";
    let mut res = match owner_port(ctx).await { Some(sp) if ctx.state["running"][pack].is_object() => get(format!("http://127.0.0.1:{sp}"), token(ctx)).await, _ => Err("not running".into()) };
    if res.is_err() {
        if !ctx.quiet { eprintln!("starting a separate {pack} engine with --embeddings (a chat engine does not answer /v1/embeddings: llama.cpp's --embeddings turns chat off, so the server's model is left as it is)"); }
        let (mut child, port) = private_engine(ctx, pack, &["--embeddings", "--pooling", "mean"]).await?;
        res = get(format!("http://127.0.0.1:{port}"), String::new()).await;
        let _ = child.kill().await;
        how = "a separate engine with --embeddings";
    }
    let v = res?;
    let e: Vec<f64> = v["data"][0]["embedding"].as_array().map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
    if e.is_empty() { return Err("the engine returned no embedding".into()); }
    let norm = e.iter().map(|x| x * x).sum::<f64>().sqrt();
    out(j, json!({ "model": pack, "dimensions": e.len(), "embedding": e, "via": how }), || format!("{} dimensions (norm {norm:.3}, from {how}): [{} ...]  (--json prints all)", e.len(), e.iter().take(8).map(|x| format!("{x:.4}")).collect::<Vec<_>>().join(", ")));
    Ok(())
}

// 33 license
async fn license(ctx: &mut Ctx, pack: &str, j: bool) -> Result<(), String> {
    let inst = ctx.packs().get(pack).cloned();
    let cat = match ctx.load_catalog().await { Ok(c) => c["packs"].as_array().and_then(|a| a.iter().find(|p| p["id"] == pack).cloned()), Err(_) => None };
    let p = inst.clone().or(cat.clone()).ok_or(format!("{pack} is neither installed nor in the catalog"))?;
    let mut texts = vec![];
    if let Some(i) = &inst { let dir = PathBuf::from(i["dir"].as_str().unwrap_or(""));
        for e in walk(&dir) { let n = e.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default(); if n.starts_with("license") || n.starts_with("notice") { if let Ok(t) = std::fs::read_to_string(&e) { texts.push((e.to_string_lossy().to_string(), t)); } } } }
    let v = json!({ "pack": pack, "license": p["license"], "url": cat.as_ref().map(|c| c["licenseUrl"].clone()), "files": texts.iter().map(|(f, t)| json!({ "file": f, "text": t })).collect::<Vec<_>>() });
    out(j, v.clone(), || { let mut s = format!("{pack}: {}{}", p["license"].as_str().unwrap_or("not stated"), v["url"].as_str().map(|u| format!("\n{u}")).unwrap_or_default());
        for (f, t) in &texts { s += &format!("\n\n--- {f}\n{t}"); }
        if texts.is_empty() { s += "\n(the pack has no license file of its own; the link above is the model's license)"; }
        s });
    Ok(())
}
fn walk(d: &Path) -> Vec<PathBuf> { let mut v = vec![]; for e in std::fs::read_dir(d).into_iter().flatten().flatten() { let p = e.path(); if p.is_dir() { v.extend(walk(&p)); } else { v.push(p); } } v }

// 34 https
async fn https(ctx: &mut Ctx, domain: &str, j: bool) -> Result<(), String> {
    let d = domain.trim().to_ascii_lowercase();
    if d.is_empty() || !d.contains('.') || !d.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') { return Err("give a domain name, e.g. ai.example.com".into()); }
    let port = ctx.setting("port").as_u64().unwrap_or(7874);
    let dir = ctx.data.join("https"); std::fs::create_dir_all(&dir).map_err(err)?;
    let file = dir.join("Caddyfile");
    // the Host header is passed on as is (never rewritten to localhost: that would hand the page's local token to the internet)
    std::fs::write(&file, format!("# Sushila behind HTTPS: Caddy gets a certificate for {d} and forwards to the local server.\n{d} {{\n\treverse_proxy 127.0.0.1:{port}\n}}\n")).map_err(err)?;
    set_share(ctx, json!({ "enabled": true, "addHost": d })).await?;
    let caddy = run_capture("caddy", &["version"], 10).await.map(|r| r["code"] == 0).unwrap_or(false);
    let sudo = if cfg!(unix) { "sudo " } else { "" };
    let steps = format!("1. DNS: point {d} (an A/AAAA record) at this computer's public address.\n2. Open ports 80 and 443 in the firewall and router (Caddy gets the certificate on port 80).\n3. Install Caddy if needed: https://caddyserver.com/docs/install\n4. {sudo}caddy run --config {}\n5. Give each user an access key: sushila keys add <name>; they open https://{d}/\n{d} was added to the allowed host names and sharing was turned on (with keys). The local server stays on 127.0.0.1:{port}: only Caddy is exposed.", file.display());
    out(j, json!({ "ok": true, "caddyfile": file.to_string_lossy(), "caddy": caddy, "steps": steps }), || format!("wrote {}\n{steps}", file.display()));
    if caddy && !j && tty_in() {
        eprint!("Caddy is installed. Start it now in this terminal (Ctrl+C stops it)? [y/N] ");
        let mut a = String::new(); let _ = std::io::stdin().read_line(&mut a);
        if a.trim().eq_ignore_ascii_case("y") { let _ = tokio::process::Command::new("caddy").args(["run", "--config"]).arg(&file).status().await; }
    }
    Ok(())
}

// 35 uninstall
async fn uninstall(ctx: &mut Ctx, all: bool, yes: bool, j: bool) -> Result<(), String> {
    if owner_port(ctx).await.is_some() { return Err("a server is running: stop it first (sushila stop)".into()); }
    // --all: list and ask before anything is removed
    if all {
        let mut list: Vec<(String, u64)> = std::fs::read_dir(&ctx.data).map_err(err)?.flatten().map(|e| (e.file_name().to_string_lossy().to_string(), dir_size(&e.path()))).collect();
        list.sort();
        let total: u64 = list.iter().map(|x| x.1).sum();
        if !j { eprintln!("This deletes the home folder {} ({}):", ctx.data.display(), human(total)); for (n, b) in &list { eprintln!("  {:>9}  {n}", human(*b)); } }
        if !yes {
            if !tty_in() { return Err("nothing was removed: add --yes to delete the home folder without a terminal to ask in".into()); }
            eprint!("Type yes to delete all of it (models, settings, logs): ");
            let mut a = String::new(); let _ = std::io::stdin().read_line(&mut a);
            if a.trim() != "yes" { return Err("nothing was removed".into()); }
        }
    }
    let mut done = vec![];
    // the start-at-login service, if one was installed (sushila service install)
    let home = dirs::home_dir().unwrap_or_default();
    let has_service = match ctx.info["os"].as_str() {
        Some("linux") => home.join(".config/systemd/user/sushila.service").exists(),
        Some("macos") => home.join("Library/LaunchAgents/ai.sushila.serve.plist").exists(),
        _ => run_capture("schtasks", &["/Query", "/TN", "Sushila"], 20).await.map(|r| r["code"] == 0).unwrap_or(false),
    };
    if has_service { crate::service(ctx, &crate::ServiceCmd::Remove, j)?; done.push("the start-at-login service".to_string()); }
    if let Some(f) = crate::locate::pointer_file().filter(|f| f.is_file()) { crate::locate::forget(); done.push(format!("the home pointer {}", f.display())); }
    if all {
        drop(local_lock(ctx)?);
        std::fs::remove_dir_all(&ctx.data).map_err(|e| format!("could not delete {}: {e}", ctx.data.display()))?;
        done.push(format!("the home folder {}", ctx.data.display()));
    }
    out(j, json!({ "ok": true, "removed": done }), || format!("removed: {}\n{}", if done.is_empty() { "nothing (no service, no home pointer)".into() } else { done.join("; ") },
        if all { "Delete the sushila program file itself to finish." } else { "The home folder (models, settings) was kept: sushila uninstall --all deletes it too." }));
    Ok(())
}

// 36 assistant
async fn assistant(ctx: &mut Ctx, question: Option<String>, j: bool) -> Result<(), String> {
    refresh(ctx);
    let gpu = ctx.nvidia_gpu().await; let other = ctx.other_gpu().await;
    let mut cat = read_json(&ctx.data.join("catalog-cache.json")).unwrap_or(Value::Null);
    if !cat["packs"].is_array() && ctx.write_catalog_cache().await.is_ok() { cat = read_json(&ctx.data.join("catalog-cache.json")).unwrap_or(Value::Null); }
    let port = ctx.setting("port").as_u64().unwrap_or(7874);
    let st = ctx.state.clone();
    let facts = crate::assistant::live_facts(&st, &cat, &gpu, &other, &ctx.info, port, true, &ctx.data.to_string_lossy());
    let pack = default_text_pack(ctx).await;
    if !ctx.packs().contains_key(&pack) { return Err(format!("no text model is installed: sushila install {DEFAULT_MODEL}")); }
    let quote = crate::assistant::small_model(&ctx.packs()[&pack]);
    let (base, here) = if quote { (String::new(), false) } else { text_base(ctx, &pack, None).await? };
    let gl = crate::assistant::gpu_line(&gpu, &other, &ctx.info);
    let tok = token(ctx);
    let ctx_tokens = ctx.setting("contextSize").as_u64().unwrap_or(4096);
    let mut hist: Vec<Value> = vec![];
    let interactive = question.is_none();
    if interactive && tty_in() { eprintln!("Ask Sushila (answers from Sushila's documentation, by {pack}); /exit to end"); }
    let r: Result<(), String> = async { loop {
        let q = match &question { Some(q) => q.clone(), None => {
            if tty_in() { eprint!("\n? "); }
            let mut l = String::new(); if std::io::stdin().read_line(&mut l).map_err(err)? == 0 { return Ok(()); }
            let l = l.trim().to_string(); if l == "/exit" || l == "/quit" { return Ok(()); } if l.is_empty() { continue; } l } };
        if quote {
            // under 3B parameters: the notes themselves, not generated text (small models invent steps)
            let v = crate::assistant::quote_answer(&q, &crate::assistant::quote_sections(&q), &st, &cat, &gl, true, &ctx.data.to_string_lossy(), &pack);
            if j { println!("{v}"); } else { println!("{}\n\n[{pack} is a small model, so this is quoted from the notes: {}]", v["answer"].as_str().unwrap_or(""),
                v["quotes"].as_array().map(|a| a.iter().filter_map(|x| x["title"].as_str()).collect::<Vec<_>>().join("; ")).unwrap_or_default()); }
            if !interactive { return Ok(()); }
            continue;
        }
        let notes = crate::assistant::retrieve(&q, crate::assistant::notes_budget(ctx_tokens, facts.len(), q.len()));
        let msgs = crate::assistant::messages(&q, &hist, &notes, &facts, port);
        let mut print = |t: &str| { if !j { use std::io::Write; print!("{t}"); let _ = std::io::stdout().flush(); } };
        let (a, _) = chat(&base, &tok, &pack, &msgs, 600, 0.2, if j { None } else { Some(&mut print) }).await?;
        let sources: Vec<String> = notes.iter().map(|s| format!("{} ({})", s.title, s.source)).collect();
        if j { println!("{}", json!({ "mode": "generate", "answer": a, "sources": sources, "model": pack })); } else { println!("\n\n[answered by {pack}; notes used: {}]", sources.join("; ")); }
        hist.push(json!({ "role": "user", "content": q })); hist.push(json!({ "role": "assistant", "content": a }));
        if !interactive { return Ok(()); }
    } }.await;
    if here { ctx.stop_model(&pack).await; }
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn iso_roundtrip() { let t = now_iso(); let s = iso_secs(&t).unwrap(); assert!(now_secs().abs_diff(s) < 5); assert_eq!(iso_secs("1970-01-02T00:00:01Z"), Some(86401)); }
    #[test] fn snippets() {
        let c = snippet("curl", "http://localhost:7874", "qwen", "text", ("x-sushila-token", "abc"));
        assert!(c.contains("http://localhost:7874/v1/chat/completions") && c.contains("x-sushila-token: abc") && c.contains("\"model\":\"qwen\""));
        let p = snippet("python", "http://10.0.0.2:7874", "qwen", "text", ("Authorization", "Bearer sk-1"));
        assert!(p.contains("base_url=\"http://10.0.0.2:7874/v1\"") && p.contains("api_key=\"sk-1\""));
        assert!(snippet("js", "http://h:1", "z", "image", ("a", "b")).contains("/v1/images/generations"));
        assert!(snippet("curl", "http://h:1", "w", "video", ("a", "b")).contains("/api/queue"));
    }
    #[test] fn qr() { let q = qr_text("http://192.168.1.20:7874/").unwrap(); let lines: Vec<&str> = q.lines().collect(); assert!(lines.len() >= 12 && lines.iter().all(|l| l.chars().count() == lines[0].chars().count())); }
    #[test] fn settings_validated() {
        assert_eq!(parse_setting("ticker", "off").unwrap(), json!("off")); assert!(parse_setting("ticker", "maybe").is_err());
        assert_eq!(parse_setting("port", "8800").unwrap(), json!(8800)); assert!(parse_setting("port", "0").is_err()); assert!(parse_setting("nope", "1").is_err());
        assert_eq!(parse_setting("keepCopy", "false").unwrap(), json!(false)); assert!(parse_setting("gpuLayers", "-2").is_err()); assert!(parse_setting("catalogUrl", "https://evil.example/c.json").is_err());
    }
    #[test] fn share_rules() {
        let mut st = json!({ "share": { "enabled": false, "hosts": [], "keys": [] } });
        apply_share(&mut st, &json!({ "enabled": true, "addHost": "AI.Example.com" })).unwrap(); assert_eq!(st["share"]["hosts"], json!(["ai.example.com"]));
        apply_share(&mut st, &json!({ "enabled": true, "listen": true })).unwrap(); assert_eq!(st["share"]["hosts"], json!(["ai.example.com", "*"]));
        assert!(apply_share(&mut st, &json!({ "addHost": "bad host/x" })).is_err());
        apply_share(&mut st, &json!({ "enabled": false })).unwrap(); assert_eq!(st["share"]["listen"], json!(false));
    }
    #[test] fn numbers() { assert_eq!(last_number("so 3+4 = 7.\nAnswer: 1,234"), Some(1234)); assert_eq!(last_number("The answer is 42."), Some(42)); assert_eq!(MATH.len(), 20); }
    #[test] fn reproduce_names_unique() { let mut n: Vec<_> = REPRODUCE.iter().map(|x| x.0).collect(); n.sort(); n.dedup(); assert_eq!(n.len(), REPRODUCE.len()); }
}

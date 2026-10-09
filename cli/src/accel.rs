// Accelerated for your own models (Install Unlisted Model Pack, or a file put in the model-packs folder), prepared on
// this computer, with nothing downloaded and nothing sent anywhere:
//   pictures   a cache plan calibrated on this GPU: the day-0 method of scripts/cache/calibrate_cache_plan.py (each
//              candidate plan on calibration prompts, the fastest whose pictures stay close to the uncached ones, mean
//              SSIM >= 0.95, then checked on held-out prompts it never saw);
//   chat/code  a smaller installed model with the same tokenizer drafts tokens (speculative decoding: the model checks
//              every drafted token, so the answers follow the same distribution).
// Either is kept only when measured at least 1.10x faster here; else the model stays Standard and says so. The result
// is written to the model's sushila-pack.json, bound to the model file's sha256 (a changed file starts over).
use std::{path::{Path, PathBuf}, process::Stdio, time::{Duration, Instant}};
use serde_json::{json, Value};
use crate::util::*;

pub const MIN_SPEEDUP: f64 = 1.10;
pub const MIN_SSIM: f64 = 0.95;
const SIZE: &str = "512x512";
const CALIB: [&str; 3] = ["a red fox standing in fresh snow at sunrise, soft golden light, photograph",
    "a cozy cafe interior with a chalkboard menu, warm lighting", "a watercolor painting of a lighthouse on a cliff during a storm"];
const TEST: [&str; 2] = ["portrait of an elderly woman with silver hair, natural window light, 85mm",
    "a mountain lake reflecting snowy peaks, early morning mist"];
const TEXT_PROMPTS: [&str; 2] = ["Explain in about 200 words how a refrigerator keeps food cold.",
    "Write a Python function that checks whether a string is a palindrome, with three tests."];

/// How to run the model's engine for a trial, outside the running models (from Ctx::trial_spec).
pub struct Trial { pub kind: String, pub program: String, pub base: Vec<String>, pub dir: PathBuf, pub ld: Option<String>,
                   pub port: u16, pub log: PathBuf, pub cpu: bool, pub model_sha: String }
/// An installed text model that may draft for another.
#[derive(Clone)]
pub struct Candidate { pub id: String, pub name: String, pub model: PathBuf, pub bytes: u64 }

/// The cache plans tried for pictures: the engine's cache modes for DiT models (Z-Image, Flux, SD3: easycache, dbcache,
/// taylorseer, cache-dit) and for UNet models (SD 1.x/2.x, SDXL: ucache), and spectrum for both. A mode the model does
/// not support changes nothing (the same picture, no faster) and is dropped after its first picture.
pub fn plans() -> Vec<Value> {
    [("ucache", "threshold=0.1"), ("ucache", "threshold=0.2"), ("ucache", "threshold=0.3"), ("ucache", "threshold=0.5"),
     ("easycache", "threshold=0.1"), ("easycache", "threshold=0.2"), ("easycache", "threshold=0.3"), ("dbcache", "threshold=0.08,warmup=2"),
     ("dbcache", "threshold=0.15,warmup=2"), ("taylorseer", ""), ("cache-dit", "warmup=2"), ("spectrum", "window=2,warmup=2"), ("spectrum", "window=2,warmup=4")]
        .iter().map(|(m, o)| if o.is_empty() { json!({ "cache_mode": m }) } else { json!({ "cache_mode": m, "cache_option": o }) }).collect()
}

// ---------- the tokenizer of a GGUF file (does a smaller model speak the same tokens?)
#[derive(Debug, Clone, PartialEq)]
pub struct Vocab { pub model: String, pub pre: String, pub n: u64, pub bos: i64, pub eos: i64, pub hash: String }

/// Reads the tokenizer of a GGUF file from its header: type, pre-tokenizer, size, BOS/EOS and a sha256 of the first
/// 32,000 token texts. Two models can share drafts only when all of these agree (the engine checks again at start).
pub fn gguf_vocab(path: &Path) -> Result<Vocab, String> {
    use std::io::{BufReader, Read};
    use sha2::{Digest, Sha256};
    let mut f = BufReader::with_capacity(1 << 20, std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?);
    fn n<const K: usize>(f: &mut impl Read) -> Result<[u8; K], String> { let mut b = [0u8; K]; f.read_exact(&mut b).map_err(err)?; Ok(b) }
    fn u32_(f: &mut impl Read) -> Result<u32, String> { Ok(u32::from_le_bytes(n::<4>(f)?)) }
    fn u64_(f: &mut impl Read) -> Result<u64, String> { Ok(u64::from_le_bytes(n::<8>(f)?)) }
    fn bytes(f: &mut impl Read) -> Result<Vec<u8>, String> {
        let l = u64_(f)?; if l > 1 << 24 { return Err("a GGUF string is too long".into()); }
        let mut b = vec![0u8; l as usize]; f.read_exact(&mut b).map_err(err)?; Ok(b)
    }
    fn size(t: u32) -> Option<i64> { match t { 0 | 1 | 7 => Some(1), 2 | 3 => Some(2), 4 | 5 | 6 => Some(4), 10 | 11 | 12 => Some(8), _ => None } }
    fn int(f: &mut impl Read, t: u32) -> Result<i64, String> {
        Ok(match t { 0 => n::<1>(f)?[0] as i64, 1 => n::<1>(f)?[0] as i8 as i64, 2 => u16::from_le_bytes(n::<2>(f)?) as i64, 3 => i16::from_le_bytes(n::<2>(f)?) as i64,
            4 => u32::from_le_bytes(n::<4>(f)?) as i64, 5 => i32::from_le_bytes(n::<4>(f)?) as i64, 10 => u64::from_le_bytes(n::<8>(f)?) as i64, 11 => i64::from_le_bytes(n::<8>(f)?),
            _ => return Err("not an integer".into()) })
    }
    fn skip(f: &mut BufReader<std::fs::File>, t: u32) -> Result<(), String> {
        match t {
            8 => { let l = u64_(f)?; f.seek_relative(l as i64).map_err(err) }
            9 => { let et = u32_(f)?; let c = u64_(f)?;
                   match size(et) { Some(s) => f.seek_relative(s * c as i64).map_err(err), None if et == 8 => { for _ in 0..c { let l = u64_(f)?; f.seek_relative(l as i64).map_err(err)?; } Ok(()) }
                                    None => Err("nested GGUF arrays are not read".into()) } }
            t => f.seek_relative(size(t).ok_or("unknown GGUF value type")?).map_err(err),
        }
    }
    if &n::<4>(&mut f)? != b"GGUF" { return Err(format!("{} is not a GGUF file", path.display())); }
    if u32_(&mut f)? < 2 { return Err("GGUF version 1 is not read".into()); }
    let _tensors = u64_(&mut f)?; let kvs = u64_(&mut f)?;
    let mut v = Vocab { model: String::new(), pre: String::new(), n: 0, bos: -1, eos: -1, hash: String::new() };
    for _ in 0..kvs.min(1 << 16) {
        let key = String::from_utf8_lossy(&bytes(&mut f)?).to_string();
        let t = u32_(&mut f)?;
        match (key.as_str(), t) {
            ("tokenizer.ggml.model", 8) => v.model = String::from_utf8_lossy(&bytes(&mut f)?).to_string(),
            ("tokenizer.ggml.pre", 8) => v.pre = String::from_utf8_lossy(&bytes(&mut f)?).to_string(),
            ("tokenizer.ggml.bos_token_id", t) if size(t).is_some() && t != 6 && t != 12 && t != 7 => v.bos = int(&mut f, t)?,
            ("tokenizer.ggml.eos_token_id", t) if size(t).is_some() && t != 6 && t != 12 && t != 7 => v.eos = int(&mut f, t)?,
            ("tokenizer.ggml.tokens", 9) => {
                let et = u32_(&mut f)?; let c = u64_(&mut f)?;
                if et != 8 { return Err("the token list is not text".into()); }
                let mut h = Sha256::new();
                for i in 0..c { let b = bytes(&mut f)?; if i < 32_000 { h.update((b.len() as u32).to_le_bytes()); h.update(&b); } }
                v.n = c; v.hash = hex::encode(h.finalize());
            }
            _ => skip(&mut f, t)?,
        }
    }
    if v.n == 0 { return Err("the file has no token list".into()); }
    Ok(v)
}
/// llama.cpp's own rule allows vocabularies that differ by at most 128 tokens; the rest must be the same.
pub fn same_tokens(a: &Vocab, b: &Vocab) -> bool {
    a.model == b.model && a.pre == b.pre && a.bos == b.bos && a.eos == b.eos && a.hash == b.hash && a.n.abs_diff(b.n) <= 128
}
/// Installed text models that could draft for `target`: same tokens, at most a quarter of its size; smallest first.
pub fn draft_candidates(target: &Path, target_bytes: u64, others: &[Candidate]) -> Result<Vec<Candidate>, String> {
    let tv = gguf_vocab(target)?;
    let mut out: Vec<Candidate> = others.iter().filter(|c| c.bytes > 0 && c.bytes * 4 <= target_bytes && c.model != target)
        .filter(|c| gguf_vocab(&c.model).map(|v| same_tokens(&tv, &v)).unwrap_or(false)).cloned().collect();
    out.sort_by_key(|c| c.bytes);
    Ok(out)
}

// ---------- pictures: decode and compare
/// A PNG as 8-bit RGB.
pub fn png_rgb(b: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    let mut d = png::Decoder::new(std::io::Cursor::new(b));
    d.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut r = d.read_info().map_err(err)?;
    let mut buf = vec![0u8; r.output_buffer_size()];
    let info = r.next_frame(&mut buf).map_err(err)?;
    let (w, h) = (info.width as usize, info.height as usize);
    let ch = match info.color_type { png::ColorType::Rgb => 3, png::ColorType::Rgba => 4, png::ColorType::Grayscale => 1, png::ColorType::GrayscaleAlpha => 2, png::ColorType::Indexed => 3 };
    let mut out = Vec::with_capacity(w * h * 3);
    for y in 0..h { let row = &buf[y * info.line_size..]; for x in 0..w {
        let p = &row[x * ch..x * ch + ch];
        if ch >= 3 { out.extend_from_slice(&p[..3]); } else { out.extend_from_slice(&[p[0], p[0], p[0]]); }
    } }
    Ok((w, h, out))
}
/// Mean structural similarity of two RGB pictures of the same size (1 = identical), as scikit-image computes it
/// (structural_similarity with channel_axis: 7x7 uniform window, sample covariance, K1 0.01, K2 0.03, mean over channels).
pub fn ssim(a: &[u8], b: &[u8], w: usize, h: usize) -> f64 {
    if w < 7 || h < 7 || a.len() != w * h * 3 || b.len() != a.len() { return 0.0; }
    let (r, np) = (3usize, 49.0f64);
    let cov = np / (np - 1.0);
    let (c1, c2) = ((0.01f64 * 255.0).powi(2), (0.03f64 * 255.0).powi(2));
    let ww = w + 1;
    let mut total = 0.0;
    for ch in 0..3 {
        let mut s = vec![[0f64; 5]; ww * (h + 1)];
        for y in 0..h { let mut row = [0f64; 5]; for x in 0..w {
            let (p, q) = (a[(y * w + x) * 3 + ch] as f64, b[(y * w + x) * 3 + ch] as f64);
            row[0] += p; row[1] += q; row[2] += p * p; row[3] += q * q; row[4] += p * q;
            let up = s[y * ww + x + 1];
            s[(y + 1) * ww + x + 1] = [up[0] + row[0], up[1] + row[1], up[2] + row[2], up[3] + row[3], up[4] + row[4]];
        } }
        let (mut sum, mut cnt) = (0.0, 0.0);
        for y in r..h - r { for x in r..w - r {
            let (y0, y1, x0, x1) = (y - r, y + r + 1, x - r, x + r + 1);
            let g = |k: usize| s[y1 * ww + x1][k] - s[y0 * ww + x1][k] - s[y1 * ww + x0][k] + s[y0 * ww + x0][k];
            let (mx, my) = (g(0) / np, g(1) / np);
            let (vx, vy, cxy) = ((g(2) / np - mx * mx) * cov, (g(3) / np - my * my) * cov, (g(4) / np - mx * my) * cov);
            sum += ((2.0 * mx * my + c1) * (2.0 * cxy + c2)) / ((mx * mx + my * my + c1) * (vx + vy + c2));
            cnt += 1.0;
        } }
        total += sum / cnt;
    }
    total / 3.0
}

// ---------- running a trial engine
struct Engine { child: tokio::process::Child }
impl Engine {
    async fn start(t: &Trial, extra: &[String], what: &str) -> Result<Engine, String> {
        let args = [t.base.clone(), extra.to_vec()].concat();
        let mut c = command(&t.program, &args);
        c.current_dir(&t.dir).kill_on_drop(true);
        if let Some(d) = &t.ld { c.env("LD_LIBRARY_PATH", d); }
        let log = std::fs::OpenOptions::new().create(true).append(true).open(&t.log).ok();
        if let Some(mut f) = log.as_ref().and_then(|f| f.try_clone().ok()) { use std::io::Write; let _ = writeln!(f, "----- Accelerated trial {} ({what}): {} {}", now_iso(), t.program, args.join(" ")); }
        match log.and_then(|f| f.try_clone().ok().map(|g| (f, g))) { Some((o, e)) => { c.stdout(Stdio::from(o)).stderr(Stdio::from(e)); } None => { c.stdout(Stdio::null()).stderr(Stdio::null()); } }
        let child = c.spawn().map_err(|e| format!("could not start {}: {e}", t.program))?;
        crate::core::tie_to_us(&child);
        let mut e = Engine { child };
        let health = format!("http://127.0.0.1:{}{}", t.port, if t.kind == "image" { "/" } else { "/health" });
        let t0 = Instant::now();
        loop {
            if let Ok(Some(st)) = e.child.try_wait() { return Err(format!("the engine stopped while loading ({what}, {st}); see the model's log")); }
            if reqwest::Client::new().get(&health).timeout(Duration::from_secs(3)).send().await.map(|r| r.status().is_success()).unwrap_or(false) { return Ok(e); }
            if t0.elapsed() > Duration::from_secs(900) { e.stop().await; return Err(format!("the engine did not get ready in 15 minutes ({what})")); }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    async fn stop(&mut self) { let _ = self.child.kill().await; let _ = self.child.wait().await; }
    /// Once more after a few seconds when the first start fails (the GPU may still be freeing the model stopped just before)
    async fn start_retry(t: &Trial, extra: &[String], what: &str) -> Result<Engine, String> {
        match Engine::start(t, extra, what).await { Ok(e) => Ok(e), Err(_) => { tokio::time::sleep(Duration::from_secs(5)).await; Engine::start(t, extra, what).await } }
    }
}

fn set(prog: Option<&Prog>, label: String, done: u64, total: u64) {
    if let Some(p) = prog { if let Ok(mut g) = p.lock() { *g = json!({ "label": label, "done": done, "total": total }); } }
}

async fn picture(port: u16, prompt: &str, plan: Option<&Value>) -> Result<(Vec<u8>, usize, usize, f64), String> {
    let mut extra = plan.and_then(|p| p.as_object().cloned()).unwrap_or_default();
    extra.insert("seed".into(), json!(42));
    let body = json!({ "prompt": format!("{prompt} <sd_cpp_extra_args>{}</sd_cpp_extra_args>", Value::Object(extra)), "size": SIZE, "n": 1, "output_format": "png" });
    let t0 = Instant::now();
    let r = reqwest::Client::new().post(format!("http://127.0.0.1:{port}/v1/images/generations")).json(&body).timeout(Duration::from_secs(1800)).send().await.map_err(err)?;
    if !r.status().is_success() { return Err(format!("the image engine answered {}", r.status())); }
    let j: Value = r.json().await.map_err(err)?;
    let s = t0.elapsed().as_secs_f64();
    use base64::Engine as _;
    let png = base64::engine::general_purpose::STANDARD.decode(j["data"][0]["b64_json"].as_str().ok_or("no picture in the answer")?).map_err(err)?;
    let (w, h, rgb) = png_rgb(&png)?;
    Ok((rgb, w, h, s))
}
fn median(v: &mut [f64]) -> f64 { v.sort_by(|a, b| a.total_cmp(b)); if v.is_empty() { 0.0 } else if v.len() % 2 == 1 { v[v.len() / 2] } else { (v[v.len() / 2 - 1] + v[v.len() / 2]) / 2.0 } }

/// Pictures: one engine in Standard; every plan is a per-request setting, so no restart between candidates.
pub async fn calibrate_image(t: &Trial, prog: Option<&Prog>) -> Result<Value, String> {
    let mut e = Engine::start_retry(t, &[], "Standard").await?;
    let r = async {
        set(prog, "loading and a first picture".into(), 0, 1);
        let (_, _, _, first) = picture(t.port, CALIB[0], None).await?;  // warm-up (loads the model)
        let cands = plans();
        let total = (CALIB.len() + TEST.len() + cands.len() * CALIB.len() + TEST.len()) as u64;
        // a picture of more than a minute (no GPU) would make this take hours: refuse, honestly
        if first > 90.0 { return Err(format!("one picture takes {first:.0} s on this computer: calibrating would take hours (it needs about {total} pictures)")); }
        let mut done = 0u64;
        let mut refs = vec![];
        for p in CALIB.iter().chain(TEST.iter()) { set(prog, "pictures without a plan".into(), done, total); refs.push(picture(t.port, p, None).await?); done += 1; }
        let base = median(&mut refs[..CALIB.len()].iter().map(|r| r.3).collect::<Vec<_>>());
        let mut rows = vec![];
        for c in &cands {
            let name = format!("{} {}", c["cache_mode"].as_str().unwrap_or(""), c["cache_option"].as_str().unwrap_or(""));
            let (mut secs, mut q, mut bad) = (vec![], vec![], None);
            for (i, p) in CALIB.iter().enumerate() {
                set(prog, format!("trying {}", name.trim()), done, total); done += 1;
                match picture(t.port, p, Some(c)).await {
                    Ok((rgb, w, h, s)) => { let (rr, rw, rh, _) = &refs[i]; if (w, h) != (*rw, *rh) { bad = Some("another size".to_string()); break; }
                        let sim = ssim(&rgb, rr, w, h); secs.push(s); q.push(sim);
                        if sim < 0.85 { bad = Some(format!("SSIM {sim:.2}")); break; }  // far from the uncached picture: the rest is not needed
                        // the very same picture and no faster: this model ignores the mode (e.g. a DiT cache on a UNet model)
                        if i == 0 && sim > 0.9999 && s > refs[0].3 * 0.97 { bad = Some("not supported by this model (no change)".into()); break; } }
                    Err(er) => { bad = Some(er); break; }
                }
            }
            if let Some(why) = bad { done += (CALIB.len() - q.len().min(CALIB.len())) as u64; rows.push(json!({ "plan": c, "skipped": why.chars().take(120).collect::<String>() })); continue; }
            let s = median(&mut secs); let m = q.iter().sum::<f64>() / q.len() as f64;
            rows.push(json!({ "plan": c, "s": s, "speedup": base / s.max(1e-9), "ssim": m }));
        }
        let best = rows.iter().filter(|r| r["ssim"].as_f64().map(|s| s >= MIN_SSIM).unwrap_or(false) && r["speedup"].as_f64().unwrap_or(0.0) >= MIN_SPEEDUP)
            .max_by(|a, b| (a["speedup"].as_f64().unwrap_or(0.0) * 100.0).round().total_cmp(&(b["speedup"].as_f64().unwrap_or(0.0) * 100.0).round())
                .then(a["ssim"].as_f64().unwrap_or(0.0).total_cmp(&b["ssim"].as_f64().unwrap_or(0.0)))).cloned();
        let mut out = json!({ "kind": "image", "for": t.model_sha, "at": now_iso(), "size": SIZE, "uncachedS": base, "candidates": rows, "kept": false });
        let Some(best) = best else { out["why"] = json!(format!("no plan was {MIN_SPEEDUP:.2}x faster with pictures as close as SSIM {MIN_SSIM}")); return Ok(out); };
        // held-out prompts: the honest numbers, and the final check
        let (mut ts, mut us, mut q) = (vec![], vec![], vec![]);
        for (i, p) in TEST.iter().enumerate() {
            set(prog, "checking the plan on new prompts".into(), done, total); done += 1;
            let (rgb, w, h, s) = picture(t.port, p, Some(&best["plan"])).await?;
            let (rr, _, _, rs) = &refs[CALIB.len() + i];
            ts.push(s); us.push(*rs); q.push(ssim(&rgb, rr, w, h));
        }
        let sp = median(&mut us) / median(&mut ts).max(1e-9); let m = q.iter().sum::<f64>() / q.len() as f64;
        out["test"] = json!({ "speedup": sp, "ssim": m });
        out["plan"] = best["plan"].clone();
        if sp >= MIN_SPEEDUP && m >= MIN_SSIM - 0.02 { out["kept"] = json!(true); out["speedup"] = json!(sp); out["ssim"] = json!(m); }
        else { out["why"] = json!(format!("the best plan was {sp:.2}x faster on new prompts (SSIM {m:.3}): not enough")); }
        Ok(out)
    }.await;
    e.stop().await;
    r
}

async fn tokens_per_s(port: u16, prompt: &str, max: u32) -> Result<f64, String> {
    let body = json!({ "messages": [{ "role": "user", "content": prompt }], "max_tokens": max, "temperature": 0.0, "stream": false });
    let t0 = Instant::now();
    let r = reqwest::Client::new().post(format!("http://127.0.0.1:{port}/v1/chat/completions")).json(&body).timeout(Duration::from_secs(1800)).send().await.map_err(err)?;
    if !r.status().is_success() { return Err(format!("the engine answered {}", r.status())); }
    let j: Value = r.json().await.map_err(err)?;
    // the engine's own decoding speed when it reports it; else tokens over the whole request
    Ok(j["timings"]["predicted_per_second"].as_f64().filter(|v| *v > 0.0)
        .unwrap_or_else(|| j["usage"]["completion_tokens"].as_f64().unwrap_or(0.0) / t0.elapsed().as_secs_f64().max(1e-9)))
}
async fn measure_text(t: &Trial, extra: &[String], what: &str) -> Result<f64, String> {
    let mut e = Engine::start_retry(t, extra, what).await?;
    let r = async {
        tokens_per_s(t.port, "Say hello.", 8).await?;  // warm-up
        let mut v = vec![];
        for p in TEXT_PROMPTS { v.push(tokens_per_s(t.port, p, 256).await?); }
        Ok::<f64, String>(median(&mut v))
    }.await;
    e.stop().await;
    r
}
pub fn draft_args(model: &Path, cpu: bool) -> Vec<String> {
    vec!["-md".into(), model.to_string_lossy().into(), "-ngld".into(), if cpu { "0".into() } else { "99".into() }, "--spec-draft-n-max".into(), "16".into()]
}
/// Chat and code: Standard, then each candidate draft (at most two, smallest first); the fastest is kept if it is
/// MIN_SPEEDUP faster.
pub async fn calibrate_text(t: &Trial, target: &Path, target_bytes: u64, others: Vec<Candidate>, prog: Option<&Prog>) -> Result<Value, String> {
    let (tp, tb) = (target.to_path_buf(), target_bytes);
    let cands = tokio::task::spawn_blocking(move || draft_candidates(&tp, tb, &others)).await.map_err(err)??;
    let mut out = json!({ "kind": "text", "for": t.model_sha, "at": now_iso(), "kept": false, "candidates": [] });
    if cands.is_empty() {
        out["why"] = json!("no installed chat or code model has the same tokens and is small enough (a quarter of its size or less) to draft for it; install a smaller model of the same family and try again");
        return Ok(out);
    }
    let cands: Vec<Candidate> = cands.into_iter().take(2).collect();
    let total = 1 + cands.len() as u64;
    set(prog, "measuring Standard".into(), 0, total);
    let base = measure_text(t, &[], "Standard").await?;
    out["standardTps"] = json!(base);
    let mut best: Option<(f64, &Candidate)> = None;
    for (i, c) in cands.iter().enumerate() {
        set(prog, format!("measuring with {} drafting", c.name), 1 + i as u64, total);
        match measure_text(t, &draft_args(&c.model, t.cpu), &format!("draft {}", c.id)).await {
            Ok(v) => { out["candidates"].as_array_mut().unwrap().push(json!({ "pack": c.id, "name": c.name, "tps": v, "speedup": v / base.max(1e-9) }));
                       if best.map(|(b, _)| v > b).unwrap_or(true) { best = Some((v, c)); } }
            Err(e) => out["candidates"].as_array_mut().unwrap().push(json!({ "pack": c.id, "name": c.name, "skipped": e.chars().take(160).collect::<String>() })),
        }
    }
    match best {
        Some((v, c)) if v / base.max(1e-9) >= MIN_SPEEDUP => {
            out["kept"] = json!(true); out["draft"] = json!({ "pack": c.id, "name": c.name }); out["speedup"] = json!(v / base.max(1e-9)); out["acceleratedTps"] = json!(v);
        }
        Some((v, c)) => out["why"] = json!(format!("with {} drafting it was {:.2}x as fast: not enough", c.name, v / base.max(1e-9))),
        None => out["why"] = json!("no draft model ran with it"),
    }
    Ok(out)
}

/// A short line for the logs and the pages.
pub fn summary(a: &Value) -> String {
    if a["kept"] == true {
        match a["kind"].as_str() {
            Some("image") => format!("Accelerated on this computer: {:.2}x faster pictures (cache plan {} {}; SSIM {:.3} on new prompts)", a["speedup"].as_f64().unwrap_or(0.0),
                a["plan"]["cache_mode"].as_str().unwrap_or(""), a["plan"]["cache_option"].as_str().unwrap_or(""), a["ssim"].as_f64().unwrap_or(0.0)),
            _ => format!("Accelerated on this computer: {:.2}x faster ({:.0} instead of {:.0} tokens/s; {} drafts)", a["speedup"].as_f64().unwrap_or(0.0),
                a["acceleratedTps"].as_f64().unwrap_or(0.0), a["standardTps"].as_f64().unwrap_or(0.0), a["draft"]["name"].as_str().unwrap_or("a smaller model")),
        }
    } else { format!("Checked on this computer: stays Standard ({})", a["why"].as_str().unwrap_or("not faster")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn gguf(path: &Path, toks: &[&str], pre: &str) {
        let mut b: Vec<u8> = b"GGUF".to_vec();
        b.extend(3u32.to_le_bytes()); b.extend(0u64.to_le_bytes()); b.extend(6u64.to_le_bytes());
        let s = |b: &mut Vec<u8>, t: &str| { b.extend((t.len() as u64).to_le_bytes()); b.extend(t.as_bytes()); };
        s(&mut b, "general.architecture"); b.extend(8u32.to_le_bytes()); s(&mut b, "llama");
        s(&mut b, "general.some_floats"); b.extend(9u32.to_le_bytes()); b.extend(6u32.to_le_bytes()); b.extend(2u64.to_le_bytes()); b.extend(1f32.to_le_bytes()); b.extend(2f32.to_le_bytes());
        s(&mut b, "tokenizer.ggml.model"); b.extend(8u32.to_le_bytes()); s(&mut b, "gpt2");
        s(&mut b, "tokenizer.ggml.pre"); b.extend(8u32.to_le_bytes()); s(&mut b, pre);
        s(&mut b, "tokenizer.ggml.tokens"); b.extend(9u32.to_le_bytes()); b.extend(8u32.to_le_bytes()); b.extend((toks.len() as u64).to_le_bytes()); for t in toks { s(&mut b, t); }
        s(&mut b, "tokenizer.ggml.eos_token_id"); b.extend(4u32.to_le_bytes()); b.extend(2u32.to_le_bytes());
        std::fs::write(path, b).unwrap();
    }
    #[test] fn vocab_and_drafts() {
        let d = std::env::temp_dir().join(format!("sushila-accel-{}", std::process::id())); std::fs::create_dir_all(&d).unwrap();
        let (a, b, c) = (d.join("big.gguf"), d.join("small.gguf"), d.join("other.gguf"));
        gguf(&a, &["<s>", "a", "b", "hello"], "qwen2"); gguf(&b, &["<s>", "a", "b", "hello"], "qwen2"); gguf(&c, &["<s>", "x", "y", "z"], "qwen2");
        let (va, vb, vc) = (gguf_vocab(&a).unwrap(), gguf_vocab(&b).unwrap(), gguf_vocab(&c).unwrap());
        assert_eq!((va.model.as_str(), va.pre.as_str(), va.n, va.eos), ("gpt2", "qwen2", 4, 2));
        assert!(same_tokens(&va, &vb) && !same_tokens(&va, &vc));
        let cand = |id: &str, p: &PathBuf, bytes| Candidate { id: id.into(), name: id.into(), model: p.clone(), bytes };
        // the same tokens and a quarter of the size or less: a candidate; another vocabulary, or too big: not
        let got = draft_candidates(&a, 4000, &[cand("small", &b, 1000), cand("other", &c, 500), cand("big2", &b, 2000)]).unwrap();
        assert_eq!(got.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["small"]);
        assert!(gguf_vocab(&d.join("missing.gguf")).is_err());
        std::fs::write(d.join("bad.gguf"), b"NOPE").unwrap(); assert!(gguf_vocab(&d.join("bad.gguf")).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test] fn ssim_basics() {
        let (w, h) = (32usize, 32usize);
        let a: Vec<u8> = (0..w * h * 3).map(|i| ((i * 37) % 251) as u8).collect();
        assert!((ssim(&a, &a, w, h) - 1.0).abs() < 1e-9);
        let b: Vec<u8> = a.iter().enumerate().map(|(i, v)| v.saturating_add(((i * 13) % 40) as u8)).collect();
        let s = ssim(&a, &b, w, h); assert!(s < 0.999 && s > 0.0, "{s}");
        let c: Vec<u8> = a.iter().map(|v| 255 - v).collect(); assert!(ssim(&a, &c, w, h) < s);
        assert_eq!(ssim(&a, &a[..30].to_vec(), w, h), 0.0);
    }
    #[test] fn png_roundtrip() {
        let mut buf = vec![];
        { let mut e = png::Encoder::new(&mut buf, 3, 2); e.set_color(png::ColorType::Rgba); e.set_depth(png::BitDepth::Eight);
          let mut w = e.write_header().unwrap(); w.write_image_data(&(0..24).map(|i| i as u8).collect::<Vec<_>>()).unwrap(); }
        let (w, h, rgb) = png_rgb(&buf).unwrap();
        assert_eq!((w, h, rgb.len()), (3, 2, 18)); assert_eq!(&rgb[..6], &[0, 1, 2, 4, 5, 6]);
    }
    #[test] fn plans_pass_the_request_filter() {
        for p in plans() { assert!(crate::core::turbo_request(&json!({ "turboRequest": p })).is_some(), "{p}"); }
        let a = json!({ "kind": "image", "kept": true, "speedup": 1.4, "ssim": 0.97, "plan": { "cache_mode": "easycache", "cache_option": "threshold=0.2" } });
        assert!(summary(&a).contains("1.40x") && summary(&a).contains("easycache"));
        assert!(summary(&json!({ "kind": "text", "kept": false, "why": "no draft" })).contains("stays Standard (no draft)"));
    }
}

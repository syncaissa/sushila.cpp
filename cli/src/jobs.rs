// Generating with a running model: one request (sushila run) or the background queue (sushila serve), the same calls the
// desktop app makes. Text -> .md, image -> .png, video -> .webm, music -> .mp3.
use std::time::Duration;
use serde_json::{json, Value};
use crate::util::err;

pub const WAN_NEGATIVE_PROMPT: &str = "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

/// Wan 2.2 TI2V-5B sampling: Wan's own settings, 50 steps, guidance 5, flow shift 5. At 1280x704 this matches Wan's
/// official pipeline frame for frame in quality; 30 steps were enough at 832x480 but murky at 720p, and the engine
/// defaults (20 steps) with our earlier guidance 6 / shift 3 gave noise: results/video_quality_20261007/.
pub static WAN_SAMPLING: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| json!({ "sample_method": "euler", "sample_steps": 50, "guidance": { "txt_cfg": 5.0 }, "flow_shift": 5.0 }));

/// info: what the model decided itself and is worth keeping with the file (a song's lyrics when it wrote them, its bpm, key,
/// time signature, ...); null when there is nothing.
pub struct Output { pub ext: String, pub mime: String, pub bytes: Vec<u8>, pub info: Value }

fn http() -> reqwest::Client { reqwest::Client::builder().timeout(Duration::from_secs(3600)).build().expect("http client") }

async fn post(base: &str, path: &str, body: &Value) -> Result<reqwest::Response, String> {
    let r = http().post(format!("{base}{path}")).json(body).send().await.map_err(err)?;
    if !r.status().is_success() { let st = r.status(); return Err(format!("{st} {}", r.text().await.unwrap_or_default().chars().take(300).collect::<String>())); }
    Ok(r)
}
/// The seed for a picture or video: the one asked for (a number 0 or more), else a fresh random one for every job, so
/// the same prompt gives very different faces and backgrounds each time. Without it the engines use a fixed default seed
/// and repeat themselves. The seed used is saved with the file (repeat a result by typing it).
pub fn seed_of(p: &Value) -> i64 {
    let asked = p.get("seed").and_then(|s| s.as_i64().or_else(|| s.as_str().and_then(|x| x.trim().parse::<i64>().ok())));
    match asked { Some(s) if s >= 0 => s, _ => { let mut b = [0u8; 4]; let _ = getrandom::getrandom(&mut b); (u32::from_le_bytes(b) & 0x7fff_ffff) as i64 } }
}
fn b64(s: &str) -> Result<Vec<u8>, String> { use base64::Engine; base64::engine::general_purpose::STANDARD.decode(s.trim()).map_err(err) }

/// The first audio/* part of a multipart answer (acestep.cpp's /synth result).
fn multipart_audio(buf: &[u8], ctype: &str) -> Option<Vec<u8>> {
    let b = ctype.split("boundary=").nth(1)?.trim_matches('"').split(';').next()?.to_string();
    let sep = format!("--{b}").into_bytes();
    let find = |hay: &[u8], needle: &[u8], from: usize| hay.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|i| i + from);
    let mut at = find(buf, &sep, 0)?;
    loop {
        let start = at + sep.len();
        if buf.get(start..start + 2) == Some(b"--") { return None; }
        let next = find(buf, &sep, start)?;
        let head_end = find(buf, b"\r\n\r\n", start)?;
        let head = String::from_utf8_lossy(&buf[start..head_end]).to_lowercase();
        if head.contains("content-type: audio/") {
            let mut end = next; if end >= 2 && &buf[end - 2..end] == b"\r\n" { end -= 2; }
            return Some(buf[head_end + 4..end].to_vec());
        }
        at = next;
    }
}

/// kind: text | image | video | music; params as the app's queue sends them (prompt, size, seed, lyrics, style, duration...).
/// accel: the pack's precomputed cache plan (Accelerated image/video), if any. tick: progress callback.
pub async fn run(kind: &str, model: &str, port: u16, p: &Value, accel: Option<Value>, mut tick: impl FnMut(&str)) -> Result<Output, String> {
    let base = format!("http://127.0.0.1:{port}");
    match kind {
        "text" => {
            tick("writing");
            // an optional system instruction (Code asks for an expert programmer), then the question
            let mut messages = vec![];
            if let Some(sys) = p["system"].as_str().filter(|t| !t.is_empty()) { messages.push(json!({ "role": "system", "content": sys })); }
            messages.push(json!({ "role": "user", "content": p["prompt"].as_str().unwrap_or("") }));
            let j: Value = post(&base, "/v1/chat/completions", &json!({ "messages": messages,
                "max_tokens": p["max_tokens"].as_u64().unwrap_or(1024).min(8192), "temperature": p.get("temperature").cloned().unwrap_or(json!(0.7)), "stream": false })).await?.json().await.map_err(err)?;
            let text = j["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
            Ok(Output { ext: "md".into(), mime: "text/markdown; charset=utf-8".into(), bytes: text.into_bytes(), info: Value::Null })
        }
        "image" => {
            tick("drawing");
            let mut extra = accel.and_then(|a| a.as_object().cloned()).unwrap_or_default();
            let seed = seed_of(p);
            extra.insert("seed".into(), json!(seed));
            let mut prompt = p["prompt"].as_str().unwrap_or("").to_string();
            if !extra.is_empty() { prompt += &format!(" <sd_cpp_extra_args>{}</sd_cpp_extra_args>", Value::Object(extra)); }
            let j: Value = post(&base, "/v1/images/generations", &json!({ "model": model, "prompt": prompt, "size": p["size"].as_str().unwrap_or("1024x1024"), "n": 1, "output_format": "png" })).await?.json().await.map_err(err)?;
            let d = j["data"][0]["b64_json"].as_str().ok_or("the server returned no image")?;
            Ok(Output { ext: "png".into(), mime: "image/png".into(), bytes: b64(d)?, info: json!({ "seed": seed }) })
        }
        "video" => {
            let mut body = json!({ "negative_prompt": WAN_NEGATIVE_PROMPT, "fps": 24, "seed": -1, "output_format": "webm",
                                   "sample_params": WAN_SAMPLING.clone() });
            for src in [accel.unwrap_or(json!({})), p.clone()] { if let Some(o) = src.as_object() { for (k, v) in o { body[k] = v.clone(); } } }
            let seed = seed_of(p);
            body["seed"] = json!(seed);
            let j: Value = post(&base, "/sdcpp/v1/vid_gen", &body).await?.json().await.map_err(err)?;
            let id = j["id"].as_str().ok_or("the video server returned no job")?.to_string();
            let t0 = std::time::Instant::now();
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                tick("filming");
                // a video that is not done in 3 hours is cancelled on the engine and reported, never waited on forever
                if t0.elapsed() > Duration::from_secs(3 * 3600) {
                    let _ = http().post(format!("{base}/sdcpp/v1/jobs/{id}/cancel")).timeout(Duration::from_secs(10)).send().await;
                    return Err("the video was not done after 3 hours; it was cancelled".into());
                }
                let st: Value = http().get(format!("{base}/sdcpp/v1/jobs/{id}")).timeout(Duration::from_secs(30)).send().await.map_err(err)?.json().await.map_err(err)?;
                match st["status"].as_str() {
                    Some("completed") => { let r = &st["result"]; let ext = r["output_format"].as_str().unwrap_or("webm").to_string();
                        return Ok(Output { mime: r["mime_type"].as_str().map(String::from).unwrap_or(format!("video/{ext}")), ext, bytes: b64(r["b64_json"].as_str().unwrap_or(""))?, info: json!({ "seed": seed }) }); }
                    Some("failed") | Some("cancelled") => return Err(st["error"]["message"].as_str().unwrap_or("the video job failed").to_string()),
                    _ => {}
                }
            }
        }
        "music" => {
            async fn job(base: &str, path: &str, body: &Value, label: &str, tick: &mut impl FnMut(&str)) -> Result<reqwest::Response, String> {
                let id = post(base, path, body).await?.json::<Value>().await.map_err(err)?["id"].as_str().map(String::from).ok_or("the music server returned no job")?;
                let t0 = std::time::Instant::now();
                loop {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    tick(label);
                    if t0.elapsed() > Duration::from_secs(3600) { return Err(format!("{label}: not done after an hour")); }
                    let st: Value = http().get(format!("{base}/job?id={id}")).timeout(Duration::from_secs(30)).send().await.map_err(err)?.json().await.map_err(err)?;
                    match st["status"].as_str() {
                        Some("done") => return http().get(format!("{base}/job?id={id}&result=1")).send().await.map_err(err),
                        Some("failed") | Some("cancelled") => return Err(format!("{label}: {}", st["status"])),
                        _ => {}
                    }
                }
            }
            let lyrics = p["lyrics"].as_str().filter(|l| !l.is_empty()).unwrap_or("[Instrumental]");
            let planned: Value = job(&base, "/lm", &json!({ "caption": p["style"].as_str().unwrap_or(""), "lyrics": if lyrics == "[auto]" { "" } else { lyrics },
                "duration": p["duration"].as_f64().unwrap_or(60.0), "seed": -1, "output_format": "mp3" }), "writing the song", &mut tick).await?.json().await.map_err(err)?;
            let songs: Vec<Value> = match planned { Value::Array(a) => a, v => vec![v] }.into_iter().map(|mut x| { x["output_format"] = json!("mp3"); x }).collect();
            let info = songs.first().map(crate::library::prompt_details).unwrap_or(Value::Null);
            let r = job(&base, "/synth", &Value::Array(songs), "singing it", &mut tick).await?;
            let ct = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            let buf = r.bytes().await.map_err(err)?.to_vec();
            let audio = if ct.starts_with("audio/") { Some(buf) } else { multipart_audio(&buf, &ct) };
            Ok(Output { ext: "mp3".into(), mime: "audio/mpeg".into(), bytes: audio.ok_or("the server returned no audio")?, info })
        }
        k => Err(format!("unknown kind {k}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn seeds() {
        // a seed asked for is kept (the same picture again); none, "" or -1: a different random seed every time
        assert_eq!(seed_of(&json!({ "seed": 20 })), 20);
        assert_eq!(seed_of(&json!({ "seed": "20" })), 20);
        let r: std::collections::HashSet<i64> = (0..20).map(|_| seed_of(&json!({ "seed": "" }))).chain((0..20).map(|_| seed_of(&json!({})))).chain((0..20).map(|_| seed_of(&json!({ "seed": -1 })))).collect();
        assert!(r.len() > 55 && r.iter().all(|s| *s >= 0), "random seeds differ: {}", r.len());
    }
}

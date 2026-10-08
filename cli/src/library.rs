// The Library: everything made with Sushila on this computer, in one list. Files live in the home folder:
//   outputs/images/<date>/  pictures from the Inference page      outputs/music/<date>/  songs     outputs/video/<date>/  videos
//   outputs/<job>.<ext>     results of queue jobs
// and outputs/library.jsonl keeps one line per file with what made it (prompt, lyrics, model, mode, size, seed, time),
// so the Library tab can search every field. Files on disk without a line (older ones) are listed too.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const EXTS: [(&str, &str); 11] = [("png", "image"), ("jpg", "image"), ("jpeg", "image"), ("webp", "image"), ("gif", "image"),
    ("mp3", "music"), ("wav", "music"), ("flac", "music"), ("ogg", "music"), ("webm", "video"), ("mp4", "video")];
pub fn kind_of(p: &Path) -> Option<&'static str> {
    let e = p.extension()?.to_string_lossy().to_lowercase();
    EXTS.iter().find(|(x, _)| *x == e).map(|(_, k)| *k)
}
pub fn mime_of(p: &Path) -> &'static str {
    match p.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("png") => "image/png", Some("jpg") | Some("jpeg") => "image/jpeg", Some("webp") => "image/webp", Some("gif") => "image/gif",
        Some("mp3") => "audio/mpeg", Some("wav") => "audio/wav", Some("flac") => "audio/flac", Some("ogg") => "audio/ogg",
        Some("webm") => "video/webm", Some("mp4") => "video/mp4", _ => "application/octet-stream",
    }
}

/// Words of a prompt for a file name: "a red fox in the snow" -> "a-red-fox-in-the-snow".
pub fn slug(text: &str) -> String {
    let s: String = text.split("<sd_cpp_extra_args>").next().unwrap_or("").split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty())
        .take(6).collect::<Vec<_>>().join("-").to_lowercase().chars().take(48).collect();
    s.trim_matches('-').to_string()
}

/// One line in outputs/library.jsonl for a file just made (`meta`: prompt, lyrics, pack, mode, size, seed, ...).
pub fn record(dir: &Path, file: &Path, kind: &str, mut meta: Value) {
    use std::io::Write;
    let rel = file.strip_prefix(dir.join("outputs")).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    if rel.is_empty() { return; }
    meta["rel"] = json!(rel); meta["kind"] = json!(kind); meta["created"] = json!(crate::util::now_iso());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("outputs").join("library.jsonl")) { let _ = writeln!(f, "{meta}"); }
}

// ---------- "made by AI" in every file Sushila writes (EU AI Act art. 50(2): machine-readable marking; China's labelling
// rules: an implicit label in the metadata). The standard field is IPTC DigitalSourceType = trainedAlgorithmicMedia,
// written as XMP (pictures) or as an ID3 tag (songs); the content itself is not changed.
const DST: &str = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data { c ^= b as u32; for _ in 0..8 { c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 }; } }
    !c
}
fn esc(t: &str) -> String { t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;") }
/// The bytes with the AI marking added (PNG: an XMP iTXt chunk and tEXt fields before IEND; MP3: an ID3v2.3 tag in front,
/// unless the file has one already). Other formats come back unchanged.
pub fn mark_ai(bytes: &[u8], ext: &str, pack: &str, prompt: &str) -> Vec<u8> {
    let tool = format!("Sushila {} (model: {})", env!("CARGO_PKG_VERSION"), if pack.is_empty() { "unknown" } else { pack });
    let note = format!("AI-generated with {tool}. Prompt: {}", prompt.chars().take(500).collect::<String>());
    let now = crate::util::now_iso();
    match ext {
        "png" if bytes.len() >= 20 && bytes[..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] && bytes[bytes.len() - 8..bytes.len() - 4] == *b"IEND" => {
            let chunk = |typ: &[u8], data: &[u8]| -> Vec<u8> {
                let mut c = (data.len() as u32).to_be_bytes().to_vec(); let mut td = typ.to_vec(); td.extend_from_slice(data);
                c.extend_from_slice(&td); c.extend_from_slice(&crc32(&td).to_be_bytes()); c
            };
            let xmp = format!("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" \
xmlns:Iptc4xmpExt=\"http://iptc.org/std/Iptc4xmpExt/2008-02-29/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
Iptc4xmpExt:DigitalSourceType=\"{DST}\" xmp:CreatorTool=\"{}\" xmp:CreateDate=\"{now}\"><dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></dc:description>\
</rdf:Description></rdf:RDF></x:xmpmeta>", esc(&tool), esc(&note));
            let mut itxt = b"XML:com.adobe.xmp\0\0\0\0\0".to_vec(); itxt.extend_from_slice(xmp.as_bytes());
            let mut out = bytes[..bytes.len() - 12].to_vec();
            out.extend(chunk(b"iTXt", &itxt));
            for (k, v) in [("Software", tool.as_str()), ("Comment", note.as_str()), ("AI-Generated", "true"), ("DigitalSourceType", DST)] {
                let mut d = k.as_bytes().to_vec(); d.push(0); d.extend(v.chars().filter(|c| (*c as u32) < 256).map(|c| c as u8)); out.extend(chunk(b"tEXt", &d));
            }
            out.extend_from_slice(&bytes[bytes.len() - 12..]);
            out
        }
        "mp3" if !bytes.starts_with(b"ID3") => {
            let latin = |t: &str| -> Vec<u8> { t.chars().map(|c| if (c as u32) < 256 { c as u8 } else { b'?' }).collect() };
            let frame = |id: &[u8], data: Vec<u8>| -> Vec<u8> { let mut f = id.to_vec(); f.extend_from_slice(&(data.len() as u32).to_be_bytes()); f.extend_from_slice(&[0, 0]); f.extend(data); f };
            let txxx = |desc: &str, val: &str| -> Vec<u8> { let mut d = vec![0u8]; d.extend(latin(desc)); d.push(0); d.extend(latin(val)); frame(b"TXXX", d) };
            let mut body = vec![];
            body.extend(frame(b"TSSE", { let mut d = vec![0u8]; d.extend(latin(&tool)); d }));
            body.extend(frame(b"COMM", { let mut d = vec![0u8]; d.extend_from_slice(b"eng"); d.push(0); d.extend(latin(&note)); d }));
            body.extend(frame(b"TIT2", { let mut d = vec![0u8]; d.extend(latin(&prompt.chars().take(120).collect::<String>())); d }));
            body.extend(txxx("AI_GENERATED", "true"));
            body.extend(txxx("DIGITAL_SOURCE_TYPE", DST));
            body.extend(txxx("CREATED", &now));
            let n = body.len() as u32;
            let mut out = b"ID3\x03\x00\x00".to_vec();
            out.extend_from_slice(&[((n >> 21) & 0x7f) as u8, ((n >> 14) & 0x7f) as u8, ((n >> 7) & 0x7f) as u8, (n & 0x7f) as u8]);  // synchsafe size
            out.extend(body); out.extend_from_slice(bytes);
            out
        }
        _ => bytes.to_vec(),
    }
}

/// Writes a result to outputs/<kind folder>/<date>/<HHMMSS>-<words>.<ext>, records it, returns its path.
pub fn save(dir: &Path, kind: &str, ext: &str, bytes: &[u8], title: &str, meta: Value) -> Option<PathBuf> {
    let now = crate::util::now_iso();
    let folder = match kind { "image" => "images", "video" => "video", _ => "music" };
    let day = dir.join("outputs").join(folder).join(&now[..10]);
    std::fs::create_dir_all(&day).ok()?;
    let stamp: String = now[11..19].chars().filter(|c| c.is_ascii_digit()).collect();
    let base = format!("{stamp}-{}", { let s = slug(title); if s.is_empty() { kind.to_string() } else { s } });
    let mut f = day.join(format!("{base}.{ext}"));
    let mut k = 2; while f.exists() { f = day.join(format!("{base}-{k}.{ext}")); k += 1; }
    let marked = mark_ai(bytes, ext, meta["pack"].as_str().unwrap_or(""), meta["prompt"].as_str().unwrap_or(title));
    std::fs::write(&f, marked).ok()?;
    record(dir, &f, kind, meta);
    Some(f)
}

/// The first audio part of a multipart answer (the music engine sends the song with its metadata).
pub fn audio_in_multipart(body: &[u8], ctype: &str) -> Option<(Vec<u8>, String)> {
    let b = ctype.split(';').map(str::trim).find_map(|p| p.strip_prefix("boundary="))?.trim_matches('"').to_string();
    let sep = format!("--{b}");
    let text = body;
    let find = |hay: &[u8], needle: &[u8], from: usize| hay.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|i| i + from);
    let mut at = find(text, sep.as_bytes(), 0)?;
    loop {
        let start = at + sep.len();
        if text.get(start..start + 2) == Some(b"--") { return None; }
        let next = find(text, sep.as_bytes(), start)?;
        let head_end = find(text, b"\r\n\r\n", start)?;
        let head = String::from_utf8_lossy(&text[start..head_end]).to_lowercase();
        if let Some(t) = head.lines().find_map(|l| l.strip_prefix("content-type:")).map(|t| t.trim().to_string()).filter(|t| t.starts_with("audio/")) {
            let mut end = next; if text.get(end - 2..end) == Some(b"\r\n") { end -= 2; }
            return Some((text[head_end + 4..end].to_vec(), t));
        }
        at = next;
    }
}

/// Everything in outputs/, newest first: the files on disk, with what the index and the queue know about each.
pub fn list(dir: &Path) -> Vec<Value> {
    let out = dir.join("outputs");
    let mut meta: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for l in std::fs::read_to_string(out.join("library.jsonl")).unwrap_or_default().lines() {
        if let Ok(v) = serde_json::from_str::<Value>(l) { if let Some(r) = v["rel"].as_str() { meta.insert(r.to_string(), v); } }
    }
    // queue jobs: their output file and what they were asked
    let q = crate::webserver::read_queue(dir);
    for j in q["jobs"].as_array().cloned().unwrap_or_default() {
        if let Some(f) = j["output"]["file"].as_str() {
            meta.entry(f.to_string()).or_insert_with(|| json!({ "pack": j["model"], "prompt": j["params"]["prompt"].as_str().or(j["params"]["style"].as_str()).or(j["title"].as_str()),
                "lyrics": j["params"]["lyrics"], "seed": j["params"]["seed"], "size": j["params"]["size"], "duration": j["params"]["duration"], "source": "queue", "created": j["created"] }));
        }
    }
    let mut items = vec![];
    let mut stack = vec![out.clone()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() { if !p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false) { stack.push(p); } continue; }
            let Some(kind) = kind_of(&p) else { continue };
            let md = e.metadata().ok();
            let rel = p.strip_prefix(&out).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            let m = meta.get(&rel).cloned().unwrap_or(json!({}));
            let modified = md.as_ref().and_then(|m| m.modified().ok()).map(iso).unwrap_or_default();
            let mut v = json!({ "rel": rel, "path": p.to_string_lossy(), "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "kind": m["kind"].as_str().unwrap_or(kind), "bytes": md.map(|m| m.len()).unwrap_or(0), "created": m["created"].as_str().map(String::from).unwrap_or(modified) });
            for k in ["pack", "mode", "prompt", "lyrics", "seed", "size", "duration", "frames", "source"] { if !m[k].is_null() { v[k] = m[k].clone(); } }
            items.push(v);
        }
    }
    items.sort_by(|a, b| b["created"].as_str().cmp(&a["created"].as_str()));
    items
}
// ---------- the trash: Delete moves a file to outputs/.trash/<same place>; Restore moves it back; Delete permanently
// removes it. outputs/.trash/trash.jsonl keeps when each was deleted (and its index line, so a restored file keeps
// its prompt and model).
fn trash(dir: &Path) -> PathBuf { dir.join("outputs").join(".trash") }
/// A path given by the page, made safe: relative, inside outputs (or the trash), no "..".
fn safe(base: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() || rel.starts_with('/') || rel.starts_with('\\') || rel.contains(':') || rel.split(['/', '\\']).any(|c| c == ".." || c.is_empty()) { return None; }
    Some(base.join(rel))
}
pub fn delete(dir: &Path, rel: &str) -> Result<(), String> {
    use std::io::Write;
    if rel.starts_with(".trash") { return Err("already in the trash".into()); }
    let from = safe(&dir.join("outputs"), rel).filter(|p| p.is_file()).ok_or("no such file")?;
    let to = trash(dir).join(rel);
    if let Some(d) = to.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
    let meta = list_meta(dir).remove(rel).unwrap_or(json!({}));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(trash(dir).join("trash.jsonl")) {
        let _ = writeln!(f, "{}", json!({ "rel": rel, "deleted": crate::util::now_iso(), "meta": meta }));
    }
    Ok(())
}
pub fn restore(dir: &Path, rel: &str) -> Result<(), String> {
    let from = safe(&trash(dir), rel).filter(|p| p.is_file()).ok_or("not in the trash")?;
    let to = dir.join("outputs").join(rel);
    if to.exists() { return Err("a file with that name is back already".into()); }
    if let Some(d) = to.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}
pub fn purge(dir: &Path, rel: &str) -> Result<(), String> {
    let f = safe(&trash(dir), rel).filter(|p| p.is_file()).ok_or("not in the trash")?;
    std::fs::remove_file(f).map_err(|e| e.to_string())
}
/// Removes everything in the trash; returns how many files.
pub fn empty_trash(dir: &Path) -> usize {
    let n = list_trash(dir).len();
    let _ = std::fs::remove_dir_all(trash(dir));
    n
}
/// What is in the trash, newest deletion first (with the details the file had).
pub fn list_trash(dir: &Path) -> Vec<Value> {
    let t = trash(dir);
    let mut when: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for l in std::fs::read_to_string(t.join("trash.jsonl")).unwrap_or_default().lines() {
        if let Ok(v) = serde_json::from_str::<Value>(l) { if let Some(r) = v["rel"].as_str() { when.insert(r.to_string(), v); } }
    }
    let mut items = vec![];
    let mut stack = vec![t.clone()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() { stack.push(p); continue; }
            let Some(kind) = kind_of(&p) else { continue };
            let rel = p.strip_prefix(&t).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            let w = when.get(&rel).cloned().unwrap_or(json!({}));
            let mut v = json!({ "rel": rel, "path": p.to_string_lossy(), "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "kind": kind, "bytes": e.metadata().map(|m| m.len()).unwrap_or(0), "deleted": w["deleted"], "trash": true });
            for k in ["pack", "mode", "prompt", "lyrics", "seed", "size", "duration", "created"] { if !w["meta"][k].is_null() { v[k] = w["meta"][k].clone(); } }
            items.push(v);
        }
    }
    items.sort_by(|a, b| b["deleted"].as_str().cmp(&a["deleted"].as_str()));
    items
}
fn list_meta(dir: &Path) -> std::collections::HashMap<String, Value> {
    let mut meta = std::collections::HashMap::new();
    for l in std::fs::read_to_string(dir.join("outputs").join("library.jsonl")).unwrap_or_default().lines() {
        if let Ok(v) = serde_json::from_str::<Value>(l) { if let Some(r) = v["rel"].as_str() { meta.insert(r.to_string(), v); } }
    }
    meta
}

fn iso(t: std::time::SystemTime) -> String {
    let s = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (s.div_euclid(86400), s.rem_euclid(86400));
    // civil date from days (Howard Hinnant)
    let z = days + 719468; let era = z.div_euclid(146097); let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; let y = yoe + era * 400; let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153; let d = doy - (153 * mp + 2) / 5 + 1; let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", if m <= 2 { y + 1 } else { y }, m, d, rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn saves_lists_and_reads_multipart() {
        let dir = std::env::temp_dir().join(format!("sushila-lib-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir); std::fs::create_dir_all(&dir).unwrap();
        let f = save(&dir, "music", "mp3", b"ID3fake", "Upbeat pop, female vocals", json!({ "pack": "ace-step-15", "prompt": "Upbeat pop, female vocals", "lyrics": "[Verse] hello", "duration": 60 })).unwrap();
        assert!(f.to_string_lossy().contains("outputs") && f.file_name().unwrap().to_string_lossy().ends_with("-upbeat-pop-female-vocals.mp3"));
        std::fs::write(dir.join("outputs").join("old.png"), b"png").unwrap();  // an older file without a line in the index
        let l = list(&dir);
        assert_eq!(l.len(), 2);
        let song = l.iter().find(|x| x["kind"] == "music").unwrap();
        assert_eq!(song["pack"], "ace-step-15"); assert_eq!(song["lyrics"], "[Verse] hello"); assert_eq!(song["bytes"], 7);
        assert!(l.iter().any(|x| x["name"] == "old.png" && x["kind"] == "image" && x["created"].as_str().unwrap().len() == 20));
        let body = b"--XyZ\r\nContent-Type: application/json\r\n\r\n{}\r\n--XyZ\r\nContent-Type: audio/mpeg\r\n\r\nMP3DATA\r\n--XyZ--\r\n";
        let (a, t) = audio_in_multipart(body, "multipart/mixed; boundary=XyZ").unwrap();
        assert_eq!(a, b"MP3DATA"); assert_eq!(t, "audio/mpeg");
        // delete -> trash -> restore; delete -> purge; paths outside are refused
        let rel = song["rel"].as_str().unwrap().to_string();
        delete(&dir, &rel).unwrap();
        assert_eq!(list(&dir).len(), 1); let t = list_trash(&dir); assert_eq!(t.len(), 1); assert_eq!(t[0]["prompt"], "Upbeat pop, female vocals");
        restore(&dir, &rel).unwrap(); assert_eq!(list(&dir).len(), 2); assert!(list_trash(&dir).is_empty());
        delete(&dir, "old.png").unwrap(); purge(&dir, "old.png").unwrap(); assert_eq!(list(&dir).len(), 1); assert!(list_trash(&dir).is_empty());
        assert!(delete(&dir, "../state.json").is_err() && delete(&dir, "/etc/passwd").is_err() && restore(&dir, "a/../../x").is_err());
        delete(&dir, &rel).unwrap(); assert_eq!(empty_trash(&dir), 1); assert!(list(&dir).is_empty());
        // the AI marking: a valid PNG stays valid (CRCs), an MP3 gets an ID3 tag in front
        let png: Vec<u8> = [&[0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A][..], &[0, 0, 0, 0], b"IEND", &crc32(b"IEND").to_be_bytes()].concat();
        let m = mark_ai(&png, "png", "z-image-turbo", "a fox");
        assert!(m.windows(18).any(|w| w == b"XML:com.adobe.xmp\0") && m.ends_with(&png[8..]) && String::from_utf8_lossy(&m).contains("trainedAlgorithmicMedia"));
        assert_eq!(crc32(b"IEND"), 0xAE42_6082);
        let mp3 = mark_ai(b"\xff\xfbDATA", "mp3", "ace-step-15", "pop"); assert!(mp3.starts_with(b"ID3\x03") && mp3.ends_with(b"\xff\xfbDATA") && String::from_utf8_lossy(&mp3).contains("AI_GENERATED"));
        assert_eq!(mark_ai(b"ID3old", "mp3", "", ""), b"ID3old"); assert_eq!(mark_ai(b"webm", "webm", "", ""), b"webm");
        assert_eq!(iso(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_760_000_000)), "2025-10-09T08:53:20Z");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

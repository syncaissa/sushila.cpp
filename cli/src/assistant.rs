// "Ask Sushila": the installed text model answers questions about Sushila itself, from Sushila's own notes
// (web/sushila_knowledge.md, the documentation page) and live facts about this computer, found by BM25 keyword
// scoring (no embedding model needed). Used by `sushila assistant` and POST /api/assistant.
use serde_json::{json, Value};

pub const KNOWLEDGE_MD: &str = include_str!("../web/sushila_knowledge.md");

#[derive(Clone, Debug)]
pub struct Section { pub source: String, pub title: String, pub text: String }

/// Every section of the notes and of the documentation page. Long documentation sections (the command table) are cut
/// into pieces of about 1,200 characters at line ends, so one question does not pull in the whole table.
pub fn sections() -> &'static Vec<Section> {
    static S: std::sync::OnceLock<Vec<Section>> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        let mut v = vec![];
        for part in KNOWLEDGE_MD.split("\n## ").skip(1) {
            let (title, body) = part.split_once('\n').unwrap_or((part, ""));
            v.push(Section { source: "notes".into(), title: title.trim().into(), text: body.trim().into() });
        }
        v.extend(doc_sections(crate::webserver::DOCS_HTML));
        v
    })
}

/// The documentation page as plain-text sections (split at <h2>/<h3>; table rows become lines).
pub fn doc_sections(html: &str) -> Vec<Section> {
    let body = html.split("<main>").nth(1).and_then(|b| b.split("</main>").next()).unwrap_or(html);
    let mut out = vec![];
    let mut title = String::from("Sushila documentation");
    let mut rest = body;
    loop {
        let next = [rest.find("<h2"), rest.find("<h3")].into_iter().flatten().min();
        let (chunk, after) = match next { Some(i) => (&rest[..i], Some(&rest[i..])), None => (rest, None) };
        let text: String = strip_tags(chunk).lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n");
        if !text.trim().is_empty() {
            let mut buf = String::new(); let mut n = 0;
            for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
                if buf.len() + line.len() > 1200 && !buf.is_empty() { n += 1; out.push(Section { source: "documentation".into(), title: format!("{title} ({n})"), text: std::mem::take(&mut buf) }); }
                buf += line; buf.push('\n');
            }
            if !buf.is_empty() { out.push(Section { source: "documentation".into(), title: if n > 0 { format!("{title} ({})", n + 1) } else { title.clone() }, text: buf }); }
        }
        let Some(a) = after else { break };
        let end = a.find(if a.starts_with("<h2") { "</h2>" } else { "</h3>" }).unwrap_or(a.len());
        title = strip_tags(&a[..end]).trim().to_string();
        rest = &a[(end + 5).min(a.len())..];
    }
    out
}

/// Tags removed, entities decoded, one line per table row / list item / paragraph.
pub fn strip_tags(h: &str) -> String {
    let h = h.replace("<code>", "`").replace("</code>", "`").replace("</tr>", "\n").replace("</li>", "\n").replace("</p>", "\n").replace("<br>", "\n").replace("</pre>", "\n").replace("</td><td>", " : ").replace("</th><th>", " : ");
    let mut s = String::new(); let mut tag = false;
    for c in h.chars() { match c { '<' => tag = true, '>' if tag => tag = false, c if !tag => s.push(c), _ => {} } }
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&").replace("&quot;", "\"").replace("&nbsp;", " ")
}

const STOP: [&str; 64] = ["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "be", "with", "as", "by", "at", "from", "this", "that",
    "i", "my", "me", "do", "does", "how", "what", "which", "can", "you", "your", "are", "was", "will", "if", "its", "not", "no", "so", "use",
    "there", "here", "when", "where", "should", "would", "could", "about", "into", "than", "then", "them", "they", "we", "our", "us", "has",
    "have", "get", "one", "all", "any", "sushila", "e"];

/// Lowercase words without stop words, with a crude stem (plural -s, -ing, -ed) so "models" finds "model".
pub fn words(t: &str) -> Vec<String> {
    t.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 1 && !STOP.contains(w)).map(|w| {
        let w = w.to_string();
        for suf in ["ing", "ed", "es", "s"] { if w.len() > suf.len() + 3 && w.ends_with(suf) { return w[..w.len() - suf.len()].to_string(); } }
        w
    }).collect()
}

/// Everyday words people use for what the notes call by another name.
fn expand(q: &str) -> String {
    let l = q.to_lowercase();
    let mut x = q.to_string();
    for (k, add) in [("phone", "share network other machines access key"), ("tablet", "share network other machines access key"), ("laptop", "share network other machines"),
                     ("forgot", "lost reset password"), ("forget", "lost reset password"), ("fast", "speed expect"), ("slow", "speed GPU layers"), ("speed", "expect"),
                     ("stored", "home folder model-packs"), ("where", "home folder"), ("delete", "remove uninstall"), ("coding", "code coder pack install"),
                     ("fit", "fits memory GPU pack"), ("gpu", "GPU memory"), ("video", "video Wan"), ("picture", "image"), ("song", "music"),
                     ("accelerated", "Standard Accelerated precomputed"), ("start automatically", "service install"), ("boot", "service"), ("update", "update engine")] {
        if l.contains(k) { x += " "; x += add; }
    }
    x
}

/// BM25 (k1 1.2, b 0.75) over the sections; titles count twice. Returns indexes, best first.
pub fn rank(q: &str, secs: &[Section]) -> Vec<(usize, f64)> {
    let qw = words(&expand(q));
    let docs: Vec<Vec<String>> = secs.iter().map(|s| { let mut w = words(&s.title); w.extend(words(&s.title)); w.extend(words(&s.text)); w }).collect();
    let n = docs.len() as f64;
    let avg = docs.iter().map(|d| d.len()).sum::<usize>() as f64 / n.max(1.0);
    let mut scores: Vec<(usize, f64)> = docs.iter().enumerate().map(|(i, d)| {
        let mut s = 0.0;
        let mut seen = std::collections::HashSet::new();
        for w in &qw {
            if !seen.insert(w) { continue; }
            let df = docs.iter().filter(|x| x.contains(w)).count() as f64;
            if df == 0.0 { continue; }
            let tf = d.iter().filter(|x| *x == w).count() as f64;
            let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
            s += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * d.len() as f64 / avg));
        }
        (i, if secs[i].source == "notes" { s * 1.3 } else { s })  // the notes are written for the assistant
    }).filter(|x| x.1 > 0.0).collect();
    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scores
}

/// The best sections that fit in `budget` characters (at most 4: a small model answers better from less).
pub fn retrieve(q: &str, budget: usize) -> Vec<Section> {
    let secs = sections();
    let mut used = 0; let mut out = vec![];
    for (i, _) in rank(q, secs) {
        let s = &secs[i];
        let len = s.title.len() + s.text.len() + 8;
        if used + len > budget { if out.is_empty() { out.push(Section { text: s.text.chars().take(budget.saturating_sub(s.title.len() + 8)).collect(), ..s.clone() }); } continue; }
        used += len; out.push(s.clone());
        if out.len() >= 4 { break; }
    }
    out
}

/// Quote mode: the best section, and the second only when it scores nearly as well (else it is noise to read).
pub fn quote_sections(q: &str) -> Vec<Section> {
    let secs = sections();
    let r = rank(q, secs);
    let Some(top) = r.first().map(|x| x.1) else { return vec![] };
    // a section counts only if it shares a real word with the question ("why is the sky blue" shares only "why" with a
    // note about crashes): otherwise the question is not about Sushila and nothing is quoted
    const GENERIC: [&str; 12] = ["why", "please", "tell", "explain", "know", "want", "need", "help", "thing", "way", "like", "make"];
    let qw: Vec<String> = words(q).into_iter().filter(|w| !GENERIC.contains(&w.as_str())).collect();
    r.iter().take(2).filter(|x| x.1 >= 0.75 * top).filter(|x| { let sw = words(&format!("{} {}", secs[x.0].title, secs[x.0].text)); qw.iter().any(|w| sw.contains(w)) })
        .map(|x| secs[x.0].clone()).collect()
}

/// What is true on this computer right now, as plain lines. `local`: false for visitors from other machines (no paths).
pub fn live_facts(state: &Value, catalog: &Value, gpu: &Option<Value>, other_gpu: &Option<String>, info: &Value, port: u64, local: bool, home: &str) -> String {
    let mut f = String::from("## Live facts about this computer (now)\n");
    f += &format!("System: {} {}, {} CPU cores, {:.0} GB memory.\n", info["os"].as_str().unwrap_or("?"), info["arch"].as_str().unwrap_or("?"), info["cpus"], info["memory_bytes"].as_f64().unwrap_or(0.0) / 1e9);
    f += &match (gpu, other_gpu) {
        (Some(g), _) => format!("GPU: {} with {} GB of memory (NVIDIA).\n", g["name"].as_str().unwrap_or("NVIDIA GPU"), g["memoryGB"]),
        (None, Some(o)) => format!("GPU: {o} (AMD or Intel: the Vulkan engine).\n"),
        _ if info["os"] == "macos" && info["arch"] == "aarch64" => "GPU: Apple silicon (Metal), using the shared memory.\n".into(),
        _ => "GPU: none found (the CPU engine is used).\n".into(),
    };
    let e = &state["engine"];
    f += &if e.is_object() { format!("Engine: Sushila.cpp {} for {}.\n", e["version"].as_str().unwrap_or(""), crate::core::Ctx::gpu_label(e["key"].as_str().unwrap_or(""))) } else { "Engine: not installed yet (sushila engine install).\n".into() };
    let packs: Vec<String> = state["packs"].as_object().map(|m| m.values().map(|p| format!("{} ({}, {})", p["id"].as_str().unwrap_or(""), p["kind"].as_str().unwrap_or("text"), crate::util::human(p["bytes"].as_u64().unwrap_or(0)))).collect()).unwrap_or_default();
    f += &format!("Installed packs: {}.\n", if packs.is_empty() { "none".into() } else { packs.join(", ") });
    let running: Vec<String> = state["running"].as_object().map(|m| m.iter().map(|(id, r)| format!("{id} ({})", if r["mode"] == "turbo" { "Accelerated" } else { "Standard" })).collect()).unwrap_or_default();
    f += &format!("Running models: {}.\n", if running.is_empty() { "none".into() } else { running.join(", ") });
    if let Some(list) = catalog["packs"].as_array() {
        fn kind(p: &Value) -> &str { let k = p["kind"].as_str().unwrap_or("text"); if k == "text" { if p["id"].as_str().unwrap_or("").contains("coder") { "coding" } else { "chat" } } else { k } }
        let row = |p: &Value| format!("- {} ({}, {}): install with: sushila install {}\n", p["id"].as_str().unwrap_or(""), kind(p), crate::util::human(p["bytes"].as_u64().unwrap_or(0)), p["id"].as_str().unwrap_or(""));
        f += "Packs that fit this computer:\n";
        for p in list.iter().filter(|p| p["fits"] != false) { f += &row(p); }
        let no: Vec<&str> = list.iter().filter(|p| p["fits"] == false).filter_map(|p| p["id"].as_str()).collect();
        if !no.is_empty() { f += &format!("Packs that do NOT fit this computer (other hardware needed): {}\n", no.join(", ")); }
    }
    f += &format!("Addresses: Inference http://localhost:{port}/, Documentation http://localhost:{port}/docs, API http://localhost:{port}/v1{}.\n", if local { format!(", Admin http://localhost:{port}/admin") } else { String::new() });
    if local && !home.is_empty() { f += &format!("Home folder: {home} (model packs are in its model-packs folder).\n"); }
    f
}

/// The chat messages: system prompt with the notes and facts, earlier turns, the question.
pub fn messages(question: &str, history: &[Value], notes: &[Section], facts: &str, port: u64) -> Value {
    let mut sys = format!("You are the Sushila assistant. Answer the user's question about Sushila ONLY from the notes below. \
Questions about this computer (its GPU, which packs fit, what is installed or running, where files are) are answered from the live facts: name the actual packs and paths. \
Give exact commands exactly as they appear in the notes, and say in one sentence what each does. Keep the answer short. End with a line 'Sources:' naming the section titles you used. \
If the notes do not answer the question, say that you do not know and point to the Documentation page http://localhost:{port}/docs.\n\n{facts}\n");
    // the best section last, next to the question (small models weigh the end of the prompt most)
    for s in notes.iter().rev() { sys += &format!("\n## {} ({})\n{}\n", s.title, s.source, s.text); }
    let mut m = vec![json!({ "role": "system", "content": sys })];
    for h in history.iter().rev().take(4).rev() { if let (Some(r), Some(c)) = (h["role"].as_str(), h["content"].as_str()) { if r == "user" || r == "assistant" { m.push(json!({ "role": r, "content": c.chars().take(1500).collect::<String>() })); } } }
    m.push(json!({ "role": "user", "content": question }));
    json!(m)
}

/// Characters of notes that fit: the context per slot, minus the answer (600 tokens), the question and the facts, at
/// about 3.2 characters per token (English with commands).
pub fn notes_budget(context_tokens: u64, facts_chars: usize, question_chars: usize) -> usize {
    let tokens = context_tokens.saturating_sub(600 + 150) as f64;
    ((tokens * 3.2) as usize).saturating_sub(facts_chars + question_chars + 600).max(800)
}

/// Which installed text pack answers: a running one (the largest), else the largest that fits in memory_gb, preferring
/// chat models over coding models; else None (the caller falls back to the default pack).
pub fn pick_model(state: &Value, memory_gb: f64) -> Option<String> {
    let text = |p: &Value| p["kind"].as_str().unwrap_or("text") == "text";
    let coder = |id: &str| id.contains("coder") || id.contains("code");
    let packs = state["packs"].as_object()?;
    let mut running: Vec<(&String, u64)> = state["running"].as_object().map(|r| r.keys().filter_map(|id| packs.get(id).filter(|p| text(p)).map(|p| (id, p["bytes"].as_u64().unwrap_or(0)))).collect()).unwrap_or_default();
    running.sort_by_key(|(id, b)| (!coder(id), *b));
    if let Some((id, _)) = running.last() { return Some(id.to_string()); }
    let mut all: Vec<(&String, u64)> = packs.iter().filter(|(_, p)| text(p) && (memory_gb <= 0.0 || p["bytes"].as_f64().unwrap_or(0.0) / 1e9 * 1.3 < memory_gb)).map(|(id, p)| (id, p["bytes"].as_u64().unwrap_or(0))).collect();
    all.sort_by_key(|(id, b)| (!coder(id), *b));
    all.last().map(|(id, _)| id.to_string())
}

// ---------- quote mode: models under 3B parameters do not write free text (they invent steps); the assistant then
// answers with the notes themselves, the commands in them, and facts about this computer.

/// Billions of parameters from a pack's id or name ("qwen2.5-0.5b-q4km" -> 0.5, "qwen3-30b-a3b" -> 30), if it says.
pub fn params_b(p: &Value) -> Option<f64> {
    for t in [p["id"].as_str(), p["name"].as_str()].into_iter().flatten() {
        for w in t.to_lowercase().split(|c: char| c == '-' || c == '_' || c == ' ' || c == '(' || c == ')') {
            if let Some(n) = w.strip_suffix('b') { if let Ok(x) = n.parse::<f64>() { if x > 0.0 { return Some(x); } } }
        }
    }
    None
}
/// Under 3B parameters (or, when the name does not say, under 1.6 GB: a 3B model in 4 bits is about 1.9 GB).
pub fn small_model(p: &Value) -> bool { params_b(p).map(|b| b < 3.0).unwrap_or(p["bytes"].as_f64().unwrap_or(0.0) < 1.6e9) }

/// The lines of a long section that share the most words with the question (in their order), about `max` characters.
pub fn trim_to(q: &str, text: &str, max: usize) -> String {
    if text.len() <= max { return text.to_string(); }
    let qw: std::collections::HashSet<String> = words(&expand(q)).into_iter().collect();
    let lines: Vec<&str> = text.lines().collect();
    let mut scored: Vec<(usize, usize)> = lines.iter().enumerate().map(|(i, l)| (words(l).iter().filter(|w| qw.contains(*w)).count(), i)).collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let (mut keep, mut used) = (vec![], 0);
    for (sc, i) in scored { if sc == 0 && !keep.is_empty() { break; } if used + lines[i].len() > max && !keep.is_empty() { continue; } used += lines[i].len() + 1; keep.push(i); }
    keep.sort();
    let mut out = String::new(); let mut last = None;
    for i in keep { if last.map(|l: usize| i > l + 1).unwrap_or(i > 0) { out += "…\n"; } out += lines[i]; out.push('\n'); last = Some(i); }
    if last.map(|l| l + 1 < lines.len()).unwrap_or(false) { out += "…"; }
    out.trim_end().to_string()
}
/// Every `sushila ...` command written in code quotes in a text, in order, once each.
pub fn commands_in(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for (i, part) in text.split('`').enumerate() {
        let c = part.trim();
        if i % 2 == 1 && c.starts_with("sushila ") && !c.contains('\n') && !c.contains("...") && !out.iter().any(|x| x == c) { out.push(c.to_string()); }
    }
    out
}
fn kind_of(p: &Value) -> &str { let k = p["kind"].as_str().unwrap_or("text"); if k == "text" { if p["id"].as_str().unwrap_or("").contains("coder") { "code" } else { "chat" } } else { k } }

/// A question about this computer that the facts answer: which packs fit, where the models are.
pub fn facts_answer(q: &str, state: &Value, catalog: &Value, gpu_line: &str, local: bool, home: &str) -> Option<String> {
    let l = q.to_lowercase();
    let has = |ws: &[&str]| ws.iter().any(|w| l.contains(w));
    let packs = state["packs"].as_object();
    let running = state["running"].as_object();
    let mode = |m: &Value| if m == "turbo" { "Accelerated" } else { "Standard" };
    let how = has(&["how do", "how to", "how can"]);
    // what is installed / running: straight from the state, with or without a language model
    if has(&["running", "loaded", "active", "started"]) && has(&["model", "pack", "what", "which", "anything"]) && !how {
        let r: Vec<String> = running.map(|m| m.iter().map(|(id, v)| format!("- {} ({id}): {}{}", v["name"].as_str().unwrap_or(id), mode(&v["mode"]), if v["ready"] == true { "" } else { ", still loading" })).collect()).unwrap_or_default();
        return Some(if r.is_empty() { "No model pack is running. Start one on its Generate page (pick it at the top) or on the Model packs page or with `sushila start <pack>`; `sushila list` shows the installed ones.".into() }
            else { format!("Running now:\n{}\nStop one with `sushila stop <pack>` or the Stop button at the top of its Generate page.", r.join("\n")) });
    }
    if has(&["install", "have", "list", "show", "my ", "all "]) && has(&["model", "pack"]) && !how && !has(&["where", "fit", "can i run", "should", "recommend"]) {
        let mut v: Vec<(&String, &Value)> = packs.map(|m| m.iter().collect()).unwrap_or_default();
        v.sort_by_key(|(_, p)| kind_of(p).to_string());
        if v.is_empty() { return Some("No model pack is installed yet. `sushila search --fits` lists the ones that fit this computer; `sushila install <pack>` adds one.".into()); }
        let lines: Vec<String> = v.iter().map(|(id, p)| format!("- {} ({id}): {}, {}{}", p["name"].as_str().unwrap_or(id), kind_of(p), crate::util::human(p["bytes"].as_u64().unwrap_or(0)),
            running.and_then(|m| m.get(id.as_str())).map(|r| format!(", running ({})", mode(&r["mode"]))).unwrap_or_default())).collect();
        return Some(format!("Installed model packs ({}):\n{}\nStart one: pick it at the top of its Generate page, or `sushila start <pack>` (one pack runs at a time).", v.len(), lines.join("\n")));
    }
    if has(&["where"]) && has(&["image", "picture", "photo", "output", "song", "video", "result"]) {
        return Some(if local { let out = crate::locate::outputs(std::path::Path::new(home));
            format!("Your pictures, songs and videos are saved in {} (Images, Music and Videos, one folder per day); under each one, Show in folder opens it. Change the folder in Settings -> Where my files go.",
            out.display()) }
            else { "On the computer that runs the server, in its files folder (Documents/Sushila unless its owner chose another one in Settings).".into() });
    }
    if has(&["gpu", "graphics", "video card", "vram"]) && has(&["what", "which", "do i have", "my "]) && !has(&["fit", "run"]) { return Some(gpu_line.to_string()); }
    if has(&["version"]) && has(&["sushila", "engine", "what", "which"]) {
        return Some(format!("sushila {}, engine Sushila.cpp {} ({}). `sushila version` prints both.", env!("CARGO_PKG_VERSION"), state["engine"]["version"].as_str().unwrap_or("not installed"), state["engine"]["key"].as_str().unwrap_or("")));
    }
    if has(&["where"]) && has(&["model", "pack", "stored", "store", "file", "folder", "home", "kept", "saved"]) {
        return Some(if local { format!("On this computer the model packs are in {}, inside the home folder {home}. `sushila home` prints it; `sushila du` shows the space each pack uses.",
            std::path::Path::new(home).join("model-packs").display()) }
            else { "In the model-packs folder of the Sushila home folder on the computer that runs the server (`sushila home` there prints it).".into() });
    }
    if has(&["fit", "can i run", "which model", "which pack", "what model", "what pack", "which image", "which video", "which music", "which chat", "which coding", "which code", "recommend"]) {
        let want = if has(&["image", "picture", "photo"]) { Some("image") } else if has(&["video", "clip"]) { Some("video") } else if has(&["music", "song"]) { Some("music") }
                   else if has(&["code", "coding", "program"]) { Some("code") } else if has(&["chat", "text", "assistant"]) { Some("chat") } else { None };
        let list: Vec<&Value> = catalog["packs"].as_array().map(|a| a.iter().filter(|p| p["fits"] != false && want.map(|w| kind_of(p) == w).unwrap_or(true)).collect()).unwrap_or_default();
        if !catalog["packs"].is_array() { return Some(format!("{gpu_line}\nThe catalog is not loaded yet: `sushila search --fits` lists the packs that fit.")); }
        let mut a = format!("{gpu_line}\nPacks{} that fit this computer:\n", want.map(|w| format!(" ({w})")).unwrap_or_default());
        if list.is_empty() { a += "- none in the catalog\n"; }
        for p in &list { let id = p["id"].as_str().unwrap_or(""); a += &format!("- {id} ({}, {}){}: `sushila install {id}`\n", kind_of(p), crate::util::human(p["bytes"].as_u64().unwrap_or(0)), if state["packs"][id].is_object() { " [installed]" } else { "" }); }
        return Some(a.trim_end().to_string());
    }
    None
}

/// The quote-mode answer: facts for questions about this computer, else the best 1-2 sections as they are written,
/// the commands in them, and (when one fits) the bigger chat model that would answer in its own words.
pub fn quote_answer(q: &str, notes: &[Section], state: &Value, catalog: &Value, gpu_line: &str, local: bool, home: &str, model: &str) -> Value {
    let _ = model;
    let hint = fuller_hint(state, catalog);
    let (mut answer, quotes, commands): (String, Vec<Value>, Vec<String>);
    if let Some(f) = facts_answer(q, state, catalog, gpu_line, local, home) {
        commands = commands_in(&f);
        answer = f; quotes = vec![json!({ "title": "Live facts about this computer", "source": "facts", "text": answer })];
    } else if notes.is_empty() {
        answer = "Without a chat model running, the Sushila helper answers questions about Sushila and this computer (what is installed or running, how to make pictures, songs and videos, settings, problems). For this question you need a chat model.".into(); quotes = vec![]; commands = vec![];
    } else {
        let best: Vec<&Section> = notes.iter().take(2).collect();
        // the notes are one paragraph per section, wrapped at about 120 characters: unwrapped, so terminals and the page
        // wrap them at their own width; documentation sections keep one line per table row or item
        let q2: Vec<Value> = best.iter().map(|s| { let t = trim_to(q, &s.text, 900); json!({ "title": s.title, "source": s.source, "text": if s.source == "notes" { t.replace('\n', " ") } else { t } }) }).collect();
        commands = q2.iter().flat_map(|x| commands_in(x["text"].as_str().unwrap_or(""))).fold(vec![], |mut v: Vec<String>, c| { if !v.contains(&c) { v.push(c); } v });
        answer = q2.iter().map(|x| format!("From \"{}\" ({}):\n{}", x["title"].as_str().unwrap_or(""), x["source"].as_str().unwrap_or(""), x["text"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n\n");
        if !commands.is_empty() { answer += &format!("\n\nCommands from these notes:\n{}", commands.iter().map(|c| format!("  {c}")).collect::<Vec<_>>().join("\n")); }
        quotes = q2;
    }
    if let Some(h) = &hint { answer += &format!("\n\n{h}"); }
    json!({ "mode": "quote", "answer": answer, "quotes": quotes, "commands": commands, "hint": hint, "model": model })
}
/// small_model for a pack known by its key (records carry the id too, but the key is what counts).
fn small_pack(id: &str, p: &Value) -> bool { let mut q = p.clone(); q["id"] = json!(id); small_model(&q) }
/// The chat model (3B or more) that runs and is ready, if any.
pub fn running_chat(state: &Value) -> Option<String> {
    let packs = state["packs"].as_object()?;
    state["running"].as_object()?.iter().filter(|(id, r)| r["ready"] == true && packs.get(*id).map(|p| p["kind"].as_str().unwrap_or("text") == "text" && !small_pack(id, p)).unwrap_or(false))
        .max_by_key(|(id, _)| packs[*id]["bytes"].as_u64().unwrap_or(0)).map(|(id, _)| id.clone())
}
/// How to get an answer in plain words: start an installed chat model (and what that stops), or install one.
pub fn fuller_hint(state: &Value, catalog: &Value) -> Option<String> {
    if running_chat(state).is_some() { return None; }
    let chat = state["packs"].as_object().and_then(|m| m.iter().filter(|(id, p)| p["kind"].as_str().unwrap_or("text") == "text" && !small_pack(id, p) && !id.contains("coder"))
        .min_by_key(|(_, p)| p["bytes"].as_u64().unwrap_or(0)).map(|(id, p)| (id.clone(), p["name"].as_str().unwrap_or(id).to_string())));
    let stops: Vec<String> = state["running"].as_object().map(|m| m.iter().map(|(id, r)| r["name"].as_str().unwrap_or(id).to_string()).collect()).unwrap_or_default();
    match chat {
        Some((id, name)) => Some(format!("For a fuller answer in plain words, start the chat model: `sushila start {id}` ({name}){}.",
            if stops.is_empty() { String::new() } else { format!("; this stops {} (one model pack runs at a time)", stops.join(", ")) })),
        None => catalog["packs"].as_array().and_then(|a| a.iter().find(|p| p["id"] == "qwen3-4b-instruct-2507" && p["fits"] != false))
            .map(|p| format!("For answers in plain words, install a chat model: `sushila install qwen3-4b-instruct-2507` (about {:.0} GB), then start it.", (p["bytes"].as_f64().unwrap_or(2.5e9) / 1e9).ceil())),
    }
}
/// The classic helper's direct answer to common tasks ("make a picture", "write a song", ...): the steps, with the pack
/// names installed here (no language model involved).
pub fn intent_answer(q: &str, state: &Value, port: u16) -> Option<String> {
    let l = q.to_lowercase();
    let has = |ws: &[&str]| ws.iter().any(|w| l.contains(w));
    let pack_of = |k: &str| state["packs"].as_object().and_then(|m| m.iter().find(|(_, p)| kind_of(p) == k).map(|(id, _)| id.clone()));
    let page = format!("http://localhost:{port}/");
    let task = |k: &str, what: &str, example: &str, install: &str| -> String {
        match pack_of(k) {
            Some(id) => format!("To {what}: open Sushila ({page}), and on its Generate page pick {id} at the top (it starts after asking), then type your request. In a terminal: `sushila run {id} \"{example}\"`."),
            None => format!("To {what} you need {} {k} pack first: `sushila install {install}` (or `sushila search --kind {k} --fits`).", if k.starts_with(['a', 'e', 'i', 'o', 'u']) { "an" } else { "a" }),
        }
    };
    if has(&["picture", "image", "photo", "draw", "illustration"]) && !has(&["where", "fit"]) { return Some(task("image", "make a picture", "a red fox in the snow", "z-image-turbo")); }
    if has(&["song", "music", "melody", "lyrics"]) && !has(&["where", "fit"]) { return Some(task("music", "make a song", "an upbeat pop song about summer", "ace-step-15")); }
    if has(&["video", "clip", "movie", "animation"]) && !has(&["where", "fit"]) { return Some(task("video", "make a video", "two bears dancing by a river", "wan2.2-ti2v-5b")); }
    if has(&["code", "program", "script", "function", "coding"]) && has(&["write", "help", "make", "create", "fix"]) { return Some(task("code", "get help with code", "write a Python function that reverses a string", "qwen2.5-coder-7b")); }
    if has(&["phone", "tablet", "other computer", "another computer"]) { return Some("To use Sushila from a phone or another computer: `sushila share on`, restart the server, `sushila keys add phone`, then `sushila share qr` (same network).".into()); }
    None
}
/// One line about the GPU, for quote-mode answers.
pub fn gpu_line(gpu: &Option<Value>, other: &Option<String>, info: &Value) -> String {
    match (gpu, other) {
        (Some(g), _) => format!("This computer: {} with {} GB of GPU memory.", g["name"].as_str().unwrap_or("NVIDIA GPU"), g["memoryGB"]),
        (None, Some(o)) => format!("This computer: {o} (Vulkan)."),
        _ if info["os"] == "macos" && info["arch"] == "aarch64" => format!("This computer: Apple silicon with {:.0} GB of shared memory.", info["memory_bytes"].as_f64().unwrap_or(0.0) / 1e9),
        _ => format!("This computer: no GPU found (CPU), {:.0} GB of memory.", info["memory_bytes"].as_f64().unwrap_or(0.0) / 1e9),
    }
}

/// This computer's GPUs and memory, looked up once per server process.
pub async fn probe(dir: &std::path::Path) -> &'static (Option<Value>, Option<String>, Value) {
    static P: tokio::sync::OnceCell<(Option<Value>, Option<String>, Value)> = tokio::sync::OnceCell::const_new();
    P.get_or_init(|| async { match crate::core::Ctx::load(dir.to_path_buf(), true) {
        Ok(mut c) => { let g = c.nvidia_gpu().await; let o = c.other_gpu().await; (g, o, c.info.clone()) }
        Err(_) => (None, None, crate::util::host_info()) } }).await
}

/// The server's answer to POST /api/assistant: picks the model (starting it if needed), retrieves notes, asks it.
pub async fn answer_here(dir: &std::path::Path, port: u16, q: &str, history: &[Value], local: bool) -> Result<Value, String> {
    answer_stream(dir, port, q, history, local, None, None).await
}
/// The same, streaming tokens into `each` (the server window). `extra`: more instructions for the system prompt.
pub async fn answer_stream(dir: &std::path::Path, port: u16, q: &str, history: &[Value], local: bool, extra: Option<&str>, each: crate::cmds::Each<'_>) -> Result<Value, String> {
    let st = crate::webserver::read_state(dir);
    let (gpu, other, info) = probe(dir).await;
    let cat: Value = std::fs::read_to_string(dir.join("catalog-cache.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let facts = live_facts(&st, &cat, gpu, other, info, port as u64, local, &dir.to_string_lossy());
    let mem = gpu.as_ref().and_then(|g| g["memoryGB"].as_f64()).unwrap_or(info["memory_bytes"].as_f64().unwrap_or(0.0) / 1e9 * 0.6);
    let _ = mem;
    let gl = gpu_line(gpu, other, info);
    // questions about this computer (installed, running, where, which fits): answered from the live state, always
    if let Some(f) = facts_answer(q, &st, &cat, &gl, local, &dir.to_string_lossy()) {
        if let Some(e) = each { e(&f); }
        crate::core::log(true, &format!("assistant: {} chars asked, answered from the live facts", q.len()));
        return Ok(json!({ "mode": "facts", "answer": f, "model": "sushila helper", "sources": [{ "title": "Live facts about this computer", "source": "facts" }], "commands": commands_in(&f) }));
    }
    // a chat model (3B or more) that already runs answers in its own words; none is ever started for an answer, since
    // starting one would stop the pack in use (one at a time): without one, the classic helper answers
    let model = running_chat(&st).unwrap_or_default();
    if model.is_empty() || small_model(&st["packs"][&model]) {
        // quote mode: nothing generated, so the model need not even be loaded
        let notes = quote_sections(q);
        let mut v = quote_answer(q, &notes, &st, &cat, &gl, local, &dir.to_string_lossy(), &model);
        v["model"] = json!("sushila helper");
        if let Some(i) = intent_answer(q, &st, port) { v["answer"] = json!(format!("{i}\n\n{}", v["answer"].as_str().unwrap_or(""))); }
        v["sources"] = json!(v["quotes"].as_array().map(|a| a.iter().map(|x| json!({ "title": x["title"], "source": x["source"] })).collect::<Vec<_>>()).unwrap_or_default());
        if let Some(f) = each { f(v["answer"].as_str().unwrap_or("")); }
        crate::core::log(true, &format!("assistant: {} chars asked, answered by the helper (no chat model running)", q.len()));
        return Ok(v);
    }
    let st2 = crate::webserver::start_and_wait(dir, &model, 300).await.ok_or(format!("{model} did not start; see the Logs page"))?;
    let eport = st2["running"][&model]["port"].as_u64().ok_or("the model is not running")?;
    let ctx_tokens = st2["settings"]["contextSize"].as_u64().unwrap_or(4096);
    let extra_len = extra.map(|e| e.len()).unwrap_or(0);
    let notes = retrieve(q, notes_budget(ctx_tokens, facts.len() + extra_len, q.len()));
    let mut msgs = messages(q, history, &notes, &facts, port as u64);
    if let Some(e) = extra { let s0 = msgs[0]["content"].as_str().unwrap_or("").to_string(); msgs[0]["content"] = json!(format!("{s0}\n{e}")); }
    crate::webserver::touch(&model, 1);
    let r = crate::cmds::chat(&format!("http://127.0.0.1:{eport}"), "", &model, &msgs, 600, 0.2, each).await;
    crate::webserver::touch(&model, -1);
    let a = r?.0;
    crate::core::log(true, &format!("assistant: {} chars asked, {model} answered", q.len()));
    Ok(json!({ "mode": "generate", "answer": a, "model": model, "sources": notes.iter().map(|s| json!({ "title": s.title, "source": s.source })).collect::<Vec<_>>() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn notes_and_docs_split() {
        let s = sections();
        assert!(s.iter().any(|x| x.title == "Standard and Accelerated" && x.source == "notes"));
        assert!(s.iter().any(|x| x.source == "documentation" && x.title.starts_with("Managing Sushila: no password")));
        assert!(s.iter().all(|x| x.text.len() <= 1500 || x.source == "notes"));
    }
    #[test] fn retrieval_finds_the_right_section() {
        let top = |q: &str| retrieve(q, 6000).into_iter().map(|s| s.title).collect::<Vec<_>>();
        assert!(top("I forgot the admin password").iter().take(3).any(|t| t.contains("Admin")), "{:?}", top("I forgot the admin password"));
        assert!(top("what does Accelerated do?").iter().take(2).any(|t| t.contains("Accelerated")));
        assert!(top("where are my models stored?").iter().take(3).any(|t| t.contains("home folder") || t.contains("Files and folders") || t.contains("model-packs")));
    }
    #[test] fn strips_tags() { assert_eq!(strip_tags("<tr><td><code>a &lt;b&gt;</code></td><td>x</td></tr>").trim(), "`a <b>` : x"); }
    #[test] fn small_models() {
        assert_eq!(params_b(&json!({ "id": "qwen2.5-0.5b-q4km" })), Some(0.5)); assert_eq!(params_b(&json!({ "id": "qwen3-30b-a3b-q4km" })), Some(30.0));
        assert!(small_model(&json!({ "id": "qwen2.5-0.5b-q4km", "bytes": 534772932u64 })) && !small_model(&json!({ "id": "qwen3-4b-instruct-2507", "bytes": 2500000000u64 })));
        assert!(small_model(&json!({ "id": "my-model", "bytes": 900000000u64 })) && !small_model(&json!({ "id": "my-model", "bytes": 5000000000u64 })));
    }
    #[test] fn quotes() {
        assert_eq!(commands_in("run `sushila keys add phone` or `ls` then `sushila keys add phone`"), vec!["sushila keys add phone"]);
        let notes = retrieve("how do I use it from my phone", 6000);
        let cat = json!({ "packs": [{ "id": "qwen3-4b-instruct-2507", "kind": "text", "bytes": 2500000000u64, "fits": true }, { "id": "z-image-turbo-nvidia", "kind": "image", "bytes": 12e9 as u64, "fits": false }, { "id": "z-image-turbo", "kind": "image", "bytes": 6.7e9 as u64, "fits": true }] });
        let st = json!({ "packs": { "qwen2.5-0.5b-q4km": { "bytes": 534772932u64 } } });
        let v = quote_answer("how do I use it from my phone", &notes, &st, &cat, "GPU", true, "/h", "qwen2.5-0.5b-q4km");
        let a = v["answer"].as_str().unwrap();
        assert!(v["commands"].as_array().unwrap().iter().any(|c| c == "sushila keys add phone") && a.contains("Commands from these notes:") && a.contains("install a chat model: `sushila install qwen3-4b-instruct-2507` (about 3 GB)"), "{a}");
        let f = quote_answer("which image model fits my GPU?", &notes, &st, &cat, "GPU", true, "/h", "qwen2.5-0.5b-q4km");
        let fa = f["answer"].as_str().unwrap(); assert!(fa.contains("z-image-turbo (image") && !fa.contains("z-image-turbo-nvidia") && !fa.contains("- qwen3"), "{fa}");
        let w = quote_answer("where are my models stored?", &notes, &st, &cat, "GPU", false, "/secret/home", "qwen2.5-0.5b-q4km");
        assert!(!w["answer"].as_str().unwrap().contains("/secret"));
        let st4 = json!({ "packs": { "qwen2.5-0.5b-q4km": { "bytes": 1 }, "qwen3-4b-instruct-2507": { "bytes": 2 } } });
        // the chat model is installed but not running: start it (not install it)
        assert!(quote_answer("hello", &notes, &st4, &cat, "GPU", true, "/h", "qwen2.5-0.5b-q4km")["hint"].as_str().unwrap_or("").contains("`sushila start qwen3-4b-instruct-2507`"));
    }
    #[test] fn helper_without_a_model() {
        // installed: a chat model and an image pack; running: only the image pack (no language model answers)
        let st = json!({ "packs": { "qwen3-4b-instruct-2507": { "id": "qwen3-4b-instruct-2507", "name": "Qwen3 4B", "kind": "text", "bytes": 2500000000u64 },
                                    "z-image-turbo-nvidia": { "id": "z-image-turbo-nvidia", "name": "Z-Image-Turbo NVIDIA", "kind": "image", "bytes": 12000000000u64 } },
                         "running": { "z-image-turbo-nvidia": { "name": "Z-Image-Turbo NVIDIA", "mode": "turbo", "ready": true } }, "engine": { "version": "0.1.1", "key": "windows-x86_64-cuda" } });
        let cat = json!({ "packs": [] });
        let f = |q: &str| facts_answer(q, &st, &cat, "GPU line", true, "/h").unwrap_or_default();
        let list = f("list all the models installed");
        assert!(list.contains("Installed model packs (2)") && list.contains("qwen3-4b-instruct-2507") && list.contains("z-image-turbo-nvidia") && list.contains("running (Accelerated)"), "{list}");
        assert!(f("what is running now?").contains("Running now:") && f("which model is running").contains("Z-Image-Turbo NVIDIA"));
        assert!(f("where are my pictures saved?").contains("saved in") && f("what gpu do i have").contains("GPU line"));
        assert!(facts_answer("how do I add a coding model?", &st, &cat, "g", true, "/h").is_none(), "a how-to question goes to the notes, not the facts");
        assert!(running_chat(&st).is_none());
        let h = fuller_hint(&st, &cat).unwrap();
        assert!(h.contains("`sushila start qwen3-4b-instruct-2507`") && h.contains("this stops Z-Image-Turbo NVIDIA"), "{h}");
        let i = intent_answer("how do I make a picture of a cat?", &st, 7874).unwrap();
        assert!(i.contains("z-image-turbo-nvidia") && i.contains("http://localhost:7874/"), "{i}");
        assert!(intent_answer("make me a song", &st, 7874).unwrap().contains("sushila install ace-step-15"));
        assert!(intent_answer("make a video", &st, 7874).unwrap().contains("need a video pack") && intent_answer("draw an image", &json!({}), 1).unwrap().contains("need an image pack"));
        assert!(quote_sections("why is the sky blue?").is_empty(), "off-topic: nothing quoted");
        assert!(!quote_sections("I forgot the admin password").is_empty());
        // with the chat model running and ready, it answers (no hint)
        let mut st2 = st.clone(); st2["running"] = json!({ "qwen3-4b-instruct-2507": { "ready": true, "mode": "regular" } });
        assert_eq!(running_chat(&st2).as_deref(), Some("qwen3-4b-instruct-2507")); assert!(fuller_hint(&st2, &cat).is_none());
    }
    #[test] fn trims() { let t = "alpha one\nbeta two\npassword reset here\ngamma\ndelta"; assert!(trim_to("password", t, 25).contains("password reset here")); assert_eq!(trim_to("x", "short", 100), "short"); }
    #[test] fn picks_largest_running_chat_model() {
        let st = json!({ "packs": { "a": { "kind": "text", "bytes": 1 }, "b-coder": { "kind": "text", "bytes": 9 }, "c": { "kind": "text", "bytes": 5 }, "img": { "kind": "image", "bytes": 99 } }, "running": {} });
        assert_eq!(pick_model(&st, 0.0).as_deref(), Some("c"));
        let st2 = json!({ "packs": st["packs"], "running": { "a": {} } });
        assert_eq!(pick_model(&st2, 0.0).as_deref(), Some("a"));
    }
}

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
    let h = h.replace("</tr>", "\n").replace("</li>", "\n").replace("</p>", "\n").replace("<br>", "\n").replace("</pre>", "\n").replace("</td><td>", " : ").replace("</th><th>", " : ");
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

/// This computer's GPUs and memory, looked up once per server process.
async fn probe(dir: &std::path::Path) -> &'static (Option<Value>, Option<String>, Value) {
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
    let model = pick_model(&st, mem).or_else(|| st["packs"].get(crate::core::DEFAULT_MODEL).map(|_| crate::core::DEFAULT_MODEL.to_string()))
        .ok_or("no text model is installed (install one on the Admin tab, e.g. qwen2.5-0.5b-q4km)")?;
    let st2 = crate::webserver::start_and_wait(dir, &model, 300).await.ok_or(format!("{model} did not start; see the Admin tab, Logs"))?;
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
    Ok(json!({ "answer": a, "model": model, "sources": notes.iter().map(|s| json!({ "title": s.title, "source": s.source })).collect::<Vec<_>>() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn notes_and_docs_split() {
        let s = sections();
        assert!(s.iter().any(|x| x.title == "Standard and Accelerated" && x.source == "notes"));
        assert!(s.iter().any(|x| x.source == "documentation" && x.title.starts_with("Admin password")));
        assert!(s.iter().all(|x| x.text.len() <= 1500 || x.source == "notes"));
    }
    #[test] fn retrieval_finds_the_right_section() {
        let top = |q: &str| retrieve(q, 6000).into_iter().map(|s| s.title).collect::<Vec<_>>();
        assert!(top("I forgot the admin password").iter().take(3).any(|t| t.contains("Admin")), "{:?}", top("I forgot the admin password"));
        assert!(top("what does Accelerated do?").iter().take(2).any(|t| t.contains("Accelerated")));
        assert!(top("where are my models stored?").iter().take(3).any(|t| t.contains("home folder") || t.contains("Files and folders") || t.contains("model-packs")));
    }
    #[test] fn strips_tags() { assert_eq!(strip_tags("<tr><td><code>a &lt;b&gt;</code></td><td>x</td></tr>").trim(), "a <b> : x"); }
    #[test] fn picks_largest_running_chat_model() {
        let st = json!({ "packs": { "a": { "kind": "text", "bytes": 1 }, "b-coder": { "kind": "text", "bytes": 9 }, "c": { "kind": "text", "bytes": 5 }, "img": { "kind": "image", "bytes": 99 } }, "running": {} });
        assert_eq!(pick_model(&st, 0.0).as_deref(), Some("c"));
        let st2 = json!({ "packs": st["packs"], "running": { "a": {} } });
        assert_eq!(pick_model(&st2, 0.0).as_deref(), Some("a"));
    }
}

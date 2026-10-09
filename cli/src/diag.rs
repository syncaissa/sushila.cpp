// Why did a model fail? When a model stops, loses a job or does not answer, Sushila looks for the reason itself instead
// of passing on the raw error: GPU memory and the programs using the GPU, system memory, disk space, the model's own
// log (known error patterns) and how often it crashed lately. The result is a verdict in words and what to do about
// it; the page shows it (GET /api/diagnose?pack=<id>), the terminal prints its first line when a model stops.
use serde_json::{json, Value};
use std::path::Path;

/// Known lines in an engine's log and what they mean.
const PATTERNS: [(&[&str], &str, &str); 7] = [
    (&["out of memory", "cudamalloc", "cuda error 2", "failed to allocate", "outofmemoryerror", "cudaerrormemoryallocation", "not enough memory"],
     "gpu-memory", "ran out of GPU memory"),
    (&["no space left", "disk full", "there is not enough space"], "disk", "the disk is full"),
    (&["cannot allocate memory", "memoryerror", "bad_alloc", "std::bad_alloc"], "ram", "ran out of system memory (RAM)"),
    (&["no such file", "cannot find the file", "failed to open", "file not found", "unable to open"], "file", "a file it needs is missing or cannot be read"),
    (&["invalid magic", "corrupt", "checksum", "unexpected end of file", "failed to load model", "invalid gguf"], "damaged", "a model file looks damaged"),
    (&["access is denied", "permission denied"], "access", "it was not allowed to open a file or folder"),
    (&["cuda driver version is insufficient", "no cuda-capable device", "cudaerrorinsufficientdriver", "driver"], "driver", "the GPU driver is too old or not working"),
];

/// GPU numbers and the programs using it (nvidia-smi); None without an NVIDIA GPU.
pub fn gpu() -> Option<Value> {
    let q = |args: &[&str]| crate::util::output_within("nvidia-smi", args, 8);
    let line = q(&["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"])?;
    let f: Vec<&str> = line.lines().next()?.split(',').map(str::trim).collect();
    let n = |i: usize| f.get(i).and_then(|x| x.parse::<f64>().ok()).map(|m| (m / 1024.0 * 10.0).round() / 10.0);
    // programs with GPU work (on Windows the memory column often reads N/A; the names are still useful)
    let apps: Vec<String> = q(&["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"]).unwrap_or_default().lines()
        .filter_map(|l| { let c: Vec<&str> = l.split(',').map(str::trim).collect();
            let name = c.get(1)?.rsplit(['\\', '/']).next()?.to_string();
            // inside some containers the name is hidden
            let name = if name.starts_with('[') || name.is_empty() { "another program".to_string() } else { name };
            Some(match c.get(2).and_then(|m| m.parse::<f64>().ok()) { Some(m) => format!("{name} ({:.1} GB)", m / 1024.0), None => name }) })
        .collect();
    Some(json!({ "name": f.first(), "totalGB": n(1), "usedGB": n(2), "programs": apps }))
}

/// Minutes since an ISO time ("2026-10-08T04:44:38Z"), from the clock (large if it cannot be read).
fn minutes_since(t: &str) -> f64 {
    let p = |a: usize, b: usize| t.get(a..b).and_then(|x| x.parse::<i64>().ok());
    let (Some(y), Some(mo), Some(d), Some(h), Some(mi), Some(se)) = (p(0, 4), p(5, 7), p(8, 10), p(11, 13), p(14, 16), p(17, 19)) else { return 1e9 };
    // days from the civil date (Howard Hinnant's algorithm), then seconds
    let (y2, m2) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = y2.div_euclid(400); let yoe = y2 - era * 400; let doy = (153 * m2 + 2) / 5 + d - 1; let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let secs = (era * 146097 + doe - 719468) * 86400 + h * 3600 + mi * 60 + se;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    (now - secs) as f64 / 60.0
}

/// The diagnosis of one pack: { verdict, kind, facts: [...], advice: [...] }.
pub fn diagnose(data: &Path, pack: &str) -> Value {
    let st = crate::webserver::read_state(data);
    let name = st["packs"][pack]["name"].as_str().unwrap_or(pack).to_string();
    let mut facts: Vec<String> = vec![];
    let mut advice: Vec<String> = vec![];
    let mut kind = "unknown";
    let mut verdict = String::new();

    // the model's own log: its last run (each start begins with "----- start"); if it crashed in the last 10 minutes and
    // was restarted, the run before too (the restarted one is clean, the reason is in the one that stopped)
    let log = std::fs::read_to_string(data.join("logs").join(format!("{pack}.log"))).unwrap_or_default();
    let crashes: Vec<Value> = std::fs::read_to_string(data.join("crashes.json")).ok().and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok()).unwrap_or_default();
    let mine: Vec<&Value> = crashes.iter().filter(|c| c["pack"] == pack).collect();
    let recent = mine.last().and_then(|c| c["time"].as_str()).map(|t| minutes_since(t) < 10.0).unwrap_or(false);
    let runs: Vec<&str> = log.rsplit("----- start ").take(if recent { 2 } else { 1 }).collect();
    let run = runs.join("\n").to_lowercase();
    for (words, k, what) in PATTERNS {
        if words.iter().any(|w| run.contains(w)) { kind = k; verdict = format!("{name} {what}"); break; }
    }
    let last: Vec<String> = log.rsplit("----- start ").next().unwrap_or("").lines().skip(1).filter(|l| !l.trim().is_empty())
        .collect::<Vec<_>>().into_iter().rev().take(3).map(|l| l.chars().take(200).collect()).collect::<Vec<_>>().into_iter().rev().collect();

    // the machine now
    let g = gpu();
    if let Some(g) = &g {
        let (t, u) = (g["totalGB"].as_f64().unwrap_or(0.0), g["usedGB"].as_f64().unwrap_or(0.0));
        facts.push(format!("GPU: {} with {:.1} of {:.1} GB free", g["name"].as_str().unwrap_or("NVIDIA GPU"), (t - u).max(0.0), t));
        let others: Vec<String> = g["programs"].as_array().map(|a| a.iter().filter_map(|p| p.as_str().map(String::from)).collect()).unwrap_or_default();
        if !others.is_empty() { facts.push(format!("Programs using the GPU now: {}", others.join(", "))); }
        if kind == "unknown" && t > 0.0 && (t - u) < 1.0 { kind = "gpu-memory"; verdict = format!("{name} probably ran out of GPU memory (less than 1 GB free now)"); }
    }
    let mut sys = sysinfo::System::new(); sys.refresh_memory();
    let (ram_t, ram_f) = (sys.total_memory() as f64 / 1e9, sys.available_memory() as f64 / 1e9);
    facts.push(format!("Memory (RAM): {ram_f:.1} of {ram_t:.1} GB free"));
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let home = std::fs::canonicalize(data).unwrap_or(data.to_path_buf());
    let disk_free = disks.list().iter().filter(|d| home.starts_with(d.mount_point())).max_by_key(|d| d.mount_point().as_os_str().len()).map(|d| d.available_space() as f64 / 1e9);
    if let Some(f) = disk_free { facts.push(format!("Disk with the home folder: {f:.1} GB free")); }
    if kind == "unknown" && ram_f < 1.0 { kind = "ram"; verdict = format!("{name} probably ran out of system memory (RAM): {ram_f:.1} GB free"); }
    if kind == "unknown" && disk_free.map(|f| f < 1.0).unwrap_or(false) { kind = "disk"; verdict = format!("the disk is almost full ({:.1} GB free)", disk_free.unwrap_or(0.0)); }

    // its state and recent crashes
    let r = &st["running"][pack];
    facts.push(if r.is_object() { format!("{name} is {} now", if r["ready"] == true { "running again" } else { "starting" }) } else { format!("{name} is not running now") });
    if let Some(c) = mine.last() { facts.push(format!("Its last stop: {} ({}); {} kept in total", c["reason"].as_str().unwrap_or("?"), c["time"].as_str().unwrap_or("").replace('T', " ").chars().take(19).collect::<String>(), mine.len())); }
    if !last.is_empty() { facts.push(format!("Its last log lines: {}", last.join(" | "))); }

    // what to do
    match kind {
        "gpu-memory" => {
            advice.push("Close other programs that use the GPU (games, video editors, browsers with many tabs), then try again.".into());
            advice.push("Make less at once: a smaller picture size, fewer pictures, or a shorter song or video.".into());
            if g.as_ref().and_then(|g| g["totalGB"].as_f64()).map(|t| t < 12.0).unwrap_or(false) { advice.push("On a GPU with less than 12 GB, the smaller packs and Standard mode are the safe choice.".into()); }
        }
        "ram" => advice.push("Close other programs to free system memory, or choose a smaller pack.".into()),
        "disk" => advice.push(format!("Free disk space: `sushila clean` removes leftovers; `sushila du` shows what each pack uses (home folder: {}).", data.display())),
        "file" | "damaged" => advice.push(format!("Check and repair the pack: `sushila verify`, then `sushila remove {pack}` and `sushila install {pack}` if a file is reported.")),
        "access" => advice.push("Another program (often an antivirus) may be blocking the file; allow the Sushila home folder, or restart the computer.".into()),
        "driver" => advice.push("Update the graphics driver (NVIDIA: GeForce Experience or nvidia.com/drivers), then `sushila selftest`.".into()),
        _ => advice.push("Try again; if it happens again, `sushila report` collects the details (no secrets) for a bug report.".into()),
    }
    if verdict.is_empty() { verdict = format!("{name} stopped; no clear reason in its log"); }
    json!({ "pack": pack, "name": name, "kind": kind, "verdict": verdict, "facts": facts, "advice": advice })
}

/// The diagnosis in one line, for the terminal and the log.
pub fn one_line(d: &Value) -> String {
    let facts: Vec<&str> = d["facts"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).filter(|f| f.starts_with("GPU") || f.starts_with("Memory") || f.starts_with("Programs")).collect()).unwrap_or_default();
    format!("{} ({}). {}", d["verdict"].as_str().unwrap_or(""), facts.join("; "), d["advice"].as_array().and_then(|a| a.first()).and_then(|x| x.as_str()).unwrap_or(""))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn reads_the_log() {
        let dir = std::env::temp_dir().join(format!("sushila-diag-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("state.json"), r#"{"packs":{"ace":{"name":"ACE-Step"}},"running":{}}"#).unwrap();
        std::fs::write(dir.join("logs").join("ace.log"), "----- start A\nall fine\n----- start B\nloading\nggml_cuda: cudaMalloc failed: out of memory\n").unwrap();
        let d = diagnose(&dir, "ace");
        assert_eq!(d["kind"], "gpu-memory"); assert!(d["verdict"].as_str().unwrap().starts_with("ACE-Step ran out of GPU memory"));
        assert!(d["advice"][0].as_str().unwrap().contains("Close other programs"));
        assert!(d["facts"].as_array().unwrap().iter().any(|f| f.as_str().unwrap().contains("is not running now")));
        // an earlier run's error does not count, unless that run crashed in the last 10 minutes (then it was restarted)
        std::fs::write(dir.join("logs").join("ace.log"), "----- start A\nout of memory\n----- start B\nfine\n").unwrap();
        assert_ne!(diagnose(&dir, "ace")["kind"], "gpu-memory");
        std::fs::write(dir.join("crashes.json"), format!(r#"[{{"pack":"ace","time":"{}","reason":"exit code 1"}}]"#, crate::util::now_iso())).unwrap();
        assert_eq!(diagnose(&dir, "ace")["kind"], "gpu-memory");
        assert!(minutes_since("2000-01-01T00:00:00Z") > 1e6 && minutes_since(&crate::util::now_iso()) < 1.0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// The Host Station logic without a window: state.json (shared with the desktop app), the signed catalog, the engine for
// this computer's GPU, model packs, and starting models. Ported from worker_sushila_host.js; the same rules everywhere.
use std::{collections::HashMap, path::{Path, PathBuf}, process::Stdio, sync::Arc, time::Duration};
use serde_json::{json, Value};
use tokio::{io::{AsyncBufReadExt, BufReader}, sync::Mutex};
use crate::util::*;

pub const CATALOG_URL: &str = "https://sushila.ai/hoststation/catalog.json";
pub const SIGNING_KEYS: [&str; 1] = ["Z1PIla052/oI3aZmZvsgB/V3lZUrqnjEoJEeYv4OwTs="];
pub const DEFAULT_MODEL: &str = "qwen2.5-0.5b-q4km";
const PACK_EXT: [&str; 7] = [".gguf", ".safetensors", ".json", ".mclp", ".mclk", ".txt", ".md"];

/// The data folder: the same one the desktop app uses (ai.sushila.hoststation), so packs installed with either show up
/// in both. SUSHILA_HOME or --data-dir chooses another (e.g. /var/lib/sushila on a server).
pub fn default_data_dir() -> PathBuf {
    if let Ok(h) = std::env::var("SUSHILA_HOME") { if !h.is_empty() { return PathBuf::from(h); } }
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("ai.sushila.hoststation")
}

pub struct Ctx {
    pub data: PathBuf,
    /// The model-packs folder: one folder per pack (see packs_dir_for).
    pub packs_dir: PathBuf,
    pub state: Value,
    pub catalog: Option<Value>,
    pub info: Value,
    gpu: Option<Option<Value>>,
    other_gpu: Option<Option<String>>,
    pub quiet: bool,
    pub procs: Arc<Mutex<HashMap<String, tokio::process::Child>>>,
}

/// Every action, from any client, goes to one file: <data>/logs/sushila.log ("<time> [source] message").
pub static LOG_FILE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
pub static SOURCE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
pub fn log(quiet: bool, line: &str) {
    if !quiet { eprintln!("[{}] {line}", &now_iso()[11..19]); }
    if let Some(p) = LOG_FILE.get() {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            let _ = writeln!(f, "{} [{}] {}", now_iso(), SOURCE.get().map(|s| s.as_str()).unwrap_or("cli"), line.replace('\n', " | "));
        }
    }
}

impl Ctx {
    pub fn load(data: PathBuf, quiet: bool) -> Result<Ctx, String> {
        std::fs::create_dir_all(&data).map_err(|e| format!("cannot use the data folder {}: {e}", data.display()))?;
        let raw = std::fs::read_to_string(data.join("state.json")).ok();
        let mut s: Value = raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or(json!({}));
        if !s.is_object() { s = json!({}); }
        let defaults = json!({ "catalogUrl": CATALOG_URL, "port": 8765, "enginePort": 8766, "threads": 0, "contextSize": 4096, "gpuLayers": -1,
                               "scope": "user", "parallel": 0, "keepCopy": true });
        let mut settings = defaults.as_object().unwrap().clone();
        if let Some(o) = s.get("settings").and_then(|x| x.as_object()) { for (k, v) in o { settings.insert(k.clone(), v.clone()); } }
        if settings.get("gpuLayers").and_then(|v| v.as_i64()) == Some(99) { settings.insert("gpuLayers".into(), json!(-1)); }
        if settings.get("settingsVersion").is_none() {  // 1 was the old default: now 0 = choose the parallel slots from the hardware
            if settings.get("parallel").and_then(|v| v.as_i64()) == Some(1) { settings.insert("parallel".into(), json!(0)); }
            settings.insert("settingsVersion".into(), json!(2));
        }
        s["settings"] = Value::Object(settings);
        if !s["packs"].is_object() { s["packs"] = json!({}); }
        if !s["share"].is_object() { s["share"] = json!({ "enabled": false, "bind": "0.0.0.0", "hosts": [], "keys": [], "perMinute": 30 }); }
        if s["token"].as_str().map(|t| t.is_empty()).unwrap_or(true) { s["token"] = json!(random_token()); }
        if !s["running"].is_object() { s["running"] = json!({}); }
        let _ = std::fs::create_dir_all(data.join("logs")); let _ = LOG_FILE.set(data.join("logs").join("sushila.log"));
        let packs_dir = packs_dir_for(&data);
        let _ = std::fs::create_dir_all(&packs_dir);
        // earlier installs kept packs in <data>/packs/: move them into the model-packs folder (same disk: a rename)
        let old = data.join("packs");
        if old.is_dir() && packs_dir == data.join("model-packs") {
            for e in std::fs::read_dir(&old).into_iter().flatten().flatten() {
                let to = packs_dir.join(e.file_name());
                if !to.exists() && std::fs::rename(e.path(), &to).is_ok() {
                    let id = e.file_name().to_string_lossy().to_string();
                    if s["packs"][&id].is_object() { s["packs"][&id]["dir"] = json!(to.to_string_lossy()); if !to.join("sushila-pack.json").exists() { write_pack_meta(&to, &s["packs"][&id], None); } }
                }
            }
            let _ = std::fs::remove_dir(&old);
            let _ = std::fs::write(data.join("state.json"), serde_json::to_string_pretty(&s).unwrap_or_default());  // the new folders, at once
        }
        Ok(Ctx { data, packs_dir, state: s, catalog: None, info: host_info(), gpu: None, other_gpu: None, quiet, procs: Arc::new(Mutex::new(HashMap::new())) })
    }
    pub fn log(&self, line: &str) { log(self.quiet, line) }
    pub fn setting(&self, k: &str) -> Value { self.state["settings"][k].clone() }
    pub fn packs(&self) -> &serde_json::Map<String, Value> { self.state["packs"].as_object().unwrap() }

    /// state.json with its "public" part (what the web page may see), written atomically.
    pub fn save(&mut self) -> Result<(), String> {
        let running: Vec<Value> = self.state["running"].as_object().map(|m| m.iter().map(|(id, r)| {
            let p = &self.state["packs"][id];
            json!({ "packId": id, "name": r["name"], "kind": r.get("kind").cloned().unwrap_or(json!("text")), "startedAt": r["startedAt"],
                    "mode": r.get("mode").cloned().unwrap_or(json!("regular")), "turbo": can_turbo(p), "ready": r["ready"].as_bool().unwrap_or(false),
                    "request": if r["mode"] == "turbo" { turbo_request(p).unwrap_or(Value::Null) } else { Value::Null } })
        }).collect()).unwrap_or_default();
        let packs: Vec<Value> = self.packs().values().map(|p| json!({ "id": p["id"], "name": p["name"], "kind": p.get("kind").cloned().unwrap_or(json!("text")), "turbo": can_turbo(p) })).collect();
        let engine = self.state.get("engine").filter(|e| e.is_object()).map(|e| json!({ "version": e["version"], "source": e["source"] })).unwrap_or(Value::Null);
        let tasks = self.state.get("tasks").cloned().unwrap_or(json!([]));
        let owner = self.state.get("owner").cloned().unwrap_or(Value::Null);
        let packs: Vec<Value> = packs.into_iter().map(|mut p| { let id = p["id"].as_str().unwrap_or("").to_string(); p["bytes"] = self.state["packs"][&id]["bytes"].clone(); p }).collect();
        let s = &self.state["settings"];
        let settings = json!({ "port": s["port"], "enginePort": s["enginePort"], "threads": s["threads"], "contextSize": s["contextSize"], "gpuLayers": s["gpuLayers"], "parallel": s["parallel"] });
        let sh = &self.state["share"];
        let share = json!({ "enabled": sh["enabled"], "open": sh["open"], "keys": sh["keys"].as_array().map(|a| a.len()).unwrap_or(0) });
        self.state["public"] = json!({ "app": "sushila", "appVersion": env!("CARGO_PKG_VERSION"), "engine": engine, "running": running, "packs": packs,
                                       "tasks": tasks, "owner": owner, "gpu": self.state["engine"]["key"].as_str().map(Self::gpu_label), "settings": settings, "share": share,
                                       "engineKey": self.state["engine"]["key"], "fallback": self.state["engineFallback"],
                                       "packsDir": self.packs_dir.to_string_lossy(), "packProblems": self.state.get("packProblems").cloned().unwrap_or(json!([])) });
        let tmp = self.data.join("state.json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&self.state).map_err(err)?).map_err(err)?;
        std::fs::rename(&tmp, self.data.join("state.json")).map_err(err)
    }

    pub fn platform_key(&self) -> String {
        let os = match self.info["os"].as_str() { Some("macos") => "macos", Some("windows") => "windows", _ => "linux" };
        let arch = if self.info["arch"] == "aarch64" { "aarch64" } else { "x86_64" };
        format!("{os}-{arch}")
    }


    pub async fn load_catalog(&mut self) -> Result<&Value, String> {
        if self.catalog.is_none() {
            let url = self.setting("catalogUrl").as_str().unwrap_or(CATALOG_URL).to_string();
            let text = http_text(&url, 30).await.map_err(|e| format!("could not reach the catalog at {url} ({e}); installed packs keep working offline"))?;
            self.catalog = Some(serde_json::from_str(&text).map_err(|e| format!("the catalog is not valid JSON: {e}"))?);
        }
        Ok(self.catalog.as_ref().unwrap())
    }
    fn catalog_pack(&self, id: &str) -> Option<Value> {
        self.catalog.as_ref()?.get("packs")?.as_array()?.iter().find(|p| p["id"] == id).cloned()
    }

    /// The catalog as the page shows it: every pack with size, kind, license, whether it fits and is installed.
    pub async fn write_catalog_cache(&mut self) -> Result<(), String> {
        self.load_catalog().await?;
        let packs = self.catalog.as_ref().unwrap()["packs"].as_array().cloned().unwrap_or_default();
        let mut rows = vec![];
        for p in packs.iter().filter(|p| p["hidden"] != true) {
            let fits = self.pack_fits(p).await;
            let bytes: u64 = p["files"].as_array().map(|a| a.iter().map(|f| f["bytes"].as_u64().unwrap_or(0)).sum()).unwrap_or(0);
            rows.push(json!({ "id": p["id"], "name": p["name"], "kind": p.get("kind").cloned().unwrap_or(json!("text")), "category": p["category"], "bytes": bytes, "fits": fits,
                              "license": p["license"], "variantOf": p["variantOf"], "minRamGB": p["minRamGB"], "description": p["description"] }));
        }
        let v = json!({ "updated": now_iso(), "engineVersion": self.catalog.as_ref().unwrap()["engine"]["version"], "packs": rows });
        std::fs::write(self.data.join("catalog-cache.json"), serde_json::to_string(&v).map_err(err)?).map_err(err)
    }

    // ---------- GPUs
    /// The NVIDIA GPU: {name, compute (8.9 = RTX 4090), memoryGB}, or None.
    pub async fn nvidia_gpu(&mut self) -> Option<Value> {
        if let Some(g) = &self.gpu { return g.clone(); }
        let q = |fields: &'static str| async move {
            let r = run_capture("nvidia-smi", &[&format!("--query-gpu={fields}"), "--format=csv,noheader,nounits"], 15).await?;
            let out = r["stdout"].as_str().unwrap_or("").trim().to_string();
            if r["code"] != 0 || out.is_empty() { return None; }
            Some(out.lines().next().unwrap_or("").split(',').map(|x| x.trim().to_string()).collect::<Vec<_>>())
        };
        let full = q("name,compute_cap,memory.total").await;
        let name = match &full { Some(f) => Some(f.clone()), None => q("name").await };
        let g = name.map(|n| json!({ "vendor": "nvidia", "name": n[0],
            "compute": full.as_ref().and_then(|f| f.get(1)).and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0),
            "memoryGB": full.as_ref().and_then(|f| f.get(2)).and_then(|x| x.parse::<f64>().ok()).map(|m| (m / 1024.0).round()).unwrap_or(0.0) }));
        self.gpu = Some(g.clone());
        g
    }
    /// AMD Radeon or Intel Arc/Iris/Xe (the Vulkan build).
    pub async fn other_gpu(&mut self) -> Option<String> {
        if let Some(g) = &self.other_gpu { return g.clone(); }
        let names = match self.info["os"].as_str() {
            Some("windows") => run_capture("powershell", &["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"], 20).await
                .filter(|r| r["code"] == 0).map(|r| r["stdout"].as_str().unwrap_or("").to_string()).unwrap_or_default(),
            Some("linux") => run_capture("lspci", &[], 10).await.filter(|r| r["code"] == 0)
                .map(|r| r["stdout"].as_str().unwrap_or("").lines().filter(|l| l.contains("VGA") || l.contains("3D") || l.contains("Display")).collect::<Vec<_>>().join("\n")).unwrap_or_default(),
            _ => String::new(),
        };
        let hit = names.lines().find(|l| { let u = l.to_lowercase(); u.contains("amd") || u.contains("radeon") || (u.contains("intel") && (u.contains("arc") || u.contains("iris") || u.contains("xe"))) })
            .map(|l| l.trim().to_string());
        self.other_gpu = Some(hit.clone());
        hit
    }
    pub fn gpu_label(key: &str) -> &'static str {
        if key.ends_with("-cuda") { "NVIDIA GPU (CUDA)" } else if key.ends_with("-vulkan") { "GPU (Vulkan)" } else if key.starts_with("macos-aarch64") { "Apple GPU (Metal)" } else { "CPU" }
    }

    // ---------- engine (Sushila.cpp)
    fn builds(&self) -> serde_json::Map<String, Value> {
        self.catalog.as_ref().and_then(|c| c["engine"]["builds"].as_object().cloned()).unwrap_or_default()
    }
    /// The build for this computer's GPU: NVIDIA -> CUDA (else Vulkan), AMD/Intel -> Vulkan, Apple silicon -> Metal, else CPU.
    pub async fn engine_key(&mut self) -> String {
        let (pk, builds) = (self.platform_key(), self.builds());
        let nv = self.nvidia_gpu().await.is_some();
        if nv && builds.contains_key(&format!("{pk}-cuda")) { return format!("{pk}-cuda"); }
        if nv && builds.contains_key(&format!("{pk}-vulkan")) { return format!("{pk}-vulkan"); }
        if self.other_gpu().await.is_some() && builds.contains_key(&format!("{pk}-vulkan")) { return format!("{pk}-vulkan"); }
        pk
    }
    pub fn fallback_key(&self, key: &str) -> Option<String> {
        let (pk, builds) = (self.platform_key(), self.builds());
        if key.ends_with("-cuda") && builds.contains_key(&format!("{pk}-vulkan")) { return Some(format!("{pk}-vulkan")); }
        if (key.ends_with("-cuda") || key.ends_with("-vulkan")) && builds.contains_key(&pk) { return Some(pk); }
        None
    }
    pub fn signed_index(&self, idx: &Value, what: &str) -> Result<Value, String> {
        let (Some(text), Some(sig)) = (idx["text"].as_str(), idx["signature"].as_str()) else { return Err(format!("{what} is not signed by Sushila; refusing to install it.")) };
        if SIGNING_KEYS.iter().any(|k| verify_signature(k, text, sig)) { return serde_json::from_str(text).map_err(err); }
        Err(format!("{what}: the Sushila signature does not match; the download may have been tampered with. Nothing was installed."))
    }
    pub fn engine_ok(&self) -> bool {
        self.state["engine"]["server"].as_str().map(|s| Path::new(s).exists()).unwrap_or(false)
    }
    /// Checks the signed build list and returns what to download (None: already installed).
    pub async fn prepare_engine(&mut self, force: Option<String>) -> Result<Option<EnginePlan>, String> {
        self.load_catalog().await?;
        let key = match force { Some(k) => k, None => self.engine_key().await };
        let builds = self.builds();
        let build = builds.get(&key).cloned().ok_or_else(|| format!("No Sushila.cpp build is published for {key} yet. Builds: {}", builds.keys().cloned().collect::<Vec<_>>().join(", ")))?;
        let cat_engine = self.catalog.as_ref().unwrap()["engine"].clone();
        let index = self.signed_index(&cat_engine["index"], &format!("Sushila.cpp {}", cat_engine["version"].as_str().unwrap_or("")))?;
        let v = index["version"].as_str().unwrap_or("").to_string();
        let r = &index["builds"][&key];
        if r.is_null() || r["sha256"] != build["sha256"] || build["sha256"].as_str().unwrap_or("").is_empty() { return Err("This build does not match the signed list of Sushila.cpp builds; refusing to install it.".into()); }
        let server_rel = build["server"].as_str().unwrap_or("").to_string();
        let url = build["url"].as_str().unwrap_or("").to_string();
        if !safe_rel_path(&server_rel) || !crate::net::allowed_url(&reqwest::Url::parse(&url).map_err(err)?, false) { return Err("The build entry is not valid or not from an allowed source.".into()); }
        if self.state["engine"]["version"] == v.as_str() && self.state["engine"]["key"] == key.as_str() && self.engine_ok() {
            self.log(&format!("Sushila.cpp {v} ({key}) is already installed")); return Ok(None);
        }
        Ok(Some(EnginePlan { staging: self.data.join("downloads").join(format!("sushila-cpp-{v}-{key}.{}", build["archive"].as_str().unwrap_or("zip"))),
            dir: self.data.join("engine").join(&v), key, version: v, url, build, server_rel, quiet: self.quiet }))
    }
    /// Downloads and unpacks (no state is touched: safe to run in the background).
    pub async fn fetch_engine(p: &EnginePlan, prog: Option<&Prog>) -> Result<(), String> {
        log(p.quiet, &format!("installing Sushila.cpp {} for {} ({})", p.version, Self::gpu_label(&p.key), p.key));
        download_p(&p.url, &p.staging, p.build["sha256"].as_str(), p.build["bytes"].as_u64(), &format!("Sushila.cpp {}", p.version), p.quiet, prog).await?;
        extract_archive(&p.staging, &p.dir).await?;
        std::fs::write(p.dir.join("sushila-engine.json"), json!({ "version": p.version, "key": p.key, "sha256": p.build["sha256"], "server": p.server_rel, "servers": p.build["servers"] }).to_string()).map_err(err)?;
        let _ = std::fs::remove_file(&p.staging);
        Ok(())
    }
    /// Records the installed engine in state.json.
    pub fn apply_engine(&mut self, p: &EnginePlan) -> Result<(), String> {
        let server = join_rel(&p.dir, &p.server_rel);
        set_executable(&server);
        let mut servers = json!({ "text": server.to_string_lossy() });
        for k in ["image", "music"] {
            if let Some(rel) = p.build["servers"][k].as_str().filter(|r| safe_rel_path(r)) { let x = join_rel(&p.dir, rel); set_executable(&x); servers[k] = json!(x.to_string_lossy()); }
        }
        self.state["engine"] = json!({ "version": p.version, "key": p.key, "server": server.to_string_lossy(), "servers": servers, "dir": p.dir.to_string_lossy(), "source": "installed by sushila", "installedAt": now_iso() });
        self.save()?;
        self.log(&format!("Sushila.cpp {} ({}) installed in {}", p.version, Self::gpu_label(&p.key), p.dir.display()));
        Ok(())
    }
    /// Installs Sushila.cpp for this computer (or the given build, e.g. linux-x86_64 for the CPU build).
    pub async fn install_engine(&mut self, force: Option<String>) -> Result<(), String> {
        if let Some(p) = self.prepare_engine(force).await? { Self::fetch_engine(&p, None).await?; self.apply_engine(&p)?; }
        Ok(())
    }

    // ---------- packs
    pub async fn pack_fits(&mut self, p: &Value) -> bool {
        let r = &p["requires"];
        if r.is_null() { return true; }
        if r["gpu"] == "nvidia" {
            let Some(g) = self.nvidia_gpu().await else { return false };
            let c = g["compute"].as_f64().unwrap_or(0.0);
            if c == 0.0 { return false; }
            if r["minCompute"].as_f64().map(|m| c < m).unwrap_or(false) || r["maxCompute"].as_f64().map(|m| c > m).unwrap_or(false) { return false; }
            let rt = self.catalog.as_ref().map(|c| c["runtimes"]["image-nunchaku"]["builds"][format!("{}-cuda", self.platform_key())].is_object()).unwrap_or(false);
            if p["serve"]["engine"] == "image-nunchaku" && !rt { return false; }
        }
        true
    }
    /// The variant made for this computer's GPU (e.g. z-image-turbo-nvidia) if one fits, else the pack itself.
    pub async fn best_variant(&mut self, id: &str) -> String {
        let packs = self.catalog.as_ref().and_then(|c| c["packs"].as_array().cloned()).unwrap_or_default();
        for p in packs.iter().filter(|p| p["variantOf"] == id) { if self.pack_fits(p).await { return p["id"].as_str().unwrap_or(id).to_string(); } }
        id.to_string()
    }
    fn check_pack(&self, pack: &Value) -> Result<(), String> {
        let name = pack["name"].as_str().unwrap_or("pack");
        let index = self.signed_index(&pack["index"], name)?;
        let listed: HashMap<String, Value> = index["files"].as_array().map(|a| a.iter().map(|f| (f["path"].as_str().unwrap_or("").to_string(), f.clone())).collect()).unwrap_or_default();
        let files = pack["files"].as_array().ok_or(format!("{name}: no files"))?;
        for f in files {
            let path = f["path"].as_str().unwrap_or("");
            if !safe_rel_path(path) { return Err(format!("{name}: unsafe file path {path}")); }
            if !PACK_EXT.iter().any(|e| path.to_lowercase().ends_with(e)) { return Err(format!("{name}: {path} is not a data file; packs may only contain model data.")); }
            let r = listed.get(f["src"].as_str().unwrap_or(""));
            if r.map(|r| r["sha256"] != f["sha256"] || r["bytes"] != f["bytes"]).unwrap_or(true) { return Err(format!("{name}: {path} does not match the signed index.")); }
            let ok = reqwest::Url::parse(f["url"].as_str().unwrap_or("")).map(|u| crate::net::allowed_url(&u, false)).unwrap_or(false);
            if !ok { return Err(format!("{name}: {path} comes from a source sushila does not download from.")); }
        }
        let model = pack["serve"]["model"].as_str().unwrap_or("");
        if !safe_rel_path(model) || !files.iter().any(|f| f["path"] == model) { return Err(format!("{name}: the model file is not part of the pack.")); }
        let args: Vec<&Value> = pack["serve"]["args"].as_array().into_iter().flatten().chain(pack["serve"]["turboArgs"].as_array().into_iter().flatten()).collect();
        for a in args {
            let a = a.as_str().unwrap_or("");
            if !pack_arg_ok(a, files) { return Err(format!("{name}: engine option {a} is not allowed in a pack")); }
        }
        if let Some(e) = pack["serve"]["engine"].as_str() { if !["text", "image", "image-nunchaku", "music"].contains(&e) { return Err(format!("{name}: unknown engine {e}")); } }
        Ok(())
    }
    fn pack_record(&self, pack: &Value, dir: &Path, source: Option<&str>) -> Value {
        let files: Vec<Value> = pack["files"].as_array().map(|a| a.iter().map(|f| json!({ "path": f["path"], "sha256": f["sha256"], "bytes": f["bytes"], "role": f["role"] })).collect()).unwrap_or_default();
        let bytes: u64 = pack["files"].as_array().map(|a| a.iter().map(|f| f["bytes"].as_u64().unwrap_or(0)).sum()).unwrap_or(0);
        let mut r = json!({ "id": pack["id"], "name": pack["name"], "kind": pack.get("kind").cloned().unwrap_or(json!("text")), "engine": pack["serve"].get("engine").cloned().unwrap_or(json!("text")),
            "bytes": bytes, "dir": dir.to_string_lossy(), "model": pack["serve"]["model"], "args": pack["serve"].get("args").cloned().unwrap_or(json!([])),
            "turboArgs": pack["serve"].get("turboArgs").cloned().unwrap_or(json!([])), "turboRequest": pack["serve"].get("turboRequest").cloned().unwrap_or(Value::Null),
            "files": files, "license": pack["license"], "scope": "user", "installedAt": now_iso(), "artifacts": pack.get("artifacts").cloned().unwrap_or(json!([])) });
        if let Some(s) = source { r["source"] = json!(s); }
        r
    }
    /// Checks a catalog pack against its signed index and this computer; returns what to download (None: installed).
    pub async fn prepare_pack(&mut self, id: &str) -> Result<Option<PackPlan>, String> {
        if self.packs().contains_key(id) { self.log(&format!("{id} is already installed")); return Ok(None); }
        self.load_catalog().await?;
        let pack = self.catalog_pack(id).ok_or_else(|| format!("{id} is not in the catalog (sushila packs lists them)"))?;
        self.check_pack(&pack)?;
        if !self.pack_fits(&pack).await { return Err(format!("{} needs a matching NVIDIA GPU; install {} instead.", pack["name"].as_str().unwrap_or(id), pack["variantOf"].as_str().unwrap_or("another pack"))); }
        Ok(Some(PackPlan { id: id.to_string(), dir: self.packs_dir.join(format!(".installing-{id}")), final_dir: self.packs_dir.join(id), pack, quiet: self.quiet }))
    }
    /// Downloads every file of the pack, each checked against its sha256 (no state touched).
    pub async fn fetch_pack(p: &PackPlan, prog: Option<&Prog>) -> Result<(), String> {
        let files = p.pack["files"].as_array().cloned().unwrap_or_default();
        let total: u64 = files.iter().map(|f| f["bytes"].as_u64().unwrap_or(0)).sum();
        log(p.quiet, &format!("installing {} ({}, {} files)", p.pack["name"].as_str().unwrap_or(&p.id), human(total), files.len()));
        for (i, f) in files.iter().enumerate() {
            let dest = join_rel(&p.dir, f["path"].as_str().unwrap_or(""));
            if dest.exists() && file_sha256(&dest).await.ok().as_deref() == f["sha256"].as_str() { continue; }
            let label = format!("{}: file {} of {} ({})", p.id, i + 1, files.len(), f["path"].as_str().unwrap_or("").rsplit('/').next().unwrap_or(""));
            download_p(f["url"].as_str().unwrap_or(""), &dest, f["sha256"].as_str(), f["bytes"].as_u64(), &label, p.quiet, prog).await?;
        }
        Ok(())
    }
    pub fn apply_pack(&mut self, p: &PackPlan) -> Result<(), String> {
        write_pack_meta(&p.dir, &p.pack, Some(&p.pack["index"]));
        if p.final_dir.exists() { std::fs::remove_dir_all(&p.final_dir).map_err(err)?; }
        std::fs::rename(&p.dir, &p.final_dir).map_err(err)?;
        let rec = self.pack_record(&p.pack, &p.final_dir, None);
        self.state["packs"][&p.id] = rec;
        self.save()?;
        self.log(&format!("{} installed", p.pack["name"].as_str().unwrap_or(&p.id)));
        Ok(())
    }
    /// Installs a pack from the catalog (download straight into the data folder, every file checked).
    pub async fn install_pack(&mut self, id: &str) -> Result<(), String> {
        if !self.engine_ok() { self.install_engine(None).await?; }
        let Some(p) = self.prepare_pack(id).await? else { return Ok(()) };
        if p.pack["serve"]["engine"] == "image-nunchaku" && !self.state["runtimes"]["image-nunchaku"].is_object() { self.install_runtime("image-nunchaku").await?; }
        Self::fetch_pack(&p, None).await?;
        self.apply_pack(&p)
    }
    /// Installs a .sushilapack file (from a USB drive, another computer, the website): signed index and every sha256 checked.
    pub async fn install_pack_file(&mut self, path: &Path) -> Result<String, String> {
        let staging = self.data.join("staging").join(format!("pack-{}", &random_token()[..8]));
        let res = async {
            extract_archive(path, &staging).await?;
            // a zip of the pack's folder: the pack is the one folder inside
            let mut root = staging.clone();
            if !root.join("sushila-pack.json").exists() {
                let subs: Vec<PathBuf> = std::fs::read_dir(&staging).map(|d| d.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default();
                if subs.len() == 1 && subs[0].join("sushila-pack.json").exists() { root = subs[0].clone(); }
            }
            let staging = root;
            let raw = std::fs::read_to_string(staging.join("sushila-pack.json")).map_err(|_| "This file is not a Sushila model pack.".to_string())?;
            let meta: Value = serde_json::from_str(&raw).map_err(err)?;
            let name = meta["name"].as_str().unwrap_or("pack").to_string();
            let index = self.signed_index(&meta["index"], &name)?;
            let listed: HashMap<String, Value> = index["files"].as_array().map(|a| a.iter().map(|f| (f["path"].as_str().unwrap_or("").to_string(), f.clone())).collect()).unwrap_or_default();
            for f in meta["files"].as_array().cloned().unwrap_or_default() {
                let p = f["path"].as_str().unwrap_or("");
                if !safe_rel_path(p) || !PACK_EXT.iter().any(|e| p.to_lowercase().ends_with(e)) { return Err(format!("{name}: {p} is not an allowed data file.")); }
                let r = listed.get(f["src"].as_str().unwrap_or(""));
                if r.map(|r| r["sha256"] != f["sha256"] || r["bytes"] != f["bytes"]).unwrap_or(true) { return Err(format!("{name}: {p} does not match the signed index.")); }
                let got = file_sha256(&join_rel(&staging, p)).await.unwrap_or_else(|_| "missing".into());
                if Some(got.as_str()) != f["sha256"].as_str() { return Err(format!("{name}: {p} is {}; nothing was installed.", if got == "missing" { "missing" } else { "damaged or changed" })); }
            }
            let model = meta["serve"]["model"].as_str().unwrap_or("");
            if !safe_rel_path(model) || !meta["files"].as_array().map(|a| a.iter().any(|f| f["path"] == model)).unwrap_or(false) { return Err(format!("{name}: the model file is not part of the pack.")); }
            let id = meta["id"].as_str().unwrap_or("").to_string();
            if !safe_id_dots(&id) { return Err("the pack id is not valid".into()); }
            let dir = self.packs_dir.join(&id);
            if dir.exists() { std::fs::remove_dir_all(&dir).map_err(err)?; }
            if let Some(d) = dir.parent() { std::fs::create_dir_all(d).map_err(err)?; }
            std::fs::rename(&staging, &dir).map_err(err)?;
            let rec = self.pack_record(&meta, &dir, Some(&path.to_string_lossy()));
            self.state["packs"][&id] = rec;
            self.save()?;
            Ok(id)
        }.await;
        let _ = std::fs::remove_dir_all(&staging);
        res
    }
    /// The NVIDIA image runtime (Python 3.11 + PyTorch + Nunchaku + the Sushila image server), signed, every file checked.
    pub async fn install_runtime(&mut self, name: &str) -> Result<(), String> {
        let cat = self.catalog.as_ref().map(|c| c["runtimes"][name].clone()).unwrap_or(Value::Null);
        let key = format!("{}-cuda", self.platform_key());
        let build = cat["builds"][&key].clone();
        if !build.is_object() { return Err(format!("The {name} runtime is not published for {key}.")); }
        let index = self.signed_index(&cat["index"], &format!("Sushila runtime {name}"))?;
        let r = index["builds"][&key].clone();
        if !r.is_object() { return Err(format!("The signed list of {name} runtimes has no build for {key}.")); }
        let all = |b: &Value| -> Vec<Value> { let mut v = vec![b["python"].clone(), b["server"].clone()]; v.extend(b["wheels"].as_array().cloned().unwrap_or_default()); v };
        let listed: HashMap<String, Value> = all(&r).into_iter().map(|f| (f["path"].as_str().unwrap_or("").to_string(), f)).collect();
        for f in all(&build) {
            let ok = listed.get(f["path"].as_str().unwrap_or("")).map(|x| x["sha256"] == f["sha256"] && x["bytes"] == f["bytes"]).unwrap_or(false)
                && safe_rel_path(f["path"].as_str().unwrap_or("")) && reqwest::Url::parse(f["url"].as_str().unwrap_or("")).map(|u| crate::net::allowed_url(&u, false)).unwrap_or(false);
            if !ok { return Err(format!("{} does not match the signed runtime list; refusing to install it.", f["path"])); }
        }
        let exe_rel = r["python"]["exe"].as_str().unwrap_or("");
        let script = r["server"]["script"].as_str().unwrap_or("");
        if !safe_rel_path(exe_rel) || !script.ends_with(".py") || script.contains('/') { return Err("The runtime entry is not valid.".into()); }
        let v = index["version"].as_str().unwrap_or("0").to_string();
        let dir = self.data.join("runtime").join(name).join(&v);
        let dl = self.data.join("downloads");
        self.log(&format!("installing the {name} runtime {v} (once)"));
        for (part, sub) in [("python", None), ("server", Some("server"))] {
            let f = &build[part];
            let file = dl.join(f["path"].as_str().unwrap_or("x").rsplit('/').next().unwrap_or("x"));
            download(f["url"].as_str().unwrap_or(""), &file, f["sha256"].as_str(), f["bytes"].as_u64(), part, self.quiet).await?;
            extract_archive(&file, &match sub { Some(s) => dir.join(s), None => dir.clone() }).await?;
            let _ = std::fs::remove_file(&file);
        }
        let mut wheels = vec![];
        for w in build["wheels"].as_array().cloned().unwrap_or_default() {
            let dest = dir.join("wheels").join(w["path"].as_str().unwrap_or("x").rsplit('/').next().unwrap_or("x"));
            download(w["url"].as_str().unwrap_or(""), &dest, w["sha256"].as_str(), w["bytes"].as_u64(), "wheel", self.quiet).await?;
            wheels.push(dest.to_string_lossy().to_string());
        }
        let exe = join_rel(&dir, exe_rel);
        set_executable(&exe);
        let exe_s = exe.to_string_lossy().to_string();
        let mut args: Vec<&str> = vec!["-m", "pip", "install", "--no-index", "--no-deps", "--no-warn-script-location", "--disable-pip-version-check"];
        args.extend(wheels.iter().map(|s| s.as_str()));
        let r1 = run_capture(&exe_s, &args, 3600).await.ok_or("the runtime's Python did not start")?;
        if r1["code"] != 0 { return Err(format!("The image runtime did not install: {}", r1["stderr"].as_str().unwrap_or("").chars().rev().take(400).collect::<String>().chars().rev().collect::<String>())); }
        let _ = std::fs::remove_dir_all(dir.join("wheels"));
        let t = run_capture(&exe_s, &["-c", "import torch, nunchaku; print(torch.cuda.is_available())"], 300).await.ok_or("the runtime's Python did not start")?;
        if t["code"] != 0 || !t["stdout"].as_str().unwrap_or("").contains("True") { return Err("The image runtime is installed, but PyTorch cannot use the NVIDIA GPU. Update the NVIDIA driver (570 or newer) and try again.".into()); }
        self.state["runtimes"][name] = json!({ "version": v, "python": exe_s, "script": dir.join("server").join(script).to_string_lossy(), "dir": dir.to_string_lossy(), "installedAt": now_iso() });
        self.save()
    }
    pub fn verify_pack(&self, id: &str) -> Result<Vec<String>, String> {
        let p = self.packs().get(id).ok_or(format!("{id} is not installed"))?;
        let dir = PathBuf::from(p["dir"].as_str().unwrap_or(""));
        let mut bad = vec![];
        for f in p["files"].as_array().cloned().unwrap_or_default() {
            let path = join_rel(&dir, f["path"].as_str().unwrap_or(""));
            let got = if path.exists() { sha256_of(&path).unwrap_or_default() } else { "missing".into() };
            if Some(got.as_str()) != f["sha256"].as_str() { bad.push(format!("{} ({})", f["path"].as_str().unwrap_or(""), if got == "missing" { "missing" } else { "changed" })); }
        }
        Ok(bad)
    }
    pub fn remove_pack(&mut self, id: &str) -> Result<(), String> {
        let p = self.packs().get(id).cloned().ok_or(format!("{id} is not installed"))?;
        if self.state["running"][id].is_object() { return Err(format!("{id} is running: stop it first (sushila stop)")); }
        let dir = PathBuf::from(p["dir"].as_str().unwrap_or(""));
        if dir.exists() { std::fs::remove_dir_all(&dir).map_err(|e| format!("could not remove {} ({e}){}", dir.display(), if p["scope"] == "all" { "; it was installed for all users: run this as administrator" } else { "" }))?; }
        self.state["packs"].as_object_mut().unwrap().remove(id);
        self.save()
    }

    // ---------- run models
    fn free_port(&self) -> u16 {
        let used: Vec<u64> = self.state["running"].as_object().map(|m| m.values().filter_map(|r| r["port"].as_u64()).collect()).unwrap_or_default();
        let mut p = self.setting("enginePort").as_u64().unwrap_or(8766);
        while used.contains(&p) || p == self.setting("port").as_u64().unwrap_or(8765) || std::net::TcpListener::bind(("127.0.0.1", p as u16)).is_err() { p += 1; }
        p as u16
    }
    /// How many requests a text model serves at once (continuous batching): from the GPU memory left after the model,
    /// each slot needing its own key-value cache (about 0.35 GB plus 2.5% of the model's size per 4,096 tokens), 1-16.
    /// CPU: 2 (batching helps a little there too). settings.parallel > 0 overrides it.
    async fn auto_slots(&mut self, p: &Value) -> u64 {
        let fixed = self.setting("parallel").as_u64().unwrap_or(0);
        if fixed > 0 { return fixed; }
        let key = self.state["engine"]["key"].as_str().map(String::from).unwrap_or_else(|| self.platform_key());
        let model_gb = p["bytes"].as_f64().unwrap_or(0.0) / 1e9;
        let ctx = self.setting("contextSize").as_f64().unwrap_or(4096.0);
        let per_slot = (0.35 + 0.025 * model_gb) * ctx / 4096.0;
        let free = if key.ends_with("-cuda") {
            self.nvidia_gpu().await.map(|g| g["memoryGB"].as_f64().unwrap_or(0.0)).unwrap_or(0.0) - model_gb * 1.1 - 1.5
        } else if key.starts_with("macos-aarch64") {
            self.info["memory_bytes"].as_f64().unwrap_or(0.0) / 1e9 * 0.65 - model_gb * 1.1
        } else if key.ends_with("-vulkan") { 2.0 * per_slot } else { return 2 };
        ((free / per_slot).floor() as i64).clamp(1, 16) as u64
    }
    async fn gpu_room_for(&mut self, p: &Value) -> bool {
        let key = self.state["engine"]["key"].as_str().map(String::from).unwrap_or_else(|| self.platform_key());
        let bytes = p["bytes"].as_f64().unwrap_or(0.0);
        if key.starts_with("macos-aarch64") { return self.info["memory_bytes"].as_f64().unwrap_or(0.0) >= bytes * 1.5 + 6e9; }
        if !key.ends_with("-cuda") { return false; }
        self.nvidia_gpu().await.map(|g| g["memoryGB"].as_f64().unwrap_or(0.0) * 1e9 >= bytes * 1.25 + 3e9).unwrap_or(false)
    }
    /// Starts a model and waits until it answers (GPU first; if the GPU engine cannot load it, the next build:
    /// CUDA -> Vulkan -> CPU).
    pub async fn start_model(&mut self, id: &str, mode: Option<&str>) -> Result<u16, String> {
        let r = match self.spawn_model(id, mode).await {
            Ok(s) if s.already => return Ok(s.port),
            Ok(s) => match wait_ready(self.procs.clone(), &s).await { Ok(()) => { self.model_ready(id)?; Ok(s.port) } Err(e) => { self.model_failed(id).await; Err(e) } },
            Err(e) => Err(e),
        };
        match r {
            Ok(p) => Ok(p),
            Err(e) => {
                let Some(next) = self.fallback_for(id, &e).await else { return Err(e) };
                self.install_engine(Some(next)).await?;
                Box::pin(self.start_model(id, mode)).await
            }
        }
    }
    /// After a model stopped while loading on a GPU engine: the next build to try (and records the switch), else None.
    pub async fn fallback_for(&mut self, id: &str, e: &str) -> Option<String> {
        let key = self.state["engine"]["key"].as_str().unwrap_or("").to_string();
        let engine = self.packs().get(id).map(|p| p["engine"].clone()).unwrap_or(Value::Null);
        if !e.contains("stopped while loading") || engine == "image-nunchaku" { return None; }
        let _ = self.load_catalog().await;
        let next = self.fallback_key(&key)?;
        self.log(&format!("{id} could not start on the {} engine; switching to the {} engine", Self::gpu_label(&key), Self::gpu_label(&next)));
        self.state["engineFallback"] = json!({ "from": key, "to": next, "model": id, "at": now_iso() });
        let _ = self.save();
        Some(next)
    }
    pub fn model_ready(&mut self, id: &str) -> Result<(), String> {
        if self.state["running"][id].is_object() { self.state["running"][id]["ready"] = json!(true); self.save()?; }
        self.log(&format!("{id} is ready on port {}", self.state["running"][id]["port"]));
        Ok(())
    }
    pub async fn model_failed(&mut self, id: &str) {
        self.procs.lock().await.remove(id);
        if let Some(m) = self.state["running"].as_object_mut() { m.remove(id); }
        let _ = self.save();
    }
    /// Starts the model's engine process and records it as running (not yet ready). Returns how to check readiness.
    pub async fn spawn_model(&mut self, id: &str, mode: Option<&str>) -> Result<Spawned, String> {
        if !self.engine_ok() { return Err("Sushila.cpp is not installed: run `sushila engine install`".into()); }
        let p = self.packs().get(id).cloned().ok_or(format!("{id} is not installed: run `sushila install {id}`"))?;
        if let Some(port) = self.state["running"][id]["port"].as_u64() { return Ok(Spawned { id: id.into(), port: port as u16, health: String::new(), log: PathBuf::new(), already: true }); }
        let mode = mode.map(String::from).unwrap_or_else(|| if can_turbo(&p) { "turbo".into() } else { "regular".into() });
        let port = self.free_port();
        let cpus = self.info["cpus"].as_u64().unwrap_or(2);
        let threads = self.setting("threads").as_u64().filter(|t| *t > 0).unwrap_or_else(|| (cpus.saturating_sub(1)).clamp(1, 16));
        let dir = PathBuf::from(p["dir"].as_str().unwrap_or(""));
        let mut pack_args: Vec<String> = p["args"].as_array().into_iter().flatten().chain(if mode == "turbo" { p["turboArgs"].as_array() } else { None }.into_iter().flatten())
            .filter_map(|a| a.as_str()).map(|a| match a.strip_prefix("{pack}/") { Some(r) => join_rel(&dir, r).to_string_lossy().to_string(), None => a.to_string() }).collect();
        let engine = p["engine"].as_str().unwrap_or("text").to_string();
        if engine == "image" && pack_args.iter().any(|a| a == "--offload-to-cpu") && self.gpu_room_for(&p).await {
            pack_args.retain(|a| a != "--offload-to-cpu");
            self.log(&format!("{id}: the GPU has room for the whole model, so it stays on the GPU"));
        }
        let rt = self.state["runtimes"]["image-nunchaku"].clone();
        let servers = self.state["engine"]["servers"].clone();
        let slots = if engine == "text" { self.auto_slots(&p).await } else { 1 };
        let (program, args): (String, Vec<String>) = match engine.as_str() {
            "image-nunchaku" => {
                if !rt.is_object() { return Err(format!("{id} needs the NVIDIA image runtime: install the pack again to set it up")); }
                (rt["python"].as_str().unwrap_or("").into(), [vec![rt["script"].as_str().unwrap_or("").into(), "--host".into(), "127.0.0.1".into(), "--port".into(), port.to_string(), "--name".into(), id.into()], pack_args].concat())
            }
            "music" => (servers["music"].as_str().ok_or("this Sushila.cpp has no music engine: run `sushila engine install` to update it")?.into(),
                        [vec!["--models".into(), dir.to_string_lossy().into(), "--host".into(), "127.0.0.1".into(), "--port".into(), port.to_string(), "--keep-loaded".into()], pack_args].concat()),
            "image" => (servers["image"].as_str().ok_or("this Sushila.cpp has no image engine: run `sushila engine install` to update it")?.into(),
                        [vec!["--listen-ip".into(), "127.0.0.1".into(), "--listen-port".into(), port.to_string(), "-t".into(), threads.to_string()], pack_args].concat()),
            _ => {
                let ctx = self.setting("contextSize").as_u64().unwrap_or(4096); let par = slots;
                let ngl = self.setting("gpuLayers").as_i64().unwrap_or(-1);
                (self.state["engine"]["server"].as_str().unwrap_or("").into(),
                 [vec!["-m".into(), join_rel(&dir, p["model"].as_str().unwrap_or("")).to_string_lossy().into(), "--host".into(), "127.0.0.1".into(), "--port".into(), port.to_string(),
                       "-t".into(), threads.to_string(), "-c".into(), (ctx * par).to_string(), "-np".into(), par.to_string(), "-ngl".into(), if ngl < 0 { "auto".into() } else { ngl.to_string() }], pack_args].concat())
            }
        };
        let mut c = command(&program, &args);
        c.current_dir(&dir).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        if self.info["os"] == "linux" { if let Some(d) = self.state["engine"]["dir"].as_str() { c.env("LD_LIBRARY_PATH", d); } }
        if mode == "regular" { c.env("SUSHILA", "0"); }
        if engine == "image-nunchaku" { c.env("PYTHONNOUSERSITE", "1").env("PYTHONUNBUFFERED", "1").env("HF_HUB_OFFLINE", "1"); }
        self.log(&format!("starting {id} ({}, {slots} parallel slot{}) on port {port}: {program} {}", if mode == "turbo" { "Accelerated" } else { "Standard" }, if slots == 1 { "" } else { "s" }, args.join(" ")));
        let logs = self.data.join("logs"); let _ = std::fs::create_dir_all(&logs);
        let mut child = c.spawn().map_err(|e| format!("could not start {program}: {e}"))?;
        for pipe in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)].into_iter().flatten() {
            let (path, quiet, id2) = (logs.join(format!("{id}.log")), self.quiet, id.to_string());
            tokio::spawn(async move {
                let mut f = tokio::fs::OpenOptions::new().create(true).append(true).open(&path).await.ok();
                let mut lines = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(f) = f.as_mut() { use tokio::io::AsyncWriteExt; let _ = f.write_all(format!("{line}\n").as_bytes()).await; }
                    if let Some(i) = line.find("offloaded ") { if line.contains("layers to GPU") { log(quiet, &format!("{id2}: {}", &line[i..])); } }
                }
            });
        }
        let engine_pid = child.id().unwrap_or(0);
        self.procs.lock().await.insert(id.to_string(), child);
        self.state["running"][id] = json!({ "port": port, "name": p["name"], "kind": p.get("kind").cloned().unwrap_or(json!("text")), "startedAt": now_iso(), "ready": false, "mode": mode,
                                            "pid": std::process::id(), "enginePid": engine_pid, "slots": slots });
        self.save()?;
        let health = format!("http://127.0.0.1:{port}{}", if engine == "image" { "/" } else { "/health" });
        Ok(Spawned { id: id.to_string(), port, health, log: logs.join(format!("{id}.log")), already: false })
    }
    pub async fn stop_model(&mut self, id: &str) {
        if let Some(mut c) = self.procs.lock().await.remove(id) { let _ = c.kill().await; }
        if let Some(m) = self.state["running"].as_object_mut() { m.remove(id); }
        let _ = self.save();
    }
    pub async fn stop_all(&mut self) {
        let ids: Vec<String> = self.procs.lock().await.keys().cloned().collect();
        for id in ids { self.stop_model(&id).await; }
        self.state["running"] = json!({});
        let _ = self.save();
    }
}

/// Where model packs live: SUSHILA_PACKS (or --packs-dir); else a model-packs folder next to the sushila program, if
/// there is one (everything in one folder, e.g. on a USB drive); else <data folder>/model-packs.
pub fn packs_dir_for(data: &Path) -> PathBuf {
    if let Ok(p) = std::env::var("SUSHILA_PACKS") { if !p.is_empty() { return PathBuf::from(p); } }
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("model-packs"))) { if d.is_dir() { return d; } }
    data.join("model-packs")
}

/// sushila-pack.json in a pack's folder: everything needed to verify and run it (name, how to serve it, every file with
/// its sha256, and Sushila's signed index). A pack folder is self-describing: drop it into model-packs and it is found.
pub fn write_pack_meta(dir: &Path, pack: &Value, index: Option<&Value>) {
    let mut m = json!({ "id": pack["id"], "name": pack["name"], "kind": pack.get("kind").cloned().unwrap_or(json!("text")), "license": pack["license"],
        "category": pack["category"], "artifacts": pack.get("artifacts").cloned().unwrap_or(json!([])), "files": pack["files"] });
    m["serve"] = if pack["serve"].is_object() { pack["serve"].clone() } else {
        json!({ "engine": pack["engine"], "model": pack["model"], "args": pack["args"], "turboArgs": pack["turboArgs"], "turboRequest": pack["turboRequest"] }) };
    if let Some(i) = index.filter(|i| i.is_object()) { m["index"] = i.clone(); }
    let _ = std::fs::write(dir.join("sushila-pack.json"), serde_json::to_string_pretty(&m).unwrap_or_default());
}

/// What the model-packs folder holds compared with the installed list.
pub struct Scan { pub new: Vec<(String, PathBuf)>, pub gone: Vec<String>, pub moved: Vec<(String, PathBuf)>, pub problems: Vec<Value> }

/// sha256 of a file, remembered by (path, size, modification time) in <data>/verified.json so big packs are not read
/// again at every start; any change of size or time means reading it again.
pub fn sha256_cached(data: &Path, path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(err)?;
    let stamp = format!("{}:{}", meta.len(), meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0));
    let cp = data.join("verified.json");
    let mut cache: serde_json::Map<String, Value> = std::fs::read_to_string(&cp).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let key = path.to_string_lossy().to_string();
    if let Some(e) = cache.get(&key) { if e["stamp"] == stamp.as_str() { if let Some(s) = e["sha256"].as_str() { return Ok(s.to_string()); } } }
    let sha = sha256_of(path)?;
    let mut cache2: serde_json::Map<String, Value> = std::fs::read_to_string(&cp).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    cache2.insert(key, json!({ "stamp": stamp, "sha256": sha }));
    cache = cache2;
    let _ = std::fs::write(&cp, serde_json::to_string(&Value::Object(cache)).unwrap_or_default());
    Ok(sha)
}

/// Checks a pack folder that appeared in model-packs: Sushila's signature over its index, the files it lists, and every
/// file's sha256. Returns the pack's installed record. Runs without the state (in the background).
pub fn verify_pack_folder(data: &Path, dir: &Path, prog: Option<&Prog>) -> Result<Value, String> {
    let raw = std::fs::read_to_string(dir.join("sushila-pack.json")).map_err(|_| "no sushila-pack.json: not a Sushila model pack".to_string())?;
    let meta: Value = serde_json::from_str(&raw).map_err(|e| format!("sushila-pack.json is not valid: {e}"))?;
    let name = meta["name"].as_str().unwrap_or("pack").to_string();
    let id = meta["id"].as_str().unwrap_or("").to_string();
    if !safe_id_dots(&id) { return Err("the pack id in sushila-pack.json is not valid".into()); }
    let idx = &meta["index"];
    let (Some(text), Some(sig)) = (idx["text"].as_str(), idx["signature"].as_str()) else { return Err(format!("{name}: not signed by Sushila (no index in sushila-pack.json)")) };
    if !SIGNING_KEYS.iter().any(|k| verify_signature(k, text, sig)) { return Err(format!("{name}: the Sushila signature does not match")); }
    let index: Value = serde_json::from_str(text).map_err(err)?;
    let listed: HashMap<String, Value> = index["files"].as_array().map(|a| a.iter().map(|f| (f["path"].as_str().unwrap_or("").to_string(), f.clone())).collect()).unwrap_or_default();
    let files = meta["files"].as_array().cloned().unwrap_or_default();
    let total: u64 = files.iter().map(|f| f["bytes"].as_u64().unwrap_or(0)).sum();
    let mut done = 0u64;
    for f in &files {
        let p = f["path"].as_str().unwrap_or("");
        if !safe_rel_path(p) || !PACK_EXT.iter().any(|e| p.to_lowercase().ends_with(e)) { return Err(format!("{name}: {p} is not an allowed data file")); }
        let r = listed.get(f["src"].as_str().unwrap_or(""));
        if r.map(|r| r["sha256"] != f["sha256"] || r["bytes"] != f["bytes"]).unwrap_or(true) { return Err(format!("{name}: {p} is not in the signed index")); }
        if let Some(pg) = prog { if let Ok(mut g) = pg.lock() { *g = json!({ "label": format!("checking {id}: {p}"), "done": done, "total": total }); } }
        let path = join_rel(dir, p);
        if !path.exists() { return Err(format!("{name}: {p} is missing")); }
        let got = sha256_cached(data, &path)?;
        if Some(got.as_str()) != f["sha256"].as_str() { return Err(format!("{name}: {p} is damaged or changed")); }
        done += f["bytes"].as_u64().unwrap_or(0);
    }
    let model = meta["serve"]["model"].as_str().unwrap_or("");
    if !safe_rel_path(model) || !files.iter().any(|f| f["path"] == model) { return Err(format!("{name}: the model file is not part of the pack")); }
    // sushila-pack.json's run settings are not covered by the signature (only the files are): check them like the catalog's
    for a in meta["serve"]["args"].as_array().into_iter().flatten().chain(meta["serve"]["turboArgs"].as_array().into_iter().flatten()) {
        let a = a.as_str().unwrap_or("");
        if !pack_arg_ok(a, &files) { return Err(format!("{name}: engine option {a} is not allowed in a pack")); }
    }
    if let Some(e) = meta["serve"]["engine"].as_str() { if !["text", "image", "image-nunchaku", "music"].contains(&e) { return Err(format!("{name}: unknown engine {e}")); } }
    let rec_files: Vec<Value> = files.iter().map(|f| json!({ "path": f["path"], "sha256": f["sha256"], "bytes": f["bytes"], "role": f["role"] })).collect();
    Ok(json!({ "id": id, "name": meta["name"], "kind": meta.get("kind").cloned().unwrap_or(json!("text")), "engine": meta["serve"].get("engine").cloned().unwrap_or(json!("text")),
        "bytes": total, "dir": dir.to_string_lossy(), "model": model, "args": meta["serve"].get("args").cloned().unwrap_or(json!([])),
        "turboArgs": meta["serve"].get("turboArgs").cloned().unwrap_or(json!([])), "turboRequest": meta["serve"].get("turboRequest").cloned().unwrap_or(Value::Null),
        "files": rec_files, "license": meta["license"], "scope": "user", "installedAt": now_iso(), "artifacts": meta.get("artifacts").cloned().unwrap_or(json!([])), "source": "model-packs folder" }))
}

impl Ctx {
    /// Compares the model-packs folder with the installed list: folders not yet known (to verify), installed packs whose
    /// folder is gone, and folders that are not packs.
    pub fn scan_packs(&self) -> Scan {
        let mut sc = Scan { new: vec![], gone: vec![], moved: vec![], problems: vec![] };
        let known: HashMap<String, String> = self.packs().iter().map(|(id, p)| (p["dir"].as_str().unwrap_or("").to_string(), id.clone())).collect();
        for e in std::fs::read_dir(&self.packs_dir).into_iter().flatten().flatten() {
            let dir = e.path();
            if !dir.is_dir() || e.file_name().to_string_lossy().starts_with('.') { continue; }
            if known.contains_key(dir.to_string_lossy().as_ref()) { continue; }
            if !dir.join("sushila-pack.json").exists() {
                sc.problems.push(json!({ "folder": e.file_name().to_string_lossy(), "problem": "no sushila-pack.json: not a Sushila model pack (unzip the pack's file into its own folder)" }));
                continue;
            }
            let id = std::fs::read_to_string(dir.join("sushila-pack.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|m| m["id"].as_str().map(String::from)).unwrap_or_default();
            if self.packs().contains_key(&id) {
                // an installed pack whose recorded folder is gone, found here: it moved (renamed folder, older layout)
                if !Path::new(self.packs()[&id]["dir"].as_str().unwrap_or("")).exists() { sc.moved.push((id, dir)); continue; }
                sc.problems.push(json!({ "folder": e.file_name().to_string_lossy(), "problem": format!("{id} is already installed in another folder") }));
                continue;
            }
            sc.new.push((id, dir));
        }
        for (id, p) in self.packs() {
            let d = PathBuf::from(p["dir"].as_str().unwrap_or(""));
            if !d.exists() && !sc.moved.iter().any(|(m, _)| m == id) && (d.starts_with(&self.packs_dir) || d.parent().and_then(|p| p.file_name()).map(|n| n == "packs").unwrap_or(false)) { sc.gone.push(id.clone()); }
        }
        sc
    }
}

pub struct EnginePlan { pub key: String, pub version: String, pub url: String, pub build: Value, pub server_rel: String, pub staging: PathBuf, pub dir: PathBuf, pub quiet: bool }
pub struct Spawned { pub id: String, pub port: u16, pub health: String, pub log: PathBuf, pub already: bool }

/// Waits until a started model answers (up to 5 minutes), or reports why it stopped (the last lines of its log).
pub async fn wait_ready(procs: Arc<Mutex<HashMap<String, tokio::process::Child>>>, s: &Spawned) -> Result<(), String> {
    for _ in 0..600 {
        if http_text(&s.health, 3).await.is_ok() { return Ok(()); }
        let exited = { let mut g = procs.lock().await; g.get_mut(&s.id).map(|c| c.try_wait().ok().flatten().is_some()).unwrap_or(true) };
        if exited {
            let tail = std::fs::read_to_string(&s.log).unwrap_or_default();
            let tail: Vec<&str> = tail.lines().rev().take(8).collect();
            return Err(format!("{} stopped while loading; last lines of {}:\n  {}", s.id, s.log.display(), tail.into_iter().rev().collect::<Vec<_>>().join("\n  ")));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(format!("{} did not become ready within 5 minutes; see {}", s.id, s.log.display()))
}

/// dir: where the download goes (hidden until complete, so the folder scan never sees half a pack); final_dir: model-packs/<id>.
pub struct PackPlan { pub id: String, pub dir: PathBuf, pub final_dir: PathBuf, pub pack: Value, pub quiet: bool }

// ---------- crashes: <data>/crashes.json (newest last, at most 50), shown on the Admin tab (Logs)
pub fn record_crash(data: &Path, v: Value) {
    let p = data.join("crashes.json");
    let mut list: Vec<Value> = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    list.push(v);
    let n = list.len(); if n > 50 { list.drain(..n - 50); }
    let _ = std::fs::write(&p, serde_json::to_string_pretty(&list).unwrap_or_default());
}
/// The last n lines of a text file (e.g. a log), for crash reports.
pub fn tail_lines(p: &Path, n: usize) -> String {
    let t = std::fs::read(p).map(|b| { let s = b.len().saturating_sub(64 << 10); String::from_utf8_lossy(&b[s..]).to_string() }).unwrap_or_default();
    let l: Vec<&str> = t.lines().collect();
    l[l.len().saturating_sub(n)..].join("\n")
}
/// After the server died: stop the model engines it had started (they would keep their ports and GPU memory).
pub fn kill_orphans(data: &Path) -> Vec<String> {
    let st: Value = std::fs::read_to_string(data.join("state.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut killed = vec![];
    for (id, r) in st["running"].as_object().cloned().unwrap_or_default() {
        let Some(pid) = r["enginePid"].as_u64().filter(|p| *p > 0) else { continue };
        if let Some(pr) = sys.process(sysinfo::Pid::from_u32(pid as u32)) {
            let name = pr.name().to_string_lossy().to_lowercase();
            if ["sushila", "llama", "sd-server", "ace-server", "python"].iter().any(|k| name.contains(k)) && pr.kill() { killed.push(format!("{id} (pid {pid})")); }
        }
    }
    killed
}

/// Engine options a pack may set: short plain options, or {pack}/<file> naming one of its own files. Never options
/// that change where the engine listens or what it reads or writes outside the pack (the server sets those itself).
pub fn pack_arg_ok(a: &str, files: &[Value]) -> bool {
    if let Some(r) = a.strip_prefix("{pack}/") { return safe_rel_path(r) && files.iter().any(|f| f["path"] == r); }
    // plain values cannot contain '/' or '\\': a name can only mean something inside the pack's own folder (the engine's
    // working folder); "." and ".." are refused
    if a.is_empty() || a.len() > 64 || !a.chars().all(|c| c.is_ascii_alphanumeric() || "_.=:-".contains(c)) || a.split('=').any(|p| !p.is_empty() && p.chars().all(|c| c == '.')) { return false; }
    let flag = a.trim_start_matches('-').split('=').next().unwrap_or("").to_ascii_lowercase();
    !["host", "port", "listen", "rpc", "api-key", "api_key", "log", "save", "slot", "hf-", "url", "ssl", "webui", "public", "metrics"]
        .iter().any(|bad| flag.contains(bad))
}

pub fn safe_id_dots(id: &str) -> bool { !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_') }

/// The precomputed cache plan sent with each image/video request in Accelerated mode.
pub fn turbo_request(p: &Value) -> Option<Value> {
    let r = p.get("turboRequest")?.as_object()?;
    let mut out = serde_json::Map::new();
    for k in ["cache_mode", "cache_option", "scm_mask"] {
        if let Some(v) = r.get(k).and_then(|v| v.as_str()) { if !v.is_empty() && v.len() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric() || "_.=,:-".contains(c)) { out.insert(k.into(), json!(v)); } }
    }
    if out.is_empty() { None } else { Some(Value::Object(out)) }
}
pub fn can_turbo(p: &Value) -> bool {
    let e = p["engine"].as_str().unwrap_or("text");
    let n = |k: &str| p[k].as_array().map(|a| !a.is_empty()).unwrap_or(false);
    e == "image-nunchaku" || (e == "image" && turbo_request(p).is_some()) || (e == "music" && n("turboArgs")) || (e == "text" && (n("artifacts") || n("turboArgs")))
}

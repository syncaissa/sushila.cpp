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
    pub state: Value,
    pub catalog: Option<Value>,
    pub info: Value,
    gpu: Option<Option<Value>>,
    other_gpu: Option<Option<String>>,
    pub quiet: bool,
    pub procs: Arc<Mutex<HashMap<String, tokio::process::Child>>>,
}

pub fn log(quiet: bool, line: &str) { if !quiet { eprintln!("[{}] {line}", &now_iso()[11..19]); } }

impl Ctx {
    pub fn load(data: PathBuf, quiet: bool) -> Result<Ctx, String> {
        std::fs::create_dir_all(&data).map_err(|e| format!("cannot use the data folder {}: {e}", data.display()))?;
        let raw = std::fs::read_to_string(data.join("state.json")).ok();
        let mut s: Value = raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or(json!({}));
        if !s.is_object() { s = json!({}); }
        let defaults = json!({ "catalogUrl": CATALOG_URL, "port": 8765, "enginePort": 8766, "threads": 0, "contextSize": 4096, "gpuLayers": -1,
                               "scope": "user", "parallel": 1, "keepCopy": true });
        let mut settings = defaults.as_object().unwrap().clone();
        if let Some(o) = s.get("settings").and_then(|x| x.as_object()) { for (k, v) in o { settings.insert(k.clone(), v.clone()); } }
        if settings.get("gpuLayers").and_then(|v| v.as_i64()) == Some(99) { settings.insert("gpuLayers".into(), json!(-1)); }
        s["settings"] = Value::Object(settings);
        if !s["packs"].is_object() { s["packs"] = json!({}); }
        if !s["share"].is_object() { s["share"] = json!({ "enabled": false, "bind": "0.0.0.0", "hosts": [], "keys": [], "perMinute": 30 }); }
        if s["token"].as_str().map(|t| t.is_empty()).unwrap_or(true) { s["token"] = json!(random_token()); }
        if !s["running"].is_object() { s["running"] = json!({}); }
        Ok(Ctx { data, state: s, catalog: None, info: host_info(), gpu: None, other_gpu: None, quiet, procs: Arc::new(Mutex::new(HashMap::new())) })
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
        self.state["public"] = json!({ "app": "sushila (command line)", "appVersion": env!("CARGO_PKG_VERSION"), "engine": engine, "running": running, "packs": packs });
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
    /// Installs Sushila.cpp for this computer (or the given build, e.g. linux-x86_64 for the CPU build).
    pub async fn install_engine(&mut self, force: Option<String>) -> Result<(), String> {
        self.load_catalog().await?;
        let key = match force { Some(k) => k, None => self.engine_key().await };
        let builds = self.builds();
        let build = builds.get(&key).cloned().ok_or_else(|| format!("No Sushila.cpp build is published for {key} yet. Builds: {}", builds.keys().cloned().collect::<Vec<_>>().join(", ")))?;
        let cat_engine = self.catalog.as_ref().unwrap()["engine"].clone();
        let index = self.signed_index(&cat_engine["index"], &format!("Sushila.cpp {}", cat_engine["version"].as_str().unwrap_or("")))?;
        let v = index["version"].as_str().unwrap_or("").to_string();
        let r = &index["builds"][&key];
        if r.is_null() || r["sha256"] != build["sha256"] || build["sha256"].as_str().unwrap_or("").is_empty() { return Err("This build does not match the signed list of Sushila.cpp builds; refusing to install it.".into()); }
        let server_rel = build["server"].as_str().unwrap_or("");
        let url = build["url"].as_str().unwrap_or("");
        if !safe_rel_path(server_rel) || !crate::net::allowed_url(&reqwest::Url::parse(url).map_err(err)?, false) { return Err("The build entry is not valid or not from an allowed source.".into()); }
        if self.state["engine"]["version"] == v.as_str() && self.state["engine"]["key"] == key.as_str() && self.engine_ok() {
            self.log(&format!("Sushila.cpp {v} ({key}) is already installed")); return Ok(());
        }
        let staging = self.data.join("downloads").join(format!("sushila-cpp-{v}-{key}.{}", build["archive"].as_str().unwrap_or("zip")));
        self.log(&format!("installing Sushila.cpp {v} for {} ({key})", Self::gpu_label(&key)));
        download(url, &staging, build["sha256"].as_str(), build["bytes"].as_u64(), &format!("Sushila.cpp {v}"), self.quiet).await?;
        let dir = self.data.join("engine").join(&v);
        extract_archive(&staging, &dir).await?;
        std::fs::write(dir.join("sushila-engine.json"), json!({ "version": v, "key": key, "sha256": build["sha256"], "server": server_rel, "servers": build["servers"] }).to_string()).map_err(err)?;
        let server = join_rel(&dir, server_rel);
        set_executable(&server);
        let mut servers = json!({ "text": server.to_string_lossy() });
        for k in ["image", "music"] {
            if let Some(rel) = build["servers"][k].as_str().filter(|r| safe_rel_path(r)) { let p = join_rel(&dir, rel); set_executable(&p); servers[k] = json!(p.to_string_lossy()); }
        }
        self.state["engine"] = json!({ "version": v, "key": key, "server": server.to_string_lossy(), "servers": servers, "dir": dir.to_string_lossy(), "source": "installed by the sushila command", "installedAt": now_iso() });
        let _ = std::fs::remove_file(&staging);
        self.save()?;
        self.log(&format!("Sushila.cpp {v} installed in {}", dir.display()));
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
            let plain = !a.is_empty() && a.len() <= 64 && a.chars().all(|c| c.is_ascii_alphanumeric() || "_.=:-".contains(c));
            let packfile = a.strip_prefix("{pack}/").map(|r| safe_rel_path(r) && files.iter().any(|f| f["path"] == r)).unwrap_or(false);
            if !plain && !packfile { return Err(format!("{name}: unexpected engine option {a}")); }
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
    /// Installs a pack from the catalog (download straight into the data folder, every file checked).
    pub async fn install_pack(&mut self, id: &str) -> Result<(), String> {
        if !self.engine_ok() { self.install_engine(None).await?; }
        if self.packs().contains_key(id) { self.log(&format!("{id} is already installed")); return Ok(()); }
        self.load_catalog().await?;
        let pack = self.catalog_pack(id).ok_or_else(|| format!("{id} is not in the catalog (sushila packs lists them)"))?;
        self.check_pack(&pack)?;
        if !self.pack_fits(&pack).await { return Err(format!("{} needs a matching NVIDIA GPU; install {} instead.", pack["name"].as_str().unwrap_or(id), pack["variantOf"].as_str().unwrap_or("another pack"))); }
        if pack["serve"]["engine"] == "image-nunchaku" && !self.state["runtimes"]["image-nunchaku"].is_object() { self.install_runtime("image-nunchaku").await?; }
        let dir = self.data.join("packs").join(id);
        let files = pack["files"].as_array().cloned().unwrap_or_default();
        let total: u64 = files.iter().map(|f| f["bytes"].as_u64().unwrap_or(0)).sum();
        self.log(&format!("installing {} ({}, {} files)", pack["name"].as_str().unwrap_or(id), human(total), files.len()));
        for (i, f) in files.iter().enumerate() {
            let dest = join_rel(&dir, f["path"].as_str().unwrap_or(""));
            if dest.exists() && file_sha256(&dest).await.ok().as_deref() == f["sha256"].as_str() { continue; }
            let label = format!("file {} of {} ({})", i + 1, files.len(), f["path"].as_str().unwrap_or("").rsplit('/').next().unwrap_or(""));
            download(f["url"].as_str().unwrap_or(""), &dest, f["sha256"].as_str(), f["bytes"].as_u64(), &label, self.quiet).await?;
        }
        let rec = self.pack_record(&pack, &dir, None);
        self.state["packs"][id] = rec;
        self.save()?;
        self.log(&format!("{} installed", pack["name"].as_str().unwrap_or(id)));
        Ok(())
    }
    /// Installs a .sushilapack file (from a USB drive, another computer, the website): signed index and every sha256 checked.
    pub async fn install_pack_file(&mut self, path: &Path) -> Result<String, String> {
        let staging = self.data.join("staging").join(format!("pack-{}", &random_token()[..8]));
        let res = async {
            extract_archive(path, &staging).await?;
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
            let dir = self.data.join("packs").join(&id);
            let _ = std::fs::remove_file(staging.join("sushila-pack.json"));
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
    async fn gpu_room_for(&mut self, p: &Value) -> bool {
        let key = self.state["engine"]["key"].as_str().map(String::from).unwrap_or_else(|| self.platform_key());
        let bytes = p["bytes"].as_f64().unwrap_or(0.0);
        if key.starts_with("macos-aarch64") { return self.info["memory_bytes"].as_f64().unwrap_or(0.0) >= bytes * 1.5 + 6e9; }
        if !key.ends_with("-cuda") { return false; }
        self.nvidia_gpu().await.map(|g| g["memoryGB"].as_f64().unwrap_or(0.0) * 1e9 >= bytes * 1.25 + 3e9).unwrap_or(false)
    }
    /// Starts a model on its own port (GPU first; if the GPU engine cannot load it, the next build: CUDA -> Vulkan -> CPU).
    pub async fn start_model(&mut self, id: &str, mode: Option<&str>) -> Result<u16, String> {
        match self.start_model_once(id, mode).await {
            Ok(p) => Ok(p),
            Err(e) => {
                let key = self.state["engine"]["key"].as_str().unwrap_or("").to_string();
                let engine = self.packs().get(id).map(|p| p["engine"].clone()).unwrap_or(Value::Null);
                if !e.contains("stopped while loading") || engine == "image-nunchaku" { return Err(e); }
                let _ = self.load_catalog().await;
                let Some(next) = self.fallback_key(&key) else { return Err(e) };
                self.log(&format!("{id} could not start on the {} engine ({e}); switching to the {} engine", Self::gpu_label(&key), Self::gpu_label(&next)));
                self.stop_model(id).await;
                self.install_engine(Some(next.clone())).await?;
                self.state["engineFallback"] = json!({ "from": key, "to": next, "model": id, "at": now_iso() });
                self.save()?;
                Box::pin(self.start_model(id, mode)).await
            }
        }
    }
    async fn start_model_once(&mut self, id: &str, mode: Option<&str>) -> Result<u16, String> {
        if !self.engine_ok() { return Err("Sushila.cpp is not installed: run `sushila engine install`".into()); }
        let p = self.packs().get(id).cloned().ok_or(format!("{id} is not installed: run `sushila install {id}`"))?;
        if let Some(port) = self.state["running"][id]["port"].as_u64() { return Ok(port as u16); }
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
                let ctx = self.setting("contextSize").as_u64().unwrap_or(4096); let par = self.setting("parallel").as_u64().unwrap_or(1).max(1);
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
        self.log(&format!("starting {id} ({}) on port {port}: {program} {}", if mode == "turbo" { "Accelerated" } else { "Standard" }, args.join(" ")));
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
        self.procs.lock().await.insert(id.to_string(), child);
        self.state["running"][id] = json!({ "port": port, "name": p["name"], "kind": p.get("kind").cloned().unwrap_or(json!("text")), "startedAt": now_iso(), "ready": false, "mode": mode, "pid": std::process::id() });
        self.save()?;
        let health = format!("http://127.0.0.1:{port}{}", if engine == "image" { "/" } else { "/health" });
        for _ in 0..600 {
            if http_text(&health, 3).await.is_ok() {
                self.state["running"][id]["ready"] = json!(true); self.save()?;
                self.log(&format!("{id} is ready on port {port}"));
                return Ok(port);
            }
            let exited = { let mut g = self.procs.lock().await; g.get_mut(id).map(|c| c.try_wait().ok().flatten().is_some()).unwrap_or(true) };
            if exited {
                self.procs.lock().await.remove(id);
                self.state["running"].as_object_mut().unwrap().remove(id); self.save()?;
                let tail = std::fs::read_to_string(logs.join(format!("{id}.log"))).unwrap_or_default();
                let tail: Vec<&str> = tail.lines().rev().take(8).collect();
                return Err(format!("{id} stopped while loading; last lines of {}:\n  {}", logs.join(format!("{id}.log")).display(), tail.into_iter().rev().collect::<Vec<_>>().join("\n  ")));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Err(format!("{id} did not become ready within 5 minutes; see {}", logs.join(format!("{id}.log")).display()))
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

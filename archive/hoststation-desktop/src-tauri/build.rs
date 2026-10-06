// The whole application lives in ../worker_sushila_host.js. Copy it next to dist/index.html before Tauri embeds the
// frontend, so the desktop window and the local web server run the very same file.
fn main() {
    println!("cargo:rerun-if-changed=../worker_sushila_host.js");
    std::fs::create_dir_all("../dist").expect("create dist");
    std::fs::copy("../worker_sushila_host.js", "../dist/worker_sushila_host.js").expect("copy worker_sushila_host.js");
    // Products: every build carries all presets (Host Station, ImageGen, MusicGen, ChatGen, CodeGen are one app), and
    // SUSHILA_PRESET=presets/<key>.json names the one this installer is for (its first start and its window name).
    println!("cargo:rerun-if-env-changed=SUSHILA_PRESET");
    println!("cargo:rerun-if-changed=../presets");
    let mut all = serde_json::Map::new();
    let mut names: Vec<_> = std::fs::read_dir("../presets").expect("read presets/").flatten().map(|e| e.path()).collect();
    names.sort();
    for p in names {
        if p.extension().and_then(|x| x.to_str()) != Some("json") { continue; }
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).expect("read a preset")).expect("a preset is not valid JSON");
        let key = v["key"].as_str().expect("a preset needs a key").to_string();
        all.insert(key, v);
    }
    let own = match std::env::var("SUSHILA_PRESET") {
        Ok(p) if !p.is_empty() => {
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("../{p}")).expect("read the preset file")).expect("the preset is not valid JSON");
            serde_json::Value::String(v["key"].as_str().expect("the preset needs a key").to_string())
        }
        _ => serde_json::Value::Null,
    };
    let preset = format!("window.SUSHILA_PRESETS = {};\nwindow.SUSHILA_PRESET = window.SUSHILA_PRESETS[{}] || null;\n", serde_json::Value::Object(all), own);
    std::fs::write("../dist/preset.js", preset).expect("write dist/preset.js");
    tauri_build::build()
}

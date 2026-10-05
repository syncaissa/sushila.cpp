// The whole application lives in ../worker_sushila_host.js. Copy it next to dist/index.html before Tauri embeds the
// frontend, so the desktop window and the local web server run the very same file.
fn main() {
    println!("cargo:rerun-if-changed=../worker_sushila_host.js");
    std::fs::create_dir_all("../dist").expect("create dist");
    std::fs::copy("../worker_sushila_host.js", "../dist/worker_sushila_host.js").expect("copy worker_sushila_host.js");
    // a product flavor: SUSHILA_PRESET=presets/image-generator.json builds "Sushila Image Generator" (same app, first-start preset)
    println!("cargo:rerun-if-env-changed=SUSHILA_PRESET");
    let preset = match std::env::var("SUSHILA_PRESET") {
        Ok(p) if !p.is_empty() => {
            let json = std::fs::read_to_string(format!("../{p}")).expect("read the preset file");
            let v: serde_json::Value = serde_json::from_str(&json).expect("the preset is not valid JSON");
            format!("window.SUSHILA_PRESET = {};\n", v)
        }
        _ => "window.SUSHILA_PRESET = null;\n".to_string(),
    };
    std::fs::write("../dist/preset.js", preset).expect("write dist/preset.js");
    tauri_build::build()
}

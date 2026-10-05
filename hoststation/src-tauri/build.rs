// The whole application lives in ../worker_sushila_host.js. Copy it next to dist/index.html before Tauri embeds the
// frontend, so the desktop window and the local web server run the very same file.
fn main() {
    println!("cargo:rerun-if-changed=../worker_sushila_host.js");
    std::fs::create_dir_all("../dist").expect("create dist");
    std::fs::copy("../worker_sushila_host.js", "../dist/worker_sushila_host.js").expect("copy worker_sushila_host.js");
    tauri_build::build()
}

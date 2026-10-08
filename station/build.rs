// The Sushila engine (the `sushila` program) travels inside Sushila Station: SUSHILA_BIN names the binary built for
// the same platform (the CI builds it first). Its SHA-256 names the copy the app writes to disk, so a new Station
// brings its own engine version and never runs a file that was changed after it was written.
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=SUSHILA_BIN");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("sushila.bin");
    let (bytes, sha) = match std::env::var("SUSHILA_BIN") {
        Ok(p) if !p.is_empty() => {
            println!("cargo:rerun-if-changed={p}");
            let b = std::fs::read(&p).unwrap_or_else(|e| panic!("SUSHILA_BIN={p}: {e}"));
            let h = hex::encode(Sha256::digest(&b));
            (b, h)
        }
        _ => (Vec::new(), "none".to_string()),  // a development build: the app uses a `sushila` it finds on the computer
    };
    std::fs::write(&out, &bytes).unwrap();
    println!("cargo:rustc-env=SUSHILA_BIN_PATH={}", out.display());
    println!("cargo:rustc-env=SUSHILA_BIN_SHA={sha}");
    tauri_build::build()
}

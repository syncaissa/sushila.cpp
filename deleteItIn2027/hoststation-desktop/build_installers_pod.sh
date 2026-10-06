#!/usr/bin/env bash
# Host Station installers on a RunPod Linux pod (instead of GitHub Actions): every product (Host Station, ImageGen,
# MusicGen, ChatGen, CodeGen, VideoGen = one app with a different name and first-start preset) from one compile:
#   Linux: .deb, .rpm, .AppImage;   Windows: NSIS setup.exe, cross-compiled with cargo-xwin (Tauri's documented route;
#   MSI needs Windows). macOS installers need a Mac (GitHub's macOS runners).
# Usage on the pod: SRC=/workspace/hs (this repository's hoststation/ folder) [TARGETS="linux windows"] bash build_installers_pod.sh
# Output: /workspace/dist/*.{deb,rpm,AppImage,exe}
set -uo pipefail
SRC=${SRC:-/workspace/hs}; OUT=${OUT:-/workspace/dist}; TARGETS=${TARGETS:-linux windows}; PRODUCTS=${PRODUCTS:-host imagegen musicgen chatgen codegen videogen}
mkdir -p $OUT; log() { echo "[$(date -u +%H:%M:%S)] $*"; }
export DEBIAN_FRONTEND=noninteractive
if [ ! -f /workspace/.hs_deps ]; then
  apt-get update -qq > /dev/null
  apt-get install -y -qq libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf rpm file \
    build-essential curl nsis lld llvm clang > /workspace/apt.log 2>&1 || { log "apt failed"; tail -20 /workspace/apt.log; exit 1; }
  command -v cargo > /dev/null || curl -sSf https://sh.rustup.rs | sh -s -- -y -q > /dev/null
  . $HOME/.cargo/env
  rustup target add x86_64-pc-windows-msvc > /dev/null
  cargo install --locked cargo-xwin > /workspace/xwin.log 2>&1 || { log "cargo-xwin failed"; tail -20 /workspace/xwin.log; exit 1; }
  command -v node > /dev/null || { curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1; apt-get install -y -qq nodejs > /dev/null; }
  npm install -g @tauri-apps/cli@^2 > /workspace/npm.log 2>&1
  touch /workspace/.hs_deps
fi
. $HOME/.cargo/env
log "rust $(rustc --version), tauri $(tauri --version), $(nproc) cores"
cd $SRC
for t in $TARGETS; do
  for f in $PRODUCTS; do
    conf=""
    if [ "$f" = host ]; then unset SUSHILA_PRESET; else
      export SUSHILA_PRESET=presets/$f.json
      python3 -c "import json; p=json.load(open('presets/$f.json')); json.dump({'productName': p['product'], 'mainBinaryName': p['binary']}, open('flavor.conf.json','w'))"
      conf="--config flavor.conf.json"
    fi
    rm -rf src-tauri/target/release/bundle src-tauri/target/x86_64-pc-windows-msvc/release/bundle
    if [ "$t" = linux ]; then
      log "$f: Linux"; tauri build $conf > /workspace/build-$f-linux.log 2>&1 || { log "$f linux FAILED"; tail -25 /workspace/build-$f-linux.log; exit 1; }
      find src-tauri/target/release/bundle -type f \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) -exec cp {} $OUT/ \;
    else
      log "$f: Windows (cross)"; tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis $conf > /workspace/build-$f-windows.log 2>&1 || { log "$f windows FAILED"; tail -25 /workspace/build-$f-windows.log; exit 1; }
      find src-tauri/target/x86_64-pc-windows-msvc/release/bundle -type f -name '*.exe' -exec cp {} $OUT/ \;
    fi
  done
done
ls -la $OUT; sha256sum $OUT/* > $OUT/SHA256SUMS.txt
log INSTALLERS_DONE

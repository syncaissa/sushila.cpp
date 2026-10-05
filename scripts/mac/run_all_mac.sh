#!/usr/bin/env bash
# One click on an Apple Silicon Mac: the Mac speed tests for Sushila (Accelerated images and text on Metal / MLX).
#   bash scripts/mac/run_all_mac.sh            (from a checkout of the repository; about 1-2 hours; ~45 GB free disk)
# Needs: Apple Silicon (M1-M4), macOS 14+, Xcode command line tools (xcode-select --install), cmake (brew install cmake,
# or this script installs it with pip), Python 3.10+. Results: ~/sushila-mac-results/<time>/ and a .zip next to it to
# send back; with ~/.b2_key present they also go to B2 results/mac/<time>/.
set -uo pipefail
R=$(cd "$(dirname "$0")/../.." && pwd)
export OUT=$HOME/sushila-mac-results/$(date -u +%Y%m%dT%H%MZ); mkdir -p "$OUT"
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$OUT/run.log"; }
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "This needs an Apple Silicon Mac (M1-M4)."; exit 1; }
xcode-select -p > /dev/null 2>&1 || { echo "Install the Xcode command line tools first: xcode-select --install"; exit 1; }
command -v cmake > /dev/null || python3 -m pip install --user -q cmake || { echo "Install cmake (brew install cmake)"; exit 1; }
export PATH=$PATH:$(python3 -c 'import site; print(site.USER_BASE)')/bin
free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}'); [ "${free_gb:-0}" -ge 45 ] || log "warning: only ${free_gb} GB free; about 45 GB are needed"
{ sw_vers; sysctl -n machdep.cpu.brand_string; echo "memory: $(( $(sysctl -n hw.memsize) / 1073741824 )) GB"; echo "cores: $(sysctl -n hw.ncpu)";
  system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Chipset|Cores|Metal" ; git -C "$R" log -1 --format='commit %H'; } > "$OUT/machine.txt"
log "$(head -c 400 "$OUT/machine.txt" | tr '\n' ' ')"
bash "$R/scripts/mac/bench_mac_images.sh"
bash "$R/scripts/mac/bench_mac_text.sh"
(cd "$(dirname "$OUT")" && zip -qr "$(basename "$OUT").zip" "$(basename "$OUT")")
log "results: $OUT and $OUT.zip"
if [ -f "$HOME/.b2_key" ]; then
  python3 - "$OUT" "$R" <<'PY' && log "uploaded to B2 results/mac/$(basename "$OUT")/"
import os, sys
out, repo = sys.argv[1:3]; sys.path.insert(0, f'{repo}/scripts/precompute'); import b2_save
b2 = b2_save.B2()
for root, _, files in os.walk(out):
    for f in files:
        p = os.path.join(root, f); b2.put_file(p, 'results/mac/' + os.path.relpath(p, os.path.dirname(out)))
PY
fi
log "ALL_DONE: send $OUT.zip (or tell Claude it is in B2)"

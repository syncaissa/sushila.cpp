#!/usr/bin/env bash
# Recovery script used in our run: the llama.cpp benchmarks of pod_compare2.sh, which built correctly but could not
# start (libcublas.so.13 not on the library path). Runs after RIGOR_DONE (one timing job at a time). Logs COMPARE3_DONE.
set -u
W=${W:-/workspace/day0}; S=$W; B=$(cd "$(dirname "$0")" && pwd); BC=$W/build-cuda; O=$S/out/compare; T=16
log() { echo "[$(date +%H:%M:%S)] $*" >> $S/p3.log; }
until grep -q 'RIGOR_DONE' $S/p3.log; do sleep 60; done
export LD_LIBRARY_PATH=/usr/local/cuda/lib64:${LD_LIBRARY_PATH:-}
pkill -x ollama; pkill -f sglang.launch_server; sleep 10
D=$(awk '$1=="llama3.2:1b"{print $2}' $O/blobs.txt)
cd $B
for m in llama3.2:3b llama3.1:8b llama3.1:70b; do
  t=${m//[:.]/_}; G=$(awk -v m=$m '$1==m{print $2}' $O/blobs.txt)
  python3 bench_llamacpp.py --threads $T --bin $BC/bin --model $G --out $O/stock_$t.json > $O/stock_$t.log 2>&1 && log "llama.cpp stock $m: $(tail -1 $O/stock_$t.log)" || log "llama.cpp stock $m failed"
  for dm in 8 16; do
    python3 bench_llamacpp.py --threads $T --bin $BC/bin --model $G --draft $D --draft-max $dm --out $O/sushila_${t}_dm$dm.json > $O/sushila_${t}_dm$dm.log 2>&1 \
      && log "sushila.cpp $m 1B draft dm$dm: $(tail -1 $O/sushila_${t}_dm$dm.log)" || log "sushila.cpp $m dm$dm failed"
  done
done
log COMPARE3_DONE

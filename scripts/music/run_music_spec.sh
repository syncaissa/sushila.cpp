#!/usr/bin/env bash
# MusicGen acceleration on a GPU pod: build acestep.cpp (pinned) + Sushila patch, restore the ACE-Step pack from B2,
# fetch the small LMs (drafts), then: LM speed for Standard and for draft LM x spec-k; the DiT step-reuse plan.
# Usage: W=/workspace/music REPO=/workspace/repo bash run_music_spec.sh
set -uo pipefail
W=${W:-/workspace/music}; REPO=${REPO:-/workspace/repo}; mkdir -p $W/res $W/draft; B=$W/b; mkdir -p $B
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a $W/run.log; }
export PATH=/usr/local/cuda/bin:$PATH CUDACXX=${CUDACXX:-/usr/local/cuda/bin/nvcc}
command -v cmake > /dev/null || { apt-get update -qq > /dev/null; apt-get install -y -qq cmake > /dev/null; }
if [ ! -x $B/acebuild/ace-server ]; then
  [ -d $B/acecpp ] || { git clone -q --recursive https://github.com/ServeurpersoCom/acestep.cpp $B/acecpp && git -C $B/acecpp checkout -q 694ef0f2f7cbf1b8a45b061a1ff0a817f451420c && git -C $B/acecpp submodule update -q --init --recursive; }
  git -C $B/acecpp -c user.email=s@s -c user.name=s am -q --whitespace=nowarn $REPO/hoststation/patches/acestep/*.patch || { log "patch failed"; exit 1; }
  cmake -S $B/acecpp -B $B/acebuild -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89 > $B/cmake.log 2>&1
  cmake --build $B/acebuild --config Release --target ace-server -j $(nproc) > $B/build.log 2>&1 || { log "build failed"; tail -30 $B/build.log; exit 1; }
fi
SRV=$(find $B/acebuild -name ace-server -type f | head -1); log "built $SRV"
[ -s $W/pack/vae-BF16.gguf ] || { python3 $REPO/scripts/precompute/b2_save.py restore precomputed/ace-step-15 $W/pack0 --only weights/ > $W/restore.log 2>&1; mkdir -p $W/pack; find $W/pack0 -type f -name '*.gguf' -exec mv {} $W/pack/ \; ; }
ls -la $W/pack | tee -a $W/run.log
pip install -q huggingface_hub > /dev/null 2>&1
for f in acestep-5Hz-lm-0.6B-Q8_0.gguf acestep-5Hz-lm-1.7B-Q8_0.gguf; do
  [ -s $W/draft/$f ] || python3 -c "from huggingface_hub import hf_hub_download as d; d('Serveurperso/ACE-Step-1.5-GGUF','$f',local_dir='$W/draft')" >> $W/run.log 2>&1
done
sha256sum $W/draft/*.gguf | tee $W/res/draft_sha256.txt
LM4=$(ls $W/pack/acestep-5Hz-lm-4B*.gguf | head -1)
start() {  # start the server with extra args; wait until it answers
  [ -n "${SPID:-}" ] && { kill -9 $SPID 2>/dev/null; wait $SPID 2>/dev/null; sleep 2; }
  $SRV --models $W/pack --host 127.0.0.1 --port 8097 --keep-loaded "$@" > $W/res/server-$TAG.log 2>&1 &
  SPID=$!
  for i in $(seq 1 120); do curl -sf localhost:8097/health > /dev/null && return 0; curl -sf localhost:8097/ > /dev/null && return 0; sleep 2; done
  log "server did not start ($TAG)"; tail -20 $W/res/server-$TAG.log; return 1
}
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader | tee -a $W/run.log
# Standard (also saves the song plans for the DiT test)
TAG=base; start && python3 $REPO/scripts/music/bench_music_spec.py lm --tag base --out $W/res --save-plans 2>&1 | tee -a $W/run.log
# correctness: the 4B as its own draft -> nearly every draft accepted
TAG=self-k4; start --lm-draft $LM4 --spec-k 4 && python3 $REPO/scripts/music/bench_music_spec.py lm --tag $TAG --out $W/res 2>&1 | tee -a $W/run.log
for d in 0.6B 1.7B; do for k in ${KS:-2 3 4 6}; do
  TAG=d$d-k$k; start --lm-draft $W/draft/acestep-5Hz-lm-$d-Q8_0.gguf --spec-k $k && python3 $REPO/scripts/music/bench_music_spec.py lm --tag $TAG --out $W/res 2>&1 | tee -a $W/run.log
done; done
grep -h "LM-Spec\] Decode\|LM-Phase2\] Decode" $W/res/server-*.log > /dev/null
for f in $W/res/server-*.log; do echo "== $f"; grep -E "LM-Spec\] Decode|LM-Phase2\] Decode|Phase1.*tokens|LM\] Total" $f; done > $W/res/decode_lines.txt
log LM_DONE
TAG=plan; start && python3 $REPO/scripts/music/bench_music_spec.py plan --out $W/res 2>&1 | tee -a $W/run.log
kill -9 $SPID 2>/dev/null
log MUSIC_SPEC_DONE

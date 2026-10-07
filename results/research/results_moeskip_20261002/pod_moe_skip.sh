#!/usr/bin/env bash
# Validation of adaptive experts with real skipping (LLAMA_MOE_TOP_P + LLAMA_MOE_SKIP) on Qwen3-30B-A3B.
# Run on an otherwise idle pod. Three proofs:
#  1. correctness: skipping must give the same perplexity as the mask-only run at the same p, and
#     unset variables must reproduce the stock perplexity (7.5398 on these 20 chunks)
#  2. quality: greedy output agreement with the stock model on the 20 held-out domain prompts
#  3. speed: decode tokens/s on real text (5 interleaved runs, medians) at 8/16/32 threads with the engine's
#     default settings (weight repacking on, as deployed), and batched prompt throughput (perplexity seconds
#     per pass), against stock and fixed-k
set -x
R=/workspace/Monte-Carlo-AI-Inference; W=/workspace/mc-work; S=/workspace/moeskip; B=$W/build/llama.cpp/bin
mkdir -p $S; cd $R && chown -R root:root . && scripts/build.sh > $S/build.log 2>&1 || exit 1
scripts/get_data.sh; scripts/get_model.sh qwen3-30b-a3b-q4km || exit 1
M=$W/models/qwen3-30b-a3b-q4km.gguf; T=$W/data/wikitext-2-raw/wiki.test.raw
P=${P_LIST:-"0.9 0.8 0.6"}
ppl() { $B/llama-perplexity -m $M -f $T -c 512 -t 32 --chunks 20 -ngl 0 --no-repack "$@" 2>&1 | grep -E "Final|seconds per pass"; }
# 1. correctness + batched throughput
echo "stock: $(ppl)"
for p in $P; do
  echo "p=$p mask-only: $(LLAMA_MOE_TOP_P=$p ppl)"
  echo "p=$p skip:      $(LLAMA_MOE_TOP_P=$p LLAMA_MOE_SKIP=1 ppl)"
done
for kk in 6 4; do echo "fixed k=$kk: $(ppl --override-kv qwen3moe.expert_used_count=int:$kk)"; done
echo CORRECTNESS_DONE
# 2. greedy agreement on held-out prompts (64 tokens each)
python3 - "$B" "$M" "$P" <<'PY' > $S/agreement.txt
import subprocess, sys, os
sys.path.insert(0, '/workspace/Monte-Carlo-AI-Inference/scripts')
from make_calib_mix import TEST_CHAT, TEST_MULTI
B, M, plist = sys.argv[1], sys.argv[2], sys.argv[3].split()
prompts = [f"User: {q}\nAssistant:" for q in TEST_CHAT + TEST_MULTI] + [
    "import numpy as np\n\ndef softmax(x):", "#include <stdio.h>\n\nint main(void) {",
    "The Industrial Revolution transformed", "In 1969, astronauts", "The economy of Brazil is"]
def gen(p, env):
    r = subprocess.run([f"{B}/llama-completion", "-m", M, "-p", p, "-n", "64", "--temp", "0", "-t", "32", "-no-cnv",
                        "--no-warmup", "--no-display-prompt", "--no-repack"], capture_output=True, env={**os.environ, **env},
                       text=True, encoding="utf-8", errors="replace")
    return r.stdout
ref = [gen(p, {}) for p in prompts]
for pv in plist:
    out = [gen(p, {"LLAMA_MOE_TOP_P": pv, "LLAMA_MOE_SKIP": "1"}) for p in prompts]
    same = sum(a == b for a, b in zip(ref, out))
    # tokens until first divergence, as characters of common prefix / length
    pref = sum(len(os.path.commonprefix([a, b])) / max(1, len(a)) for a, b in zip(ref, out)) / len(prompts)
    print(f"p={pv}: identical outputs {same}/{len(prompts)}, mean common prefix {pref:.1%}")
PY
cat $S/agreement.txt
# 3. decode speed
for t in 8 16 32; do for run in 1 2 3 4 5; do
  for mode in stock k6 p0.9 p0.8 p0.6; do
    case $mode in stock) E=""; X="";; k6) E=""; X="--override-kv qwen3moe.expert_used_count=int:6";;
                  p*) E="LLAMA_MOE_TOP_P=${mode#p} LLAMA_MOE_SKIP=1"; X="";; esac
    echo "t=$t run=$run mode=$mode $(env $E $B/llama-completion -m $M -p 'The history of the printing press began in' -n 128 --temp 0 -t $t -no-cnv $X 2>&1 >/dev/null | grep -E '  eval time')"
  done
done; done > $S/decode_speed.txt
echo MOESKIP_DONE

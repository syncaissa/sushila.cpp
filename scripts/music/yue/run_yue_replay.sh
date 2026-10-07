#!/usr/bin/env bash
# Same song, same length: Sushila's runner replays the official run's stage-1 tokens (every step still does its full
# work, sampling included, then takes the official token), so both runs produce the same song and are timed on exactly
# the same tokens. Then stage 2 runs in bfloat16 (as the official code) and, separately, in float32.
#   W=/workspace/yue NSEG=2 bash run_yue_replay.sh      (after run_yue_baseline.sh in that W)
# Output: $W/res/replay_bf16/, $W/res/replay_s2fp32/, each with timing.json; replay_check.json (stage-1 tokens equal?)
set -uo pipefail
W=${W:-/workspace/yue}; HERE=$(cd "$(dirname "$0")" && pwd); NSEG=${NSEG:-2}; MAXTOK=${MAXTOK:-3000}
cd $W/YuE/inference
cp infer.py infer_fast.py && python3 $HERE/patch_infer.py infer_fast.py > /dev/null && python3 $HERE/patch_fast.py infer_fast.py
export SUSHILA_YUE_DIR=$HERE SUSHILA_STAGE1=batched SUSHILA_STAGE2=batched SUSHILA_GRAPHS=1 SUSHILA_REPLAY=$W/res/base_seed42 HF_HUB_OFFLINE=1
for dt in bf16 s2fp32; do
  out=$W/res/replay_$dt; rm -rf $out; mkdir -p $out
  if [ $dt = s2fp32 ]; then export SUSHILA_S2_DTYPE=float32; else unset SUSHILA_S2_DTYPE; fi
  python3 infer_fast.py --stage1_model m-a-p/YuE-s1-7B-anneal-en-cot --stage2_model m-a-p/YuE-s2-1B-general \
    --genre_txt ../prompt_egs/genre.txt --lyrics_txt ../prompt_egs/lyrics.txt --run_n_segments $NSEG --stage2_batch_size 4 \
    --output_dir $out --max_new_tokens $MAXTOK --repetition_penalty 1.1 --seed 42 > $out/infer.log 2>&1
  grep -E "TIMING|Traceback|Error" $out/infer.log | tail -2
done
python3 - "$W" <<'PY'
import json, sys, numpy as np, glob, os
W = sys.argv[1]; R = os.path.join(W, 'res'); off = np.load(f'{R}/base_seed42/stage1_ids.npy'); res = {}
for d in ('replay_bf16', 'replay_s2fp32'):
    p = f'{R}/{d}/stage1_ids.npy'
    if not os.path.exists(p): res[d] = 'missing'; continue
    a = np.load(p); res[d] = {'stage1_tokens_identical': bool(a.shape == off.shape and (a == off).all()), 'tokens': int(a.size), 'official_tokens': int(off.size)}
    s2o = sorted(glob.glob(f'{R}/base_seed42/stage2/*.npy')); s2 = sorted(glob.glob(f'{R}/{d}/stage2/*.npy'))
    same = tot = 0
    for x, y in zip(s2o, s2):
        A, B = np.load(x), np.load(y); n = min(A.shape[1], B.shape[1]); same += int((A[:, :n] == B[:, :n]).sum()); tot += A[:, :n].size
    res[d]['stage2_codes_equal_to_official'] = same / max(tot, 1)
print(json.dumps(res)); json.dump(res, open(f'{R}/replay_check.json', 'w'), indent=1)
PY
echo REPLAY_DONE

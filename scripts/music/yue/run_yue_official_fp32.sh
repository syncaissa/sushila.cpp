#!/usr/bin/env bash
# The official float32 reference of the paper's YuE table (lab song: 1,805 s; Sushila's float32 stage-2 codes equal it).
# The official YuE code with ONE change: stage 2 runs in float32 (model_stage2.float()); same prompt, seed and segments
# as the official run of reproduce_yue.sh. Then it compares:
#   - stage 1: the official run's tokens vs this run's (the official code is deterministic at seed 42: identical);
#   - stage 2: Sushila's float32 codes (run_yue_replay.sh, replay_s2fp32) vs this run's (paper: every code equal).
#   W=/workspace/yue NSEG=2 bash run_yue_official_fp32.sh     (after reproduce_yue.sh and run_yue_replay.sh in that W)
# Output: $W/res/base_fp32/ (timing.json, codes, song) and $W/res/fp32_check.json.
set -uo pipefail
W=${W:-/workspace/yue}; HERE=$(cd "$(dirname "$0")" && pwd); NSEG=${NSEG:-2}; MAXTOK=${MAXTOK:-3000}
cd $W/YuE/inference
cp infer.py infer_timed_fp32.py && python3 $HERE/patch_infer.py infer_timed_fp32.py > /dev/null   # timing + saved codes only
python3 - <<'PY'
p = "infer_timed_fp32.py"; s = open(p).read(); o = "model_stage2.to(device)\nmodel_stage2.eval()"
assert s.count(o) == 1, "official infer.py changed: stage-2 load line not found"
open(p, "w").write(s.replace(o, "model_stage2.to(device)\nmodel_stage2 = model_stage2.float()  # official code, stage 2 in float32\nmodel_stage2.eval()"))
PY
out=$W/res/base_fp32; rm -rf $out; mkdir -p $out
HF_HUB_OFFLINE=1 python3 infer_timed_fp32.py --stage1_model m-a-p/YuE-s1-7B-anneal-en-cot --stage2_model m-a-p/YuE-s2-1B-general \
  --genre_txt ../prompt_egs/genre.txt --lyrics_txt ../prompt_egs/lyrics.txt --run_n_segments $NSEG --stage2_batch_size 4 \
  --output_dir $out --max_new_tokens $MAXTOK --repetition_penalty 1.1 --seed 42 > $out/infer.log 2>&1
grep -E "TIMING|Traceback|Error" $out/infer.log | tail -2
python3 - "$W" <<'PY'
import glob, json, os, sys
import numpy as np
R = os.path.join(sys.argv[1], 'res'); ref = f'{R}/base_fp32'
a, b = np.load(f'{R}/base_seed42/stage1_ids.npy'), np.load(f'{ref}/stage1_ids.npy')
res = {'official_stage1_identical_across_runs': bool(a.shape == b.shape and (a == b).all())}
t = json.load(open(f'{ref}/timing.json')); res['official_fp32_seconds'] = round(t['end'] - t['start'])
ours = sorted(glob.glob(f'{R}/replay_s2fp32/stage2/*.npy')); offi = sorted(glob.glob(f'{ref}/stage2/*.npy'))
same = tot = 0; shapes = len(ours) == len(offi) and len(ours) > 0
for x, y in zip(offi, ours):
    A, B = np.load(x), np.load(y); shapes = shapes and A.shape == B.shape
    n = min(A.shape[1], B.shape[1]); same += int((A[:, :n] == B[:, :n]).sum()); tot += A[:, :n].size
res['stage2_files'] = len(offi); res['sushila_fp32_codes_equal_to_official_fp32'] = same / max(tot, 1); res['same_shapes'] = bool(shapes)
res['pass'] = res['official_stage1_identical_across_runs'] and shapes and same == tot
print(json.dumps(res)); json.dump(res, open(f'{R}/fp32_check.json', 'w'), indent=1)
PY
echo OFFICIAL_FP32_DONE

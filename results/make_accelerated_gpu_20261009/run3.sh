# third GPU run: fresh home (CUDA engine), the two unlisted models moved in (the folder scan adopts them), drive2 again
export SUSHILA_HOME=/workspace/home3 SUSHILA_NO_BROWSER=1
cd /workspace/accel
: > result3
./sushila --version > setup3.log 2>&1
./sushila engine install >> setup3.log 2>&1; echo ENGINE $? >> result3
./sushila install qwen2.5-0.5b-q4km >> setup3.log 2>&1; echo DRAFT_PACK $? >> result3
mkdir -p /workspace/home3/model-packs
for d in Qwen2.5-7B-Instruct-Q4_K_M v1-5-pruned-emaonly; do [ -d /workspace/home/model-packs/$d ] && mv /workspace/home/model-packs/$d /workspace/home3/model-packs/; done
nohup ./sushila --quiet serve > serve3.log 2>&1 < /dev/null &
for i in $(seq 1 120); do curl -s -m 2 http://127.0.0.1:7874/health | grep -q '"ok":true' && break; sleep 3; done
# wait until both folders are adopted
for i in $(seq 1 120); do n=$(python3 -c "import json;print(sum(1 for p in json.load(open('/workspace/home3/state.json'))['packs'].values() if p.get('custom')))" 2>/dev/null); [ "$n" = 2 ] && break; sleep 3; done; echo ADOPTED $n >> result3
sed 's#/workspace/home/#/workspace/home3/#g; s#accel_results2.json#accel_results3.json#' drive2.py > drive3.py
python3 drive3.py > drive3.log 2>&1; echo DRIVE3 $? >> result3
python3 -c "import json;s=json.load(open('/workspace/home3/state.json'));print('ENGINE_KEY', s['engine']['key'], 'FALLBACK', s.get('engineFallback'))" >> result3
grep -c "cancelled: stopped before\|switching to the" /workspace/home3/logs/sushila.log >> result3
echo DONE >> result3

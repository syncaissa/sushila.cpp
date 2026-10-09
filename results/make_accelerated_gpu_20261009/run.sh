# GPU test of Make Accelerated (engine 35): an unlisted chat model (Qwen2.5-7B, draft: Qwen2.5-0.5B pack) and an
# unlisted picture model (SD 1.5 safetensors), each measured through the engine's API as the app does.
set -x
export SUSHILA_HOME=/workspace/home SUSHILA_NO_BROWSER=1
cd /workspace/accel
./sushila --version > setup.log 2>&1
./sushila engine install >> setup.log 2>&1; echo ENGINE $? >> result
./sushila install qwen2.5-0.5b-q4km >> setup.log 2>&1; echo DRAFT_PACK $? >> result
nohup ./sushila --quiet serve > serve.log 2>&1 < /dev/null &
for i in $(seq 1 120); do curl -s -m 2 http://127.0.0.1:7874/health | grep -q '"ok":true' && break; sleep 5; done; echo SERVE $i >> result
python3 /workspace/accel/drive.py >> drive.log 2>&1; echo DRIVE $? >> result
echo DONE >> result

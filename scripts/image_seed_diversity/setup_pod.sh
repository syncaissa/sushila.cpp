# GPU seed-diversity test: engine 33 + both Z-Image packs, as users get them (results /workspace/seed/*)
set -x
export SUSHILA_HOME=/workspace/home SUSHILA_NO_BROWSER=1 DEBIAN_FRONTEND=noninteractive
mkdir -p /workspace/seed && cd /workspace/seed
curl -sSfo sushila https://files.sushila.ai/public/temp/sushila-test-20261009-build33/sushila && chmod +x sushila
./sushila --version > setup.log 2>&1
./sushila engine install >> setup.log 2>&1; echo ENGINE $? >> result
./sushila install z-image-turbo-nvidia >> setup.log 2>&1; echo PACK_NV $? >> result
./sushila install z-image-turbo >> setup.log 2>&1; echo PACK_SD $? >> result
python3 -m venv /workspace/mvenv && /workspace/mvenv/bin/pip install -q torch torchvision --index-url https://download.pytorch.org/whl/cu124 >> setup.log 2>&1 && /workspace/mvenv/bin/pip install -q transformers lpips pillow requests >> setup.log 2>&1; echo METRICS $? >> result
nohup ./sushila --quiet serve > serve.log 2>&1 < /dev/null &
for i in $(seq 1 120); do curl -s -m 2 http://127.0.0.1:7874/health | grep -q '"ok":true' && break; sleep 5; done; echo SERVE $i >> result
echo DONE >> result

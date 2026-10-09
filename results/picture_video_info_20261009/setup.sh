# picture vs video on the real page: engine 35 (published), Z-Image NVIDIA + Wan 2.2 5B, Chromium for screenshots
set -x
export SUSHILA_HOME=/workspace/home SUSHILA_NO_BROWSER=1 DEBIAN_FRONTEND=noninteractive
mkdir -p /workspace/free && cd /workspace/free; : > result
curl -sSfo sushila https://files.sushila.ai/public/temp/sushila-test-20261009-build35/sushila && chmod +x sushila
./sushila --version > setup.log 2>&1
./sushila engine install >> setup.log 2>&1; echo ENGINE $? >> result
./sushila install z-image-turbo-nvidia >> setup.log 2>&1; echo PACK_IMG $? >> result
./sushila install wan2.2-ti2v-5b >> setup.log 2>&1; echo PACK_VID $? >> result
(pip install -q playwright && python3 -m playwright install --with-deps chromium) >> setup.log 2>&1; echo BROWSER $? >> result
nohup ./sushila --quiet serve > serve.log 2>&1 < /dev/null &
for i in $(seq 1 120); do curl -s -m 2 http://127.0.0.1:7874/health | grep -q '"ok":true' && break; sleep 5; done; echo SERVE $i >> result
echo SETUP_DONE >> result

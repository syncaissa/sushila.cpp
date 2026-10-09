cd /workspace/seed; R=/workspace/home/runtime/image-nunchaku/0.1.0; P=/workspace/home/model-packs/z-image-turbo-nvidia
: > result3
for k in 1 2; do
  SUSHILA_SEED_VARIANCE_STEPS=$k PYTHONNOUSERSITE=1 HF_HUB_OFFLINE=1 nohup $R/python/bin/python3.11 server_boost.py --host 127.0.0.1 --port 8099 --name boost --model-dir $P/model_index.json --transformer $P/transformer/svdq-int4_r128-z-image-turbo.safetensors > boost2-k$k.log 2>&1 &
  SP=$!
  for i in $(seq 1 120); do grep -q ready boost2-k$k.log && break; sleep 3; done
  for v in 0.05 0.1 0.15 0.2 0.3; do VARIANCE=$v SUSHILA_SEED_VARIANCE_STEPS=$k /workspace/mvenv/bin/python measure.py boost-v$v-k$k url http://127.0.0.1:8099 > run-boost-v$v-k$k.log 2>&1; echo "v$v k$k $?" >> result3; done
  kill $SP; sleep 5
done
echo DONE >> result3

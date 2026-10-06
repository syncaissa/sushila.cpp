# Precomputed work in B2 (bucket `sushila-ai`)

Generated 2026-10-06T18:59Z by `scripts/precompute/b2_index.py`. Everything here was computed once and is kept forever (never delete under `precomputed/`). Each folder has one `CHECKSUMS.json` listing every file with its sha256, and `CHECKSUMS.json.sig`, an Ed25519 signature checked by Sushila Host Station.

| Model | Contents | Size | Signed | Saved |
|---|---|---:|:---:|---|
| `ace-step-15` | weights (4) | 8.1 GB | yes | 2026-10-05 |
| `deepseek-r1-distill-llama-70b` | checkpoints (2), draft-head (2), training-data (2), config.env (1), weights (23) | 88.6 GB | yes | 2026-10-05 |
| `gemma3-27b` | checkpoints (2), draft-head (2), training-data (2), config.env (1), weights (23) | 38.8 GB | yes | 2026-10-05 |
| `kimi-dev-72b` | checkpoints (2), draft-head (2), training-data (2), config.env (1), weights (30) | 93.1 GB | yes | 2026-10-06 |
| `qwen2.5-0.5b-q4km` | landscape (48), landscapes-earlier (4), calibration (7), weights (1) | 0.8 GB | yes | 2026-10-05 |
| `qwen2.5-coder-7b` | weights (1) | 4.7 GB | yes | 2026-10-05 |
| `qwen3-235b-a22b` | draft-head (2), checkpoints (2), training-data (2), config.env (1), weights (43) | 271.4 GB | yes | 2026-10-05 |
| `qwen3-30b-a3b` | checkpoints (2), draft-head (2), training-data (2), config.env (1), weights (17) | 36.2 GB | yes | 2026-10-04 |
| `qwen3-32b` | checkpoints (2), draft-head (2), training-data (2), config.env (1), weights (20) | 42.7 GB | yes | 2026-10-04 |
| `qwen3-4b-instruct-2507` | weights (1) | 2.5 GB | yes | 2026-10-05 |
| `qwen3-coder-30b-a3b` | draft-head (2), checkpoints (2), training-data (2), config.env (1), weights (23) | 54.7 GB | yes | 2026-10-06 |
| `wan2.2-ti2v-5b` | weights (3) | 12.9 GB | yes | 2026-10-06 |
| `z-image-turbo` | weights (3) | 6.7 GB | yes | 2026-10-05 |
| `z-image-turbo-nvidia` | weights (16) | 12.2 GB | yes | 2026-10-05 |
| `z-image-turbo-nvidia-fp4` | weights (16) | 12.4 GB | yes | 2026-10-05 |
| `z-image-turbo-q8` | weights (3) | 9.4 GB | yes | 2026-10-05 |

## Each model

### `ace-step-15`



- **Use:** 
- **Results:** -
- **Bound to:** `{"huggingface": [{"repo": "Serveurperso/ACE-Step-1.5-GGUF", "file": "acestep-v15-turbo-Q8_0.gguf", "revision": "666ac70204440867d8c01ba4b119cc79c95b370a", "sha256": "288f708a61cfc241013a98a62f98ba331f83fe34d0d3559acdd9b0f6a2f7cd6b", "license": "mit"}, {"repo": "Serveurperso/ACE-Step-1.5-GGUF", "file": "acestep-5Hz-lm-4B-Q8_0.gguf", "revision": "666ac70204440867d8c01ba4b119cc79c95b370a", "sha256": `
- **Folders:**
  - `weights/` (4 files, 8.13 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `deepseek-r1-distill-llama-70b`

EAGLE-3 draft head for the reasoning model, refitted from the Llama-3.3-70B head (none published for R1), trained on R1's full reasoning text; 3.64x vs Ollama, 2.30x over SGLang alone.

- **Use:** SGLang as above (--context-length 2048) with weights/sglang/ (casperhansen/deepseek-r1-distill-llama-70b-awq).
- **Results:** results/deepseek-r1-distill-llama-70b/ and forGithub/results/deepseek-r1-distill-llama-70b_20261005/
- **Bound to:** `{"sglang_target": {"repo": "casperhansen/deepseek-r1-distill-llama-70b-awq", "revision": "a1ab7653aae77fbabc536cbcbac5bb2e2fb5354f"}, "warm_start_head": {"repo": "lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B", "revision": "5279b1b6b12d66c44264cbfd125bc8e43f147787"}, "ollama_gguf": {"tag": "deepseek-r1:70b", "sha256": "4cd576d9aa16961244012223abf01445567b061f1814b57dfef699e4cf8df339"}}`
- **Folders:**
  - `checkpoints/` (2 files, 3.15 GB): every other trained head checkpoint (for re-selection or further training)
  - `draft-head/` (2 files, 3.15 GB): the precomputed draft head chosen on validation prompts (ready to serve)
  - `training-data/` (2 files, 0.01 GB): the model's own answers the head was fitted on (regen.jsonl) and the prompts
  - `config.env/` (1 files, 0.00 GB): the pipeline configuration that produced the artifacts
  - `weights/` (23 files, 82.31 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `gemma3-27b`



- **Use:** python3 -m sglang.launch_server --model-path <sglang_target> --speculative-algorithm EAGLE3 --speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16 --speculative-draft-model-path draft-head/
- **Results:** -
- **Bound to:** `{"sglang_target": {"repo": "gaunernst/gemma-3-27b-it-int4-awq", "revision": "7cf8bdc81343c635390dd1e1bf590ab22dd6f366"}, "warm_start_head": {"repo": "witcheer/gemma-3-27b-eagle3-drafter", "revision": "66d6a10655c1729fe26df5cd15545f02041a0161"}, "ollama_gguf": {"tag": "gemma3:27b", "sha256": "e796792eba26c4d3b04b0ac5adb01a453dd9ec2dfd83b6c59cbf6fe5f30b0f68"}}`
- **Folders:**
  - `checkpoints/` (2 files, 1.43 GB): every other trained head checkpoint (for re-selection or further training)
  - `draft-head/` (2 files, 1.43 GB): the precomputed draft head chosen on validation prompts (ready to serve)
  - `training-data/` (2 files, 0.01 GB): the model's own answers the head was fitted on (regen.jsonl) and the prompts
  - `config.env/` (1 files, 0.00 GB): the pipeline configuration that produced the artifacts
  - `weights/` (23 files, 35.90 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `kimi-dev-72b`



- **Use:** python3 -m sglang.launch_server --model-path <sglang_target> --speculative-algorithm EAGLE3 --speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16 --speculative-draft-model-path draft-head/
- **Results:** -
- **Bound to:** `{"sglang_target": {"repo": "QuantTrio/Kimi-Dev-72B-GPTQ-Int4", "revision": "57a4cb1a3012968e5e2f3772a9877879be1a8f9a"}, "warm_start_head": {"repo": "AQ-MedAI/Qwen2.5-VL-72B-Instruct-eagle3", "revision": "bdd66af1bb4aafba09f5e5c7f975e3f1ff86ed57"}, "ollama_gguf": {"tag": "kimi-dev:72b", "sha256": "67b8610bb120fe10256fb2cf94b2a50d590826c46ad18821a22bf083c5b46fa8"}}`
- **Folders:**
  - `checkpoints/` (2 files, 2.09 GB): every other trained head checkpoint (for re-selection or further training)
  - `draft-head/` (2 files, 2.09 GB): the precomputed draft head chosen on validation prompts (ready to serve)
  - `training-data/` (2 files, 0.02 GB): the model's own answers the head was fitted on (regen.jsonl) and the prompts
  - `config.env/` (1 files, 0.00 GB): the pipeline configuration that produced the artifacts
  - `weights/` (30 files, 88.92 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `qwen2.5-0.5b-q4km`

Output-layer landscape for Qwen2.5-0.5B-Instruct Q4_K_M (CPU decoding 1.13-1.26x faster with identical output; the paper's per-model pipeline example). Default model of Sushila Host Station.

- **Use:** Sushila.cpp reads it automatically: put landscape/{manifest.json,landscape.mclp} in <model>.gguf.sushila/ next to weights/gguf/qwen2.5-0.5b-q4km.gguf (or install the Host Station pack qwen2.5-0.5b-q4km).
- **Results:** paper: output-layer landscape sections; Paper/notes/landscape (B2 results/paper-notes-landscape/)
- **Bound to:** `null`
- **Folders:**
  - `landscape/` (48 files, 0.20 GB): the precomputed output-layer landscape (manifest.json + .mclp) and its held-out validation data
  - `landscapes-earlier/` (4 files, 0.20 GB): earlier landscape builds used in the paper
  - `calibration/` (7 files, 0.02 GB): calibration activations and imatrix used to build the landscape
  - `weights/` (1 files, 0.40 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `qwen2.5-coder-7b`



- **Use:** 
- **Results:** -
- **Bound to:** `{"huggingface": [{"repo": "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF", "file": "qwen2.5-coder-7b-instruct-q4_k_m.gguf", "revision": "13fb94bfda8c8cf22497dc57b78f391a9acb426a", "sha256": "509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c", "license": "apache-2.0"}]}`
- **Folders:**
  - `weights/` (1 files, 4.68 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `qwen3-235b-a22b`



- **Use:** python3 -m sglang.launch_server --model-path <sglang_target> --speculative-algorithm EAGLE3 --speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16 --speculative-draft-model-path draft-head/
- **Results:** -
- **Bound to:** `{"sglang_target": {"repo": "QuixiAI/Qwen3-235B-A22B-AWQ", "revision": "1df91c166baa937f2d571a9cece7a1037c1cc772"}, "warm_start_head": {"repo": "lmsys/Qwen3-235B-A22B-EAGLE3", "revision": "d75f968c7d9d19ebdfb1a2fbdd176d61a032da14"}, "ollama_gguf": {"tag": "qwen3:235b-a22b-q4_K_M", "sha256": "aeacdadecbed8a07e42026d1a1d3cd30715bb2994ebe4e4ca4009e1a4abe8d5d"}}`
- **Folders:**
  - `draft-head/` (2 files, 2.43 GB): the precomputed draft head chosen on validation prompts (ready to serve)
  - `checkpoints/` (2 files, 2.43 GB): every other trained head checkpoint (for re-selection or further training)
  - `training-data/` (2 files, 0.01 GB): the model's own answers the head was fitted on (regen.jsonl) and the prompts
  - `config.env/` (1 files, 0.00 GB): the pipeline configuration that produced the artifacts
  - `weights/` (43 files, 266.51 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `qwen3-30b-a3b`

EAGLE-3 draft head refitted to Qwen3-30B-A3B (MoE) (warm start AngelSlim/Qwen3-a3B_eagle3); 1.65x vs Ollama; keeps throughput at 64 users.

- **Use:** SGLang as for qwen3-32b, with weights/sglang/ (Qwen/Qwen3-30B-A3B-GPTQ-Int4).
- **Results:** results/qwen3-30b-a3b/ and forGithub/results/qwen3_20261004/
- **Bound to:** `{"sglang_target": {"repo": "Qwen/Qwen3-30B-A3B-GPTQ-Int4", "revision": "9b534e4318b7ebc3c961a839f13eb18b1833f441"}, "warm_start_head": {"repo": "AngelSlim/Qwen3-a3B_eagle3", "revision": "266a50ea8c9dbedb729d7c18a98dd79f5b39b5c2"}, "ollama_gguf": {"tag": "qwen3:30b-a3b-q4_K_M", "sha256": "e9183b5c18a0cf736578c1e3d1cbd4b7e98e3ad3be6176b68c20f156d54a07ac"}}`
- **Folders:**
  - `checkpoints/` (2 files, 0.29 GB): every other trained head checkpoint (for re-selection or further training)
  - `draft-head/` (2 files, 0.29 GB): the precomputed draft head chosen on validation prompts (ready to serve)
  - `training-data/` (2 files, 0.01 GB): the model's own answers the head was fitted on (regen.jsonl) and the prompts
  - `config.env/` (1 files, 0.00 GB): the pipeline configuration that produced the artifacts
  - `weights/` (17 files, 35.57 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `qwen3-32b`

EAGLE-3 draft head refitted to Qwen3-32B's own answers (warm start thoughtworks/Qwen3-32B-Eagle3); 3.14x vs Ollama.

- **Use:** SGLang: --speculative-algorithm EAGLE3 --speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16 --speculative-draft-model-path draft-head/ with weights/sglang/ (Qwen/Qwen3-32B-AWQ). Host Station pack: GGUF only.
- **Results:** results/qwen3-32b/ and forGithub/results/qwen3_20261004/
- **Bound to:** `{"sglang_target": {"repo": "Qwen/Qwen3-32B-AWQ", "revision": "0499c3ac83fdef8810b907a23894ba91e95eddd8"}, "warm_start_head": {"repo": "thoughtworks/Qwen3-32B-Eagle3", "revision": "ba10360e72cc5208048695e713c2d45781921013"}, "ollama_gguf": {"tag": "qwen3:32b", "sha256": "3291abe70f16ee9682de7bfae08db5373ea9d6497e614aaad63340ad421d6312"}}`
- **Folders:**
  - `checkpoints/` (2 files, 1.57 GB): every other trained head checkpoint (for re-selection or further training)
  - `draft-head/` (2 files, 1.57 GB): the precomputed draft head chosen on validation prompts (ready to serve)
  - `training-data/` (2 files, 0.01 GB): the model's own answers the head was fitted on (regen.jsonl) and the prompts
  - `config.env/` (1 files, 0.00 GB): the pipeline configuration that produced the artifacts
  - `weights/` (20 files, 39.54 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `qwen3-4b-instruct-2507`



- **Use:** 
- **Results:** -
- **Bound to:** `{"huggingface": [{"repo": "unsloth/Qwen3-4B-Instruct-2507-GGUF", "file": "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "revision": "a06e946bb6b655725eafa393f4a9745d460374c9", "sha256": "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597", "license": "apache-2.0"}]}`
- **Folders:**
  - `weights/` (1 files, 2.50 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `qwen3-coder-30b-a3b`



- **Use:** python3 -m sglang.launch_server --model-path <sglang_target> --speculative-algorithm EAGLE3 --speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16 --speculative-draft-model-path draft-head/
- **Results:** -
- **Bound to:** `{"sglang_target": {"repo": "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ", "revision": "c58857a7f41c0920f73d1b56678640f9c02017d7"}, "warm_start_head": {"repo": "lmsys/SGLang-EAGLE3-Qwen3-Coder-30B-A3B-Instruct-SpecForge", "revision": "587f16873b7a8ef06eb8b9d0162508a9706c52b9"}, "ollama_gguf": {"tag": "qwen3-coder:30b", "sha256": "1194192cf2a187eb02722edcc3f77b11d21f537048ce04b67ccf8ba78863006a"}, "h`
- **Folders:**
  - `draft-head/` (2 files, 0.37 GB): the precomputed draft head chosen on validation prompts (ready to serve)
  - `checkpoints/` (2 files, 0.37 GB): every other trained head checkpoint (for re-selection or further training)
  - `training-data/` (2 files, 0.01 GB): the model's own answers the head was fitted on (regen.jsonl) and the prompts
  - `config.env/` (1 files, 0.00 GB): the pipeline configuration that produced the artifacts
  - `weights/` (23 files, 53.94 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `wan2.2-ti2v-5b`



- **Use:** 
- **Results:** -
- **Bound to:** `{"huggingface": [{"repo": "QuantStack/Wan2.2-TI2V-5B-GGUF", "file": "Wan2.2-TI2V-5B-Q8_0.gguf", "revision": "57437632ddd08bdcbd1508c866aa22e126ed51d2", "sha256": "57bece983817ab2f957546683bb670f13be7d99022d45674840cd999a050ea8f", "license": "apache-2.0"}, {"repo": "city96/umt5-xxl-encoder-gguf", "file": "umt5-xxl-encoder-Q8_0.gguf", "revision": "b535255bee98c2b0a59ea7c0ae2dcd0c6657b3b7", "sha256":`
- **Folders:**
  - `weights/` (3 files, 12.85 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `z-image-turbo`

Image pack (no Sushila artifacts yet): Z-Image-Turbo Q4_K + Qwen3-4B text encoder + FLUX VAE, mirrored from Hugging Face at pinned revisions.

- **Use:** stable-diffusion.cpp sd-server --diffusion-model z_image_turbo-Q4_K.gguf --llm Qwen3-4B-Instruct-2507-Q4_K_M.gguf --vae ae.safetensors --cfg-scale 1.0 --steps 8 (or Host Station pack z-image-turbo).
- **Results:** speed work in progress (sub-second plan): scripts/image/
- **Bound to:** `{"huggingface": [{"repo": "leejet/Z-Image-Turbo-GGUF", "file": "z_image_turbo-Q4_K.gguf", "revision": "c61c0e422dc8b541b7548cf33a4ef8302b0f8085", "sha256": "14b375ab4f226bc5378f68f37e899ef3c2242b8541e61e2bc1aff40976086fbd", "license": "apache-2.0"}, {"repo": "unsloth/Qwen3-4B-Instruct-2507-GGUF", "file": "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "revision": "a06e946bb6b655725eafa393f4a9745d460374c9", `
- **Folders:**
  - `weights/` (3 files, 6.70 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `z-image-turbo-nvidia`



- **Use:** 
- **Results:** -
- **Bound to:** `{"huggingface": [{"repo": "Tongyi-MAI/Z-Image-Turbo", "file": "model_index.json", "revision": "f332072aa78be7aecdf3ee76d5c247082da564a6", "sha256": "18a90e1bc117a29a8b7961bb200c86ff0b9704609e87c7171511dc724fcdc9d3", "license": "apache-2.0"}, {"repo": "Tongyi-MAI/Z-Image-Turbo", "file": "scheduler/scheduler_config.json", "revision": "f332072aa78be7aecdf3ee76d5c247082da564a6", "sha256": "3b979ab0956`
- **Folders:**
  - `weights/` (16 files, 12.24 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `z-image-turbo-nvidia-fp4`



- **Use:** 
- **Results:** -
- **Bound to:** `{"huggingface": [{"repo": "Tongyi-MAI/Z-Image-Turbo", "file": "model_index.json", "revision": "f332072aa78be7aecdf3ee76d5c247082da564a6", "sha256": "18a90e1bc117a29a8b7961bb200c86ff0b9704609e87c7171511dc724fcdc9d3", "license": "apache-2.0"}, {"repo": "Tongyi-MAI/Z-Image-Turbo", "file": "scheduler/scheduler_config.json", "revision": "f332072aa78be7aecdf3ee76d5c247082da564a6", "sha256": "3b979ab0956`
- **Folders:**
  - `weights/` (16 files, 12.43 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

### `z-image-turbo-q8`

Image pack, 8-bit Z-Image-Turbo (near-original quality); same text encoder and VAE.

- **Use:** as z-image-turbo with z_image_turbo-Q8_0.gguf (Host Station pack z-image-turbo-q8).
- **Results:** -
- **Bound to:** `{"huggingface": [{"repo": "leejet/Z-Image-Turbo-GGUF", "file": "z_image_turbo-Q8_0.gguf", "revision": "c61c0e422dc8b541b7548cf33a4ef8302b0f8085", "sha256": "df1c5baa86d1398c979495a6072dbcee79444fdb884a2445582ba0769c44e9a1", "license": "apache-2.0"}, {"repo": "unsloth/Qwen3-4B-Instruct-2507-GGUF", "file": "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "revision": "a06e946bb6b655725eafa393f4a9745d460374c9", `
- **Folders:**
  - `weights/` (3 files, 9.41 GB): the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)

## Restore anything

```sh
python3 scripts/precompute/b2_save.py verify precomputed/<model>                       # every listed file is in B2
python3 scripts/precompute/b2_save.py restore precomputed/<model> <dir> --only draft-head/   # checks every sha256
python3 scripts/precompute/sign_checksums.py check precomputed/<model>                # signature valid
```

Results of every run (timings, outputs, logs) are under `results/<model>/`; the paper's landscape notes under `results/paper-notes-landscape/`. Adding a model: `docs/ADD_A_MODEL.md`.

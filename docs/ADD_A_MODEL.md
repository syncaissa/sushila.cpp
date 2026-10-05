# Adding a model: precomputed draft head plus a comparison against vanilla Ollama

One config file and one command per model, on one 80 GB GPU. The pipeline is `scripts/precompute/`:

| File | Purpose |
|---|---|
| `models/<model>.env` | what is model-specific (below) |
| `run_model.sh` | every stage, resumable, for one model |
| `run_models.sh` | several models, one after another |
| `make_prompts.py` | all prompt sets, rendered with the model's own chat template |
| `regen.py` | the model's own answers (training data for the head) |
| `summarize.py` | `summary.md` and `summary.json` per model |

It reuses `scripts/bench70b/` for the benchmark clients, the SpecForge patch and the pod script.

## 1. Write the model's config

Here is `models/qwen3-32b.env`:

```sh
MODEL=qwen3-32b
TARGET=Qwen/Qwen3-32B-AWQ                    # 4-bit file served by SGLang (AWQ or GPTQ)
PUB_HEAD=AngelSlim/Qwen3-32B_eagle3          # published EAGLE-3 head to start from
OLLAMA_TAG=qwen3:32b                         # what Ollama users run
SF_TEMPLATE=qwen                             # SpecForge chat template: qwen or llama3
CHAT_KWARGS='{"enable_thinking": false}'     # chat-template options, used everywhere
SYSTEM_TURN=0                                # 1 if the template adds a default system turn (Llama 3.x)
# CTX=2048                                   # only if the published head declares a short context
```

Every setting a config can hold (defaults in brackets):

| Setting | Meaning |
|---|---|
| `MODEL` | folder name, also the B2 folder `precomputed/<MODEL>/` |
| `TARGET` | Hugging Face repo of the 4-bit file SGLang serves |
| `PUB_HEAD` | EAGLE-3 head to time as "published" and to warm-start ours from |
| `OLLAMA_TAG` | Ollama tag of the baseline; the run logs the model name stored in its GGUF |
| `SF_TEMPLATE` | SpecForge chat template (`llama3`, `qwen`, `deepseek-r1-distill`, `gemma`, ...); `regen.py` needs the same name in `HEADERS` |
| `CHAT_KWARGS` [`{}`] | chat-template options used everywhere, e.g. `{"enable_thinking": false}` |
| `SYSTEM_TURN` [0] | 1 if the template adds a default system turn |
| `CTX` [4096] | context length for SGLang; lower it to what the head declares |
| `PREFORMAT` [0] | 1: train on the exact prompt + answer text instead of re-rendering it with the chat template |
| `EMBED_KEY` [`model.embed_tokens.weight`] | tensor name of the token embedding in the 4-bit file |
| `LM_HEAD_KEY` [`lm_head.weight`] | tensor name of the output layer; for tied models, the embedding's name |
| `SGLANG_EXTRA` [empty] | extra SGLang flags for every SGLang server of this model (timing, answers, load test, comparison pod) |
| `TP` [1] | GPUs per model (tensor parallel) for SGLang and the hidden-state capture; models over ~70 GB at 4 bits need 2+ |
| `CAPTURE_MEM` [0.75] | GPU memory share for the hidden-state capture; raise it when the weights fill most of each GPU (Qwen3-235B: 0.88) |
| `GSM_SET` [`gsm8k`], `GSM_MAX` [512] | accuracy set and its token limit (reasoning models: `gsm40`, 1536) |

What you need for a new model:
- **A 4-bit file SGLang can serve.** Prefer the publisher's own AWQ or GPTQ release.
- **A published EAGLE-3 head.** Search Hugging Face for `<model> eagle3`, check `config.json`
  (`architectures: LlamaForCausalLMEagle3`), and read its license.
- **The Ollama tag.**

## 2. Rent a GPU and run

```sh
POD_NAME=sushila-mymodel bash scripts/bench70b/create_pod.sh     # one A100/H100 80GB, CUDA 13 driver
# copy the repository's scripts/ to the machine, then on it:
cd scripts/precompute
SMOKE=1 W=/workspace/sushila bash run_model.sh models/mymodel.env   # ~30 min: every stage on tiny inputs
W=/workspace/sushila bash run_models.sh models/mymodel.env          # the real run, about 3 hours for a 30B model
```

`W` is the work folder. The run log is `$W/<model>/run.log`, and the finished report is `$W/<model>/summary.md`.

## 3. What the run does, stage by stage

1. **Setup** (once per machine): CUDA toolkit, SGLang 0.5.21, SpecForge at commit `53398a8` plus our patch,
   and Ollama 0.35.1.
2. **Prompts.** The prompt sets are:
   - 26 main prompts;
   - 20 validation prompts;
   - 160 unseen prompts (MT-Bench 80, HumanEval 40, GSM8K 40);
   - GSM8K 100 for accuracy;
   - Dolly-15k prompts for training.

   All are rendered with the model's chat template.
3. **SGLang alone:** speed on main, unseen and temperature-0.7 prompts, plus GSM8K accuracy.
4. **SGLang with the published EAGLE-3 head:** the same speed runs.
5. **The model's own answers** to 2,000 training prompts: greedy, up to 512 tokens.
6. **Fine-tuning the published head**, 1,000 answers at a time; every checkpoint is kept.
7. **Choosing a checkpoint** by speed on the 20 validation prompts. It is never chosen on reported prompts.
8. **SGLang with the chosen precomputed head:** the same runs as in stage 3.
9. **Vanilla Ollama** with 16 CPU threads: the same runs. Containers often report more cores than they get, and
   Ollama then slows down (see `REPRODUCE_70B.md`).
10. **Summary:**
    - the speeds;
    - the cumulative steps: engine and format, then the published head, then our head;
    - 95% bootstrap intervals;
    - GSM8K accuracy;
    - how often speculative decoding left the text unchanged.

## Planned models

| Model | Status | What it needs |
|---|---|---|
| Qwen3-32B, Qwen3-30B-A3B | done (2026-10-04): results in `results/qwen3_20261004/`, precomputed artifacts and weights in B2 `precomputed/<model>/` | config in `models/` |
| DeepSeek-R1-Distill-Llama-70B | done (2026-10-05): `results/deepseek-r1-distill-llama-70b_20261005/`; B2 `precomputed/deepseek-r1-distill-llama-70b/` | config in `models/`; see the playbook below |
| Gemma 3 27B (Google) | running (2026-10-05); `models/gemma3-27b.env` | see the playbook below |
| Kimi-Dev-72B (Moonshot AI) | next for the paper; `models/kimi-dev-72b.env` has the findings | no published EAGLE-3 head: warm-start from the closest compatible one (`AQ-MedAI/Qwen2.5-VL-72B-Instruct-eagle3`) and refit; 4-bit GPTQ/AWQ files exist; Ollama via an imported GGUF; coding prompts |

## Model-family playbook (read before adding a new release)

Every problem below was found by a smoke run and fixed in the pipeline; the settings make the fix reusable. When a new
release of a family appears (a new Gemma, Qwen, Llama or DeepSeek model), copy that family's config, then check each
item for the new release. The same items are written as comments in each `models/*.env`.

**Llama 3.x** (`llama3.3-70b`, Llama-3.1-8B)
- Template `llama3`; `SYSTEM_TURN=1` (the template adds a dated system turn).
- Published heads: `lmsys/sglang-EAGLE3-...` declare a 2,048-token context: set `CTX=2048`.

**Qwen3** (`qwen3-32b`, `qwen3-30b-a3b`)
- Non-thinking mode everywhere: `CHAT_KWARGS='{"enable_thinking": false}'`; the Ollama client sends `think=false` for
  such prompts.
- **Ollama tags move.** `qwen3:30b-a3b` now holds the Thinking-2507 release, a different model; use the tag of the
  original release (`qwen3:30b-a3b-q4_K_M`) and check the GGUF name the run logs.
- **Check the head's shapes, not only its name.** `AngelSlim/Qwen3-32B_eagle3` has 80-wide attention heads (the model
  has 128) and crashed SGLang; `thoughtworks/Qwen3-32B-Eagle3` works. Some heads are labelled `LlamaForCausalLM` or
  lack `max_position_embeddings`: the pipeline relabels them and copies the model's context length.
- Published heads are often bfloat16 while the model is float16: the pipeline serves a dtype-matched copy.
- Single-file GPTQ checkpoints lack `model.safetensors.index.json`: the pipeline writes one.

**DeepSeek-R1 distills (reasoning models)** (`deepseek-r1-distill-llama-70b`)
- **No head is published for distills.** Use the head of the base model (here Llama-3.3-70B's) as the warm start and
  report it as the base model's head. On R1 it slowed decoding (0.85x); refitting gave 2.72x.
- **`PREFORMAT=1` is required.** R1's chat template deletes everything before `</think>` in assistant turns, so a head
  trained through it would learn final answers, not the reasoning it must predict.
- SpecForge's `deepseek-r1-distill` template had no end token and crashed; our SpecForge patch sets it.
- Long outputs: `GSM_SET=gsm40`, `GSM_MAX=1536`; GSM8K is graded on the text after `</think>`.
- At 64 users the head costs throughput (0.25x on a 70B model): report the load test.

**Gemma 3** (`gemma3-27b`)
- Multimodal checkpoint (`Gemma3ForConditionalGeneration`): weights are under `language_model.`, so
  `EMBED_KEY=language_model.model.embed_tokens.weight`.
- **Tied output layer** (no `lm_head` tensor): `LM_HEAD_KEY` = the embedding's name.
- `PREFORMAT=1`: Gemma's template folds any system prompt into the user turn, and SpecForge's `gemma` template adds one.
- **SGLang 0.5.21 crashes on Gemma 3 with the "breakable" prefill CUDA graph** (FlashInfer: `q.shape[0] (8) does not
  match qo_indptr[-1] (7)`): `SGLANG_EXTRA="--cuda-graph-backend-prefill disabled"` (prompt processing without a CUDA
  graph; decoding keeps its graphs). Retest without it on newer SGLang versions.
- 4-bit files: Google publishes QAT (quantization-aware) int4 checkpoints; `gaunernst/...-int4-awq` is their AWQ form.
  Ollama's default tag (`gemma3:27b`) is an ordinary Q4_K_M, and the QAT build is a separate tag (`...-it-qat`). State
  which one each engine reads; GSM8K checks answer quality.
- The only head (2026-10) is a community head trained from scratch (`witcheer/...`): expect a large gain from refitting.

**Very large MoE models** (`qwen3-235b-a22b`)
- Two 80 GB GPUs: `TP=2` (and `GPUS=2 DISK_GB=500` for the pod); `CAPTURE_MEM=0.88`, because the weights take 75% of
  each GPU.
- SGLang 0.5.21 hung capturing the prefill CUDA graph with the head at `TP=2`: `SGLANG_EXTRA="--cuda-graph-backend-prefill disabled"`.
- PCIe pods without NVLink print "custom allreduce failed": harmless, but slower than NVLink.
- Ollama's `qwen3:235b` tag holds Thinking-2507; the original release is `qwen3:235b-a22b-q4_K_M`.

**Any family: when a new release appears**
1. Search Hugging Face for a 4-bit file (`<model> awq`, `gptq`, `int4`) and an EAGLE-3 head (`<model> eagle3`); read
   both `config.json` files: architecture, hidden size, attention head width (`head_dim`), vocabulary, context length,
   `tie_word_embeddings`, dtype, and the tensor names in `model.safetensors.index.json`.
2. Check that SGLang supports EAGLE-3 for the model class (`set_eagle3_layers_to_capture` in
   `sglang/srt/models/<family>.py`) and that SpecForge has a template for it.
3. Check the Ollama tag holds the same release (the run logs the GGUF's `general.name`).
4. Copy the family's config, run the smoke run (`SMOKE=1`, about 30 minutes, about $1), fix what it finds, and add
   the fix as a setting, not an edit to the scripts, then add the finding to this playbook.
5. Full run; then `mirror_weights.sh` on the pod; `b2_save.py verify precomputed/<model>` from another machine;
   `sign_checksums.py sign precomputed/<model>` on the signing machine (this also refreshes the catalogue
   `precomputed/INDEX.json`, `README.md` and `docs/PRECOMPUTED.md`); only then delete the pod. Never delete anything under
   `precomputed/` in B2. Add the model's purpose and usage to `NOTES` in `scripts/precompute/b2_index.py`.

## When a model has no published draft head

A *draft head* is a small one-layer network that reads the model's internal state and guesses its next tokens; the
model checks the guesses in one pass. Heads are trained per model. When nobody has published one for a model:

1. **Warm start from a compatible head (easy, same cost as a normal run).** A head can be reused when the draft head's
   shapes match: the model's hidden size and vocabulary. Heads made for the base model of a fine-tune, or for a sibling
   model, qualify. The pipeline refits the head to the new model's own answers, which is exactly what it does for
   published heads. Report it as "closest published head", since it was not made for this model.
2. **Train from scratch (harder).** SpecForge can train a head from random weights. It needs many more of the model's
   own answers (likely tens of thousands instead of 2,000) and several times the GPU hours. `run_model.sh` does not
   have this option yet: it needs a "no starting head" setting in the model's config and a larger answer count.

Kimi-Dev-72B (2026-10-04) is case 1: there is no head for it or for Qwen2.5-72B, but an EAGLE-3 head for Qwen2.5-VL-72B
has the same shapes.

## 4. Publish the artifacts

After the run:

1. Upload the chosen head (`$W/<model>/head_chunk_NN/`) to B2 under
   `models/<model id>/sushila/` (`website/setup/b2_upload.sh artifact …`).
2. Add the model on the sushila.ai admin page (Models tab).
3. Write a `manifest.json` next to the model file so Sushila.cpp loads the head automatically
   (`INSTALL.md`, section 6a).

## Costs and times (one A100 80GB at about $1.6/h)

| Model | Time | Cost |
|---|---|---|
| Llama-3.3-70B (6,000 answers, our first run) | about 8 h | $13 |
| 30B-class model (2,000 answers) | about 3 h | $5 |
| DeepSeek-R1-Distill-Llama-70B (2,000 answers, reasoning) | about 5.5 h plus 3 smoke runs | $11 |
| Weights to B2 (`mirror_weights.sh`, per 70B model) | about 10 min | included |

The smoke run first costs about $1 and catches setup problems before the full run.

## Saving everything for reuse (Backblaze B2)

Precomputed work is computed once and reused for every request, so it must never be lost. `run_model.sh` saves it to
the `sushila-ai` bucket as soon as the head is chosen, and again at the end. It uses `b2_save.py` with a B2 key, given
as `B2_KEY_ID`/`B2_APP_KEY` or as `~/.b2_key` (two lines). Without a key the run log warns on every save.

```
precomputed/<model>/
  CHECKSUMS.json     what the artifacts are bound to (SGLang model and revision, warm-start head, Ollama GGUF sha256),
                     how to serve them, and the sha256 and size of every file below
  draft-head/        the precomputed draft head chosen on validation prompts
  checkpoints/       every other trained checkpoint
  training-data/     the model's own answers (regen.jsonl) and the prompts
  config.env         the pipeline config
results/<model>/     timings, outputs, logs and summary of the run
```

```sh
python3 scripts/precompute/b2_save.py precomputed $W <model> scripts/precompute/models/<model>.env
python3 scripts/precompute/b2_save.py verify precomputed/<model>      # run this before deleting the machine
python3 scripts/precompute/b2_save.py restore precomputed/<model> $W/<model>/head_ckpt_chunk_01 --only draft-head/
#   reuse a saved head on a new machine: write its path into $W/<model>/chosen.txt and run_model.sh skips training
```

The model's own files are kept in B2 too, so serving and the sushila.ai **Compare Speeds** page never download from
Hugging Face or Ollama. On the pod, after the run:

```sh
bash scripts/precompute/mirror_weights.sh models/<model>.env   # weights/sglang/ (HF revision in CHECKSUMS.json) and
                                                               # weights/ollama/ (manifest + blobs); refuses a moved tag
```

**Never delete anything under `precomputed/` in B2**: heads, checkpoints, landscapes, training answers and weights are
kept so any result can be retested or demonstrated later.

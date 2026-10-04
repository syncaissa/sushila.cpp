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
| Qwen3-32B, Qwen3-30B-A3B | running (2026-10-04) | config in `models/` |
| DeepSeek-R1-Distill-Llama-70B | next for the paper; `models/deepseek-r1-distill-llama-70b.env` has the checklist | a 4-bit release; a published EAGLE-3 head, or a "train from scratch" path (not built yet); longer outputs (reasoning) |
| Gemma 3 27B (Google) | next for the paper; `models/gemma3-27b.env` has the checklist | a 4-bit release; an EAGLE-3 head or the from-scratch path; a Gemma chat template in SpecForge and `regen.py`; SGLang speculative support for Gemma 3 (sliding-window attention, multimodal) |
| Kimi-Dev-72B (Moonshot AI) | candidate; `models/kimi-dev-72b.env` has the findings | no published EAGLE-3 head: warm-start from the closest compatible one (`AQ-MedAI/Qwen2.5-VL-72B-Instruct-eagle3`) and refit; 4-bit GPTQ/AWQ files exist; Ollama via an imported GGUF; coding prompts |

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

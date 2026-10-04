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
| DeepSeek-R1-Distill-Llama-70B | planned; `models/deepseek-r1-distill-llama-70b.env` has the checklist | a 4-bit release; a published EAGLE-3 head, or a "train from scratch" path (not built yet); longer outputs (reasoning) |

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

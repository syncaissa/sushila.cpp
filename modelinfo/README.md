# modelinfo: the exact files behind every result

Every model, draft head and dataset our experiments used is pinned here: source, exact revision, size, and the
sha256 of each file. The sha256 is the file's content fingerprint, so anyone can fetch byte-identical copies and
verify them.

| File | What it is |
|---|---|
| `MODELS.md` | readable table: what each file is and which result uses it |
| `models.json` | the full record: every file of every repository, with size and sha256 |
| `fetch.py` | downloads any pinned item and checks every byte (`python3 fetch.py --list`) |
| `collect.py` | regenerates the two files above from Hugging Face and the Ollama registry |

## Why the weights themselves are not in this repository

The files are 1-43 GB each and about 150 GB in total. GitHub's limits:

| | Limit |
|---|---|
| Normal git file | rejected above 100 MB |
| Git LFS file | 2 GB on Free and Pro plans (5 GB on Enterprise) |
| Git LFS storage | about 10 GB on Free plans |
| Repository | GitHub recommends keeping it under a few GB |

Pinning by revision and sha256 is exact. Hugging Face serves a repository at a fixed commit forever, and Ollama's
registry serves files by their sha256. A file that no longer matches is rejected by `fetch.py`.

**Mirror:** sushila.ai keeps its own copies in Backblaze B2 (bucket `sushila-ai`, `models/<model id>/`), in case an
upstream source disappears. The sha256 values here identify those copies too.

## Our own precomputed artifacts

| Artifact | Where | Status |
|---|---|---|
| Output-layer landscapes (`.mclp`) | rebuilt from the model file by `scripts/day0_landscape.sh` (deterministic, sha256 in each manifest) | reproducible from this repository |
| Precomputed draft heads: Llama-3.1-8B, Llama-3.3-70B | built by `scripts/bench70b/day0_head_70b.sh` and `scripts/precompute/run_model.sh` | the head files from those runs were not kept when the rented machines were deleted; rerunning the pipeline rebuilds them (about $5-13 each), and every measured output is in `results/` |
| Precomputed draft heads: Qwen3-32B, Qwen3-30B-A3B | `scripts/precompute/run_model.sh` | will be uploaded to B2 (`models/<model id>/sushila/`) and pinned here with sha256 |

## Licenses

Each model keeps its own license; see each Hugging Face repository and `configs/models.tsv`:
- Llama models: Llama Community License.
- Qwen models: Apache-2.0.
- AngelSlim heads: the AngelSlim model license.

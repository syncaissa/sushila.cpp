# Model packs: one table, kept consistent with B2

Every model pack the Sushila apps (Station, the browser page, `sushila install`) can install is a row in the DynamoDB
table **sushilaai-model-packs**. The sushila.ai worker builds the catalog from the rows with `active = true`; each pack's
files are in B2 under `precomputed/<model>/` (private) and `public/precomputed/<model>/` (served by files.sushila.ai),
checked against the pack's signed `CHECKSUMS.json`. The table also records where every file came from (Hugging Face
repo, file and exact revision, or the Ollama model, or "made by Sushila" for landscapes, heads and manifests), so the
original can be fetched from there instead of from us.

Tool: `scripts/model_packs.py` (AWS credentials as for the AWS CLI; B2 from `~/.b2_env` or `~/.b2_key`).

| Command | What it does |
|---|---|
| `list` | every pack: active, order, B2 folder, name |
| `show <pack>` | one row in full (definition and sources) |
| `check [<pack>...]` | the table against B2: signature valid, every file in `precomputed/` and `public/` with the signed size, sources equal to the signed ones |
| `deactivate <pack>` / `activate <pack>` | hide it from the apps or offer it again (within 10 minutes); B2 is not touched |
| `put <row.json>` | add or replace a row (checked like the worker checks it) |
| `populate <pack>` | fetch its Hugging Face files straight into B2 (streams; run on a pod for large packs) |
| `sign <pack>` | sign its `CHECKSUMS.json` (only on the signing machine, which holds `~/.sushila_signing_key`) |
| `publish <pack>` | copy its catalog files to `public/` |

## Adding a model

1. Write `row.json`:
   ```json
   {"packId": "my-model-q4km", "order": 140, "active": false, "b2Prefix": "precomputed/my-model-q4km",
    "definition": {"category": "Text (LLM)", "name": "My Model (4-bit)", "description": "...", "license": "Apache-2.0",
                   "licenseUrl": "https://huggingface.co/org/my-model", "minRamGB": 8, "artifacts": [],
                   "files": [["weights/gguf/my-model-Q4_K_M.gguf", "my-model-Q4_K_M.gguf", "weights"]],
                   "serve": {"model": "my-model-Q4_K_M.gguf", "args": []}},
    "sources": [{"src": "weights/gguf/my-model-Q4_K_M.gguf", "type": "huggingface", "repo": "org/my-model-GGUF",
                 "file": "my-model-Q4_K_M.gguf", "revision": "<commit>", "sha256": "<sha256>"}]}
   ```
2. `model_packs.py put row.json` (inactive: nobody sees it yet)
3. `model_packs.py populate my-model-q4km` (on a pod), then on the signing machine `sign`, then `publish`
4. `model_packs.py check my-model-q4km` must print OK
5. `model_packs.py activate my-model-q4km`

The worker falls back to its built-in list (`HOST_PACKS` in worker.js) only when the table cannot be read; nothing in
the table needs a signature, and the apps refuse any file that does not match the pack's signed index.

# Public files: files.sushila.ai/public/

The B2 bucket `sushila-ai` is private. Users download only through `https://files.sushila.ai/public/<key>`, a Cloudflare
Worker (source: `CF_LINK_TO_Blackblaze/worker-link.js`, outside this repository) that serves keys under `public/` and
returns 404 for everything else. Cloudflare and Backblaze are Bandwidth Alliance partners: no B2 egress for these
downloads. Links never show the storage provider and need no tokens.

What is public (a copy of the original key under `public/`):
- `public/hoststation/...`: engines, runtimes, installers and their signed lists (LATEST.json + .sig)
- `public/precomputed/<pack>/...`: exactly the files the website catalog offers per pack (`scripts/public_catalog_keys.txt`)
  plus each pack's CHECKSUMS.json + .sig
- `public/temp/...`: samples shared with people

What stays private: other weights (e.g. Kimi-Dev-72B, Gemma, Qwen3-235B), training data, checkpoints, results, evidence
archives, snapshots.

How to publish:
- after signing new engines/installers/runtimes: `python3 scripts/b2_publish_public.py hoststation/`
- a new catalog pack: add its keys to `scripts/public_catalog_keys.txt`, then `python3 scripts/b2_publish_public.py --keys-file scripts/public_catalog_keys.txt`
- the script copies server-side (no download, no egress), skips files already public with the same size and SHA-1, and
  keeps the originals (never delete under `precomputed/`).

The website catalog (`website/worker.js`, `FILES_BASE`) gives the app links on sushila.ai's counting route
(`/hoststation/get/...`), which redirects to `files.sushila.ai/public/...`; the app (Rust and JavaScript allow-lists) only
downloads from sushila.ai, files.sushila.ai/public/, Hugging Face and Ollama, and checks every file against Sushila's
signed index.

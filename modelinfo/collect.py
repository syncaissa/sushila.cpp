#!/usr/bin/env python3
"""Pin every model, draft head and dataset file the experiments used: exact source, revision, size and sha256.
Writes models.json (machine-readable) and MODELS.md (readable). Re-run to refresh; fetch.sh downloads and verifies.

Sources: Hugging Face (repo at a fixed commit; LFS files carry their sha256) and the Ollama registry (GGUF blobs are
content-addressed by sha256). Weights are not stored in git (files are 1-43 GB; GitHub rejects files over 100 MB).
"""
import hashlib
import json
import time
import urllib.request

HF = [  # (repo, role, used for)
    ('casperhansen/llama-3.3-70b-instruct-awq', 'target, AWQ 4-bit', 'Llama-3.3-70B in SGLang (paper Tables: day-0 heads, stack, robustness, Ollama comparison)'),
    ('lmsys/sglang-EAGLE3-LLaMA3.3-Instruct-70B', 'published EAGLE-3 head', 'Llama-3.3-70B: published head; warm start of our precomputed head'),
    ('yuhuili/EAGLE3-LLaMA3.3-Instruct-70B', 'published EAGLE-3 head', 'Llama-3.3-70B in llama.cpp (chain drafting, Table eagle)'),
    ('unsloth/Llama-3.3-70B-Instruct', 'tokenizer and config (16-bit model)', 'converting EAGLE-3 heads to GGUF for llama.cpp'),
    ('unsloth/Llama-3.1-8B-Instruct', 'target, 16-bit', 'Llama-3.1-8B in SGLang (day-0 head 1.86x -> 2.29x); tokenizer'),
    ('lmsys/sglang-EAGLE3-LLaMA3.1-Instruct-8B', 'published EAGLE-3 head', 'Llama-3.1-8B: published head; warm start of our head'),
    ('yuhuili/EAGLE3-LLaMA3.1-Instruct-8B', 'published EAGLE-3 head', 'Llama-3.1-8B in llama.cpp (tree verification, draft landscape)'),
    ('Qwen/Qwen3-32B-AWQ', 'target, AWQ 4-bit', 'Qwen3-32B in SGLang'),
    ('AngelSlim/Qwen3-32B_eagle3', 'published EAGLE-3 head', 'Qwen3-32B: published head; warm start of our head'),
    ('Qwen/Qwen3-30B-A3B-GPTQ-Int4', 'target, GPTQ 4-bit (MoE)', 'Qwen3-30B-A3B in SGLang'),
    ('AngelSlim/Qwen3-a3B_eagle3', 'published EAGLE-3 head', 'Qwen3-30B-A3B: published head; warm start of our head'),
]
OLLAMA = [  # (library repo, tag, used for)
    ('llama3.3', '70b', 'vanilla Ollama baseline, Llama-3.3-70B'),
    ('llama3.1', '70b', 'Ollama baseline and Sushila.cpp (same file), Llama-3.1-70B; 1B-draft results'),
    ('llama3.1', '8b', 'Ollama baseline and Sushila.cpp, Llama-3.1-8B; landscapes; tree verification'),
    ('llama3.1', '8b-instruct-q8_0', 'Llama-3.1-8B Q8_0 (EAGLE-3 diagnostic)'),
    ('llama3.2', '3b', 'Ollama baseline and Sushila.cpp, Llama-3.2-3B; 3B draft'),
    ('llama3.2', '1b', 'the 1B draft model'),
    ('qwen2.5', '7b', 'output-layer landscape (Qwen2.5-7B)'),
    ('qwen2.5', '0.5b', 'CPU landscape kernel (1.13-1.26x); day-0 pipeline demo'),
    ('qwen3', '30b-a3b', 'MoE expert count; Ollama baseline Qwen3-30B-A3B'),
    ('qwen3', '32b', 'Ollama baseline Qwen3-32B'),
]
DATA = [  # (name, url, used for)
    ('databricks-dolly-15k.jsonl', 'https://huggingface.co/datasets/databricks/databricks-dolly-15k/resolve/main/databricks-dolly-15k.jsonl',
     'training prompts (rows 0..N), evaluation (-40..-21), validation (-20..-1)'),
    ('mt_bench question.jsonl', 'https://raw.githubusercontent.com/lm-sys/FastChat/main/fastchat/llm_judge/data/mt_bench/question.jsonl', 'MT-Bench first turns'),
    ('openai_humaneval test parquet', 'https://huggingface.co/datasets/openai/openai_humaneval/resolve/main/openai_humaneval/test-00000-of-00001.parquet', 'HumanEval, first 40'),
    ('gsm8k test parquet', 'https://huggingface.co/datasets/openai/gsm8k/resolve/main/main/test-00000-of-00001.parquet', 'GSM8K test, first 100'),
    ('wikitext-2-raw-v1.zip', 'https://huggingface.co/datasets/ggml-org/ci/resolve/main/wikitext-2-raw-v1.zip', 'perplexity (scripts/get_data.sh)'),
]


def get(url, accept=None, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'Accept': accept} if accept else {})
            return urllib.request.urlopen(req, timeout=120).read()
        except Exception:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(3 * (i + 1))


out = {'generated_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()), 'huggingface': [], 'ollama': [], 'datasets': []}
for repo, role, use in HF:
    d = json.loads(get(f'https://huggingface.co/api/models/{repo}/revision/main?blobs=true'))
    files = [{'file': s['rfilename'], 'bytes': s.get('size'), 'sha256': (s.get('lfs') or {}).get('sha256')} for s in d['siblings']]
    out['huggingface'].append({'repo': repo, 'revision': d['sha'], 'role': role, 'used_for': use, 'license': (d.get('cardData') or {}).get('license'),
                               'bytes': sum(f['bytes'] or 0 for f in files), 'files': files})
    print('hf', repo, d['sha'][:10], len(files))
for lib, tag, use in OLLAMA:
    m = json.loads(get(f'https://registry.ollama.ai/v2/library/{lib}/manifests/{tag}', 'application/vnd.docker.distribution.manifest.v2+json'))
    layers = [{'media_type': l['mediaType'].split('.')[-1], 'digest': l['digest'], 'bytes': l['size']} for l in m['layers']]
    gguf = next(l for l in layers if l['media_type'] == 'model')
    out['ollama'].append({'model': f'{lib}:{tag}', 'used_for': use, 'gguf_sha256': gguf['digest'].split(':')[1], 'gguf_bytes': gguf['bytes'],
                          'gguf_url': f"https://registry.ollama.ai/v2/library/{lib}/blobs/{gguf['digest']}", 'layers': layers})
    print('ollama', lib, tag, gguf['digest'][:19])
for name, url, use in DATA:
    b = get(url)
    out['datasets'].append({'name': name, 'url': url, 'used_for': use, 'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()})
    print('data', name, len(b))
json.dump(out, open('models.json', 'w'), indent=1)

gb = lambda b: f'{b / 1e9:.2f} GB' if b and b > 1e8 else f'{(b or 0) / 1e6:.1f} MB'
md = ['# Model and data files used', '', f"Pinned {out['generated_utc']} by `collect.py`. Full lists of files with sha256: `models.json`. "
      'Download and verify: `fetch.sh`.', '', '## Hugging Face (repository at a fixed commit)', '',
      '| Repository | Revision | Size | Role | Used for |', '|---|---|---:|---|---|']
md += [f"| `{h['repo']}` | `{h['revision'][:12]}` | {gb(h['bytes'])} | {h['role']} | {h['used_for']} |" for h in out['huggingface']]
md += ['', '## Ollama registry (GGUF files, content-addressed)', '', '| Model | GGUF sha256 | Size | Used for |', '|---|---|---:|---|']
md += [f"| `{o['model']}` | `{o['gguf_sha256'][:16]}…` | {gb(o['gguf_bytes'])} | {o['used_for']} |" for o in out['ollama']]
md += ['', '## Datasets', '', '| File | sha256 | Size | Used for |', '|---|---|---:|---|']
md += [f"| {x['name']} | `{x['sha256'][:16]}…` | {gb(x['bytes'])} | {x['used_for']} |" for x in out['datasets']]
open('MODELS.md', 'w').write('\n'.join(md) + '\n')
print('wrote models.json, MODELS.md')

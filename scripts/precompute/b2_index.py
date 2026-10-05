#!/usr/bin/env python3
"""Write the catalogue of everything precomputed in B2, so nothing is lost or forgotten and all of it can be reused.

Reads every precomputed/<model>/CHECKSUMS.json (and its signature) in bucket sushila-ai and writes:
  b2://sushila-ai/precomputed/INDEX.json   machine-readable list (models, groups, sizes, signed, how to serve)
  b2://sushila-ai/precomputed/README.md    the same for people
  docs/PRECOMPUTED.md                      the same, in the repository
Run it after every new model, re-save, weights mirror or signing:  python3 scripts/precompute/b2_index.py
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import b2_save  # noqa: E402

# what each model's precomputed work is for, and where its results are (kept here so the index explains itself)
NOTES = {
    'qwen2.5-0.5b-q4km': {
        'what': 'Output-layer landscape for Qwen2.5-0.5B-Instruct Q4_K_M (CPU decoding 1.13-1.26x faster with identical output; '
                'the paper\'s per-model pipeline example). Default model of Sushila Host Station.',
        'use': 'Sushila.cpp reads it automatically: put landscape/{manifest.json,landscape.mclp} in <model>.gguf.sushila/ next to '
               'weights/gguf/qwen2.5-0.5b-q4km.gguf (or install the Host Station pack qwen2.5-0.5b-q4km).',
        'results': 'paper: output-layer landscape sections; Paper/notes/landscape (B2 results/paper-notes-landscape/)'},
    'qwen3-32b': {
        'what': 'EAGLE-3 draft head refitted to Qwen3-32B\'s own answers (warm start thoughtworks/Qwen3-32B-Eagle3); 3.14x vs Ollama.',
        'use': 'SGLang: --speculative-algorithm EAGLE3 --speculative-num-steps 4 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16 '
               '--speculative-draft-model-path draft-head/ with weights/sglang/ (Qwen/Qwen3-32B-AWQ). Host Station pack: GGUF only.',
        'results': 'results/qwen3-32b/ and forGithub/results/qwen3_20261004/'},
    'qwen3-30b-a3b': {
        'what': 'EAGLE-3 draft head refitted to Qwen3-30B-A3B (MoE) (warm start AngelSlim/Qwen3-a3B_eagle3); 1.65x vs Ollama; keeps '
                'throughput at 64 users.',
        'use': 'SGLang as for qwen3-32b, with weights/sglang/ (Qwen/Qwen3-30B-A3B-GPTQ-Int4).',
        'results': 'results/qwen3-30b-a3b/ and forGithub/results/qwen3_20261004/'},
    'deepseek-r1-distill-llama-70b': {
        'what': 'EAGLE-3 draft head for the reasoning model, refitted from the Llama-3.3-70B head (none published for R1), trained '
                'on R1\'s full reasoning text; 3.64x vs Ollama, 2.30x over SGLang alone.',
        'use': 'SGLang as above (--context-length 2048) with weights/sglang/ (casperhansen/deepseek-r1-distill-llama-70b-awq).',
        'results': 'results/deepseek-r1-distill-llama-70b/ and forGithub/results/deepseek-r1-distill-llama-70b_20261005/'},
    'z-image-turbo': {
        'what': 'Image pack (no Sushila artifacts yet): Z-Image-Turbo Q4_K + Qwen3-4B text encoder + FLUX VAE, mirrored from Hugging '
                'Face at pinned revisions.',
        'use': 'stable-diffusion.cpp sd-server --diffusion-model z_image_turbo-Q4_K.gguf --llm Qwen3-4B-Instruct-2507-Q4_K_M.gguf '
               '--vae ae.safetensors --cfg-scale 1.0 --steps 8 (or Host Station pack z-image-turbo).',
        'results': 'speed work in progress (sub-second plan): scripts/image/'},
    'z-image-turbo-q8': {
        'what': 'Image pack, 8-bit Z-Image-Turbo (near-original quality); same text encoder and VAE.',
        'use': 'as z-image-turbo with z_image_turbo-Q8_0.gguf (Host Station pack z-image-turbo-q8).',
        'results': '-'},
}
GROUP_DOC = {
    'draft-head': 'the precomputed draft head chosen on validation prompts (ready to serve)',
    'checkpoints': 'every other trained head checkpoint (for re-selection or further training)',
    'training-data': "the model's own answers the head was fitted on (regen.jsonl) and the prompts",
    'weights': 'the model files themselves (sglang/: the 4-bit file SGLang serves; ollama/: the GGUF Ollama serves; or the pack files)',
    'landscape': 'the precomputed output-layer landscape (manifest.json + .mclp) and its held-out validation data',
    'landscapes-earlier': 'earlier landscape builds used in the paper',
    'calibration': 'calibration activations and imatrix used to build the landscape',
    'config.env': 'the pipeline configuration that produced the artifacts',
}


def get(b2, name):
    return urllib.request.urlopen(urllib.request.Request(f"{b2_save._download_url(b2)}/file/{b2.bucket}/{urllib.parse.quote(name)}",
                                                         headers={'Authorization': b2.tok}), timeout=120).read()


def main():
    b2 = b2_save.B2()
    names = b2.existing('precomputed/')
    models = sorted({n.split('/')[1] for n in names if n.count('/') >= 2})
    out = {'bucket': b2.bucket, 'generated_utc': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime()),
           'signing_key': 'Ed25519 Z1PIla052/oI3aZmZvsgB/V3lZUrqnjEoJEeYv4OwTs= (scripts/precompute/sign_checksums.py)', 'models': []}
    for m in models:
        pre = f'precomputed/{m}'
        if f'{pre}/CHECKSUMS.json' not in names:
            out['models'].append({'model': m, 'warning': 'no CHECKSUMS.json'})
            continue
        c = json.loads(get(b2, f'{pre}/CHECKSUMS.json'))
        groups = {}
        for f in c.get('files', []):
            g = f['path'].split('/')[0]
            groups.setdefault(g, {'files': 0, 'bytes': 0})
            groups[g]['files'] += 1
            groups[g]['bytes'] += f.get('bytes', 0)
        n = NOTES.get(m, {})
        out['models'].append({'model': m, 'prefix': pre + '/', 'signed': f'{pre}/CHECKSUMS.json.sig' in names, 'saved_utc': c.get('saved_utc'),
                              'bound_to': c.get('bound_to'), 'groups': groups, 'total_bytes': sum(g['bytes'] for g in groups.values()),
                              'what': n.get('what', ''), 'use': n.get('use', c.get('how_to_serve', '')), 'results': n.get('results', '')})
    md = ['# Precomputed work in B2 (bucket `sushila-ai`)', '',
          f'Generated {out["generated_utc"]} by `scripts/precompute/b2_index.py`. Everything here was computed once and is kept '
          'forever (never delete under `precomputed/`). Each folder has one `CHECKSUMS.json` listing every file with its sha256, '
          'and `CHECKSUMS.json.sig`, an Ed25519 signature checked by Sushila Host Station.', '',
          '| Model | Contents | Size | Signed | Saved |', '|---|---|---:|:---:|---|']
    for x in out['models']:
        if 'warning' in x:
            md.append(f'| `{x["model"]}` | **{x["warning"]}** | | | |')
            continue
        md.append(f'| `{x["model"]}` | ' + ', '.join(f'{g} ({v["files"]})' for g, v in x['groups'].items()) +
                  f' | {x["total_bytes"] / 1e9:.1f} GB | {"yes" if x["signed"] else "**no**"} | {(x["saved_utc"] or "")[:10]} |')
    md += ['', '## Each model', '']
    for x in out['models']:
        if 'warning' in x:
            continue
        md += [f'### `{x["model"]}`', '', x['what'] or '', '', f'- **Use:** {x["use"]}', f'- **Results:** {x["results"] or "-"}',
               f'- **Bound to:** `{json.dumps(x["bound_to"])[:400]}`', '- **Folders:**']
        md += [f'  - `{g}/` ({v["files"]} files, {v["bytes"] / 1e9:.2f} GB): {GROUP_DOC.get(g, "")}' for g, v in x['groups'].items()]
        md.append('')
    md += ['## Restore anything', '', '```sh',
           'python3 scripts/precompute/b2_save.py verify precomputed/<model>                       # every listed file is in B2',
           'python3 scripts/precompute/b2_save.py restore precomputed/<model> <dir> --only draft-head/   # checks every sha256',
           'python3 scripts/precompute/sign_checksums.py check precomputed/<model>                # signature valid',
           '```', '', 'Results of every run (timings, outputs, logs) are under `results/<model>/`; the paper\'s landscape notes under '
           '`results/paper-notes-landscape/`. Adding a model: `docs/ADD_A_MODEL.md`.', '']
    text = '\n'.join(md)
    b2.put('precomputed/INDEX.json', json.dumps(out, indent=1).encode())
    b2.put('precomputed/README.md', text.encode())
    doc = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'docs', 'PRECOMPUTED.md')
    open(doc, 'w').write(text)
    print(text.split('## Each model')[0])
    print(f'wrote b2://{b2.bucket}/precomputed/INDEX.json, README.md and docs/PRECOMPUTED.md')


if __name__ == '__main__':
    main()

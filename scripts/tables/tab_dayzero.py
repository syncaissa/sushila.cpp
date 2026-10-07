#!/usr/bin/env python3
"""tab:dayzero -- precomputed draft heads (ours) vs the published EAGLE-3 heads, SGLang tree drafting, one A100.

Raw files (per-prompt JSON lists, one entry per prompt in the order of the 26 evaluation prompts: 20 held-out Dolly
instructions, then 6 other prompts; keys tokens, seconds, accept_len):
  Llama-3.1-8B (16-bit):  results/research/results_l70all_20261003/sgl/out/
      base_tmpl.json (SGLang alone), eagle3_tree_tmpl.json (published lmsys head),
      eagle3_tree_dayzero_tmpl.json (precomputed head)            -- pod_sglang_eagle.sh / pod_dayzero_*.sh
      prompt order: results/research/results_l70all_20261003/ngram8b/eval_prompts.txt (pod_ngram.sh)
  Llama-3.3-70B (AWQ):    results/70b_day0/out/  base.json, pub_tree.json, dz_ck00_tree.json (1,000 answers),
      dz_ck00_s4n16.json (1,000, 16-token tree), dz_full_tree.json (6,000), dz_full_tree_s4n16.json,
      dz_ck01_s4n16.json (2,000 answers, chosen checkpoint)       -- scripts/bench70b/
Reported prompts: the 26 minus those whose stock answer (base) is shorter than 50 tokens.
Speedup: median (range) over prompts of (tokens/seconds) / (tokens/seconds of base, same prompt). Tokens/s: total
tokens / total seconds over the reported prompts. Tokens/pass: mean accept_len over the reported prompts.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

N_DOLLY = 20          # prompts 0-19 are Dolly, 20-25 the other six (pod_ngram.sh / scripts/bench70b/prompts.py)


def load(path):
    with open(path) as f:
        return json.load(f)


def rows_for(t, model, base_path, heads, tps_dec, check_order=None):
    base = load(base_path)
    assert len(base) == 26
    keep = [i for i, x in enumerate(base) if x['tokens'] >= 50]
    bt = {i: base[i]['tokens'] / base[i]['seconds'] for i in range(26)}
    src0 = C.rel(base_path)
    t.add(f'{model}: SGLang alone', 'Tokens/s', sum(base[i]['tokens'] for i in keep) / sum(base[i]['seconds'] for i in keep),
          1, src0, 'stock speed in the caption (total tokens / total time, reported prompts)')
    t.add(f'{model}: SGLang alone', 'reported prompts', len(keep), 0, src0, 'prompts whose stock answer has >= 50 tokens')
    t.add(f'{model}: SGLang alone', 'reported Dolly', sum(1 for i in keep if i < N_DOLLY), 0, src0)
    t.add(f'{model}: SGLang alone', 'reported other', sum(1 for i in keep if i >= N_DOLLY), 0, src0)
    for fname, row in heads:
        f = os.path.join(os.path.dirname(base_path), fname)
        e = load(f)
        assert len(e) == 26
        r = {i: (e[i]['tokens'] / e[i]['seconds']) / bt[i] for i in range(26)}
        rk = [r[i] for i in keep]
        src = f'{C.rel(f)} vs {os.path.basename(base_path)}'
        name = f'{model}: {row}'
        t.add(name, 'Speedup', C.median(rk), 2, src, unit='x')
        t.add(name, 'Speedup min', min(rk), 2, src, unit='x')
        t.add(name, 'Speedup max', max(rk), 2, src, unit='x')
        t.add(name, 'Tokens/s', sum(e[i]['tokens'] for i in keep) / sum(e[i]['seconds'] for i in keep), tps_dec, src)
        t.add(name, 'All 26 (median)', C.median(r.values()), 2, src, unit='x')
        t.add(name, 'Held-out Dolly', C.median(r[i] for i in keep if i < N_DOLLY), 2, src, unit='x')
        t.add(name, 'Other', C.median(r[i] for i in keep if i >= N_DOLLY), 2, src, unit='x')
        al = [e[i]['accept_len'] for i in keep]
        t.add(name, 'Tokens/pass', sum(al) / len(al), 1, src,
              f'mean over reported prompts; alternatives: median {C.median(al):.3f}, '
              f'mean over all 26 {sum(x["accept_len"] for x in e) / 26:.3f}')


def build():
    """Rebuild tab:dayzero (Llama-3.1-8B and Llama-3.3-70B rows)."""
    t = C.Table('tab:dayzero', 'precomputed vs published EAGLE-3 heads, SGLang tree drafting')
    # Llama-3.1-8B: check the prompt order behind the 20 + 6 split
    pf = os.path.join(C.RESEARCH, 'results_l70all_20261003', 'ngram8b', 'eval_prompts.txt')
    qs = [json.loads(l) for l in open(pf, encoding='utf-8')]
    assert len(qs) == 26 and qs[N_DOLLY].startswith('Explain how a bill becomes a law'), 'unexpected prompt order'
    S = os.path.join(C.RESEARCH, 'results_l70all_20261003', 'sgl', 'out')
    rows_for(t, 'Llama-3.1-8B', os.path.join(S, 'base_tmpl.json'),
             [('eagle3_tree_tmpl.json', 'Published (lmsys)'),
              ('eagle3_tree_dayzero_tmpl.json', 'Precomputed (ours)')], 0)
    O = os.path.join(C.RESULTS, '70b_day0', 'out')
    srcs = [x['source'] for x in load(os.path.join(O, 'ollama.json'))]          # same 26 prompts, labelled
    assert srcs == ['dolly'] * N_DOLLY + ['ours'] * 6, 'unexpected 70B prompt order'
    rows_for(t, 'Llama-3.3-70B', os.path.join(O, 'base.json'),
             [('pub_tree.json', 'Published (lmsys)'),
              ('dz_ck00_tree.json', 'Precomputed, 1,000 ans.'),
              ('dz_ck00_s4n16.json', 'Precomputed, 1,000, 16-tok.'),
              ('dz_full_tree.json', 'Precomputed, 6,000 ans.'),
              ('dz_full_tree_s4n16.json', 'Precomputed, 6,000, 16-tok.'),
              ('dz_ck01_s4n16.json', 'Precomp., 2,000 (chosen), 16-tok.')], 1)
    return t


if __name__ == '__main__':
    C.main(build, __file__)

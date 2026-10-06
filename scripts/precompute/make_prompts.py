#!/usr/bin/env python3
"""All prompt sets for one model, rendered with the model's own chat template (and chat options such as
enable_thinking), so SGLang, Ollama and the training data all see exactly the same text.

  main      26 prompts: Dolly-15k rows -40..-21 (held out from training) + 6 of ours        -> main.jsonl
  val       Dolly-15k rows -20..-1, used only to choose the checkpoint                       -> val.jsonl
  mtbench   MT-Bench first turns (80); mt40.jsonl = the first 40 (sampling run)             -> mtbench.jsonl, mt40.jsonl
  humaneval HumanEval, first 40 problems                                                     -> humaneval.jsonl
  gsm8k     GSM8K test, first 100 (with references); gsm40.jsonl = first 40                 -> gsm8k.jsonl, gsm40.jsonl
  ood       mtbench + humaneval + gsm40 (160 prompts nothing was tuned on)                  -> ood.jsonl
  train     Dolly-15k rows 0..N-1 (never the last 40): prompts for the model's own answers  -> train.jsonl

Usage: python3 make_prompts.py --tokenizer Qwen/Qwen3-32B-AWQ --chat-kwargs '{"enable_thinking": false}' --out DIR --train 2200
"""
import argparse
import json
import os
import urllib.request

DOLLY = 'https://huggingface.co/datasets/databricks/databricks-dolly-15k/resolve/main/databricks-dolly-15k.jsonl'
# coding models: training questions from Magicoder OSS-Instruct (MIT; decontaminated against HumanEval and others)
MAGICODER = 'https://huggingface.co/datasets/ise-uiuc/Magicoder-OSS-Instruct-75K/resolve/main/data-oss_instruct-decontaminated.jsonl'
MTBENCH = 'https://raw.githubusercontent.com/lm-sys/FastChat/main/fastchat/llm_judge/data/mt_bench/question.jsonl'
OURS = ["Explain how a bill becomes a law in the United States, step by step.",
        "Write a Python function that merges two sorted lists into one sorted list, with comments.",
        "What are the main differences between TCP and UDP? Give examples of when to use each.",
        "Write a short story about a lighthouse keeper who finds a message in a bottle.",
        "Summarize the causes and consequences of the French Revolution.",
        "Écris un paragraphe sur l'importance de la biodiversité."]


def get(url):
    return urllib.request.urlopen(url, timeout=300).read().decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tokenizer', required=True)
    ap.add_argument('--chat-kwargs', default='{}')
    ap.add_argument('--out', required=True)
    ap.add_argument('--train', type=int, default=2200)
    ap.add_argument('--train-source', choices=['dolly', 'code', 'mix'], default='dolly',
                    help='training questions: Dolly (default), Magicoder coding tasks, or half and half (coding models)')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.tokenizer)
    kw = json.loads(a.chat_kwargs)
    render = lambda q: tok.apply_chat_template([{'role': 'user', 'content': q}], add_generation_prompt=True, tokenize=False, **kw)
    dolly = [json.loads(l) for l in get(DOLLY).splitlines() if l.strip()]
    dq = lambda r: r['instruction'] + (('\n\n' + r['context']) if r.get('context') else '')
    sets = {
        'main': [(dq(r), 'dolly', None) for r in dolly[-40:][:20]] + [(q, 'ours', None) for q in OURS],
        'val': [(dq(r), 'dolly', None) for r in dolly[-20:]],
        'mtbench': [(json.loads(l)['turns'][0], 'mtbench', json.loads(l)['category']) for l in get(MTBENCH).splitlines() if l.strip()],
        'train': [(dq(r), 'dolly', None) for r in dolly[:-40][:a.train]],
    }
    if a.train_source != 'dolly':
        import random
        code = [json.loads(l)['problem'] for l in get(MAGICODER).splitlines() if l.strip()]
        random.Random(0).shuffle(code)
        n_code = a.train if a.train_source == 'code' else a.train // 2
        train = [(q, 'magicoder', None) for q in code[:n_code]] + sets['train'][:a.train - n_code]
        random.Random(1).shuffle(train)
        sets['train'] = train
    from datasets import load_dataset
    he = load_dataset('openai/openai_humaneval', split='test').select(range(40))
    sets['humaneval'] = [('Complete the following Python function.\n\n```python\n' + r['prompt'] + '```', 'humaneval', r['task_id']) for r in he]
    gs = load_dataset('openai/gsm8k', 'main', split='test').select(range(100))
    sets['gsm8k'] = [(r['question'], 'gsm8k', r['answer'].split('####')[-1].strip().replace(',', '')) for r in gs]
    sets['mt40'] = sets['mtbench'][:40]
    sets['gsm40'] = sets['gsm8k'][:40]
    sets['ood'] = sets['mtbench'] + sets['humaneval'] + sets['gsm40']
    for name, items in sets.items():
        with open(f'{a.out}/{name}.jsonl', 'w') as f:
            for i, (q, src, ref) in enumerate(items):
                f.write(json.dumps({'id': i, 'source': src, 'question': q, 'ref': ref, 'text': render(q)}) + '\n')
        print(f'{name}: {len(items)}')


if __name__ == '__main__':
    main()

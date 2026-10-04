#!/usr/bin/env python3
"""Evaluation prompt sets beyond the 26 main prompts, so that results do not rest on Dolly-like text alone.

  val       20 Dolly-15k rows never used for training or the main evaluation (the last 20 rows); used ONLY to choose
            the day-0 checkpoint, so the choice is never made on the prompts that are reported
  mtbench   MT-Bench, the 80 first-turn questions (writing, roleplay, reasoning, math, coding, extraction, STEM, humanities)
  humaneval HumanEval, the first 40 Python problems (the prompt is the function signature and docstring)
  gsm8k     GSM8K test, the first 100 grade-school math problems (with the reference answer, for scoring quality)

Each prompt is rendered with the model's chat template, like prompts.py.
Usage: python3 prompt_sets.py --set mtbench --out mtbench.jsonl [--tokenizer casperhansen/llama-3.3-70b-instruct-awq]
"""
import argparse
import json
import urllib.request

MTBENCH = 'https://raw.githubusercontent.com/lm-sys/FastChat/main/fastchat/llm_judge/data/mt_bench/question.jsonl'
DOLLY = 'https://huggingface.co/datasets/databricks/databricks-dolly-15k/resolve/main/databricks-dolly-15k.jsonl'


def get(url):
    return urllib.request.urlopen(url, timeout=120).read().decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', required=True, choices=['val', 'mtbench', 'humaneval', 'gsm8k'])
    ap.add_argument('--out', required=True)
    ap.add_argument('--tokenizer', default='casperhansen/llama-3.3-70b-instruct-awq')
    args = ap.parse_args()
    items = []  # (question, reference or None)
    if args.set == 'val':
        rows = [json.loads(l) for l in get(DOLLY).splitlines() if l.strip()][-20:]
        items = [(r['instruction'] + (('\n\n' + r['context']) if r.get('context') else ''), None) for r in rows]
    elif args.set == 'mtbench':
        items = [(json.loads(l)['turns'][0], json.loads(l)['category']) for l in get(MTBENCH).splitlines() if l.strip()]
    else:
        from datasets import load_dataset
        if args.set == 'humaneval':
            ds = load_dataset('openai/openai_humaneval', split='test')
            items = [('Complete the following Python function.\n\n```python\n' + r['prompt'] + '```', r['task_id']) for r in ds.select(range(40))]
        else:
            ds = load_dataset('openai/gsm8k', 'main', split='test')
            items = [(r['question'], r['answer'].split('####')[-1].strip().replace(',', '')) for r in ds.select(range(100))]
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.tokenizer)
    with open(args.out, 'w') as f:
        for i, (q, ref) in enumerate(items):
            text = tok.apply_chat_template([{'role': 'user', 'content': q}], add_generation_prompt=True, tokenize=False)
            f.write(json.dumps({'id': i, 'source': args.set, 'question': q, 'ref': ref, 'text': text}) + '\n')
    print(f'{len(items)} prompts -> {args.out}')


if __name__ == '__main__':
    main()

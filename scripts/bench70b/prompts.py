#!/usr/bin/env python3
"""The 26 held-out evaluation prompts used for every 70B speed number in the paper.

20 from Dolly-15k (the first 20 of its last 40 rows; the day-0 draft head is never trained on the last 40 rows) and
6 of our own (explanation, code, comparison, story, history, French). Each is rendered with the model's own chat
template, so every engine sees exactly the same text.

Usage: python3 prompts.py --tokenizer casperhansen/llama-3.3-70b-instruct-awq --out prompts.jsonl
"""
import argparse
import json
import urllib.request

DOLLY = 'https://huggingface.co/datasets/databricks/databricks-dolly-15k/resolve/main/databricks-dolly-15k.jsonl'
OURS = ["Explain how a bill becomes a law in the United States, step by step.",
        "Write a Python function that merges two sorted lists into one sorted list, with comments.",
        "What are the main differences between TCP and UDP? Give examples of when to use each.",
        "Write a short story about a lighthouse keeper who finds a message in a bottle.",
        "Summarize the causes and consequences of the French Revolution.",
        "Écris un paragraphe sur l'importance de la biodiversité."]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tokenizer', default='casperhansen/llama-3.3-70b-instruct-awq')
    ap.add_argument('--out', default='prompts.jsonl')
    args = ap.parse_args()
    rows = [json.loads(l) for l in urllib.request.urlopen(DOLLY).read().decode().splitlines() if l.strip()]
    qs = [r['instruction'] + (('\n\n' + r['context']) if r.get('context') else '') for r in rows[-40:][:20]] + OURS
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.tokenizer)
    with open(args.out, 'w') as f:
        for i, q in enumerate(qs):
            text = tok.apply_chat_template([{'role': 'user', 'content': q}], add_generation_prompt=True, tokenize=False)
            f.write(json.dumps({'id': i, 'source': 'dolly' if i < 20 else 'ours', 'question': q, 'text': text}) + '\n')
    print(f'{len(qs)} prompts -> {args.out}')


if __name__ == '__main__':
    main()

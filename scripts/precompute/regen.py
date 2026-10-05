#!/usr/bin/env python3
"""The model's own answers to the training prompts (self-distillation data for the draft head), from a running SGLang
server: greedy, up to 512 tokens, rendered exactly as served. Writes SpecForge conversations; the assistant content
starts with whatever the served template puts after the assistant header (e.g. Qwen3's empty <think></think> in
non-thinking mode), so the training sequences match what the head sees at inference.

Usage: python3 regen.py --prompts train.jsonl --tokenizer T --chat-kwargs '{...}' --template qwen --system-turn 0 --n 2000 --out regen.jsonl
"""
import argparse
import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HEADERS = {'qwen': '<|im_start|>assistant\n', 'llama3': '<|start_header_id|>assistant<|end_header_id|>\n\n',
           'deepseek-r1-distill': '<｜Assistant｜>'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--prompts', required=True)
    ap.add_argument('--tokenizer', required=True)
    ap.add_argument('--chat-kwargs', default='{}')
    ap.add_argument('--template', required=True, choices=sorted(HEADERS))
    ap.add_argument('--system-turn', type=int, default=0)
    ap.add_argument('--n', type=int, default=2000)
    ap.add_argument('--out', required=True)
    ap.add_argument('--port', type=int, default=30000)
    ap.add_argument('--concurrency', type=int, default=48)
    a = ap.parse_args()
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.tokenizer)
    kw = json.loads(a.chat_kwargs)
    conv = [{'role': 'user', 'content': 'x'}]
    gen = tok.apply_chat_template(conv, add_generation_prompt=True, tokenize=False, **kw)
    base = tok.apply_chat_template(conv, add_generation_prompt=False, tokenize=False, **kw)
    suffix = gen[len(base):] if gen.startswith(base) else ''
    prefix = suffix.split(HEADERS[a.template], 1)[1] if HEADERS[a.template] in suffix else ''
    print('assistant prefix:', repr(prefix))
    rows = [json.loads(l) for l in open(a.prompts)]

    def answer(p):
        body = {'text': p['text'], 'sampling_params': {'temperature': 0, 'max_new_tokens': 512}}
        try:
            r = json.loads(urllib.request.urlopen(urllib.request.Request(f'http://localhost:{a.port}/generate', data=json.dumps(body).encode(),
                           headers={'Content-Type': 'application/json'}), timeout=900).read())
            return p, r['text'], r.get('meta_info', {}).get('finish_reason', {}).get('type') == 'stop'
        except Exception as e:  # noqa: BLE001
            return p, None, False

    out, done = [], 0
    with ThreadPoolExecutor(a.concurrency) as ex:
        for p, text, finished in ex.map(answer, rows):
            done += 1
            if text and text.strip() and len(out) < a.n:
                c = ([{'role': 'system', 'content': ''}] if a.system_turn else []) + [{'role': 'user', 'content': p['question']},
                                                                                      {'role': 'assistant', 'content': prefix + text}]
                # 'text': the exact prompt the model saw plus its answer, for preformatted training (PREFORMAT=1). Chat
                # templates such as DeepSeek-R1's delete the <think> reasoning from earlier turns, which is the text the head must learn.
                out.append({'id': f"dolly-{p['id']}", 'conversations': c, 'text': p['text'] + text + (tok.eos_token if finished else '')})
    with open(a.out, 'w') as f:
        for r in out:
            f.write(json.dumps(r) + '\n')
    print(f'{len(out)} conversations from {done} prompts -> {a.out}')


if __name__ == '__main__':
    main()

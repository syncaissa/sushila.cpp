#!/usr/bin/env python3
"""Build a mixed calibration text for landscapes: prose, code, chat and multilingual, interleaved.

Hidden states differ by domain, so a landscape fitted on one kind of text can miss on another
(a preview fitted on WikiText missed tokens on code). This writes one text file whose 512-token
chunks mix four sources in round-robin blocks:
  prose         WikiText-2 *train*
  code          C/C++ and Python files of llama.cpp (src/, gguf-py/)
  chat          "User: ... Assistant: ..." turns whose answers the model generates itself (greedy)
  multilingual  the same, with questions in Chinese, Spanish, French, German, Hindi and Japanese
Self-generated answers are the closest match to what the model sees while decoding.
None of the evaluation prompts used for the paper are in these lists.

Usage: make_calib_mix.py <model.gguf> <llama-completion binary> <out.txt> [--chars 12000] [--threads N]
"""
import argparse
import glob
import os
import subprocess

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

CHAT = [
    "How do I make a cup of green tea?", "Explain what a mortgage is in simple terms.",
    "Write a short poem about the sea.", "What are the main causes of inflation?",
    "Give me a packing list for a weekend hiking trip.", "How does a vaccine train the immune system?",
    "Summarize the plot of Romeo and Juliet.", "What is the difference between a virus and a bacterium?",
    "Write an email asking my manager for a day off.", "How can I improve my sleep?",
    "Explain recursion to a ten-year-old.", "What should I consider when buying a used car?",
    "Describe how photosynthesis works.", "Suggest three names for a bakery.",
    "How do I convert Celsius to Fahrenheit?", "What are good habits for learning a language?",
    "Write a SQL query that counts orders per customer.", "Why is the sky blue?",
    "Plan a three-day trip to Rome.", "How do electric cars charge?",
    "What is a balanced diet?", "Explain the rules of chess briefly.",
]
MULTI = [
    "请用中文介绍一下长城的历史。", "如何学好数学？请给出几个建议。", "写一段关于春天的短文。",
    "¿Cuáles son los beneficios de hacer ejercicio?", "Explica cómo funciona una computadora.",
    "Escribe una receta sencilla de tortilla de patatas.",
    "Quels sont les monuments les plus célèbres de Paris ?", "Explique le cycle de l'eau.",
    "Wie funktioniert ein Kühlschrank?", "Schreibe eine kurze Geschichte über einen Hund.",
    "भारत की राजधानी के बारे में बताइए।", "स्वस्थ रहने के लिए क्या करना चाहिए?",
    "日本の四季について説明してください。", "おすすめの勉強方法を教えてください。",
    "Was ist der Unterschied zwischen Wetter und Klima?", "¿Qué es la inteligencia artificial?",
    "Décris une journée typique d'un étudiant.", "请解释一下什么是人工智能。",
    "Erkläre die Photosynthese in einfachen Worten.", "東京の観光地を三つ紹介してください。",
    "Comment préparer une bonne soupe à l'oignon ?", "¿Cómo se forma un arcoíris?",
]


def generate(binary, model, questions, threads, cache, n_tokens=96):
    if os.path.exists(cache):
        return open(cache, encoding="utf-8").read()
    out = []
    for q in questions:
        prompt = f"User: {q}\nAssistant:"
        r = subprocess.run([binary, "-m", model, "-p", prompt, "-n", str(n_tokens), "--temp", "0", "-t", str(threads),
                            "-no-cnv", "--no-warmup", "--no-display-prompt"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", check=True)
        out.append(f"User: {q}\nAssistant:{r.stdout.rstrip()}\n")
    with open(cache, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    return "\n".join(out)


def code_text(chars):
    files = sorted(glob.glob(os.path.join(ROOT, "llama.cpp/src/*.cpp")))[:12] + \
            sorted(glob.glob(os.path.join(ROOT, "llama.cpp/gguf-py/gguf/*.py")))[:12]
    parts, n = [], 0
    for i in range(0, 4 * len(files)):
        f = files[(i * 7) % len(files)]            # alternate C++ and Python files
        text = open(f, encoding="utf-8", errors="ignore").read()
        start = (i * 3001) % max(1, len(text) - 2000)
        parts.append(text[start:start + 2000])
        n += 2000
        if n >= chars:
            break
    return "\n".join(parts)


def interleave(domains, block=1500):
    blocks = [[t[i:i + block] for i in range(0, len(t), block)] for t in domains]
    out = []
    for i in range(max(len(b) for b in blocks)):
        for b in blocks:
            if i < len(b):
                out.append(b[i])
    return "\n\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model")
    ap.add_argument("binary")
    ap.add_argument("out")
    ap.add_argument("--chars", type=int, default=12000, help="characters per domain")
    ap.add_argument("--threads", type=int, default=os.cpu_count())
    ap.add_argument("--wikitext", default=os.path.join(ROOT, "work/data/wikitext-2-raw/wiki.train.raw"))
    args = ap.parse_args()

    prose = open(args.wikitext, encoding="utf-8").read()[100000:100000 + args.chars]
    code = code_text(args.chars)
    chat = generate(args.binary, args.model, CHAT, args.threads, args.out + ".chat")[: args.chars]
    multi = generate(args.binary, args.model, MULTI, args.threads, args.out + ".multi")[: args.chars]
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(interleave([prose, code, chat, multi]))
    print(f"{args.out}: prose {len(prose)}, code {len(code)}, chat {len(chat)}, multilingual {len(multi)} characters")


if __name__ == "__main__":
    main()

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

# Held-out evaluation prompts (--set test): none of these appear in CHAT / MULTI above.
TEST_CHAT = [
    "How can I save money on groceries?", "What is a black hole?", "Write a haiku about autumn.",
    "How do I fix a flat bicycle tire?", "Give me tips for a job interview.", "What causes earthquakes?",
    "Explain how a credit score works.", "Write a limerick about a cat.", "How do I start running safely?",
    "What is the difference between weather and climate?", "Suggest a weekly meal plan for a family.",
    "How does a refrigerator keep food cold?", "Explain what DNS does on the internet.",
    "What are the pros and cons of working from home?", "How do I write a good cover letter?",
    "Describe the water cycle.", "What is compound interest?", "How do noise-cancelling headphones work?",
    "Give advice for a first-time manager.", "Why do leaves change color in autumn?",
]
TEST_MULTI = [
    "请介绍一下北京的美食。", "如何提高英语口语？", "解释一下什么是区块链。", "写一首关于月亮的短诗。",
    "¿Cuál es la capital de Argentina y qué se puede visitar allí?", "¿Cómo puedo aprender a programar?",
    "Escribe un poema corto sobre el mar.", "¿Por qué es importante el reciclaje?",
    "Quels sont les avantages du vélo en ville ?", "Comment fonctionne un moteur électrique ?",
    "Raconte une courte histoire sur un dragon.", "Pourquoi le ciel est-il bleu ?",
    "Was sind die Vorteile von erneuerbaren Energien?", "Wie lerne ich am besten eine neue Sprache?",
    "富士山について教えてください。", "日本の伝統的な料理を紹介してください。",
    "भारत में कौन से त्योहार मनाए जाते हैं?", "योग के क्या फायदे हैं?",
    "Quali sono le città più belle d'Italia?", "Como funciona a energia solar?",
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


def code_text(chars, test=False, part=None):
    if test:   # different files from the calibration set; part 0 / 1 = disjoint halves (validation / test)
        files = sorted(glob.glob(os.path.join(ROOT, "llama.cpp/tools/*/*.cpp")))[:12] + \
                sorted(glob.glob(os.path.join(ROOT, "llama.cpp/convert*.py")) + glob.glob(os.path.join(ROOT, "scripts/*.py")))[:12]
        if part is not None:
            files = files[part::2]
    else:
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
    # same data location rule as scripts/common.sh: $WORK_DIR, else /workspace/mc-work on RunPod, else ./work
    work = os.environ.get("WORK_DIR") or ("/workspace/mc-work" if os.path.isdir("/workspace/mc-work") else os.path.join(ROOT, "work"))
    ap.add_argument("--wikitext", default=os.path.join(work, "data/wikitext-2-raw/wiki.train.raw"))
    ap.add_argument("--set", choices=["calib", "test", "val"], default="calib",
                    help="test / val: held-out prompts and code files, one file per domain (<out>.code/.chat/.multi); "
                         "val and test use disjoint halves of the held-out prompts and files, test alone uses all")
    ap.add_argument("--split", action="store_true", help="with --set test: use only the test half (disjoint from val)")
    args = ap.parse_args()

    if args.set in ("test", "val"):
        part = 0 if args.set == "val" else (1 if args.split else None)
        sel = (lambda lst: lst[part::2]) if part is not None else (lambda lst: lst)
        outs = {"code": code_text(args.chars, test=True, part=part),
                "chat": generate(args.binary, args.model, sel(TEST_CHAT), args.threads, args.out + ".chat.gen", 160),
                "multi": generate(args.binary, args.model, sel(TEST_MULTI), args.threads, args.out + ".multi.gen", 160)}
        for dom, text in outs.items():
            with open(f"{args.out}.{dom}", "w", encoding="utf-8") as f:
                f.write(text[: args.chars])
            print(f"{args.out}.{dom}: {min(len(text), args.chars)} characters")
        return
    prose = open(args.wikitext, encoding="utf-8").read()[100000:100000 + args.chars]
    code = code_text(args.chars)
    chat = generate(args.binary, args.model, CHAT, args.threads, args.out + ".chat")[: args.chars]
    multi = generate(args.binary, args.model, MULTI, args.threads, args.out + ".multi")[: args.chars]
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(interleave([prose, code, chat, multi]))
    print(f"{args.out}: prose {len(prose)}, code {len(code)}, chat {len(chat)}, multilingual {len(multi)} characters")


if __name__ == "__main__":
    main()

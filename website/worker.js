/**
 * sushila.ai — single-file Cloudflare Worker front end for Sushila.cpp.
 *
 * Routes
 *   GET  /                      the site (what Sushila.cpp does, downloads, models, serverless API)
 *   GET  /signin, /account      passwordless sign-in (6-digit code by e-mail) and the account page
 *   GET  /download/<file>       license confirmation for a hosted model file (signed-in users)
 *   POST /api/auth/send-code    {email, purpose: SIGN_IN | SIGN_UP | ADD_EMAIL}  e-mails a code (Resend)
 *   POST /api/auth/verify-code  {email, code, firstName?, lastName?, organization?}  sets the session cookie
 *   POST /api/auth/sign-out
 *   GET|POST /api/account       profile, linked e-mails, download history
 *   GET  /bugs, /bugs/new, /bugs/<id>; GET|POST /api/bugs, /api/bugs/<id>, POST /api/bugs/<id>/comments   bug reports
 *   POST /api/download          {file, accept: true}  records the download, returns a 24-hour B2 link
 *   POST /api/waitlist          serverless-API early access
 *   GET  /models.json, /terms, /privacy, /media/<file> (logo animation from B2, with ranges), images, /robots.txt
 *
 * Environment (Cloudflare secrets/variables):
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION   DynamoDB; tables sushilaai-* (website/setup/dynamodb_tables.py)
 *   B2_KEY_ID, B2_APP_KEY, B2_BUCKET_NAME (sushila-ai)     Backblaze B2: models/<model id>/<file>, media/<file>
 *   RUNPOD_API_KEY (secret)                               admin "Compare Speeds": creates and deletes GPU pods on RunPod
 *   Cron trigger, every 5 minutes                         deletes comparison pods that are idle, failed or too old
 *   RESEND_API_KEY, RESEND_FROM                             sign-in e-mails
 *   SESSION_SECRET                                          signs sessions, hashes sign-in codes
 *   RELEASED ("true" once the repository is public), REPO_URL, CONTACT, GOVERNING_LAW   optional
 *   (DEEPINFRA_API_KEY and DEEPSEEK_PLATFORM_API_KEY are reserved for the serverless API and not used here yet.)
 * Without AWS / B2 / Resend settings the site still works: sign-in is unavailable, downloads go to Hugging Face,
 * and the waitlist falls back to e-mail. GET /api/health shows which services are set up (DynamoDB tables, B2, Resend).
 *
 * Deploy: npx wrangler deploy worker.js --name sushila --compatibility-date 2026-10-01
 */

// Source repository; override with the REPO_URL variable (e.g. after moving the repository to a sushila organization).
const REPO_DEFAULT = 'https://github.com/syncaissa/sushila.cpp';
const DEFAULT_CONTACT = 'contact@sushila.ai';  // set up with Cloudflare Email Routing, or override with CONTACT

// Models whose files we host (byte-identical to the Ollama registry blobs; sha256 is the file's digest).
// "tuned": has Sushila day-0 artifacts (landscapes / draft head) measured in the paper.
const HOSTED = [
  { id: 'llama3.1-8b-q4km', name: 'Llama 3.1 8B Instruct', quant: 'Q4_K_M', file: 'llama3.1-8b-instruct-q4_k_m.gguf', bytes: 4920738944,
    sha256: '667b0c1932bc6ffc593ed1d03f895bf2dc8dc6df21db3042284a6f4416b06a29', license: 'Llama 3.1 Community License',
    licenseUrl: 'https://www.llama.com/llama3_1/license/', hf: 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', tuned: true },
  { id: 'llama3.1-8b-q8', name: 'Llama 3.1 8B Instruct', quant: 'Q8_0', file: 'llama3.1-8b-instruct-q8_0.gguf', bytes: 8540775552,
    sha256: 'cc04e85e1f866a5ba87dd66b5260f0cb32354e2c66505e86a7ac3c0092272b7d', license: 'Llama 3.1 Community License',
    licenseUrl: 'https://www.llama.com/llama3_1/license/', hf: 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', tuned: true },
  { id: 'llama3.3-70b-q4km', name: 'Llama 3.3 70B Instruct', quant: 'Q4_K_M', file: 'llama3.3-70b-instruct-q4_k_m.gguf', bytes: 42520398528,
    sha256: '4824460d29f2058aaf6e1118a63a7a197a09bed509f0e7d4e2efb1ee273b447d', license: 'Llama 3.3 Community License',
    licenseUrl: 'https://www.llama.com/llama3_3/license/', hf: 'https://huggingface.co/bartowski/Llama-3.3-70B-Instruct-GGUF', tuned: true },
  { id: 'llama3.2-3b-q4km', name: 'Llama 3.2 3B Instruct', quant: 'Q4_K_M', file: 'llama3.2-3b-instruct-q4_k_m.gguf', bytes: 2019377376,
    sha256: 'dde5aa3fc5ffc17176b5e8bdc82f587b24b2678c6c66101bf7da77af9f7ccdff', license: 'Llama 3.2 Community License',
    licenseUrl: 'https://www.llama.com/llama3_2/license/', hf: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF', tuned: false },
  { id: 'llama3.2-1b-q8', name: 'Llama 3.2 1B Instruct', quant: 'Q8_0', file: 'llama3.2-1b-instruct-q8_0.gguf', bytes: 1321082688,
    sha256: '74701a8c35f6c8d9a4b91f3f3497643001d63e0c7a84e085bed452548fa88d45', license: 'Llama 3.2 Community License',
    licenseUrl: 'https://www.llama.com/llama3_2/license/', hf: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF', tuned: false,
    note: 'draft model for the 70B' },
  { id: 'qwen2.5-7b-q4km', name: 'Qwen2.5 7B Instruct', quant: 'Q4_K_M', file: 'qwen2.5-7b-instruct-q4_k_m.gguf', bytes: 4683073952,
    sha256: '2bada8a7450677000f678be90653b85d364de7db25eb5ea54136ada5f3933730', license: 'Apache-2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0', hf: 'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF', tuned: true },
  { id: 'qwen3-30b-a3b-q4km', category: 'Text (LLM)', name: 'Qwen3 30B-A3B (MoE)', quant: 'Q4_K_M', file: 'qwen3-30b-a3b-q4_k_m.gguf', bytes: 18556685856,
    sha256: '58574f2e94b99fb9e4391408b57e5aeaaaec10f6384e9a699fc2cb43a5c8eabf', license: 'Apache-2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0', hf: 'https://huggingface.co/Qwen/Qwen3-30B-A3B-GGUF', tuned: true },
];

// Models that run with Sushila.cpp (any GGUF does) but that users download themselves from Hugging Face.
const LISTED = [
  { name: 'Qwen3 8B', hf: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF', license: 'Apache-2.0' },
  { name: 'Qwen3 32B', hf: 'https://huggingface.co/Qwen/Qwen3-32B-GGUF', license: 'Apache-2.0' },
  { name: 'Qwen2.5 Coder 7B Instruct', hf: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', license: 'Apache-2.0' },
  { name: 'Mistral 7B Instruct v0.3', hf: 'https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF', license: 'Apache-2.0' },
  { name: 'Gemma 2 9B Instruct', hf: 'https://huggingface.co/bartowski/gemma-2-9b-it-GGUF', license: 'Gemma Terms of Use' },
  { name: 'Phi-3 Mini 4K Instruct', hf: 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf', license: 'MIT' },
  { name: 'DeepSeek-R1 Distill Llama 8B', hf: 'https://huggingface.co/bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF', license: 'MIT + Llama 3.1 License' },
  { name: 'Llama 3.1 70B Instruct', hf: 'https://huggingface.co/bartowski/Meta-Llama-3.1-70B-Instruct-GGUF', license: 'Llama 3.1 Community License' },
];

// Measured results (paper, Table "Every model in the per-model pipeline", 2026-10-07). Text: vanilla Ollama vs Sushila.cpp on the same
// A100, 160 unseen prompts, greedy, 256 tokens; images/video/music: the reference engine vs Sushila on one RTX 4090.
// [model, kind, baseline + hardware, baseline speed, Sushila speed, speedup, our precomputed part]
const RESULTS = [
  ['Llama 3.3 70B', 'chat', 'Ollama 0.35.1, A100', '23.6 tok/s', '95.7 tok/s', '4.05×', 'draft head refitted to its answers: +8%'],
  ['DeepSeek-R1 Distill Llama 70B', 'reasoning', 'Ollama 0.35.1, A100', '23.5 tok/s', '85.6 tok/s', '3.64×', 'draft head (none published): 2.30× over the engine'],
  ['Kimi-Dev 72B', 'coding', 'Ollama 0.35.1, A100', '20.9 tok/s', '74.4 tok/s', '3.56×', 'draft head from the closest published one: +41%'],
  ['Qwen3 32B', 'chat', 'Ollama 0.35.1, A100', '43.2 tok/s', '135.7 tok/s', '3.14×', 'draft head: +1%'],
  ['Qwen3-Coder 30B-A3B', 'coding (MoE)', 'Ollama 0.35.1, A100', '146.3 tok/s', '262.8 tok/s', '1.80×', 'draft head: +2%'],
  ['Qwen3 30B-A3B', 'chat (MoE)', 'Ollama 0.35.1, A100', '163.8 tok/s', '270.6 tok/s', '1.65×', 'draft head: +1%'],
  ['Llama 3.1 8B (16-bit)', 'chat', 'Ollama 0.35.1, A100', '143.3 tok/s', '222.2 tok/s', '1.55×', 'draft head refitted to its answers: +11%'],
  ['Gemma 3 27B', 'chat', 'Ollama 0.35.1, A100', '46.5 tok/s', '56.6 tok/s', '1.22×', 'draft head over a community one: +9%'],
  ['Qwen2.5 0.5B', 'chat (CPU)', 'llama.cpp, 8 CPU threads', '145.5 tok/s', '183.3 tok/s', '1.26×', 'output-layer landscape (approx., ≥99.4% top-1; vs stock llama.cpp)'],
  ['Z-Image-Turbo', 'images', 'stable-diffusion.cpp, RTX 4090', '', '', '1.10×', 'cache plan (SSIM 0.98)'],
  ['Wan 2.2 TI2V-5B', 'video', 'stable-diffusion.cpp, RTX 4090', '889 s/clip', '549 s/clip', '1.62×', 'cache plan (frame SSIM 0.93), 720p 5 s, medians of 5 prompts; vs the same engine without the plan (Wan official bf16: 536 s on one prompt)'],
  ['ACE-Step 1.5', 'music', 'acestep.cpp, RTX 4090', '5.16 s/song', '4.05 s/song', '1.27×', 'faster sampler (same distribution)'],
  ['YuE v1', 'music', 'official YuE code, RTX 4090', '1,210 s/song', '253 s/song', '4.77×', 'equivalent runner on the same song (one cache, batching, CUDA graphs); full 134 s song 3.29×; with stage 2 in float32 every code equals the official float32 output; research code, not yet in Sushila.cpp'],
];
const RESULTS_AVG = [['Average, 8 GPU chat and coding models vs Ollama', '2.58×', 'geometric mean 2.35×'], ['Average, all 13 models', '2.36×', 'geometric mean 2.07×'], ['Average, 12 without YuE', '2.16×', 'geometric mean 1.93×']];
const RESULTS_MORE = [
  ['Qwen3 235B-A22B (out of scope)', 'chat (MoE)', 'Ollama, 2× A100', '', '', '0.73×', 'draft heads slow it; SGLang alone 1.25×'],
];

// SUSHILA_DOCS_BEGIN (generated by scripts/website/embed_docs.py from cli/web/sushila_docs.html: edit that file)
const SUSHILA_DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sushila documentation</title>
<!-- One self-contained file: served by \`sushila serve\` at /docs, and meant to be reused as is by the website (worker.js). -->
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16202c;--mut:#5b6876;--line:#dfe4ea;--acc:#0f766e;--accbg:#e6f4f2;--code:#f0f2f5;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#0f1418;--card:#171e24;--ink:#e6edf3;--mut:#9aa7b4;--line:#2a343d;--acc:#2dd4bf;--accbg:#123733;--code:#1f2830;--warn:#f0c46a}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.top{display:flex;align-items:center;gap:12px;padding:10px 18px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:3}
.top a{color:var(--acc);text-decoration:none;font-weight:600}.top b{font-size:17px}.sp{flex:1}
.wrap{display:flex;max-width:1180px;margin:0 auto}nav.toc{width:230px;flex:none;padding:18px 10px 40px 18px;position:sticky;top:50px;align-self:flex-start;max-height:calc(100vh - 50px);overflow:auto}
nav.toc a{display:block;color:var(--mut);text-decoration:none;font-size:14px;padding:3px 0}nav.toc a:hover{color:var(--acc)}
main{flex:1;min-width:0;padding:18px 26px 60px}h1{font-size:26px;margin:6px 0 4px}h2{font-size:20px;margin:34px 0 8px;padding-top:6px;border-top:1px solid var(--line)}h3{font-size:16px;margin:20px 0 6px}
p,li{max-width:820px}.lead{color:var(--mut)}code{background:var(--code);padding:1px 5px;border-radius:5px;font:13px ui-monospace,Menlo,Consolas,monospace}
pre{background:var(--code);border-radius:8px;padding:12px 14px;overflow:auto;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;margin:8px 0}
table{border-collapse:collapse;width:100%;margin:8px 0;background:var(--card)}td,th{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top;font-size:14px}th{background:var(--accbg)}
td code{white-space:nowrap}.os{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px}.os div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.os h4{margin:0 0 6px}.note{border-left:4px solid var(--acc);background:var(--card);padding:8px 12px;margin:10px 0}.warn{border-left-color:var(--warn)}
.menu{position:relative}.menu summary{list-style:none;cursor:pointer;font-size:20px;padding:0 6px}.menu summary::-webkit-details-marker{display:none}
.menu>div{position:absolute;top:30px;left:0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px;min-width:180px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.menu>div a{display:block;padding:7px 10px;border-radius:7px}.menu>div a:hover{background:var(--accbg)}
.menu .where{border-top:1px solid var(--line);margin-top:6px;padding:6px 10px 2px;font-size:12px;color:var(--mut);word-break:break-all;line-height:1.6}
@media (max-width:820px){nav.toc{display:none}main{padding:14px}}
</style>
</head>
<body>
<div class="top"><details class="menu"><summary aria-label="Menu">☰</summary><div><a href="/">Inference</a><a href="/admin" id="madmin">Admin</a><a href="/docs">Documentation</a><a href="/#assistant">Ask Sushila</a><a href="#api">API</a><div class="where" id="mwhere"></div></div></details><b>Sushila</b><span class="sp"></span><span style="color:var(--mut)">Documentation</span></div>
<div class="wrap">
<nav class="toc">
  <a href="#start">Getting started</a><a href="#commands">All commands</a><a href="#os">Windows, macOS, Linux</a><a href="#serve">Serving and the web page</a>
  <a href="#network">Other machines and the internet</a><a href="#admin">Admin password</a><a href="#api">API</a><a href="#packs">Model packs folder</a><a href="#files">Files and folders</a>
  <a href="#service">Start automatically</a><a href="#trouble">Troubleshooting</a>
</nav>
<main>
<h1>Sushila documentation</h1>
<p class="lead">Sushila runs AI models on your own computer: chat, code, images, music and video. One program, <code>sushila</code>
(<code>sushila.exe</code> on Windows), does everything; the web page it serves is the user interface. The commands are the same on
Windows, macOS and Linux.</p>

<h2 id="start">Getting started</h2>
<ol>
  <li>Download <code>sushila.exe</code> (Windows) or <code>sushila</code> (macOS, Linux) for your system.</li>
  <li>Run it: double-click it, or in a terminal type <code>sushila serve</code>. The first time it installs the engine for your
      GPU (NVIDIA: CUDA; AMD and Intel: Vulkan; Apple: Metal; otherwise the CPU) and a first model, and asks you to choose an
      admin password. The first model depends on the computer: Qwen3 4B (about 2.5 GB) with a GPU of 8 GB or more, a Mac with
      Apple silicon and 16 GB or more, or 16 GB of memory without a GPU (if the disk has room); otherwise Qwen2.5 0.5B (about 535 MB).
      The log says which one and why.</li>
  <li>Open <a href="http://localhost:8765/">http://localhost:8765/</a> in a browser (double-clicking opens it for you).</li>
</ol>
<p>To check that everything works: <code>sushila selftest</code>. It installs what is needed, asks the small model (or the 4B model, if installed) one question and
ends with <code>PASS</code> (exit code 0) or says what failed.</p>

<h2 id="commands">All commands</h2>
<p>Type them in a terminal. Every command accepts <code>--json</code> (machine-readable output), <code>--quiet</code> and
<code>--data-dir &lt;folder&gt;</code>. <code>sushila --help</code> and <code>sushila &lt;command&gt; --help</code> show the details.</p>
<table>
<tr><th>Command</th><th>What it does</th></tr>
<tr><td><code>sushila</code> (no command, or double-click)</td><td>Starts the server and opens the web page in the browser.</td></tr>
<tr><td><code>sushila selftest</code></td><td>End-to-end check: engine, the small default model (or the 4B one if installed; <code>--pack</code> picks another), one answer. Exit code 0 = everything works.</td></tr>
<tr><td><code>sushila doctor</code></td><td>Checks this computer: GPU, driver, engine build, free disk, the port, the home folder, every pack file's SHA-256, the admin password. Each line says OK, WARN or FAIL, with the command that fixes it.</td></tr>
<tr><td><code>sushila assistant ["&lt;question&gt;"]</code></td><td>Ask Sushila how Sushila works: answers from this documentation and live facts about this computer, by the largest installed text model (no question: keeps asking; <code>/exit</code> ends). Also in the ☰ menu (Ask Sushila) and in the server window. With a model under 3B parameters it quotes the matching sections and their commands instead of writing an answer (small models invent steps); install a 3B+ chat model, e.g. <code>sushila install qwen3-4b-instruct-2507</code>, for answers in its own words.</td></tr>
<tr><th colspan="2">Engine and model packs</th></tr>
<tr><td><code>sushila engine install</code></td><td>Installs Sushila.cpp for this computer's GPU (CPU only when there is no usable GPU).</td></tr>
<tr><td><code>sushila engine install --build cpu</code></td><td>Forces a build: <code>cpu</code>, <code>vulkan</code> or <code>cuda</code>.</td></tr>
<tr><td><code>sushila engine info</code></td><td>Engine version, GPU, data folder.</td></tr>
<tr><td><code>sushila packs</code></td><td>The model packs you can install (<code>--all</code> also lists packs for other hardware).</td></tr>
<tr><td><code>sushila search &lt;words&gt; [--kind chat|code|image|music|video] [--fits]</code></td><td>Finds packs in the catalog by words and kind; <code>--fits</code>: only packs this computer can run.</td></tr>
<tr><td><code>sushila show &lt;pack&gt;</code></td><td>Name, kind, license, size, every file with its SHA-256, what Accelerated adds (precomputed files, engine options, cache plan), installed or not.</td></tr>
<tr><td><code>sushila license &lt;pack&gt;</code></td><td>The pack's license, its link, and the license files in the pack.</td></tr>
<tr><td><code>sushila install &lt;pack&gt;</code></td><td>Downloads a pack and checks the Sushila signature and every file's SHA-256. Several packs at once are fine.</td></tr>
<tr><td><code>sushila install &lt;file&gt;.sushilapack</code></td><td>Installs a pack file (from a USB drive or another computer), with the same checks.</td></tr>
<tr><td><code>sushila install my-model.gguf</code></td><td>Your own GGUF model: becomes our pack if we precomputed it, else "your own model" (Standard mode).</td></tr>
<tr><td><code>sushila install hf:&lt;owner&gt;/&lt;repo&gt;/&lt;file&gt;.gguf[@rev]</code></td><td>Downloads a GGUF from Hugging Face (checked, revision recorded), then the same as above.</td></tr>
<tr><td><code>sushila list</code></td><td>Installed packs.</td></tr>
<tr><td><code>sushila verify [&lt;pack&gt;]</code></td><td>Checks every file of installed packs against its SHA-256.</td></tr>
<tr><td><code>sushila remove &lt;pack&gt;</code></td><td>Removes a pack and its files.</td></tr>
<tr><td><code>sushila update [--check]</code></td><td>A newer signed engine and packs whose files changed in the catalog: <code>--check</code> lists them, without it they are installed (only changed files are downloaded).</td></tr>
<tr><td><code>sushila clean [--dry-run]</code></td><td>Removes leftovers: unfinished downloads (only while no server runs), old engine versions, outputs of removed queue jobs, stale checksum cache entries; prints the space freed.</td></tr>
<tr><td><code>sushila du</code></td><td>Disk use per pack, engine, logs, outputs and in total.</td></tr>
<tr><td><code>sushila export &lt;pack&gt; &lt;file.zip|.tar|.sushilapack&gt;</code></td><td>The pack as one file for another computer (with <code>sushila-pack.json</code>).</td></tr>
<tr><td><code>sushila import &lt;file&gt;</code></td><td>Installs such a file; every file's SHA-256 is checked before anything is adopted (signed packs also against Sushila's signature).</td></tr>
<tr><td><code>sushila convert &lt;hf-repo|folder&gt; [--out file.gguf] [--outtype q8_0]</code></td><td>Converts a Hugging Face model to GGUF with llama.cpp's converter (fetched at the version Sushila.cpp builds on) and adds it as your own model. Needs Python and the converter's packages; if they are missing it prints the exact steps.</td></tr>
<tr><td><code>sushila precompute &lt;pack&gt;</code></td><td>Experimental: runs the repository's day-0 landscape pipeline (<code>scripts/day0_landscape.sh</code>) for a text pack; without the repository it prints what is needed.</td></tr>
<tr><th colspan="2">Serving</th></tr>
<tr><td><code>sushila serve [&lt;pack&gt;...]</code></td><td>Starts the server: web page, API and queue, and the named packs (default: the first installed one).</td></tr>
<tr><td><code>sushila serve --port 8844</code></td><td>Another port (default 8765).</td></tr>
<tr><td><code>sushila serve --public</code></td><td>Reachable from other machines (listens on all addresses); they need an access key.</td></tr>
<tr><td><code>sushila serve --public --open</code></td><td>No key needed for chat and generation (trusted networks only).</td></tr>
<tr><td><code>sushila serve --standard</code></td><td>Plain models instead of Accelerated (Sushila's precomputed files off).</td></tr>
<tr><td><code>sushila start &lt;pack&gt; [--standard]</code></td><td>Starts a model in the running server.</td></tr>
<tr><td><code>sushila stop &lt;pack&gt;</code></td><td>Stops a model.</td></tr>
<tr><td><code>sushila stop</code></td><td>Stops the whole server.</td></tr>
<tr><td><code>sushila status</code></td><td>What is installed, whether the server runs, which models run (Accelerated or Standard).</td></tr>
<tr><td><code>sushila ps</code></td><td>Running models: mode, port, parallel slots, uptime, memory and GPU memory.</td></tr>
<tr><td><code>sushila top [--interval 2]</code></td><td>The same, refreshed every 2 s, with GPU use and the last tokens/s (Ctrl+C ends).</td></tr>
<tr><td><code>sushila mode &lt;pack&gt; standard|accelerated</code></td><td>Switches a running model at once; otherwise remembered for its next start.</td></tr>
<tr><td><code>sushila idle &lt;minutes&gt;|off</code></td><td>Unloads models nobody used for that long; the next request loads them again (it waits while the model loads).</td></tr>
<tr><td><code>sushila limit [--threads N] [--parallel N] [--context N] [--gpu-layers N]</code></td><td>Engine limits used when a model starts next (no flags: shows them).</td></tr>
<tr><td><code>sushila config list | get &lt;key&gt; | set &lt;key&gt; &lt;value&gt;</code></td><td>The settings (port, enginePort, threads, contextSize, gpuLayers, parallel, idleMinutes, keepCopy, catalogUrl, ticker), checked before they are saved.</td></tr>
<tr><td><code>sushila queue [list] | pause [&lt;id&gt;] | resume [&lt;id&gt;] | cancel &lt;id&gt;</code></td><td>The running server's background queue (without an id: the whole queue).</td></tr>
<tr><td><code>sushila history [show &lt;id&gt;]</code></td><td>Past queue jobs with prompt, settings, seed, times and the output file.</td></tr>
<tr><td><code>sushila open [admin|docs|assistant]</code></td><td>Opens the page in the browser.</td></tr>
<tr><td><code>sushila example &lt;pack&gt; [curl|python|js]</code></td><td>A working API request for this computer (with its local token) and for other machines (with an access key).</td></tr>
<tr><td><code>sushila share on [--open] | off | qr</code></td><td>Other machines: <code>on</code> makes the next <code>sushila serve</code> listen on the network (keys needed unless <code>--open</code>), <code>off</code> stops sharing at once, <code>qr</code> prints a QR code of the network address for a phone.</td></tr>
<tr><td><code>sushila https &lt;domain&gt;</code></td><td>HTTPS for a domain: writes a Caddyfile (Caddy forwards to this server), allows that host name, prints the steps; offers to start Caddy if it is installed. Installs nothing itself.</td></tr>
<tr><td><code>sushila home</code></td><td>Sushila's <b>home folder</b>: where <code>model-packs</code>, settings, logs and the engine live. Sushila remembers it in one small text file in your own settings folder, which every user can write without admin rights: Windows <code>%APPDATA%\\sushila\\home</code> (<code>C:\\Users\\&lt;you&gt;\\AppData\\Roaming\\sushila\\home</code>), macOS <code>~/Library/Application Support/sushila/home</code>, Linux <code>~/.config/sushila/home</code>. It holds one line, the folder's path, which you can also edit by hand; <code>sushila home</code> prints where it is. Sushila reads it at every start and goes straight there. It is the only file Sushila keeps outside its home folder. If it is deleted, Sushila searches again (and writes it again); if it finds no home, it asks for the folder of your existing home, or starts a new one when you press Enter. The first time, it searches the usual places (the system's app-data folder, next to the program, the current folder, <code>~/sushila</code>, Documents, Downloads); if it finds several homes it <b>asks</b> which one to use. <code>sushila home &lt;folder&gt;</code> makes another folder the home (replacing the remembered one); <code>sushila home --reset</code> forgets it so the next start searches again; <code>--data-dir &lt;folder&gt;</code> uses a folder for one command only. The home is also printed every time the server starts. (<code>sushila location</code> is the same command.)</td></tr>
<tr><td><code>sushila url</code></td><td>The addresses: <b>Inference URL</b> (the page for using models, e.g. <code>http://localhost:8765/</code>), <b>Admin URL</b> (<code>http://localhost:8765/admin</code>, this computer only, password protected), the OpenAI-compatible API, and the address for other machines when serving on the network. The same block is printed every time the server starts, in the terminal or in the window that opens when you double-click <code>sushila</code>.</td></tr>
<tr><th colspan="2">Generating from the terminal</th></tr>
<tr><td><code>sushila run &lt;pack&gt; "&lt;prompt&gt;"</code></td><td>One answer (printed), or one picture, video or song (saved). Uses the running model if there is one.</td></tr>
<tr><td><code>... --out file.png</code></td><td>Where to save; images also take <code>--size 1024x1024 --seed 42</code>, video <code>--size 1280x704 --frames 121</code>, music <code>--lyrics "..." --duration 60</code> (the prompt is the style).</td></tr>
<tr><td><code>sushila chat [&lt;pack&gt;] [--standard]</code></td><td>Chat in the terminal, streamed; keeps the conversation. <code>/clear</code> forgets it, <code>/save &lt;file&gt;</code> saves it, <code>/exit</code> ends.</td></tr>
<tr><td><code>sushila ask &lt;file&gt; "&lt;question&gt;" [--pack p]</code></td><td>Answers a question about a text, markdown or code file (long files are read in parts). PDF: convert it to text first.</td></tr>
<tr><td><code>sushila batch &lt;pack&gt; &lt;prompts.txt&gt; [--out &lt;folder&gt;]</code></td><td>One prompt per line (<code>#</code> starts a comment): one output each, plus <code>index.json</code> with prompt, seed, settings and seconds.</td></tr>
<tr><td><code>sushila watch &lt;folder&gt; [--pack p] [--once]</code></td><td>Each new <code>.txt</code> file in the folder is a prompt: the output is written next to it, the prompt renamed to <code>.txt.done</code>.</td></tr>
<tr><td><code>sushila embed &lt;pack&gt; &lt;text|file&gt;</code></td><td>An embedding vector (<code>/v1/embeddings</code>). A chat engine does not compute embeddings, so a separate engine with <code>--embeddings</code> is started for it.</td></tr>
<tr><td><code>sushila bench &lt;pack&gt; [--prompt ..] [--runs 3]</code></td><td>Speed on this computer in Standard and Accelerated (tokens/s for text, seconds for images, music and video), the speedup, saved in <code>bench/</code> in the home folder.</td></tr>
<tr><td><code>sushila eval &lt;pack&gt; [--n 20]</code></td><td>Accuracy on 20 built-in grade-school math questions, in Standard and Accelerated.</td></tr>
<tr><th colspan="2">Security and logs</th></tr>
<tr><td><code>sushila password</code></td><td>Sets the admin password, or changes it (asks the current one first).</td></tr>
<tr><td><code>sushila password --reset</code></td><td>Lost the password: sets a new one without the old one. Only on this computer.</td></tr>
<tr><td><code>sushila keys add &lt;name&gt;</code></td><td>An access key for another machine or program (shown once; only its hash is kept).</td></tr>
<tr><td><code>sushila keys list</code> / <code>sushila keys remove &lt;name&gt;</code></td><td>Lists or revokes keys.</td></tr>
<tr><td><code>sushila logs [-f] [-n 40]</code></td><td>The log of every action, from the web page, the commands and the queue (<code>-f</code> follows it).</td></tr>
<tr><td><code>sushila service install [--packs a,b] [--public] [--port N]</code></td><td>Starts the server automatically (at boot or login).</td></tr>
<tr><td><code>sushila service remove</code></td><td>Stops starting it automatically.</td></tr>
<tr><td><code>sushila backup &lt;file.zip&gt; / sushila restore &lt;file.zip&gt;</code></td><td>Settings, access keys (their hashes), queue history and the admin password hash; never the model packs. Restore with the server stopped.</td></tr>
<tr><td><code>sushila report [&lt;file&gt;]</code></td><td>A zip for bug reports: versions, GPU, settings, the last 300 log lines, crashes. Access keys, tokens and the password hash are removed.</td></tr>
<tr><td><code>sushila version [--verify]</code></td><td>Versions of sushila and the engine; <code>--verify</code> prints this program's SHA-256 and checks it against Sushila's signed list of builds when one is published.</td></tr>
<tr><td><code>sushila completion bash|zsh|fish|powershell</code></td><td>Tab completion for your shell.</td></tr>
<tr><td><code>sushila reproduce [&lt;name&gt;]</code></td><td>The commands that reproduce the paper's results (e.g. <code>yue</code>, <code>zimage</code>, <code>wan</code>, <code>llama3.3-70b</code>) and the link to the full guide.</td></tr>
<tr><td><code>sushila uninstall [--all] [--yes]</code></td><td>Removes the start-at-login service and the home pointer; <code>--all</code> also deletes the home folder after listing it and asking.</td></tr>
</table>
<div class="note">While a server runs, <code>install</code>, <code>remove</code>, <code>engine install</code>, <code>start</code> and <code>stop</code> are sent
to it and you see its progress: the server is the one place that changes anything, so the web page and the commands always agree.</div>

<h2 id="os">Windows, macOS, Linux</h2>
<p>The commands are identical. What differs is how you open a terminal, how you call the program, and a first-run security prompt.</p>
<div class="os">
<div><h4>Windows</h4>
Terminal: PowerShell, Command Prompt or Git Bash.<br>
In the folder of the file: <code>.\\sushila.exe serve</code><br>
Anywhere: put <code>sushila.exe</code> in a folder on your PATH, then <code>sushila serve</code>.<br>
First run: SmartScreen may say "unknown publisher": More info → Run anyway.</div>
<div><h4>macOS</h4>
Terminal: Terminal or iTerm.<br>
<code>chmod +x sushila</code> once, then <code>./sushila serve</code><br>
Anywhere: <code>sudo mv sushila /usr/local/bin/</code>, then <code>sushila serve</code>.<br>
First run: if macOS blocks it, System Settings → Privacy &amp; Security → Open Anyway (or <code>xattr -d com.apple.quarantine sushila</code>).</div>
<div><h4>Linux</h4>
Terminal: any shell.<br>
<code>chmod +x sushila</code> once, then <code>./sushila serve</code><br>
Anywhere: <code>sudo mv sushila /usr/local/bin/</code>, then <code>sushila serve</code>.<br>
NVIDIA: a recent driver is enough (the CUDA runtime comes with the engine).</div>
</div>

<h2 id="serve">Serving and the web page</h2>
<p><code>sushila serve</code> runs one web server on one port (default 8765). The page has two tabs:</p>
<ul>
  <li><b>Use</b>: chat, code, images, music and video with the running models; a background queue for long jobs.</li>
  <li><b>Admin</b> (this computer only, with the admin password): Packs (install, start, stop, verify, remove), Engine, Queue, Logs, Settings.</li>
</ul>
<p>Every page has the ☰ menu with Inference, Admin (this computer only), this documentation and the API, followed by the four addresses and, on this computer, the home folder: the same lines the server prints when it starts. Each running model's engine listens on an internal port
(8766, 8767, …) on 127.0.0.1 only; the server forwards to it, so only the one port is ever exposed.</p>
<p><b>Accelerated or Standard</b>: Accelerated uses Sushila's precomputed files for the model (faster); Standard is the plain model,
as Ollama or stock llama.cpp would run it. Switch on the Use tab, or start with <code>--standard</code>.</p>
<h3 id="window">The server window</h3>
<p>The window where <code>sushila serve</code> runs (it opens when you double-click <code>sushila</code>) takes typed lines:</p>
<ul>
  <li><b>A command</b>, with or without the word <code>sushila</code> (<code>ps</code>, <code>status</code>, <code>install qwen3-4b-instruct-2507</code>), runs right there. Commands that
      delete or change things (remove, uninstall, clean, update, restore, import, share on, keys remove, password --reset, home &lt;folder&gt;) ask
      <code>Run this? [y/N]</code> first. Commands that run until Ctrl+C (top, logs -f, watch) belong in another terminal: Ctrl+C here stops the server.</li>
  <li><b>A question</b> (<code>how do I add a coding model?</code>) is answered by the Sushila assistant, with the sections it used.</li>
  <li><b>A mistyped command</b> (<code>instal qwen</code>) gets a suggestion (with a small model, found by spelling and by matching words to commands and pack ids) (<code>Did you mean \`sushila install qwen\`? Run it? [y/N]</code>); nothing runs without a yes.</li>
  <li><code>?</code> lists the important commands, <code>urls</code> the addresses, <code>stop</code> stops the server.</li>
</ul>
<p><b>The ticker.</b> The bottom line of the window scrolls, like an LED message board, one short sentence for every command
("To add a new model pack: sushila install &lt;pack&gt; …", with this server's real addresses), with live news in between (models
running and their mode, the queue's job and progress, GPU memory, requests served). Everything else scrolls above it. It starts
with its keys: <b>Enter</b> pauses or resumes (paused, the whole message is shown), <b>b</b> goes back one message (and pauses; b again goes further
back), <b>n</b> forward, <b>all</b> prints every message, grouped like the command list, with the live news and their times, so you can scroll up and read them.
<code>ticker off</code> / <code>ticker on</code> hide or show it; <code>sushila config set ticker off</code> keeps it off. It is off by itself when the output
is not a terminal, with <code>--json</code> or <code>--quiet</code>, with <code>TERM=dumb</code> or <code>SUSHILA_TICKER=0</code>, and in windows narrower than 40 columns.
Windows: escape sequences and UTF-8 are turned on for the console at start (Windows Terminal and the classic console); where symbols cannot be shown it uses ASCII keys.
On exit (stop, Ctrl+C, a crash) the window is left as it was.</p>

<h2 id="network">Other machines and the internet</h2>
<pre>sushila serve --public --port 8844      # listens on all addresses
sushila keys add alice                  # prints a key once, e.g. sk-sushila-…</pre>
<ul>
  <li>Browser: <code>http://&lt;server address&gt;:8844/</code>; the page asks for the key once and the browser remembers it.</li>
  <li>From the internet: open the port in the firewall (and the router), then <code>http://&lt;public IP&gt;:8844/</code>.</li>
  <li>Admin is never available from other machines, with or without a key.</li>
  <li><code>--open</code>: no key needed for chat and generation; anyone who can reach the port can use your GPU.</li>
</ul>
<div class="note warn">Plain <code>http://</code> sends keys unencrypted. For use over the internet, put HTTPS in front: Cloudflare Tunnel,
Caddy or nginx (any reverse proxy that forwards to the port works).</div>

<h2 id="admin">Admin password</h2>
<ul>
  <li><b>First start</b>: asked in the terminal (typed twice, not shown); without a terminal (double-click, service), the Admin tab asks
      for it the first time, and only on this computer.</li>
  <li><b>Stored</b> as a one-way hash (Argon2id) in the file <code>adminpassword</code> in the data folder; it cannot be read back.</li>
  <li><b>Change it</b>: Admin → Settings, or <code>sushila password</code>. Both ask for the current password first. Other browsers are logged out.</li>
  <li><b>Lost it</b>: on this computer, <code>sushila password --reset</code> sets a new one without the old one. Every old login ends.</li>
  <li>The commands themselves never need the password: they run as you, on this computer.</li>
</ul>

<h2 id="api">API (OpenAI-compatible)</h2>
<pre>curl http://localhost:8765/v1/chat/completions \\
  -H "Authorization: Bearer &lt;key&gt;" -H "content-type: application/json" \\
  -d '{"model":"qwen3-4b-instruct-2507","messages":[{"role":"user","content":"Hello"}]}'</pre>
<table>
<tr><th>Path</th><th>What</th></tr>
<tr><td><code>/v1/chat/completions</code>, <code>/v1/completions</code></td><td>Text (streaming supported); <code>"model"</code> names a running pack.</td></tr>
<tr><td><code>/v1/models</code></td><td>The running models.</td></tr>
<tr><td><code>/v1/images/generations</code></td><td>Images.</td></tr>
<tr><td><code>/v1/video/…</code>, <code>/v1/music/…</code></td><td>Video and music jobs (used by the page).</td></tr>
<tr><td><code>/api/state</code></td><td>Installed packs, running models, actions in progress.</td></tr>
<tr><td><code>/api/queue</code></td><td>The background queue.</td></tr>
<tr><td><code>/health</code></td><td>The server is alive (200). For process monitors.</td></tr>
<tr><td><code>/ready</code></td><td>200 when at least one model is loaded and answering, else 503. For load balancers.</td></tr>
<tr><td><code>/metrics</code></td><td>Prometheus counters: requests by model and status, requests in flight, 429 refusals, time per request, slots, queue (this computer or a key).</td></tr>
</table>
<h3>Many users</h3>
<ul>
  <li><b>Parallel slots</b>: each text model serves several requests at once (continuous batching). Sushila chooses the number from the
      GPU memory left after the model (1-16; Settings → "Parallel requests per model", 0 = automatic).</li>
  <li><b>When busy</b>: up to 4 × slots requests per model are accepted (the rest of the slots' work waits inside the engine); beyond that the
      answer is <code>429</code> with <code>Retry-After: 2</code>, which OpenAI clients and proxies retry by themselves.</li>
  <li><b>Request ids</b>: every answer carries <code>x-request-id</code> (yours, if a proxy sends one); each request is one line in the log
      (<code>api &lt;id&gt; &lt;caller&gt; &lt;model&gt; &lt;path&gt; -&gt; &lt;status&gt; in &lt;ms&gt;</code>).</li>
  <li><b>More machines</b>: run <code>sushila serve --public</code> on each and put a load balancer in front (it can use <code>/ready</code>);
      the API keeps no per-user state, so any machine can answer any request.</li>
</ul>
<p>Any OpenAI client works: base URL <code>http://&lt;server&gt;:&lt;port&gt;/v1</code> and the access key as the API key.</p>

<h2 id="packs">The model-packs folder</h2>
<p>Every model pack is one folder inside <code>model-packs</code>: the model files plus <code>sushila-pack.json</code> (its name, how to run it,
every file's SHA-256 and Sushila's signature). Adding a model is just adding a folder:</p>
<ol>
  <li>Download the pack's file (one <code>.zip</code> or <code>.sushilapack</code> per pack).</li>
  <li>Unzip it into <code>model-packs</code>, so you get <code>model-packs/&lt;pack&gt;/</code>.</li>
  <li>Within a few seconds the running server finds it, checks the signature and every file, and the model is available on the
      Use and Admin tabs. No restart. The log says <code>new pack in …: &lt;pack&gt; verified and available</code>.</li>
</ol>
<p>Removing a folder removes the model (it is stopped first if it runs). A folder that fails the checks is listed on Admin → Packs with
the reason and is never run. <code>sushila install &lt;pack&gt;</code>, <code>sushila install &lt;file&gt;.zip</code> and the Admin tab create exactly the
same folders. Big packs are checked once: a file is read again only if its size or date changes.</p>
<table>
<tr><th>Where</th><th>Which folder</th></tr>
<tr><td>Default</td><td><code>model-packs</code> in the data folder (below)</td></tr>
<tr><td>Everything in one place (e.g. a USB drive)</td><td>a <code>model-packs</code> folder next to <code>sushila</code> / <code>sushila.exe</code>: used when it exists</td></tr>
<tr><td>Anywhere else</td><td><code>--packs-dir &lt;folder&gt;</code> or the environment variable <code>SUSHILA_PACKS</code></td></tr>
</table>
<p><code>sushila engine info</code> shows which folder is used.</p>
<h3>Your own model (GGUF)</h3>
<p>Any text model in GGUF format (the files Ollama, LM Studio and llama.cpp use, e.g. from Hugging Face) can be added:</p>
<pre>sushila install hf:Qwen/Qwen2.5-7B-Instruct-GGUF/qwen2.5-7b-instruct-q4_k_m.gguf     # from Hugging Face (@revision optional)
sushila install C:\\Users\\me\\Downloads\\my-model.gguf                                # a file you have</pre>
<p>or drop the <code>.gguf</code> file (or a folder holding it) into <code>model-packs</code>, or use Admin → Packs → "Add from Hugging Face".</p>
<ul>
  <li><b>If we precomputed it</b> (the file is byte for byte one of our packs' models, compared by SHA-256), it becomes that signed pack:
      only the precomputed files are downloaded, and Accelerated is available.</li>
  <li><b>Otherwise</b> it is listed as <b>your own model, not verified by Sushila</b>, and runs in Standard mode (no precomputed files).
      A Hugging Face download is checked against the SHA-256 Hugging Face lists for it, and its repository and revision are recorded.</li>
  <li>Split files (<code>-00001-of-0000N</code>) load from the first part; a vision projector (a file named <code>*mmproj*</code>) is used with it.</li>
  <li>Hugging Face's original format (safetensors with <code>config.json</code>) is not run directly: use its GGUF version, or convert it with llama.cpp's
      <code>convert_hf_to_gguf.py</code>.</li>
</ul>

<h2 id="files">Files and folders</h2>
<p>Created the first time; nothing is searched for, and no administrator rights are needed. The program itself can live anywhere.</p>
<table>
<tr><th>System</th><th>Data folder</th></tr>
<tr><td>Windows</td><td><code>%APPDATA%\\ai.sushila.hoststation</code></td></tr>
<tr><td>macOS</td><td><code>~/Library/Application Support/ai.sushila.hoststation</code></td></tr>
<tr><td>Linux</td><td><code>~/.local/share/ai.sushila.hoststation</code></td></tr>
</table>
<p>Another folder: <code>--data-dir &lt;folder&gt;</code> or the environment variable <code>SUSHILA_HOME</code>. Inside:</p>
<table>
<tr><td><code>engine/&lt;version&gt;/</code></td><td>Sushila.cpp (text, image/video and music engines)</td></tr>
<tr><td><code>model-packs/&lt;pack&gt;/</code></td><td>Installed model packs (one folder each; see above)</td></tr>
<tr><td><code>logs/sushila.log</code></td><td>Every action, with its source (page, cli, server)</td></tr>
<tr><td><code>logs/&lt;pack&gt;.log</code></td><td>The engine output of each model</td></tr>
<tr><td><code>outputs/</code>, <code>queue.json</code></td><td>Finished queue jobs (images, songs, videos, texts) and the queue</td></tr>
<tr><td><code>state.json</code></td><td>Settings, installed packs, what runs (written only by the server)</td></tr>
<tr><td><code>adminpassword</code>, <code>admin-cli.token</code></td><td>The admin password's hash; the commands' private token</td></tr>
<tr><td><code>downloads/</code></td><td>Partial downloads (resumed automatically)</td></tr>
</table>

<h2 id="service">Start automatically</h2>
<p><code>sushila service install</code> uses each system's own service manager:</p>
<table>
<tr><th>System</th><th>How</th><th>Check</th></tr>
<tr><td>Windows</td><td>Task Scheduler task "Sushila", at logon</td><td><code>schtasks /Query /TN Sushila</code></td></tr>
<tr><td>macOS</td><td>launchd agent <code>ai.sushila.serve</code>, at login</td><td><code>launchctl list | grep sushila</code></td></tr>
<tr><td>Linux</td><td>systemd user service <code>sushila.service</code> (also without a login session)</td><td><code>systemctl --user status sushila</code></td></tr>
</table>

<h2 id="trouble">Troubleshooting</h2>
<ul>
  <li><b>First step, always</b>: <code>sushila selftest</code>, then <code>sushila logs -n 60</code>.</li>
  <li><b>"port is busy"</b>: another server already runs (<code>sushila status</code>), or use <code>--port</code>.</li>
  <li><b>A model does not start</b>: its engine output is in <code>logs/&lt;pack&gt;.log</code>. If the GPU engine cannot load a model
      (e.g. an old driver), Sushila switches to the next engine (CUDA → Vulkan → CPU) by itself and says so in the log;
      <code>sushila engine install</code> tries the GPU again after a driver update.</li>
  <li><b>Slow</b>: <code>sushila engine info</code> shows whether the GPU is used; the model's log shows how many layers are on the GPU.</li>
  <li><b>A download stopped</b>: run the same command again; it resumes.</li>
  <li><b>A pack seems damaged</b>: <code>sushila verify &lt;pack&gt;</code>; reinstall it if a file is listed.</li>
  <li><b>Lost the admin password</b>: <code>sushila password --reset</code> on this computer.</li>
  <li><b>It crashed</b>: Sushila restarts itself; Admin → Logs → Crashes shows why (exit code or signal, the error, the last log lines).</li>
</ul>
</main>
</div>
<script>
// the addresses (and, on this computer, the home folder) in the ☰ menu, as the server prints them at start;
// on the website (sushila.ai) there is no server behind the page, so the block stays empty
(function () {
  var w = document.getElementById('mwhere'); if (!w || location.protocol === 'file:') return;
  fetch('/api/admin').then(function (r) { return r.ok ? r.json() : Promise.reject(); }).then(function (a) {
    var o = location.origin, rows = ['Inference: ' + o + '/'];
    if (a.allowed) rows.push('Admin: ' + o + '/admin'); else { var m = document.getElementById('madmin'); if (m) m.remove(); }
    rows.push('Documentation: ' + o + '/docs', 'API (OpenAI): ' + o + '/v1'); if (a.home) rows.push('Home folder: ' + a.home);
    rows.forEach(function (t) { var d = document.createElement('div'); d.textContent = t; w.appendChild(d); });
  }).catch(function () {});
})();
</script>
</body>
</html>
`;
// SUSHILA_DOCS_END

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = (b) => (b / 1e9).toFixed(b < 1e10 ? 1 : 0) + ' GB';

// Logo (logo/SushilaLogoWithBaseG.jpg: background made transparent, cropped, resized, 256-colour palette), served from memory.
// Logo animation (logo/SushilaLogoWithBaseG.mp4, 10 s, 1280x720, 24 fps, H.264 + AAC, 4.3 MB): too large to embed, so it is
// served from B2 under media/<key>; without B2 settings the page omits it.
const VIDEO = { key: 'SushilaLogoWithBaseG.mp4', type: 'video/mp4' };

const IMAGES = {
  '/logo-swan.png': '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',
  '/logo-base.png': 'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAMAAABrrFhUAAADAFBMVEUAAABnaXJ+fn7U1dSnp6/l5enHx83///6IiJGam6S0s7vJycnU1Nq7u8KTk5v29/t4eoTl5ubc3OFZW2Vwcnvc4eGSk5rb2+CMjJJdYG2eoKeZmaFVVFtHR042Nkh+gIujo6m8vL6gn6i+wMZgX2Vyc3mVlZnAvsfc4dzg3uMWFhZtbXOAf4iLjJHf4OHy8u9bW1t/f/9+gISIiY6RkZGRkaOdoKajpKa/xcXU1NTj4+QvLy82NjZbW22Pj5KcnJycnJ6UkpWurLC+vsDDvcPFxb/Dw8bg2+Dm5uYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACS90U4AAABAHRSTlMA7gIt+/7+A/n7/ij+/vj+/in++vk03Tfa/vPe8g4O/g4q+/7x1nD+Nf8PDvqq/jAOAoyNDg7ekSgGShAODmVdjKV/ZisoZzofAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjIUqjAAAAwJJREFUeNrt1+l6mkAUgGEBIyiagkpQE7Vu2ddmT/e9939FHbaZATFp+qT50Xyvj6IjzMw5s4iVCgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB5in9l/yFTKv7fPzJXsv+iZXajiCSw38oyZvjWH++K4PxoOR6PR8PT9gXlx+Tp2eWEeHJxG5cPhu+ikt+btv+laSQqslcL0+HM38IMwCH0/FEd/1wqCwPcD8UkTl/j+ryD+ssTJ3Y8v10eO1zWMjjSfG/N5/G4r0zEWvc/XX+9O/BP9csuK6w/DMAjEixXK7hW6vBtoRK9FQXZmWBL+ds9xDp17rOfUpelgMKjmiM/1wdXVprJRtCmqcEQOIsaSuNiLmtzopZI38bVR20ttFgySvsnuFkJxep/sYvxOtaGubwitVi3TzLRja0+h3T5Oj3GVx9HrcaHq9p7+ae/RLUd1NgvSkOpHtrYKzIrrVJ3iGHjCWI1+lNFc2huNJE+RWe0hehLT/r0qk8aq9bXVSlpaMT5L4c1a2cnZJJBDP/ZS6zXnowhbJWDb6251NP2+SkVyyVitBDn7B+XZiDR0UUEuEWoelYffbmaxy2CmWTTikLWYT4LMVhx6Gvah6HpukfWFTr/jOW+0BWBWPnQNGboKXkavh79eL58LWei11myWS0FcuqMnoL1qFsiZ21QZaKnBT9Kuws9q1We3zEA9HfgoBV7JVpNPwETfkbUJIDOgtkLVCTnwSYzFSZ8PXI9+7Z41UEjBjp6A6nQ6rRaGX+1NSQrUFEg6nISfj70vHp1tbQmITfDcMEp3Y08Zl/0q1EsMtPeF3VmbKiu2jWzuyEv07bzYcOn2rxa9XPIlPzYLO38rYJ8vugkjevzvFkfW8p2AO5l8E0/XndzcfHcj0T2DW2CJh2s9J3eVx56vXbl8L2y/uL8+yyXmC2Lz5xcAAFR+A86+axIcsq5VAAAAAElFTkSuQmCC',
  '/logo.png': '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',
  '/apple-touch-icon.png': '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',
  '/favicon.png': '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',
  '/favicon-32.png': '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',
};
IMAGES['/favicon.ico'] = IMAGES['/favicon-32.png'];  // browsers accept a PNG here
const ICON_LINKS = `<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="64x64" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:image" content="https://sushila.ai/logo.png">`;

const STYLE = `:root{--bg:#fbfaf7;--fg:#1c1f23;--mut:#5b636d;--line:#e3e0d8;--card:#ffffff;--acc:#0f766e;--acc2:#115e59;--accbg:#e6f4f1;--code:#f2f0ea}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111416;--fg:#e8e6e1;--mut:#9aa3ad;--line:#2a3035;--card:#171b1e;--acc:#2dd4bf;--acc2:#5eead4;--accbg:#12302c;--code:#1e2327}}
:root[data-theme="dark"]{--bg:#111416;--fg:#e8e6e1;--mut:#9aa3ad;--line:#2a3035;--card:#171b1e;--acc:#2dd4bf;--acc2:#5eead4;--accbg:#12302c;--code:#1e2327}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--acc)}
.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
header{border-bottom:1px solid var(--line)}
nav{display:flex;align-items:center;gap:20px;height:60px}
nav .brand{font-weight:700;font-size:18px;color:var(--fg);text-decoration:none;display:flex;gap:8px;align-items:center}
nav .links{margin-left:auto;display:flex;gap:18px;font-size:15px;flex-wrap:wrap;justify-content:flex-end}
nav .links a{color:var(--mut);text-decoration:none}
nav .links a:hover{color:var(--fg)}
.herologo{position:relative;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.herologo img{position:absolute;inset:0;width:100%;height:100%;user-select:none;-webkit-user-drag:none}
.herologo .swan{transform-origin:54% 92.2%;will-change:transform}
.herologo.rock .swan{animation:rock 2.6s ease-in-out}
@keyframes rock{0%{transform:rotate(0)}12%{transform:rotate(-9deg)}30%{transform:rotate(7deg)}47%{transform:rotate(-5deg)}63%{transform:rotate(3deg)}79%{transform:rotate(-1.5deg)}91%{transform:rotate(.6deg)}100%{transform:rotate(0)}}
.brand img{transform-origin:54% 92.2%}
.brand:hover img,.brand:active img{animation:rock 1.6s ease-in-out}
@media (prefers-reduced-motion:reduce){.herologo.rock .swan,.brand:hover img,.brand:active img{animation:none}}
.intro{margin:0 0 40px}.intro video{display:block;width:100%;max-width:760px;height:auto;margin:0 auto;border-radius:14px;background:#000;box-shadow:0 6px 30px rgba(0,0,0,.18)}
.hero{padding:56px 0 40px;display:flex;align-items:center;gap:32px}.herotext{flex:1;min-width:0}.herologo{flex:none;width:220px;height:220px}
.hero h1{font-size:clamp(30px,5vw,48px);line-height:1.15;margin:0 0 16px;letter-spacing:-.02em}
.hero p{font-size:19px;color:var(--mut);max-width:680px;margin:0 0 28px}
.btn{display:inline-block;background:var(--acc);color:var(--bg);padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;border:0;font-size:15px;cursor:pointer}
.btn:hover{background:var(--acc2)}
.btn.ghost{background:transparent;color:var(--acc);border:1px solid var(--line)}
.btn.small{padding:6px 12px;font-size:14px}
.herocta{display:block;font-size:20px;line-height:1.3;padding:16px 22px;margin:18px 0 6px;border-radius:12px;text-align:left;box-shadow:0 6px 18px rgba(15,118,110,.25)}
.herocta span{display:block;font-size:14px;font-weight:500;opacity:.9;margin-top:4px}@media (max-width:640px){.herocta{font-size:17px}}
.btn.off{background:var(--code);color:var(--mut);cursor:default}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
section{padding:44px 0;border-top:1px solid var(--line)}
h2{font-size:26px;margin:0 0 8px;letter-spacing:-.01em}
.lead{color:var(--mut);margin:0 0 24px;max-width:720px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
.card h3{margin:0 0 6px;font-size:17px}
.card p{margin:0;color:var(--mut);font-size:15px}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:15px}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);font-weight:600}
tr:last-child td{border-bottom:0}
.avg td{border-top:2px solid var(--line, #ccc)}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.act{white-space:nowrap;text-align:right}
.sub{color:var(--mut);font-size:13px}
.tag{display:inline-block;background:var(--accbg);color:var(--acc);font-size:12px;font-weight:600;padding:1px 8px;border-radius:99px;margin-left:4px}
.copy{background:none;border:1px solid var(--line);color:var(--mut);border-radius:6px;padding:5px 8px;font-size:12px;cursor:pointer;margin-left:6px}
pre{background:var(--code);border-radius:10px;padding:16px;overflow-x:auto;font-size:14px;margin:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.disc p{margin:0 0 12px;color:var(--mut);font-size:14px}.disc p:last-child{margin:0}
.tabs{display:flex;gap:6px;margin-bottom:12px}.tab{background:var(--card);border:1px solid var(--line);color:var(--mut);padding:7px 16px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}.tab[aria-selected="true"]{background:var(--accbg);color:var(--acc);border-color:var(--acc)}.ospanel{margin-bottom:8px}.ospanel .sub{margin:0 0 8px}
.note{font-size:14px;color:var(--mut);margin-top:12px}
form{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
input{flex:1 1 240px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font-size:15px}
#msg{margin-top:10px;font-size:14px;min-height:1.4em}
footer{border-top:1px solid var(--line);padding:28px 0 40px;color:var(--mut);font-size:14px}
@media (max-width:640px){.hero{flex-direction:column-reverse;align-items:flex-start;gap:12px}.herologo{width:120px;height:120px}nav{height:auto;flex-wrap:wrap;padding:10px 0;gap:8px}nav .links{margin-left:0;gap:6px 14px;font-size:14px;justify-content:flex-start}.hero{padding:40px 0 28px}th,td{padding:8px 10px}}
.doc{max-width:760px;padding:40px 0 56px}
.doc h1{font-size:34px;margin:0 0 4px;letter-spacing:-.02em}
.doc h2{font-size:20px;margin:32px 0 8px}
.doc p,.doc li{color:var(--fg)}
.doc .meta{color:var(--mut);margin:0 0 24px}
`;

const accountLink = (user) => user ? `${user.isAdmin ? '<a href="/admin">Admin</a>' : ''}<a href="/account">${esc(user.firstName || 'Account')}</a>` : `<a href="/signin">Sign in</a>`;
const brand = () => `<a class="brand" href="/"><img src="/logo.png" width="32" height="32" alt=""> Sushila.cpp</a>`;

const footer = (contact) => `<footer><div class="wrap row" style="justify-content:space-between">
  <span>© ${new Date().getUTCFullYear()} Sushila, an open-source research project</span>
  <span><a href="/#disclaimer">Disclaimer</a> · <a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Policy</a> · <a href="/bugs/new">Report a bug</a> · <a href="mailto:${esc(contact)}">${esc(contact)}</a></span>
</div></footer>`;

function docPage(env, title, desc, body, user) {
  const contact = env.CONTACT || DEFAULT_CONTACT;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Sushila.cpp</title>
<meta name="description" content="${esc(desc)}">
${ICON_LINKS}
<style>
${STYLE}</style>
</head>
<body>
<header><div class="wrap"><nav>
  ${brand()}
  <div class="links"><a href="/">Home</a><a href="/manual" class="hide">Manual install</a><a href="/bugs/new">Report a bug</a>${accountLink(user)}</div>
</nav></div></header>
<main class="wrap"><article class="doc">
${body(contact)}
</article></main>
${footer(contact)}
</body>
</html>`;
}

const EFFECTIVE = '4 October 2026';
// Governing law and courts: set GOVERNING_LAW (e.g. "the State of Delaware, USA") once counsel confirms it.
const law = (env) => env.GOVERNING_LAW || 'the jurisdiction in which the operator of sushila.ai is established';

const TERMS = (env) => (contact) => `
<h1>Terms of Service</h1>
<p class="meta">Effective ${EFFECTIVE}</p>
<p>These Terms of Service ("Terms") govern your use of the sushila.ai website, the Sushila.cpp software and scripts, the model
files we host, and the Sushila serverless API (together, the "Services"), provided by the Sushila research project ("Sushila", "we",
"us"). By using the Services you agree to these Terms. If you use the Services for an organization, you agree on its behalf and
confirm that you may do so. If you do not agree, do not use the Services.</p>

<h2>1. The website and downloads are free</h2>
<p>The website, Sushila.cpp and the downloads are free of charge. Sushila.cpp is open-source software licensed under the MIT License;
that license, not these Terms, governs your rights to the source code. The model files are made by third parties (such as Meta and
Alibaba Cloud) and are governed by their own licenses and acceptable use policies, which you must read and follow. Llama models are
licensed under the applicable Llama Community License. "Built with Llama."</p>

<h2>1a. Accounts</h2>
<p>Downloading hosted files requires a free account. You sign in with one-time codes sent to e-mail addresses you control; keep access
to them secure, because anyone who can read those e-mails can sign in. Give accurate information, and use one account per person. Each
download is recorded together with your acceptance of the model's license. You may delete your account at any time by contacting us.</p>

<h2>2. The serverless API</h2>
<p>The serverless API is a paid service that runs open models on our GPUs. Pricing, usage limits and any API-specific terms are shown
when you sign up or in your account, and form part of these Terms. You are responsible for all usage under your API keys, for
keeping the keys secret, and for paying all fees and applicable taxes when due. We may change prices with at least 30 days' notice;
changes do not apply to usage before they take effect. We may suspend access for non-payment, for a breach of these Terms, or to
protect the Services or other users. Early-access sign-ups do not create an obligation for either party.</p>

<h2>3. Your prompts and outputs</h2>
<p>You keep all rights to the prompts and data you send to the API ("Inputs") and to the text the models produce for you ("Outputs"),
as far as the law and the model's license allow. You give us only the permission needed to process Inputs and Outputs to provide the
Services. We do not use your Inputs or Outputs to train models. You are responsible for your Inputs, including having the right to
send them, and for how you use the Outputs. See the <a href="/privacy">Privacy Policy</a>.</p>

<h2>4. Acceptable use</h2>
<p>You must not use the Services to: break any law or anyone's rights; violate a model's license or acceptable use policy; generate
or spread content that sexually exploits minors, incites violence, harasses others or is used for fraud; develop weapons capable of
mass harm; attack, probe or overload the Services or other systems; get around usage limits, billing or security; or resell API
access without our written permission. We may remove access for any of these.</p>

<h2>5. AI output</h2>
<p>Model outputs are produced automatically and can be wrong, incomplete, biased or offensive, and can resemble content owned by
others. Outputs are not professional advice (including medical, legal, financial or safety advice). Check Outputs before relying
on them, and use human review where errors could cause harm.</p>

<h2>6. No warranty</h2>
<p>THE SERVICES ARE PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, AVAILABILITY AND SECURITY. NO WARRANTY IS
IMPLIED OR GIVEN BY ANYTHING ON THE WEBSITE OR IN ANY COMMUNICATION FROM US. YOU USE THE SERVICES AT YOUR OWN RISK AND ASSUME ALL
RISKS OF THAT USE. Speed figures are measurements on specific hardware and settings; your results may differ.</p>

<h2>7. Limitation of liability</h2>
<p>TO THE FULLEST EXTENT PERMITTED BY LAW, SUSHILA, ITS CONTRIBUTORS AND SUPPLIERS ARE NOT LIABLE FOR ANY INDIRECT, INCIDENTAL,
SPECIAL, CONSEQUENTIAL, EXEMPLARY OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF DATA, PROFITS, REVENUE OR BUSINESS, ARISING FROM OR RELATED
TO THE SERVICES, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. OUR TOTAL LIABILITY FOR ALL CLAIMS RELATED TO THE SERVICES IS
LIMITED TO THE GREATER OF (A) THE AMOUNTS YOU PAID US FOR THE SERVICES IN THE 12 MONTHS BEFORE THE CLAIM AND (B) US$100.</p>

<h2>8. Indemnity</h2>
<p>You will defend and indemnify Sushila against third-party claims, and the resulting losses and costs (including reasonable
legal fees), that arise from your Inputs, your use of Outputs, or your breach of these Terms or of a model's license.</p>

<h2>9. Changes and termination</h2>
<p>We may change the Services or these Terms. For material changes to these Terms we will post the new version here with a new
effective date and, for API customers, give notice by e-mail at least 30 days before it applies. You may stop using the Services
at any time. We may suspend or end your access if you breach these Terms. Sections 3 and 5 to 10 survive termination.</p>

<h2>10. General</h2>
<p>These Terms are governed by the laws of ${esc(law(env))}, excluding its conflict-of-law rules, and disputes go to the courts
there, unless the law where you live requires otherwise. Some jurisdictions do not allow certain warranty exclusions or liability
limits; in those places they apply only as far as the law allows. If any part of these Terms is unenforceable, the rest stays in
effect. Failing to enforce a term is not a waiver. These Terms, the Privacy Policy and any API terms you accept are the entire
agreement about the Services. You may not transfer these Terms without our consent; we may transfer them with our business.</p>

<h2>11. Contact</h2>
<p>The Sushila project, <a href="mailto:${esc(contact)}">${esc(contact)}</a>.</p>
`;

const PRIVACY = (env) => (contact) => `
<h1>Privacy Policy</h1>
<p class="meta">Effective ${EFFECTIVE}</p>
<p>This policy explains what personal data the Sushila research project ("we") collects through sushila.ai, the model downloads and the
Sushila serverless API, why, and your choices. We collect as little as we can.</p>

<h2>1. What we collect</h2>
<ul>
<li><b>Your account:</b> the e-mail addresses you add and verify, your name and (optionally) organization, when you created the
account and last signed in, and records of sign-ins and e-mail changes. Sign-in codes are stored only as a keyed hash and expire after
5 minutes.</li>
<li><b>Downloads:</b> for each download, which file, when, that you accepted its license, and the country of your connection.</li>
<li><b>Download counts:</b> for every download of Sushila Host Station, Sushila.cpp, a model pack or a model file (from this website or
from Host Station), the file, the time, your IP address and country, your browser or app user agent and operating system, and the kind
of file. We use this to count downloads, plan capacity and prevent abuse, and delete each record after 12 months; only the totals per
file are kept.</li>
<li><b>Early-access sign-up:</b> the e-mail address and the optional list of models you enter, the time of sign-up and the country
of your connection (derived by our hosting provider from your IP address). If you choose to e-mail us instead, we receive what you
send.</li>
<li><b>Requests to the website and downloads:</b> our hosting provider, Cloudflare, processes your IP address, browser user agent,
the pages and files requested and the time, to deliver the site, prevent abuse and keep it secure.</li>
<li><b>Serverless API (when you use it):</b> your account and billing details, API usage (such as token counts and times) for
billing and capacity, and the Inputs and Outputs needed to answer each request.</li>
</ul>
<p>The website sets one cookie, a signed session cookie, only when you sign in. It uses no advertising, no tracking cookies and no
third-party analytics scripts. Copying a checksum uses your browser's
clipboard locally.</p>

<h2>2. Why we use it</h2>
<ul>
<li>to provide the website, downloads and API, and to bill for the API (performance of a contract);</li>
<li>to contact you about the early access you asked for (your consent, which you can withdraw at any time);</li>
<li>to secure the Services, prevent abuse and fix problems (our legitimate interests);</li>
<li>to meet legal, tax and accounting duties (legal obligation).</li>
</ul>

<h2>3. Prompts and outputs</h2>
<p>API Inputs and Outputs are processed only to answer your requests. We do not use them to train models, and we do not sell them.
We do not store them after a request completes, except as needed for short-term abuse prevention or debugging that you ask for, or
where the law requires it.</p>

<h2>4. Sharing</h2>
<p>We do not sell or rent personal data. We share it only with service providers that process it for us under contract, such as
Cloudflare (website hosting and network), Amazon Web Services (DynamoDB, where account and download records are stored), Backblaze
(B2, where the files you download are stored), Resend (which sends sign-in codes), GPU cloud providers that run the API, and a payment
processor for billing; with professional advisers; when the law requires it; or as part of a merger or sale of our business, under this policy.</p>

<h2>5. International transfers</h2>
<p>Our providers may process data in the United States and other countries. Where required, we use legal safeguards such as the
European Commission's Standard Contractual Clauses.</p>

<h2>6. How long we keep it</h2>
<p>Account data and download records are kept while your account exists; ask us to delete your account and we will delete them,
except where the law requires us to keep them. Early-access sign-ups are kept until you ask us to delete them or until early access ends
and you have not become a customer, whichever is first. API account and billing records are kept for as long as your account is open and then as long as tax and accounting laws
require. Hosting logs are kept by Cloudflare for a short period under its own policies.</p>

<h2>7. Your rights</h2>
<p>Depending on where you live (for example under the GDPR, the UK GDPR or California law), you may have the right to access,
correct, delete or export your personal data, to object to or restrict its use, and to withdraw consent. E-mail
<a href="mailto:${esc(contact)}">${esc(contact)}</a> to make a request; we will answer within 30 days. You may also complain to your
data protection authority. We do not sell or share personal data for cross-context behavioral advertising.</p>

<h2>8. Security</h2>
<p>Data is sent over HTTPS and stored with access limited to the people who need it. No system is perfectly secure; if a breach
affects your data, we will notify you as the law requires.</p>

<h2>9. Children</h2>
<p>The Services are not directed at children under 16, and we do not knowingly collect their personal data. If you believe a child has
given us personal data, contact us and we will delete it.</p>

<h2>10. Changes</h2>
<p>We will post any change here with a new effective date, and e-mail API customers and people on the early-access list about
material changes.</p>

<h2>11. Contact</h2>
<p>The Sushila project, <a href="mailto:${esc(contact)}">${esc(contact)}</a>.</p>
`;

function page(env, user, models, packs = [], app = null, mode = 'home') {
  const REPO = String(env.REPO_URL || REPO_DEFAULT).replace(/\/+$/, '');
  const released = String(env.RELEASED || '').toLowerCase() === 'true';
  const contact = env.CONTACT || DEFAULT_CONTACT;
  const dl = (path, label) => released
    ? `<a class="btn" href="${REPO}${path}">${label}</a>`
    : `<span class="btn off" title="The source is released together with the paper">${label} — with the paper</span>`;

  const hostedRows = models.map((m) => `
    <tr>
      <td><b>${esc(m.name)}</b>${m.tuned ? ' <span class="tag">precomputed</span>' : ''}${m.note ? `<div class="sub">${esc(m.note)}</div>` : ''}</td>
      <td>${esc(m.quant)}</td>
      <td class="num">${gb(m.bytes)}</td>
      <td><a href="${esc(m.licenseUrl)}">${esc(m.license)}</a></td>
      <td class="act"><a class="btn small" href="/download/${esc(m.file)}">Download</a>
        <button class="copy" data-copy="${m.sha256}" title="Copy sha256">sha256</button></td>
    </tr>`).join('');

  // model packs: installed by sushila (the Sushila.cpp server) running on the visitor's computer. "Install" opens its
  // page (http://localhost:8765/install/<pack>), which asks before installing; or the command; or the pack file
  const packRows = packs.map((p) => `
    <tr>
      <td><b>${esc(p.name)}</b>${(p.artifacts || []).length ? ' <span class="tag">precomputed</span>' : ''}<div class="sub">${esc(p.description || '')}</div></td>
      <td>${esc(p.category || '')}</td>
      <td class="num">${gb(p.files.reduce((a, f) => a + (f.bytes || 0), 0))}</td>
      <td>${p.licenseUrl ? `<a href="${esc(p.licenseUrl)}">${esc(p.license)}</a>` : esc(p.license)}</td>
      <td class="act"><a class="btn small sinstall" data-pack="${esc(p.id)}" href="http://localhost:8765/install/${esc(p.id)}" target="_blank" rel="noopener" title="Opens Sushila on this computer (it must be running: sushila serve, or double-click sushila); it asks before installing">Install</a>
        <button class="btn small ghost copycmd" data-cmd="sushila install ${esc(p.id)}" title="sushila install ${esc(p.id)}">Copy command</button>
        <a class="btn small ghost" href="/hoststation/pack/${esc(p.id)}.sushilapack" title="One file with the whole pack: sushila install ${esc(p.id)}.sushilapack, or unpack it into the model-packs folder">Download pack</a></td>
    </tr>`).join('');

  const listedRows = LISTED.map((m) => `
    <tr><td><b>${esc(m.name)}</b></td><td>${esc(m.license)}</td>
      <td class="act"><a class="btn small ghost" href="${esc(m.hf)}">Hugging Face ↗</a></td></tr>`).join('');


  if (mode === 'manual') {
    return docPage(env, 'Manual install', 'Install Sushila.cpp and download model files by hand: for developers and servers.', () => `
<style>.doc{max-width:1040px}</style>
<h1>Manual install</h1>
<p class="lead">The easy way is <a href="/hoststation">Sushila Host Station</a>: a few clicks install Sushila.cpp and model packs, with no command prompt. This page is the old-fashioned way, for developers, servers and scripts: build or download Sushila.cpp yourself and download model files directly.</p>
<section id="download">
  <h2>Download Sushila.cpp</h2>
  <p class="lead">Free and open source under the MIT License, like llama.cpp and Ollama. It reads the same GGUF files, including the
  ones Ollama has already downloaded, and has the same tools: <code>llama-cli</code>, <code>llama-server</code> (OpenAI-compatible API) and more.</p>
  <div class="row">${dl('/releases/latest', 'Prebuilt release')}${dl('/archive/refs/heads/main.zip', 'Source ZIP')}${dl('', 'GitHub')}</div>
  <div class="tabs" role="tablist" style="margin-top:24px">
    <button class="tab" data-os="linux" role="tab">Linux</button><button class="tab" data-os="mac" role="tab">macOS</button><button class="tab" data-os="win" role="tab">Windows</button>
  </div>
  <div class="ospanel" data-os="linux">
  <p class="sub">Ubuntu, Debian, Fedora and others; CPU or NVIDIA GPU. Tested on Ubuntu 22.04.</p>
  <pre><code># 1. tools (Ubuntu/Debian; on Fedora: sudo dnf install gcc gcc-c++ make cmake git curl)
sudo apt-get install -y build-essential cmake git curl
# 2. download
git clone ${REPO}.git && cd sushila.cpp
# 3. build (for an NVIDIA GPU add -DGGML_CUDA=ON; needs the CUDA toolkit)
cmake -S llama.cpp -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_USE_PREBUILT_UI=OFF
cmake --build build --config Release -j --target llama-cli llama-server llama-speculative-simple
# 4. run
build/bin/llama-server -m model.gguf -ngl 99 --port 8080</code></pre></div>
  <div class="ospanel" data-os="mac">
  <p class="sub">macOS 13 or newer, Apple Silicon or Intel. On Apple Silicon the GPU (Metal) is used automatically.</p>
  <pre><code># 1. tools
xcode-select --install
brew install cmake git
# 2. download
git clone ${REPO}.git && cd sushila.cpp
# 3. build
cmake -S llama.cpp -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_USE_PREBUILT_UI=OFF
cmake --build build --config Release -j --target llama-cli llama-server llama-speculative-simple
# 4. run
build/bin/llama-server -m model.gguf -ngl 99 --port 8080</code></pre></div>
  <div class="ospanel" data-os="win">
  <p class="sub">Windows 10/11 through WSL2 (real Linux inside Windows; NVIDIA GPUs work). A native Windows build is planned.</p>
  <pre><code># 1. in PowerShell as administrator, then restart
wsl --install
# 2. open "Ubuntu" from the Start menu and continue there
sudo apt-get update && sudo apt-get install -y build-essential cmake git curl
git clone ${REPO}.git && cd sushila.cpp
# 3. build (NVIDIA GPU: install the Windows NVIDIA driver, add -DGGML_CUDA=ON)
cmake -S llama.cpp -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_USE_PREBUILT_UI=OFF
cmake --build build --config Release -j --target llama-cli llama-server llama-speculative-simple
# 4. run
build/bin/llama-server -m model.gguf -ngl 99 --port 8080</code></pre></div>
  <p class="note">Already use Ollama? Reuse its files: <code>ollama show --modelfile llama3.1:8b | grep '^FROM /'</code> prints the model's path.
  Full guide: <a href="${REPO}/blob/main/INSTALL.md">INSTALL.md</a>. Provided as is, without warranty (<a href="/#disclaimer">disclaimer</a>).</p>
</section>

<section id="models">
  <h2>Models</h2>
  <p class="lead">We host these files ourselves. Downloads are free with a <a href="/signin">sushila.ai account</a> (no password: a code is sent to your e-mail), so we can record that you accepted each model's license. Each file is byte-identical to the public release, so check its sha256 after you download it.
  Models tagged <span class="tag">precomputed</span> come with measured Sushila artifacts.</p>
  <div class="tablewrap"><table>
    <thead><tr><th>Model</th><th>Quant</th><th class="num">Size</th><th>License</th><th></th></tr></thead>
    <tbody>${hostedRows}</tbody>
  </table></div>
  <p class="note">Downloads are provided as is, with no warranty; you assume all risks of use (see the <a href="/#disclaimer">disclaimer</a>).</p>
  <p class="note">Built with Llama. The Llama models are distributed under their community licenses and Meta's acceptable use policy.</p>

  <h3 style="margin:32px 0 6px">More models: download from Hugging Face</h3>
  <p class="lead" style="margin-bottom:16px">Any GGUF model runs with Sushila.cpp. Download these directly from their publishers.</p>
  <div class="tablewrap"><table>
    <thead><tr><th>Model</th><th>License</th><th></th></tr></thead>
    <tbody>${listedRows}</tbody>
  </table></div>
</section>

<script>
(function () {
  const tabs = document.querySelectorAll('.tab'), panels = document.querySelectorAll('.ospanel');
  const show = (os) => { tabs.forEach(t => t.setAttribute('aria-selected', t.dataset.os === os)); panels.forEach(p => p.hidden = p.dataset.os !== os); };
  tabs.forEach(t => t.addEventListener('click', () => show(t.dataset.os)));
  const ua = navigator.userAgent;
  show(/Windows/.test(ua) ? 'win' : /Mac OS X|Macintosh/.test(ua) ? 'mac' : 'linux');
})();
document.querySelectorAll('.copy').forEach(b => b.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'copied'; }
  catch (e) { prompt('sha256', b.dataset.copy); }
  setTimeout(() => b.textContent = 'sha256', 1500);
}));
</script>`, user);
  }

  const row = (r) => `
    <tr><td><b>${esc(r[0])}</b><div class="sub">${esc(r[1])}</div></td><td class="sub">${esc(r[2])}</td><td class="num">${esc(r[3])}</td><td class="num">${esc(r[4])}</td>
      <td class="num"><b>${esc(r[5])}</b></td><td class="sub">${esc(r[6])}</td></tr>`;
  const resultRows = RESULTS.map(row).join('')
    + RESULTS_AVG.map((a) => `<tr class="avg"><td colspan="4"><b>${esc(a[0])}</b></td><td></td><td class="num"><b>${esc(a[1])}</b></td><td class="sub">${esc(a[2])}</td></tr>`).join('').replace(/<td><\/td>/g, '')
    + RESULTS_MORE.map(row).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sushila.cpp — faster LLM inference, same model files</title>
<meta name="description" content="Sushila.cpp: a llama.cpp-based engine that precomputes per-model artifacts once, right after each model's release, so every token costs less. Same GGUF files, same output.">
${ICON_LINKS}
<style>
${STYLE}</style>
</head>
<body>
<header><div class="wrap"><nav>
  ${brand()}
  <div class="links"><a href="#how">How</a><a href="#results">Results</a><a href="#get">Get Sushila</a><a href="#packs">Packs</a><a href="/manual">Manual install</a><a href="#api">API</a><a href="/bugs/new">Report a bug</a>${accountLink(user)}</div>
</nav></div></header>

<main class="wrap">
<div class="hero"><div class="herotext">
  <h1>Faster LLM inference.<br>Same model files, same answers.</h1>
  <p>Sushila.cpp is a llama.cpp-based engine that does the expensive work once per model, right after the model is released,
  so every token you generate afterwards costs less. Llama-3.3-70B runs 4.05× faster than vanilla Ollama on the same GPU;
  on the very same model file, Llama-3.1-70B runs 2.0× faster than stock llama.cpp on a GPU and 2.3× on a CPU, with exactly its output.</p>
  <a class="btn herocta" href="#get">Run AI models on your own computer, free<span>One program for Windows, Mac and Linux · chat, code, images, music, video in your browser</span></a>
  <div class="row"><a class="btn ghost" href="#packs">Model packs</a><a class="btn ghost" href="/manual">Manual install</a><a class="btn ghost" href="#api">Serverless API</a></div>
</div><div class="herologo" id="swanlogo" role="img" aria-label="Sushila logo: a swan shaped like the letter S, with an S-marked integrated circuit, on a base"><img class="swan" src="/logo-swan.png" alt=""><img class="base" src="/logo-base.png" alt=""></div></div>

<section id="how">
  <h2>What Sushila.cpp does</h2>
  <p class="lead">Decoding is limited by how many bytes of weights the hardware reads per token. Sushila
  (<b>S</b>calable <b>U</b>pstream <b>S</b>ynthesis for <b>H</b>ybrid <b>I</b>nference in <b>L</b>arge-model <b>A</b>cceleration)
  computes small artifacts once per model so each token reads fewer bytes or the model runs fewer passes.</p>
  <div class="grid">
    <div class="card"><h3>Landscapes</h3><p>A precomputed map of each model's output layer: a cheap preview picks a short list of candidate tokens,
      which are then scored exactly. About 13–15% of the layer is read, with the same top token.</p></div>
    <div class="card"><h3>Precomputed draft heads</h3><p>A small head fitted on the model's own answers proposes several tokens; the full model checks them all
      in one pass. Accepted tokens are exactly what the model would have produced.</p></div>
    <div class="card"><h3>Landscape hunt</h3><p>Each model gets the stack that suits it. New models first try the existing landscapes,
      and a new one is searched for only if none fits.</p></div>
    <div class="card"><h3>Kernels</h3><p>Tree verification in llama.cpp and a tuned GPU kernel switch make checking 5–8 drafted tokens 18–38% cheaper.</p></div>
  </div>
  <p class="note">Sushila.cpp also uses established methods, including EAGLE-3 draft heads, small draft models and fast 4-bit kernels,
  and combines them with its own. The paper credits each method and reports how much it adds.</p>
</section>

<section id="results">
  <h2>Measured speed, every model</h2>
  <p class="lead">Sushila.cpp against the usual way to run each model locally, on the same hardware. Text: vanilla Ollama on one A100,
  160 unseen benchmark prompts, greedy decoding. Images, video and music: the reference engine on one RTX 4090.</p>
  <div class="tablewrap"><table>
    <thead><tr><th>Model</th><th>Baseline</th><th class="num">Baseline</th><th class="num">Sushila</th><th class="num">Speedup</th><th>Our precomputed part</th></tr></thead>
    <tbody>${resultRows}</tbody>
  </table></div>
  <p class="note">The text models' output is the model's own, up to numerical near-ties (GSM8K accuracy unchanged). Ollama reads a different
  4-bit file of the same model (GGUF Q4_K_M against AWQ or GPTQ), so its wording can differ. Image and video plans are measured by
  similarity (SSIM) to the uncached output. Most of the text speedup comes from published methods that Sushila.cpp combines per model:
  a faster engine with 4-bit kernels and EAGLE-3 speculative decoding. The last column is what our own once-per-model work adds.</p>

  <h3 id="retest">Retest it yourself</h3>
  <p>Every input is pinned so the numbers can be checked: software by version, model files by Hugging Face revision and SHA-256,
  and our draft heads by SHA-256 in a signed index at <code>files.sushila.ai/public/precomputed/&lt;model&gt;/</code>. One command on one
  80 GB NVIDIA GPU reruns a text model's comparison and prints the paper's numbers beside yours. It stops if a model tag now points to another file.</p>
  <pre><code>git clone https://github.com/syncaissa/sushila.cpp.git &amp;&amp; cd sushila.cpp
bash scripts/reproduce/retest.sh qwen3-32b     # or kimi-dev-72b, deepseek-r1-distill-llama-70b, gemma3-27b, ...</code></pre>
  <div class="tablewrap"><table style="margin-top:12px">
    <thead><tr><th>Component</th><th>Exact version</th></tr></thead>
    <tbody>
      <tr><td>Ollama (baseline)</td><td>0.35.1</td></tr>
      <tr><td>llama.cpp (base of Sushila.cpp)</td><td>b11232 (<code>6f767fe</code>), the version Ollama pins</td></tr>
      <tr><td>SGLang</td><td>0.5.21 (Gemma 3: 0.5.14)</td></tr>
      <tr><td>SpecForge (head refitting)</td><td><code>53398a8</code> + our patch</td></tr>
      <tr><td>Speculative decoding</td><td>EAGLE-3, 4 steps, top-k 4, 16 draft tokens</td></tr>
      <tr><td>stable-diffusion.cpp / acestep.cpp</td><td><code>3f8527a</code> / <code>694ef0f</code> + our patches</td></tr>
      <tr><td>GPU</td><td>A100 80GB (text), RTX 4090 (images, video, music)</td></tr>
    </tbody>
  </table></div>
  <p class="note">The model revisions and checksums of every row are in the paper's appendix "Exact Versions, for Retesting".
  A run counts as reproduced when the speedup is within 10% of ours. Absolute speeds follow the GPU, but all configurations run on the same one.</p>
</section>


<section id="get">
  <h2>Get Sushila</h2>
  <p class="lead">One program, <code>sushila</code> (<code>sushila.exe</code> on Windows), runs the models on your own computer and opens a page in your
  browser for chat, code, images, music and video. It uses your GPU (NVIDIA, AMD, Intel, Apple) automatically, and the CPU otherwise.</p>
  <ol class="steps">
    <li><b>Download</b> Sushila for your system (one file). <span class="sub">The downloads open when the Sushila paper is published:
      <a href="#" id="getnotify">email me when they are ready</a>.</span></li>
    <li><b>Run it</b>: double-click it; the first time it sets itself up for your GPU and asks you to choose an admin password.
      Or in a terminal: <code>sushila serve</code>. Your browser opens <code>http://localhost:8765</code>.</li>
    <li><b>Choose a model pack</b> below (<b>Install</b>), or on its Admin tab. Everything runs on your computer: free, private, offline once installed.</li>
  </ol>
  <div id="sstatus2" class="note" role="status" style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0">Checking whether Sushila runs on this computer…</div>
  <p class="sub">All commands, for Windows, macOS and Linux: <a href="/docs">documentation</a>.</p>
</section>

<section id="packs">
  <h2>Model packs</h2>
  <div id="sstatus" class="note" role="status" style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0">Checking whether Sushila runs on this computer…</div>
  <p class="lead">A model pack is a model and its precomputed files (landscape, draft head), installed by <b>Sushila</b> on your own computer:
  one program (<code>sushila</code>, <code>sushila.exe</code> on Windows) that runs the models and serves a web page for chat, code,
  images, music and video. Every pack is signed by Sushila and contains only data files; Sushila checks each file before using it.</p>
  <p class="sub">Three ways to add a pack, all the same result (a folder in <code>model-packs</code>):
  <b>Install</b> opens Sushila on this computer (<code>http://localhost:8765</code>; start it first) and asks before installing ·
  <b>Copy command</b> for a terminal (<code>sushila install &lt;pack&gt;</code>) · <b>Download pack</b>: one file, then
  <code>sushila install &lt;file&gt;</code>, or unpack it into the <code>model-packs</code> folder (found within seconds, no restart).</p>
  ${packs.length ? `<div class="tablewrap"><table>
    <thead><tr><th>Pack</th><th>Kind</th><th class="num">Size</th><th>License</th><th></th></tr></thead>
    <tbody>${packRows}</tbody>
  </table></div>` : '<p class="note">The pack list is unavailable right now. Please try again shortly.</p>'}
</section>
<script>
// Is Sushila running on this computer? The page asks its /health (Sushila lets only sushila.ai read it, and answers
// Chrome's private-network check), every few seconds while the page is open, so the box turns green once it starts.
(function () {
  const boxes = ['sstatus', 'sstatus2'].map((i) => document.getElementById(i)).filter(Boolean);
  if (!boxes.length) return;
  let port = 8765; try { const p = +localStorage.getItem('sushila-port'); if (p > 0 && p < 65536) port = p; } catch (_) {}
  let up = null, reason = '';
  const paint = () => {
    const html = up
      ? '<b style="color:var(--ok)">✓ Sushila ' + up.version + ' is running on this computer</b> (port ' + up.port + '). <b>Install</b> opens it and asks before installing. <a href="http://localhost:' + up.port + '/" target="_blank" rel="noopener">Open Sushila</a>'
      : '<b>Sushila is not running on this computer</b>, so <b>Install</b> cannot reach it yet.<ol style="margin:8px 0 4px">' +
        '<li>Don&#39;t have it? <a href="#get">Get Sushila</a>.</li>' +
        '<li>Have it? Start it: double-click <code>sushila.exe</code> (Windows) or <code>sushila</code> (Mac, Linux), or in a terminal <code>sushila serve</code>. This box turns green within seconds.</li></ol>' +
        '<span class="sub">Running already and still not green? Your browser may block this check' + (reason ? ' (' + reason + ')' : '') + ', or Sushila uses another port: ' +
        '<a href="http://localhost:' + port + '/" target="_blank" rel="noopener">open http://localhost:' + port + '</a> · port <input class="sport" value="' + port + '" size="5" style="width:70px;padding:2px 6px"></span>';
    for (const b of boxes) b.innerHTML = html;
    for (const i of document.querySelectorAll('.sport')) i.onchange = () => { const v = +i.value; if (v > 0 && v < 65536) { port = v; try { localStorage.setItem('sushila-port', v); } catch (_) {} check(); } };
    for (const a of document.querySelectorAll('.sinstall')) a.href = 'http://localhost:' + (up ? up.port : port) + '/install/' + encodeURIComponent(a.dataset.pack);
  };
  async function check() {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 2000);
    try {
      const r = await fetch('http://localhost:' + port + '/health', { signal: c.signal, cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      up = j && j.app === 'sushila' ? j : null; reason = '';
    } catch (e) { up = null; reason = e && e.name === 'AbortError' ? '' : 'it said: ' + (e && e.message || e); }
    finally { clearTimeout(t); }
    paint();
  }
  // Install while Sushila is not running: explain here instead of a "refused to connect" page
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('.sinstall');
    if (!a || up) return;
    e.preventDefault();
    const b = document.getElementById('sstatus'); b.scrollIntoView({ behavior: 'smooth', block: 'center' });
    b.style.outline = '3px solid var(--acc)'; setTimeout(() => { b.style.outline = ''; }, 1600);
  });
  const n = document.getElementById('getnotify');
  if (n) n.addEventListener('click', async (e) => {
    e.preventDefault();
    const email = prompt('Your email: we write once, when the Sushila downloads are ready.');
    if (!email) return;
    const r = await fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, model: 'sushila-download' }) }).catch(() => null);
    n.textContent = r && r.ok ? 'thank you: we will email you' : 'could not sign up just now; try again';
  });
  paint(); check(); setInterval(() => { if (!document.hidden) check(); }, 5000);
})();
</script>
<script>document.querySelectorAll('.copycmd').forEach((b) => b.addEventListener('click', () => {
  try { navigator.clipboard.writeText(b.dataset.cmd); const t = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = t; }, 1500); } catch (_) {}
}));</script>


<section id="api">
  <h2>Serverless API</h2>
  <p class="lead">This website and Sushila.cpp are free. To skip the hardware, use our hosted GPUs: an OpenAI-compatible API,
  billed per token. Because each token costs us less to generate, our rates are lower.</p>
  <div class="grid">
    <div class="card"><h3>Free</h3><p>Sushila.cpp, the models above and every script, running on your own machine.</p></div>
    <div class="card"><h3>Pay per token</h3><p>Hosted open models on serverless GPUs. No servers to run and no minimum spend.</p></div>
    <div class="card"><h3>Dedicated</h3><p>Reserved capacity and custom day-0 tuning for your own model. <a href="mailto:${esc(contact)}">Contact us</a>.</p></div>
  </div>
  <form id="wl"><input type="email" name="email" placeholder="you@company.com" required aria-label="Email">
    <input type="text" name="model" placeholder="Models you need (optional)" aria-label="Models">
    <button class="btn" type="submit">Request early access</button></form>
  <div id="msg" role="status"></div>
  <p class="note">The API is provided as is, with no warranty or guarantee of availability; see the <a href="#disclaimer">disclaimer</a>,
  the <a href="/terms">Terms of Service</a> and the <a href="/privacy">Privacy Policy</a>. We use your e-mail only to contact you about early access.</p>
</section>
<section id="disclaimer">
  <h2>Disclaimer</h2>
  <div class="card disc">
  <p><b>Sushila is a research project.</b> Sushila.cpp, the precomputed landscapes and draft heads, the benchmarks, the hosted
  model files and the serverless API are research software and research results, published so that others can study, reproduce and
  build on them. They are experimental, may change or stop at any time, and are not a finished commercial product.</p>
  <p><b>Use at your own risk.</b> Sushila.cpp, the model files, scripts, benchmarks, the serverless API and everything else on this
  website are provided <b>"as is" and "as available", without warranty of any kind</b>, express or implied. This includes, without
  limitation, any warranty of merchantability, fitness for a particular purpose, accuracy, reliability, availability, security or
  non-infringement. No warranty is implied or given by anything on this website or in any communication from the Sushila project.</p>
  <p>By downloading or using any of it, you <b>assume all risks</b> of that use, including the risk of incorrect, harmful or offensive
  model output, data loss, hardware or system damage, security issues and costs. You are responsible for checking what the
  software and models produce before you rely on it, and for complying with each model's license and acceptable use policy.</p>
  <p>To the fullest extent permitted by law, the Sushila project, its contributors and its suppliers are not liable for any direct,
  indirect, incidental, special, consequential or punitive damages, or any loss of data, profits or business, arising from or related
  to the use of, or inability to use, anything provided here, even if advised of the possibility of such damages.</p>
  <p>Speed figures are measurements on specific hardware and settings; your results may differ. Models are made by third parties
  and are governed by their own licenses; Sushila does not endorse or take responsibility for their content. Some jurisdictions do
  not allow certain warranty exclusions or liability limits, in which case they apply only as far as the law allows.</p>
  </div>
</section>
</main>

${footer(contact)}

<script>
(function () {
  const tabs = document.querySelectorAll('.tab'), panels = document.querySelectorAll('.ospanel');
  const show = (os) => { tabs.forEach(t => t.setAttribute('aria-selected', t.dataset.os === os)); panels.forEach(p => p.hidden = p.dataset.os !== os); };
  tabs.forEach(t => t.addEventListener('click', () => show(t.dataset.os)));
  const ua = navigator.userAgent;
  show(/Windows/.test(ua) ? 'win' : /Mac OS X|Macintosh/.test(ua) ? 'mac' : 'linux');
})();
if (location.hash === '#download' || location.hash === '#models') location.replace('/manual' + location.hash);  // moved to Manual install
(function () {  // the swan rocks on its base, like the logo animation, whenever the visitor moves, touches or scrolls
  const el = document.getElementById('swanlogo');
  if (!el) return;
  const rock = () => { if (el.classList.contains('rock')) return; void el.offsetWidth; el.classList.add('rock'); };
  el.addEventListener('animationend', () => el.classList.remove('rock'));
  ['pointerenter', 'pointermove', 'pointerdown'].forEach(ev => el.addEventListener(ev, rock, { passive: true }));
  // anywhere on the page: moving the mouse, touching, scrolling or using the wheel sets it rocking (one swing at a time)
  ['pointermove', 'pointerdown', 'touchmove', 'scroll', 'wheel', 'keydown'].forEach(ev => window.addEventListener(ev, rock, { passive: true }));
})();
document.querySelectorAll('.copy').forEach(b => b.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'copied'; }
  catch (e) { prompt('sha256', b.dataset.copy); }
  setTimeout(() => b.textContent = 'sha256', 1500);
}));
document.getElementById('wl').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target), msg = document.getElementById('msg');
  msg.textContent = 'Sending…';
  try {
    const r = await fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: f.get('email'), model: f.get('model') }) });
    const j = await r.json();
    if (j.mailto) { location.href = j.mailto; msg.textContent = 'Opening your e-mail app…'; }
    else msg.textContent = j.ok ? 'Thanks. We will e-mail you when your access is ready.' : (j.error || 'Something went wrong.');
  } catch (err) { msg.textContent = 'Network error. Please e-mail us instead.'; }
});
</script>
</body>
</html>`;
}

// ============================================================
// Account pages (bodies for docPage; each returns (contact) => html)
// ============================================================
const FORM_CSS = `<style>
.auth{max-width:440px}.auth label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}
.auth input{width:100%;flex:none}.auth .btn{margin-top:16px}.auth .alt{font-size:14px;color:var(--mut);margin-top:18px}
.auth .code{font-size:24px;letter-spacing:8px;text-align:center}.msg{margin-top:12px;font-size:14px;min-height:1.4em}
.msg.err{color:#b42318}.msg.ok{color:var(--acc)}.hidden{display:none}
.list{list-style:none;padding:0;margin:0}.list li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
.linkbtn{background:none;border:0;color:var(--acc);cursor:pointer;font-size:14px;padding:0}
</style>`;

// Shared browser helper: POST JSON, show the message.
const CLIENT = `<script>
async function api(path, data){
  const r = await fetch(path, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(data||{})});
  let d = {}; try { d = await r.json(); } catch(e) {}
  if(!r.ok) throw Object.assign(new Error(d.error || ('Something went wrong (HTTP ' + r.status + '). Please try again later.')), d);
  return d;
}
function say(id, text, ok){ const m=document.getElementById(id); m.textContent=text||''; m.className='msg '+(ok?'ok':'err'); }
</script>`;

const SIGNIN = (url) => () => {
  const next = (url.searchParams.get('next') || '/account').startsWith('/') ? url.searchParams.get('next') || '/account' : '/account';
  return `${FORM_CSS}
<h1>Sign in</h1>
<p class="meta">No password: we e-mail you a one-time code. Any e-mail linked to your account works.</p>
<div class="auth">
  <div id="step1">
    <label for="email">E-mail</label><input id="email" type="email" autocomplete="email" placeholder="you@example.com">
    <div id="newfields" class="hidden">
      <label for="fn">First name</label><input id="fn" autocomplete="given-name">
      <label for="ln">Last name (optional)</label><input id="ln" autocomplete="family-name">
      <label for="org">Organization (optional)</label><input id="org" autocomplete="organization">
      <p class="note">By creating an account you agree to the <a href="/terms">Terms of Service</a> and the <a href="/privacy">Privacy Policy</a>.</p>
    </div>
    <button class="btn" id="send">Send code</button>
    <p class="alt" id="toggle"><span id="t1">New here? </span><button class="linkbtn" id="mode">Create an account</button></p>
  </div>
  <div id="step2" class="hidden">
    <p>We sent a 6-digit code to <b id="shown"></b>. It expires in 5 minutes.</p>
    <label for="code">Code</label><input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">
    <button class="btn" id="verify">Continue</button>
    <p class="alt"><button class="linkbtn" id="resend" disabled>Resend code</button> · <button class="linkbtn" id="back">Use another e-mail</button></p>
  </div>
  <div class="msg" id="m" role="status"></div>
</div>
${CLIENT}
<script>
(function(){
  let signup = false, email = '';
  const $ = (id) => document.getElementById(id), NEXT = ${JSON.stringify(next)};
  function setMode(s){ signup = s; $('newfields').classList.toggle('hidden', !s); $('t1').textContent = s ? 'Have an account? ' : 'New here? ';
    $('mode').textContent = s ? 'Sign in' : 'Create an account'; document.querySelector('h1').textContent = s ? 'Create an account' : 'Sign in'; say('m',''); }
  function timer(){ const b=$('resend'); let s=10; b.disabled=true; b.textContent='Resend code ('+s+'s)';
    const t=setInterval(()=>{ s--; if(s<=0){clearInterval(t); b.disabled=false; b.textContent='Resend code';} else b.textContent='Resend code ('+s+'s)'; },1000); }
  async function send(){
    email = $('email').value.trim();
    if(signup && !$('fn').value.trim()) return say('m','Please enter your first name.');
    try { await api('/api/auth/send-code', {email, purpose: signup ? 'SIGN_UP' : 'SIGN_IN'});
      $('shown').textContent = email; $('step1').classList.add('hidden'); $('step2').classList.remove('hidden'); $('code').focus(); timer(); say('m','Code sent.', true);
    } catch(e){ say('m', e.message); if(e.noAccount) setMode(true); if(e.exists) setMode(false); }
  }
  $('mode').onclick = () => setMode(!signup);
  $('send').onclick = send;
  $('email').addEventListener('keydown', (e) => { if(e.key==='Enter') send(); });
  $('resend').onclick = async () => { try { await api('/api/auth/send-code', {email, purpose: signup ? 'SIGN_UP' : 'SIGN_IN'}); timer(); say('m','New code sent.', true); } catch(e){ say('m', e.message); } };
  $('back').onclick = () => { $('step2').classList.add('hidden'); $('step1').classList.remove('hidden'); say('m',''); };
  async function verify(){
    try { await api('/api/auth/verify-code', {email, code: $('code').value.trim(), firstName: $('fn').value, lastName: $('ln').value, organization: $('org').value});
      location.href = NEXT; } catch(e){ say('m', e.message); }
  }
  $('verify').onclick = verify;
  $('code').addEventListener('keydown', (e) => { if(e.key==='Enter') verify(); });
})();
</script>`;
};

const ACCOUNT = (u) => () => `${FORM_CSS}
<h1>Your account</h1>
<p class="meta">Signed in as ${esc(u.primaryEmail)}${u.isAdmin ? ' · <a href="/admin">Admin</a>' : ''} · <a href="/bugs">Bug reports</a></p>
<div class="auth">
  <h2>Profile</h2>
  <label for="fn">First name</label><input id="fn" value="${esc(u.firstName)}">
  <label for="ln">Last name</label><input id="ln" value="${esc(u.lastName === '-' ? '' : u.lastName)}">
  <label for="org">Organization</label><input id="org" value="${esc(u.organization === '-' ? '' : u.organization)}">
  <button class="btn" id="save">Save</button>
  <div class="msg" id="m1" role="status"></div>

  <h2>E-mail addresses</h2>
  <p class="note" style="margin-top:0">You can sign in with any of these. Codes and notices go to the primary e-mail. Keep at least one.</p>
  <ul class="list" id="emails">${u.emails.map((e) => `<li><span>${esc(e)}${e === u.primaryEmail ? ' <span class="tag">primary</span>' : ''}</span><span>${e === u.primaryEmail ? '' : `<button class="linkbtn" data-primary="${esc(e)}">Make primary</button> · `}${u.emails.length > 1 ? `<button class="linkbtn" data-rm="${esc(e)}">Remove</button>` : ''}</span></li>`).join('')}</ul>
  <div id="add1"><label for="ne">Add another e-mail</label><input id="ne" type="email" placeholder="work@example.com"><button class="btn ghost" id="addsend">Send code</button></div>
  <div id="add2" class="hidden"><label for="nc">Code sent to <b id="neshown"></b></label><input id="nc" class="code" inputmode="numeric" maxlength="6" placeholder="123456"><button class="btn" id="addverify">Add e-mail</button></div>
  <div class="msg" id="m2" role="status"></div>
</div>

<h2>Your downloads</h2>
<div class="tablewrap"><table><thead><tr><th>When (UTC)</th><th>Model</th><th>File</th></tr></thead><tbody id="dl"><tr><td colspan="3" class="sub">Loading…</td></tr></tbody></table></div>

<form method="POST" action="/api/auth/sign-out" style="margin-top:32px"><button class="btn ghost" type="submit">Sign out</button></form>
${CLIENT}
<script>
(function(){
  const $ = (id) => document.getElementById(id);
  $('save').onclick = async () => { try { await api('/api/account', {action:'profile', firstName:$('fn').value, lastName:$('ln').value, organization:$('org').value}); say('m1','Saved.', true); } catch(e){ say('m1', e.message); } };
  $('emails').addEventListener('click', async (ev) => {
    const rm = ev.target.getAttribute('data-rm'), pr = ev.target.getAttribute('data-primary');
    try {
      if (rm) { if (!confirm('Remove '+rm+' from your account? You will no longer be able to sign in with it.')) return; await api('/api/account', {action:'remove-email', email:rm}); location.reload(); }
      if (pr) { await api('/api/account', {action:'make-primary', email:pr}); location.reload(); }
    } catch(err){ say('m2', err.message); } });
  let ne = '';
  $('addsend').onclick = async () => { ne = $('ne').value.trim(); try { await api('/api/auth/send-code', {email:ne, purpose:'ADD_EMAIL'});
    $('neshown').textContent = ne; $('add1').classList.add('hidden'); $('add2').classList.remove('hidden'); say('m2','Code sent.', true); } catch(e){ say('m2', e.message); } };
  $('addverify').onclick = async () => { try { await api('/api/auth/verify-code', {email:ne, code:$('nc').value.trim()}); location.reload(); } catch(e){ say('m2', e.message); } };
  fetch('/api/account').then(r => r.json()).then(d => {
    const rows = (d.downloads||[]).map(x => '<tr><td>'+x.at.slice(0,16).replace('T',' ')+'</td><td>'+x.model.replace(/</g,'&lt;')+'</td><td><code>'+x.file.replace(/</g,'&lt;')+'</code></td></tr>');
    $('dl').innerHTML = rows.length ? rows.join('') : '<tr><td colspan="3" class="sub">No downloads yet.</td></tr>';
  }).catch(() => { $('dl').innerHTML = '<tr><td colspan="3" class="sub">Could not load downloads.</td></tr>'; });
})();
</script>`;

const DOWNLOAD = (m) => () => `${FORM_CSS}
<h1>${esc(m.name)} <span class="sub" style="font-size:20px">${esc(m.quant)}</span></h1>
<p class="meta">${esc(m.file)} · ${gb(m.bytes)}</p>
<div class="auth" style="max-width:640px">
  <p>This model is made by a third party and licensed under the <a href="${esc(m.licenseUrl)}" target="_blank" rel="noopener">${esc(m.license)}</a>.
  Read it before downloading. It is provided as is, without warranty (see the <a href="/#disclaimer">disclaimer</a>).</p>
  <p class="sub">sha256 <code style="word-break:break-all">${m.sha256}</code>. Check it after downloading:
  <code>sha256sum ${esc(m.file)}</code> (macOS: <code>shasum -a 256 ${esc(m.file)}</code>).</p>
  <label style="display:flex;gap:10px;align-items:flex-start;font-weight:400"><input type="checkbox" id="ok" style="width:auto;flex:none;margin-top:4px">
    <span>I have read and accept the ${esc(m.license)}${/Llama/.test(m.license) ? ' and Meta\'s Acceptable Use Policy' : ''}.</span></label>
  <button class="btn" id="go">Download</button>
  <div class="msg" id="m" role="status"></div>
  <p class="note">The link is personal and works for 24 hours, and downloads can be resumed. Your downloads are listed in <a href="/account">your account</a>.</p>
</div>
${CLIENT}
<script>
document.getElementById('go').onclick = async () => {
  if(!document.getElementById('ok').checked) return say('m','Please accept the license first.');
  try { const d = await api('/api/download', {file: ${JSON.stringify(m.file)}, accept: true}); say('m','Your download is starting…', true); location.href = d.url; }
  catch(e){ if(e.signin) location.href = '/signin?next=' + encodeURIComponent(location.pathname); else say('m', e.message); }
};
</script>`;


// Admin page: tab 1 users (filter + pages), tab 2 model catalog (add, edit, show or hide on the public site).
const MODEL_FIELDS = [
  ['modelId', 'Model id', 'e.g. llama3.1-8b-q4km (letters, digits, . and -)'], ['name', 'Name', 'Llama 3.1 8B Instruct'], ['quant', 'Quantization', 'Q4_K_M'],
  ['file', 'File name', 'llama3.1-8b-instruct-q4_k_m.gguf'], ['bytes', 'Size in bytes', '4920738944'], ['sha256', 'sha256', '64 hex characters'],
  ['license', 'License', 'Llama 3.1 Community License'], ['licenseUrl', 'License URL', 'https://…'], ['hf', 'Hugging Face URL', 'https://huggingface.co/…'],
  ['artifacts', 'Precomputed artifacts', 'e.g. output-layer landscape; precomputed draft head'], ['note', 'Note', 'optional'], ['order', 'Order', '10'],
];
// Bug reports: one table (sushilaai-bugs) holds each report (item "bug") and its comments (item "c#<time>#<id>").
// Signed-in users report bugs and see and comment on their own; admins see all, comment and set the status.
const BUG_STATUS = ['open', 'in progress', 'fixed', 'closed', "won't fix"];
const BUG_CATEGORY = ['Sushila.cpp engine', 'Website', 'Downloads or models', 'Paper or results', 'Serverless API', 'Other'];
const BUG_SEVERITY = ['low', 'medium', 'high', 'critical'];
const BUG_CSS = `<style>.doc{max-width:960px}.bugtools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}.bugtools input{flex:1 1 260px}
.st{display:inline-block;font-size:12px;font-weight:600;padding:1px 9px;border-radius:99px;border:1px solid var(--line)}.st.open{color:#b42318;border-color:#f3b8b2}
.st.in-progress{color:#b54708;border-color:#f6d6a6}.st.fixed,.st.closed{color:var(--acc);border-color:var(--acc)}.bugtxt{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.cmt{border-left:3px solid var(--line);padding:4px 0 4px 12px;margin:14px 0}.cmt.adm{border-color:var(--acc)}.cmt .who{font-size:13px;color:var(--mut)}
textarea{width:100%;min-height:140px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
select{padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font-size:15px}</style>`;

const BUGS = (user) => () => `${FORM_CSS}${BUG_CSS}
<h1>Bug reports</h1>
<p class="meta">${user.isAdmin ? 'All reports (you are an admin).' : 'Your reports. Only you and the Sushila team can see them.'} <a class="btn small" href="/bugs/new" style="margin-left:8px">Report a bug</a></p>
<div class="bugtools"><input id="q" type="search" placeholder="Filter by title, text, id${user.isAdmin ? ' or reporter' : ''}">
  <select id="status"><option value="">any status</option>${BUG_STATUS.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
  ${user.isAdmin ? '<label class="sub"><input type="checkbox" id="mine" style="flex:none;width:auto"> only mine</label>' : ''}</div>
<div class="tablewrap"><table><thead><tr><th>Bug</th><th>Status</th><th>Category</th><th>Severity</th>${user.isAdmin ? '<th>Reporter</th>' : ''}<th>Updated</th><th class="num">Comments</th></tr></thead>
<tbody id="bb"><tr><td colspan="7" class="sub">Loading…</td></tr></tbody></table></div>
<div class="pager" style="display:flex;gap:10px;align-items:center;margin-top:12px;font-size:14px"><button class="btn ghost small" id="prev">Previous</button><span id="pinfo"></span><button class="btn ghost small" id="next">Next</button></div>
<script>
(function(){
  const $ = (id) => document.getElementById(id), E = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const ADMIN = ${user.isAdmin ? 'true' : 'false'};
  let page = 1, t = null;
  async function load(){
    const qs = new URLSearchParams({q: $('q').value.trim(), status: $('status').value, page, mine: ADMIN && $('mine').checked ? '1' : ''});
    const r = await fetch('/api/bugs?' + qs); const d = await r.json();
    if (!r.ok) { $('bb').innerHTML = '<tr><td colspan="7">' + E(d.error) + '</td></tr>'; return; }
    $('bb').innerHTML = d.bugs.length ? d.bugs.map(b => '<tr><td><a href="/bugs/' + E(b.bugId) + '"><b>' + E(b.title) + '</b></a><div class="sub">' + E(b.bugId) + '</div></td><td><span class="st ' + E(b.status.replace(/[^a-z]+/g,'-')) + '">' + E(b.status) + '</span></td><td>' + E(b.category) + '</td><td>' + E(b.severity) + '</td>' +
      (ADMIN ? '<td class="sub">' + E(b.reporterEmail) + '</td>' : '') + '<td>' + E((b.updatedAt||'').slice(0,16).replace('T',' ')) + '</td><td class="num">' + (b.comments||0) + '</td></tr>').join('') : '<tr><td colspan="7" class="sub">No reports match.</td></tr>';
    $('pinfo').textContent = d.total + ' report' + (d.total === 1 ? '' : 's') + ' · page ' + d.page + ' of ' + d.pages; $('prev').disabled = d.page <= 1; $('next').disabled = d.page >= d.pages; page = d.page;
  }
  $('q').oninput = () => { clearTimeout(t); t = setTimeout(() => { page = 1; load(); }, 250); };
  $('status').onchange = () => { page = 1; load(); }; if (ADMIN) $('mine').onchange = () => { page = 1; load(); };
  $('prev').onclick = () => { page--; load(); }; $('next').onclick = () => { page++; load(); };
  load();
})();
</script>`;

const BUG_NEW = (url) => () => `${FORM_CSS}${BUG_CSS}
<h1>Report a bug</h1>
<p class="meta">Tell us what went wrong. Only you and the Sushila team can see your report, and you can follow and comment on it under <a href="/bugs">Bug reports</a>. For security problems, mark the severity as critical.</p>
<div class="auth" style="max-width:720px">
  <label for="title">Title</label><input id="title" maxlength="140" placeholder="Short summary, e.g. llama-server crashes when loading a 70B model">
  <label for="cat">Category</label><select id="cat">${BUG_CATEGORY.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
  <label for="sev">Severity</label><select id="sev">${BUG_SEVERITY.map((s) => `<option${s === 'medium' ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
  <label for="desc">What happened? Steps to reproduce, what you expected, and versions (OS, GPU, Sushila.cpp commit, model)</label>
  <textarea id="desc" maxlength="8000" placeholder="1. ...&#10;2. ...&#10;Expected: ...&#10;Actual: ...&#10;Console output: ..."></textarea>
  <label for="where">Page or command (optional)</label><input id="where" maxlength="300" value="${esc(url.searchParams.get('from') || '')}" placeholder="e.g. https://sushila.ai/download/... or build/bin/llama-cli -m ...">
  <button class="btn" id="send">Submit report</button>
  <div class="msg" id="m" role="status"></div>
</div>
${CLIENT}
<script>
document.getElementById('send').onclick = async () => {
  const $ = (id) => document.getElementById(id);
  try { const d = await api('/api/bugs', {title:$('title').value, category:$('cat').value, severity:$('sev').value, description:$('desc').value, where:$('where').value});
    location.href = '/bugs/' + encodeURIComponent(d.bugId); } catch(e){ say('m', e.message); }
};
</script>`;

const BUG_VIEW = (user, bugId) => () => `${FORM_CSS}${BUG_CSS}
<p class="meta"><a href="/bugs">← Bug reports</a></p>
<div id="bug"><p class="sub">Loading…</p></div>
<h2>Comments</h2>
<div id="cmts"></div>
<div class="auth" style="max-width:720px">
  <label for="ct">Add a comment</label><textarea id="ct" maxlength="4000" style="min-height:100px"></textarea>
  ${user.isAdmin ? `<label for="ns">Set status</label><select id="ns"><option value="">keep</option>${BUG_STATUS.map((s) => `<option>${esc(s)}</option>`).join('')}</select>` : ''}
  <button class="btn" id="post">Post</button>
  <div class="msg" id="m" role="status"></div>
</div>
${CLIENT}
<script>
(function(){
  const $ = (id) => document.getElementById(id), E = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const ID = ${JSON.stringify(bugId)}, ADMIN = ${user.isAdmin ? 'true' : 'false'};
  async function load(){
    const r = await fetch('/api/bugs/' + encodeURIComponent(ID)); const d = await r.json();
    if (!r.ok) { $('bug').innerHTML = '<p>' + E(d.error) + '</p>'; return; }
    const b = d.bug;
    $('bug').innerHTML = '<h1>' + E(b.title) + '</h1><p class="meta">' + E(b.bugId) + ' · <span class="st ' + E(b.status.replace(/[^a-z]+/g,'-')) + '">' + E(b.status) + '</span> · ' + E(b.category) + ' · severity ' + E(b.severity) +
      ' · reported ' + E(b.createdAt.slice(0,16).replace('T',' ')) + ' UTC' + (ADMIN ? ' by ' + E(b.reporterEmail) : '') + '</p>' + (b.where ? '<p class="sub">Where: ' + E(b.where) + '</p>' : '') + '<div class="bugtxt">' + E(b.description) + '</div>';
    document.title = b.title + ' — Sushila.cpp';
    $('cmts').innerHTML = d.comments.length ? d.comments.map(c => '<div class="cmt' + (c.isAdmin ? ' adm' : '') + '"><div class="who">' + E(c.author) + (c.isAdmin ? ' <span class="tag">Sushila team</span>' : '') + ' · ' + E(c.at.slice(0,16).replace('T',' ')) +
      (c.status ? ' · status → <b>' + E(c.status) + '</b>' : '') + '</div>' + (c.text ? '<div class="bugtxt" style="border:0;padding:6px 0;background:none">' + E(c.text) + '</div>' : '') + '</div>').join('') : '<p class="sub">No comments yet.</p>';
  }
  $('post').onclick = async () => { try { await api('/api/bugs/' + encodeURIComponent(ID) + '/comments', {text: $('ct').value, status: ADMIN ? $('ns').value : ''}); $('ct').value = ''; if (ADMIN) $('ns').value = ''; say('m', 'Posted.', true); load(); } catch(e){ say('m', e.message); } };
  load();
})();
</script>`;

const ADMIN = () => () => `${FORM_CSS}
<style>.doc{max-width:1040px}.admtabs{display:flex;gap:6px;margin:8px 0 18px}.admin-tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.admin-tools input{flex:1 1 260px}.pager{display:flex;gap:10px;align-items:center;margin-top:12px;font-size:14px}.pager button{padding:6px 12px}
.mform{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:4px 16px;margin:12px 0}.mform label{font-size:13px;font-weight:600;margin-top:8px}
.mform input{width:100%;flex:none}.switch{cursor:pointer;border:1px solid var(--line);border-radius:99px;padding:2px 10px;font-size:12px;font-weight:600;background:var(--card)}
.switch.on{background:var(--accbg);color:var(--acc);border-color:var(--acc)}td.wrap{max-width:260px;word-break:break-word}
.cbox{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--card)}.cstage{margin:8px 0 4px;font-size:15px}.cstages{margin:4px 0 8px 18px;padding:0}
.cgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:10px}.ccard{border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--card);min-width:0}
.ccard.sus{border-color:var(--acc)}.cnum{margin:8px 0;font-size:14px}.ctext{max-height:360px;overflow:auto;white-space:pre-wrap;font-size:13px}
.cspeed{margin-top:16px;font-size:28px;color:var(--acc)}#cres .ok,.ok{color:var(--acc)}textarea{font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:inherit;box-sizing:border-box}</style>
<h1>Admin</h1>
<div class="admtabs" role="tablist"><button class="tab" data-t="users" aria-selected="true">Users</button><button class="tab" data-t="models" aria-selected="false">Models</button><button class="tab" data-t="compare" aria-selected="false">Compare Speeds</button><a class="tab" href="/bugs" style="text-decoration:none">Bugs</a></div>

<div id="t-users">
  <div class="admin-tools"><input id="q" type="search" placeholder="Filter by e-mail, name, organization or user id">
    <label class="sub"><input type="checkbox" id="onlyadmin" style="flex:none;width:auto"> admins only</label>
    <select id="size"><option>25</option><option>50</option><option>100</option></select></div>
  <div class="tablewrap"><table><thead><tr><th>User</th><th>E-mails</th><th>Organization</th><th>Created</th><th>Last sign-in</th><th>Downloads</th></tr></thead>
  <tbody id="ub"><tr><td colspan="6" class="sub">Loading…</td></tr></tbody></table></div>
  <div class="pager"><button class="btn ghost small" id="prev">Previous</button><span id="pinfo"></span><button class="btn ghost small" id="next">Next</button></div>
</div>

<div id="t-models" class="hidden">
  <p class="lead" style="margin-bottom:12px">Models whose files and precomputed artifacts we host. Only <b>visible</b> models are listed on the public site and can be downloaded by regular users.</p>
  <div class="tablewrap"><table><thead><tr><th>Model</th><th>File</th><th class="num">Size</th><th>Precomputed artifacts</th><th>Downloads</th><th>Visible</th><th></th></tr></thead>
  <tbody id="mb"><tr><td colspan="7" class="sub">Loading…</td></tr></tbody></table></div>
  <h2 id="ftitle">Add a model</h2>
  <p class="note" style="margin-top:0">Upload its files to B2 first: <code>models/&lt;model id&gt;/&lt;file&gt;</code> (and artifacts under <code>models/&lt;model id&gt;/sushila/</code>), e.g. with <code>setup/b2_upload.sh</code>.</p>
  <div class="mform">${MODEL_FIELDS.map(([k, l, ph]) => `<div><label for="f-${k}">${l}</label><input id="f-${k}" placeholder="${esc(ph)}"></div>`).join('')}
    <div><label><input type="checkbox" id="f-visible" style="flex:none;width:auto"> Visible to regular users</label></div></div>
  <button class="btn" id="msave">Save model</button> <button class="btn ghost" id="mclear">Clear</button>
  <div class="msg" id="mm" role="status"></div>
</div>
<div id="t-compare" class="hidden">
  <p class="lead" style="margin-bottom:8px">Time the same prompt on <b>Sushila</b> (SGLang 0.5.21, the model's 4-bit file and our precomputed draft head) and on <b>vanilla Ollama 0.35.1</b> (Q4_K_M), on one fresh RunPod GPU pod. The pod installs both engines, downloads the model and the precomputed files from B2 (checked by sha256), answers, and is then deleted.</p>
  <p class="note" style="margin-top:0">Setup takes about 10-20 minutes (image, downloads, loading). 70B models use 2 GPUs so both engines stay loaded. Pods are deleted after the comparison unless you keep them; the cron job also deletes pods idle for 15 minutes, failed, or older than 3 hours.</p>
  <div class="admin-tools"><select id="cm" style="flex:1 1 260px"><option>Loading models…</option></select>
    <label class="sub"><input type="checkbox" id="ckeep" style="flex:none;width:auto"> keep the pod for more prompts (deleted after 15 min idle)</label>
    <button class="btn" id="cstart">Start comparison pod</button></div>
  <div class="msg" id="cmsg" role="status"></div>
  <div id="crun" class="hidden">
    <div class="cbox"><div><b id="cmodel"></b> <span class="sub" id="cpod"></span></div>
      <div id="cstage" class="cstage"></div><ol id="cstages" class="sub cstages"></ol><div id="cchecks" class="sub"></div>
      <div class="sub" id="ccost"></div>
      <button class="btn ghost small" id="cstop">Delete pod now</button></div>
    <label for="cp" style="font-weight:600;font-size:14px;display:block;margin-top:14px">Prompt</label>
    <textarea id="cp" rows="4" style="width:100%" placeholder="e.g. Explain why the sky is blue in three sentences."></textarea>
    <div class="admin-tools" style="margin-top:8px"><label class="sub">Max tokens <select id="cn"><option>128</option><option selected>256</option><option>512</option><option>1024</option></select></label>
      <button class="btn" id="cgo" disabled>Compare</button></div>
    <div class="msg" id="cgm" role="status"></div>
    <div id="cres"></div>
  </div>
  <h2>Recent comparisons</h2>
  <div class="tablewrap"><table><thead><tr><th>When (UTC)</th><th>Model</th><th>GPU</th><th>Status</th><th class="num">Prompts</th><th class="num">Last speedup</th><th class="num">Cost</th><th></th></tr></thead>
  <tbody id="crb"><tr><td colspan="8" class="sub">Loading…</td></tr></tbody></table></div>
</div>
${CLIENT}
<script>
(function(){
  const $ = (id) => document.getElementById(id), E = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const FIELDS = ${JSON.stringify(MODEL_FIELDS.map((f) => f[0]))};
  document.querySelectorAll('.tab[data-t]').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab[data-t]').forEach(x => x.setAttribute('aria-selected', x === t));
    ['users', 'models', 'compare'].forEach(k => $('t-' + k).classList.toggle('hidden', t.dataset.t !== k));
    if (t.dataset.t === 'models') loadModels(); if (t.dataset.t === 'compare') loadCompare(); });
  // users
  let page = 1, timer = null;
  async function loadUsers(){
    const qs = new URLSearchParams({q: $('q').value.trim(), page, size: $('size').value, admins: $('onlyadmin').checked ? '1' : ''});
    const r = await fetch('/api/admin/users?' + qs); const d = await r.json();
    if (!r.ok) { $('ub').innerHTML = '<tr><td colspan="6">' + E(d.error) + '</td></tr>'; return; }
    $('ub').innerHTML = d.users.length ? d.users.map(u => '<tr><td><b>' + E((u.firstName + ' ' + (u.lastName === '-' ? '' : u.lastName)).trim()) + '</b>' + (u.isAdmin ? ' <span class="tag">admin</span>' : '') +
      '<div class="sub">' + E(u.userId) + '</div></td><td class="wrap">' + u.emails.map(e => E(e) + (e === u.primaryEmail ? ' <span class="tag">primary</span>' : '')).join('<br>') +
      '</td><td>' + E(u.organization === '-' ? '' : u.organization) + '</td><td>' + E((u.createdAt||'').slice(0,10)) + '</td><td>' + E((u.lastLoginAt||'').slice(0,16).replace('T',' ')) +
      '</td><td class="num">' + (u.downloads || 0) + '</td></tr>').join('') : '<tr><td colspan="6" class="sub">No users match.</td></tr>';
    $('pinfo').textContent = d.total + ' user' + (d.total === 1 ? '' : 's') + ' · page ' + d.page + ' of ' + d.pages;
    $('prev').disabled = d.page <= 1; $('next').disabled = d.page >= d.pages; page = d.page;
  }
  $('q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { page = 1; loadUsers(); }, 250); };
  $('onlyadmin').onchange = $('size').onchange = () => { page = 1; loadUsers(); };
  $('prev').onclick = () => { page--; loadUsers(); }; $('next').onclick = () => { page++; loadUsers(); };
  loadUsers();
  // models
  let models = [];
  async function loadModels(){
    const r = await fetch('/api/admin/models'); const d = await r.json();
    if (!r.ok) { $('mb').innerHTML = '<tr><td colspan="7">' + E(d.error) + '</td></tr>'; return; }
    models = d.models;
    $('mb').innerHTML = models.map((m, i) => '<tr><td><b>' + E(m.name) + '</b> ' + E(m.quant) + '<div class="sub">' + E(m.modelId) + '</div></td><td class="wrap"><code>' + E(m.file) + '</code></td><td class="num">' +
      (m.bytes / 1e9).toFixed(1) + ' GB</td><td class="wrap">' + (E(m.artifacts) || '<span class="sub">none yet</span>') + '</td><td class="num">' + (m.downloads || 0) + '</td><td><button class="switch' + (m.visible ? ' on' : '') + '" data-vis="' + i + '">' +
      (m.visible ? 'visible' : 'hidden') + '</button></td><td><button class="linkbtn" data-edit="' + i + '">Edit</button></td></tr>').join('');
  }
  $('mb').addEventListener('click', async (ev) => {
    const v = ev.target.getAttribute('data-vis'), ed = ev.target.getAttribute('data-edit');
    if (v !== null) { const m = models[v]; try { await api('/api/admin/models', {action:'visible', modelId: m.modelId, visible: !m.visible}); loadModels(); } catch(e){ say('mm', e.message); } }
    if (ed !== null) { const m = models[ed]; FIELDS.forEach(k => $('f-' + k).value = m[k] == null ? '' : m[k]); $('f-visible').checked = !!m.visible; $('f-modelId').readOnly = true;
      $('ftitle').textContent = 'Edit ' + m.modelId; $('ftitle').scrollIntoView({behavior:'smooth'}); }
  });
  // compare speeds
  let cmodels = [], cur = null, poll = null;
  const cost = (r) => '$' + (r.cost || 0).toFixed(2) + ' so far (' + (r.hours * 60).toFixed(0) + ' min at $' + (r.costPerHr || 0).toFixed(2) + '/h)';
  async function loadCompare(){
    const r = await fetch('/api/admin/compare/models'); const d = await r.json();
    if (!r.ok) { $('cm').innerHTML = '<option>' + E(d.error) + '</option>'; return; }
    cmodels = d.models;
    $('cm').innerHTML = cmodels.length ? cmodels.map((m, i) => '<option value="' + i + '">' + E(m.model) + ' — SGLang ' + E(m.sglang) + ' vs Ollama ' + E(m.ollama) + ' (' + m.ngpu + ' GPU' + (m.ngpu > 1 ? 's' : '') + ')</option>').join('')
      : '<option value="">No model in B2 has a precomputed draft head yet</option>';
    $('cstart').disabled = !cmodels.length || !d.runpod;
    if (!d.runpod) say('cmsg', 'RUNPOD_API_KEY is not set on the worker: add it as a secret in Cloudflare.');
    loadRuns();
  }
  async function loadRuns(){
    const r = await fetch('/api/admin/compare/runs'); const d = await r.json();
    if (!r.ok) { $('crb').innerHTML = '<tr><td colspan="8">' + E(d.error) + '</td></tr>'; return; }
    $('crb').innerHTML = d.runs.length ? d.runs.map(x => { const last = x.results[x.results.length - 1];
      return '<tr><td>' + E(x.createdAt.slice(0,16).replace('T',' ')) + '</td><td>' + E(x.model) + '</td><td>' + E(x.gpu || '') + (x.ngpu > 1 ? ' ×' + x.ngpu : '') + '</td><td>' + E(x.status) +
        (x.deleteReason ? '<div class="sub">' + E(x.deleteReason) + '</div>' : '') + '</td><td class="num">' + x.results.length + '</td><td class="num">' + (last && last.speedup ? '<b>' + last.speedup.toFixed(2) + '×</b>' : '') +
        '</td><td class="num">$' + (x.cost || 0).toFixed(2) + '</td><td>' + (x.status !== 'deleted' ? '<button class="linkbtn" data-open="' + E(x.runId) + '">Open</button>' : '') + '</td></tr>'; }).join('')
      : '<tr><td colspan="8" class="sub">No comparisons yet.</td></tr>';
  }
  $('crb').addEventListener('click', (ev) => { const id = ev.target.getAttribute('data-open'); if (id) openRun(id); });
  function openRun(id){ cur = id; $('crun').classList.remove('hidden'); $('cres').innerHTML = ''; clearInterval(poll); status(); poll = setInterval(status, 10000); }
  async function status(){
    if (!cur) return;
    const r = await fetch('/api/admin/compare/status?runId=' + encodeURIComponent(cur)); const d = await r.json();
    if (!r.ok) { say('cmsg', d.error); return; }
    const x = d.run, s = d.server || {};
    $('cmodel').textContent = x.model; $('cpod').textContent = 'pod ' + x.podId + (d.pod && d.pod.gpu ? ' · ' + d.pod.gpu : '') + (x.ngpu > 1 ? ' ×' + x.ngpu : '');
    $('cstage').innerHTML = x.status === 'deleted' ? 'Pod deleted (' + E(x.deleteReason) + ').' : s.error ? '<span class="err">Setup failed: ' + E(s.error) + '</span>'
      : s.ready ? '<b class="ok">Ready.</b> Type a prompt.' : 'Setting up: ' + E(s.stage || 'creating the pod') + '…';
    $('cstages').innerHTML = (s.stages || []).map(g => '<li>' + Math.round(g.t / 60) + ' min: ' + E(g.stage) + '</li>').join('');
    $('cchecks').innerHTML = Object.entries(s.checks || {}).map(([k, v]) => '✓ ' + E(k.replace(/_/g, ' ')) + ': ' + E(v)).join('<br>') + (s.versions ? '<br>' + Object.entries(s.versions).map(([k, v]) => E(k) + ' ' + E(v)).join(' · ') : '');
    $('ccost').textContent = cost(x);
    $('cgo').disabled = !s.ready || x.status === 'deleted'; $('cstop').disabled = x.status === 'deleted';
    if (x.status === 'deleted' || s.error) clearInterval(poll);
  }
  $('cstart').onclick = async () => {
    const m = cmodels[$('cm').value]; if (!m) return;
    $('cstart').disabled = true; say('cmsg', 'Creating the pod…', true);
    try { const d = await api('/api/admin/compare/start', {model: m.model, keep: $('ckeep').checked}); say('cmsg', 'Pod ' + d.run.podId + ' created at $' + d.run.costPerHr.toFixed(2) + '/h.', true); openRun(d.run.runId); loadRuns(); }
    catch(e){ say('cmsg', e.message); }
    $('cstart').disabled = false;
  };
  $('cstop').onclick = async () => { try { await api('/api/admin/compare/stop', {runId: cur}); say('cmsg', 'Pod deleted.', true); status(); loadRuns(); } catch(e){ say('cmsg', e.message); } };
  const card = (title, sub, x, cls) => '<div class="ccard ' + cls + '"><div class="ch"><b>' + title + '</b><div class="sub">' + sub + '</div></div><div class="cnum"><b>' + Math.round(x.ms).toLocaleString() + ' ms</b> · ' +
    x.tokens + ' tokens · <b>' + x.tok_s + ' tok/s</b>' + (x.accept_length ? ' · ' + x.accept_length + ' tokens per step' : '') + '</div><div class="bugtxt ctext">' + E(x.text) + '</div></div>';
  $('cgo').onclick = async () => {
    const prompt = $('cp').value.trim(); if (!prompt) { say('cgm', 'Type a prompt.'); return; }
    $('cgo').disabled = true; say('cgm', 'Running on both engines…', true);
    try {
      const d = await api('/api/admin/compare/prompt', {runId: cur, prompt, maxTokens: Number($('cn').value)}); const r = d.result;
      $('cres').innerHTML = '<div class="cspeed">' + (r.speedup ? '<b>' + r.speedup.toFixed(2) + '× faster</b> with Sushila' : 'No speedup computed') + '</div>' +
        '<div class="cgrid">' + card('Sushila', 'SGLang + 4-bit + precomputed draft head', r.sushila, 'sus') + card('Ollama', 'vanilla, Q4_K_M', r.ollama, 'oll') + '</div>' +
        '<p class="note">' + E(r.note) + (r.same_text ? ' The two replies are word for word identical.' : ' The replies come from two different 4-bit files of the same model, so they can differ in wording.') + '</p>';
      say('cgm', d.deleted ? 'Done. The pod has been deleted.' : 'Done.', true);
    } catch(e){ say('cgm', e.message); }
    status(); loadRuns();
  };
  $('mclear').onclick = () => { FIELDS.forEach(k => $('f-' + k).value = ''); $('f-visible').checked = false; $('f-modelId').readOnly = false; $('ftitle').textContent = 'Add a model'; say('mm',''); };
  $('msave').onclick = async () => { const m = {}; FIELDS.forEach(k => m[k] = $('f-' + k).value.trim()); m.visible = $('f-visible').checked;
    try { await api('/api/admin/models', {action:'save', model: m, isNew: !$('f-modelId').readOnly}); say('mm','Saved.', true); $('mclear').click(); loadModels(); } catch(e){ say('mm', e.message); } };
})();
</script>`;

const SEC = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC, ...extra } });
}

// ============================================================
// Storage and services (credentials come from the worker's environment):
//   DynamoDB  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION; every table is named sushilaai-*
//   B2        B2_KEY_ID, B2_APP_KEY, B2_BUCKET_NAME (downloads and media; keys listed in B2_KEYS below)
//   Resend    RESEND_API_KEY, RESEND_FROM (sign-in codes)
//   Sessions  SESSION_SECRET (signs session cookies and hashes sign-in codes)
// ============================================================
const TABLES = {
  users: 'sushilaai-users',         // PK userId (random, permanent); primaryEmail, emails (set), name, organization, isAdmin
  emails: 'sushilaai-emails',       // PK email -> userId (every verified e-mail of every account); index userId-index
  otps: 'sushilaai-otps',           // PK email; one pending sign-in code per e-mail; TTL attribute "ttl"
  downloads: 'sushilaai-downloads', // PK userId, SK downloadedAt: one row per download; index modelId-downloadedAt-index
  models: 'sushilaai-models',       // PK modelId: hosted models, their precomputed artifacts and the visible flag
  bugs: 'sushilaai-bugs',           // PK bugId, SK item: the report ("bug") and its comments ("c#<time>#<id>")
  waitlist: 'sushilaai-waitlist',   // PK email: serverless-API early access
  download: 'sushilaai-download',   // PK file, SK at: one row per download (time, IP, country, system, kind; TTL 12 months) + '#count'
  compare: 'sushilaai-compare',     // PK runId: admin "Compare Speeds" pods (pod id, model, results); pods are deleted, rows kept
  audit: 'sushilaai-audit',         // PK day, SK at: sign-ups, sign-ins, e-mail changes, downloads, admin changes
};
const OTP_TTL_MS = 5 * 60 * 1000;      // a code is valid for 5 minutes
const OTP_RESEND_MS = 10 * 1000;       // at most one code every 10 seconds per e-mail
const OTP_MAX_ATTEMPTS = 5;            // wrong guesses before the code is discarded
const SESSION_DAYS = 30;
const MAX_EMAILS = 5;                  // e-mail addresses per account
const B2_LINK_SECONDS = 24 * 3600;     // a download link works for 24 hours (resumable)
// B2 layout: models/<model id>/<file> for weights and their Sushila artifacts (landscapes, draft heads, manifests),
// media/<file> for the site's media.
const b2ModelKey = (m, file) => `models/${m.modelId}/${file}`;
const B2_MEDIA_KEY = `media/${VIDEO.key}`;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (data) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
const hmacHex = async (key, data) => hex(await hmac(key, data));
function safeEqual(a, b) {  // constant-time string comparison
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const randomId = () => hex(crypto.getRandomValues(new Uint8Array(8)));
const normEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 254);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const clean = (s, n = 100) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

// --- AWS Signature V4 (DynamoDB JSON API) ---
class DynamoDB {
  constructor(env) {
    this.env = env;
    this.region = env.AWS_REGION || 'us-east-1';
    this.host = `dynamodb.${this.region}.amazonaws.com`;
  }
  get configured() { return !!(this.env.AWS_ACCESS_KEY_ID && this.env.AWS_SECRET_ACCESS_KEY && this.env.AWS_REGION); }
  async request(action, payload) {
    const body = JSON.stringify(payload);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const date = amzDate.slice(0, 8);
    const headers = { 'content-type': 'application/x-amz-json-1.0', host: this.host, 'x-amz-date': amzDate, 'x-amz-target': `DynamoDB_20120810.${action}` };
    const names = Object.keys(headers).sort();
    const canonical = ['POST', '/', '', names.map((n) => `${n}:${headers[n]}`).join('\n') + '\n', names.join(';'), await sha256Hex(body)].join('\n');
    const scope = `${date}/${this.region}/dynamodb/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n');
    let key = await hmac('AWS4' + this.env.AWS_SECRET_ACCESS_KEY, date);
    for (const part of [this.region, 'dynamodb', 'aws4_request']) key = await hmac(key, part);
    const signature = await hmacHex(key, toSign);
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    delete headers.host;
    const r = await fetch(`https://${this.host}/`, { method: 'POST', headers, body });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(`DynamoDB ${action}: ${out.__type || r.status} ${out.message || out.Message || ''}`);
      err.type = String(out.__type || '');
      throw err;
    }
    return out;
  }
  get(table, key) { return this.request('GetItem', { TableName: table, Key: key, ConsistentRead: true }).then((r) => r.Item || null); }
  put(table, item, condition) { return this.request('PutItem', { TableName: table, Item: item, ...(condition ? { ConditionExpression: condition } : {}) }); }
  del(table, key) { return this.request('DeleteItem', { TableName: table, Key: key }); }
  update(table, key, expr, values, names) {
    return this.request('UpdateItem', { TableName: table, Key: key, UpdateExpression: expr,
      ...(values ? { ExpressionAttributeValues: values } : {}), ...(names ? { ExpressionAttributeNames: names } : {}), ReturnValues: 'ALL_NEW' })
      .then((r) => r.Attributes || null);
  }
  async scanAll(table, opts = {}, cap = 20000) {  // every item (small tables: users, models)
    const items = []; let start;
    do {
      const r = await this.request('Scan', { TableName: table, ...opts, ...(start ? { ExclusiveStartKey: start } : {}) });
      items.push(...(r.Items || [])); start = r.LastEvaluatedKey;
    } while (start && items.length < cap);
    return items;
  }
  query(table, keyExpr, values, opts = {}) {
    return this.request('Query', { TableName: table, KeyConditionExpression: keyExpr, ExpressionAttributeValues: values, ...opts }).then((r) => r.Items || []);
  }
}
const S = (v) => ({ S: String(v) });
const N = (v) => ({ N: String(v) });
const str = (item, k) => (item && item[k] && item[k].S) || '';
const bool = (item, k) => !!(item && item[k] && (item[k].BOOL === true || item[k].S === 'true'));
const num = (item, k) => Number((item && item[k] && item[k].N) || 0);

async function audit(db, event, who, request, extra = {}) {
  try {
    const now = new Date().toISOString();
    await db.put(TABLES.audit, { day: S(now.slice(0, 10)), at: S(`${now}#${randomId()}`), event: S(event), userId: S(who || '-'),
      country: S((request.cf && request.cf.country) || '-'), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, S(v)])) });
  } catch (e) { console.error('audit', e.message); }
}

// --- Backblaze B2 (native API) ---
let b2Cache = null;  // per isolate: { auth, bucketId, until }
class B2 {
  constructor(env) { this.env = env; }
  get configured() { return !!(this.env.B2_KEY_ID && this.env.B2_APP_KEY && this.env.B2_BUCKET_NAME); }
  async auth() {
    if (b2Cache && b2Cache.until > Date.now()) return b2Cache;
    const r = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
      headers: { authorization: 'Basic ' + btoa(`${this.env.B2_KEY_ID}:${this.env.B2_APP_KEY}`) } });
    if (!r.ok) throw new Error('B2 authorize: ' + r.status);
    const a = await r.json();
    const api = a.apiInfo && a.apiInfo.storageApi ? a.apiInfo.storageApi : a;
    let bucketId = (api.allowed && api.allowed.buckets && (api.allowed.buckets.find((b) => b.name === this.env.B2_BUCKET_NAME) || {}).id)
      || (api.allowed && api.allowed.bucketName === this.env.B2_BUCKET_NAME && api.allowed.bucketId) || null;
    if (!bucketId) {
      const lb = await fetch(`${api.apiUrl}/b2api/v3/b2_list_buckets`, { method: 'POST', headers: { authorization: a.authorizationToken, 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: a.accountId, bucketName: this.env.B2_BUCKET_NAME }) });
      if (!lb.ok) throw new Error('B2 list buckets: ' + lb.status);
      bucketId = ((await lb.json()).buckets || [])[0]?.bucketId;
      if (!bucketId) throw new Error('B2 bucket not found: ' + this.env.B2_BUCKET_NAME);
    }
    b2Cache = { token: a.authorizationToken, apiUrl: api.apiUrl, downloadUrl: api.downloadUrl, bucketId, until: Date.now() + 20 * 3600 * 1000 };
    return b2Cache;
  }
  fileUrl(base, key) { return `${base}/file/${encodeURIComponent(this.env.B2_BUCKET_NAME)}/${key.split('/').map(encodeURIComponent).join('/')}`; }
  async signedUrl(key, seconds, filename) {  // a time-limited link straight to B2 (large files never pass through the worker)
    const a = await this.auth();
    const r = await fetch(`${a.apiUrl}/b2api/v3/b2_get_download_authorization`, { method: 'POST',
      headers: { authorization: a.token, 'content-type': 'application/json' },
      body: JSON.stringify({ bucketId: a.bucketId, fileNamePrefix: key, validDurationInSeconds: seconds,
        b2ContentDisposition: `attachment; filename="${filename}"` }) });
    if (!r.ok) throw new Error('B2 download authorization: ' + r.status);
    const d = await r.json();
    return `${this.fileUrl(a.downloadUrl, key)}?Authorization=${encodeURIComponent(d.authorizationToken)}&b2ContentDisposition=${encodeURIComponent(`attachment; filename="${filename}"`)}`;
  }
  async fetchFile(key, request) {  // stream a (small) file through the worker, passing Range on for video players
    const a = await this.auth();
    const h = { authorization: a.token };
    const range = request.headers.get('range');
    if (range) h.range = range;
    return fetch(this.fileUrl(a.downloadUrl, key), { headers: h, cf: { cacheEverything: true, cacheTtl: 86400 } });
  }
}

// --- Resend (e-mail) ---
async function sendEmail(env, to, subject, text, html) {
  const r = await fetch('https://api.resend.com/emails', { method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.RESEND_FROM || 'sushila.ai <support@sushila.ai>', to: [to], subject, text, ...(html ? { html } : {}) }) });
  if (!r.ok) throw new Error('Resend: ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

// --- Sessions: signed cookie "sushila_session" = base64(email|expires|hmac) ---
const COOKIE = 'sushila_session';
async function createSession(userId, secret) {
  const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
  return btoa(`${userId}|${exp}|${await hmacHex(secret, `session|${userId}|${exp}`)}`);
}
async function readSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  try {
    const [userId, exp, sig] = atob(m[1]).split('|');
    if (!userId || !exp || Date.now() > Number(exp)) return null;
    return safeEqual(sig, await hmacHex(env.SESSION_SECRET, `session|${userId}|${exp}`)) ? { userId } : null;
  } catch { return null; }
}
const sessionCookie = (token) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// --- Rate limiting (per isolate, per IP and path; codes also have per-e-mail limits in DynamoDB) ---
const rate = new Map();
function limited(request, path, max = 30, windowMs = 60000) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const k = `${ip}|${path}`, now = Date.now();
  const e = rate.get(k);
  if (!e || now - e.t > windowMs) { rate.set(k, { t: now, n: 1 }); if (rate.size > 5000) rate.clear(); return false; }
  return ++e.n > max;
}

// Only accept state-changing requests from our own pages: JSON bodies from the same origin.
function sameOriginJson(request) {
  const origin = request.headers.get('origin');
  const ct = request.headers.get('content-type') || '';
  return ct.includes('application/json') && (!origin || origin === new URL(request.url).origin);
}
async function body(request) {
  const t = await request.text();
  if (t.length > 8192) throw new Error('too large');
  return t ? JSON.parse(t) : {};
}

const newUserId = () => 'u_' + hex(crypto.getRandomValues(new Uint8Array(12)));
function userFrom(u) {
  return { userId: str(u, 'userId'), primaryEmail: str(u, 'primaryEmail'), emails: (u.emails && u.emails.SS) || [str(u, 'primaryEmail')],
    firstName: str(u, 'firstName'), lastName: str(u, 'lastName'), organization: str(u, 'organization'),
    createdAt: str(u, 'createdAt'), lastLoginAt: str(u, 'lastLoginAt'), isAdmin: bool(u, 'isAdmin') };
}
async function loadUser(db, session) {
  if (!session || !db.configured) return null;
  try {
    const u = await db.get(TABLES.users, { userId: S(session.userId) });
    return u ? userFrom(u) : null;
  } catch (e) { console.error('loadUser', e.message); return null; }
}

// --- Sign-in codes (no passwords): SIGN_UP creates an account, SIGN_IN uses any e-mail linked to one,
//     ADD_EMAIL links another e-mail to the signed-in account. ---
async function sendCode(request, env, db, session) {
  if (!sameOriginJson(request)) return json({ error: 'Bad request.' }, 400);
  if (limited(request, 'send-code', 10)) return json({ error: 'Too many requests. Please wait a minute.' }, 429);
  if (!db.configured || !env.RESEND_API_KEY || !env.SESSION_SECRET) return json({ error: 'Sign-in is not available yet.' }, 503);
  let d; try { d = await body(request); } catch { return json({ error: 'Bad request.' }, 400); }
  const email = normEmail(d.email), purpose = d.purpose;
  if (!validEmail(email)) return json({ error: 'Please enter a valid e-mail address.' }, 400);
  if (!['SIGN_IN', 'SIGN_UP', 'ADD_EMAIL'].includes(purpose)) return json({ error: 'Bad request.' }, 400);
  const link = await db.get(TABLES.emails, { email: S(email) });
  if (purpose === 'SIGN_IN' && !link) return json({ error: 'No account uses this e-mail. Create an account first.', noAccount: true }, 400);
  if (purpose === 'SIGN_UP' && link) return json({ error: 'An account already uses this e-mail. Please sign in.', exists: true }, 400);
  if (purpose === 'ADD_EMAIL') {
    if (!session) return json({ error: 'Please sign in first.' }, 401);
    if (link) return json({ error: 'This e-mail is already linked to an account.' }, 400);
    const u = await loadUser(db, session);
    if (!u) return json({ error: 'Please sign in first.' }, 401);
    if (u.emails.length >= MAX_EMAILS) return json({ error: `An account can have up to ${MAX_EMAILS} e-mail addresses.` }, 400);
  }
  const prev = await db.get(TABLES.otps, { email: S(email) });
  if (prev && Date.now() - Number(prev.sentAt.N) < OTP_RESEND_MS) return json({ error: 'Please wait a few seconds before requesting another code.' }, 429);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const now = Date.now();
  await db.put(TABLES.otps, { email: S(email), codeHash: S(await hmacHex(env.SESSION_SECRET, `otp|${email}|${code}`)), purpose: S(purpose),
    forUser: S(purpose === 'ADD_EMAIL' ? session.userId : '-'), sentAt: N(now), expiresAt: N(now + OTP_TTL_MS), attempts: N(0),
    ttl: N(Math.floor((now + OTP_TTL_MS) / 1000) + 3600) });
  const what = purpose === 'SIGN_UP' ? 'create your sushila.ai account' : purpose === 'ADD_EMAIL' ? 'add this e-mail to your sushila.ai account' : 'sign in to sushila.ai';
  await sendEmail(env, email, `Your sushila.ai code: ${code}`,
    `Your code to ${what} is ${code}.\n\nIt expires in 5 minutes. If you did not ask for it, ignore this e-mail.\n\nsushila.ai`,
    `<p>Your code to ${what} is</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>It expires in 5 minutes. If you did not ask for it, ignore this e-mail.</p><p>sushila.ai</p>`);
  return json({ ok: true });
}

async function verifyCode(request, env, db, session) {
  if (!sameOriginJson(request)) return json({ error: 'Bad request.' }, 400);
  if (limited(request, 'verify-code', 20)) return json({ error: 'Too many requests. Please wait a minute.' }, 429);
  if (!db.configured || !env.SESSION_SECRET) return json({ error: 'Sign-in is not available yet.' }, 503);
  let d; try { d = await body(request); } catch { return json({ error: 'Bad request.' }, 400); }
  const email = normEmail(d.email), code = String(d.code || '').trim();
  if (!validEmail(email) || !/^\d{6}$/.test(code)) return json({ error: 'Please enter the 6-digit code.' }, 400);
  const o = await db.get(TABLES.otps, { email: S(email) });
  if (!o) return json({ error: 'No code is pending for this e-mail. Please request a new one.' }, 400);
  if (Date.now() > Number(o.expiresAt.N)) { await db.del(TABLES.otps, { email: S(email) }); return json({ error: 'The code has expired. Please request a new one.' }, 400); }
  if (!safeEqual(str(o, 'codeHash'), await hmacHex(env.SESSION_SECRET, `otp|${email}|${code}`))) {
    const left = OTP_MAX_ATTEMPTS - Number(o.attempts.N) - 1;
    if (left <= 0) { await db.del(TABLES.otps, { email: S(email) }); return json({ error: 'Too many wrong codes. Please request a new one.' }, 400); }
    await db.update(TABLES.otps, { email: S(email) }, 'ADD attempts :one', { ':one': N(1) });
    return json({ error: `Wrong code. ${left} attempt${left === 1 ? '' : 's'} left.` }, 400);
  }
  await db.del(TABLES.otps, { email: S(email) });
  const purpose = str(o, 'purpose'), now = new Date().toISOString();
  let userId;
  if (purpose === 'SIGN_UP') {
    const firstName = clean(d.firstName, 60), lastName = clean(d.lastName, 60), organization = clean(d.organization, 120);
    if (!firstName) return json({ error: 'Please enter your name.' }, 400);
    userId = newUserId();
    try { await db.put(TABLES.emails, { email: S(email), userId: S(userId), linkedAt: S(now) }, 'attribute_not_exists(email)'); }
    catch (e) { if (e.type.includes('ConditionalCheckFailed')) return json({ error: 'An account already uses this e-mail. Please sign in.' }, 400); throw e; }
    await db.put(TABLES.users, { userId: S(userId), primaryEmail: S(email), emails: { SS: [email] }, firstName: S(firstName), lastName: S(lastName || '-'),
      organization: S(organization || '-'), isAdmin: { BOOL: false }, createdAt: S(now), lastLoginAt: S(now) }, 'attribute_not_exists(userId)');
    await audit(db, 'sign-up', userId, request, { email });
  } else if (purpose === 'SIGN_IN') {
    const link = await db.get(TABLES.emails, { email: S(email) });
    if (!link) return json({ error: 'No account uses this e-mail.' }, 400);
    userId = str(link, 'userId');
    await db.update(TABLES.users, { userId: S(userId) }, 'SET lastLoginAt = :t', { ':t': S(now) });
    await audit(db, 'sign-in', userId, request, { email });
  } else if (purpose === 'ADD_EMAIL') {
    if (!session || session.userId !== str(o, 'forUser')) return json({ error: 'Please sign in with the account you are adding this e-mail to.' }, 401);
    try { await db.put(TABLES.emails, { email: S(email), userId: S(session.userId), linkedAt: S(now) }, 'attribute_not_exists(email)'); }
    catch (e) { if (e.type.includes('ConditionalCheckFailed')) return json({ error: 'This e-mail is already linked to an account.' }, 400); throw e; }
    await db.update(TABLES.users, { userId: S(session.userId) }, 'ADD emails :e', { ':e': { SS: [email] } });
    await audit(db, 'add-email', session.userId, request, { email });
    return json({ ok: true });
  } else return json({ error: 'Bad request.' }, 400);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(await createSession(userId, env.SESSION_SECRET)) });
}

async function account(request, env, db, session) {
  if (!session) return json({ error: 'Please sign in.' }, 401);
  const u = await loadUser(db, session);
  if (!u) return json({ error: 'Please sign in.' }, 401, { 'set-cookie': clearCookie() });
  if (request.method === 'GET') {
    const rows = await db.query(TABLES.downloads, 'userId = :u', { ':u': S(u.userId) }, { ScanIndexForward: false, Limit: 50 });
    return json({ user: u, downloads: rows.map((r) => ({ at: str(r, 'downloadedAt').split('#')[0], model: str(r, 'modelName'), file: str(r, 'file'), bytes: num(r, 'bytes') })) });
  }
  if (!sameOriginJson(request)) return json({ error: 'Bad request.' }, 400);
  let d; try { d = await body(request); } catch { return json({ error: 'Bad request.' }, 400); }
  const key = { userId: S(u.userId) };
  if (d.action === 'profile') {
    const firstName = clean(d.firstName, 60);
    if (!firstName) return json({ error: 'Please enter your name.' }, 400);
    await db.update(TABLES.users, key, 'SET firstName = :f, lastName = :l, organization = :o',
      { ':f': S(firstName), ':l': S(clean(d.lastName, 60) || '-'), ':o': S(clean(d.organization, 120) || '-') });
    return json({ ok: true });
  }
  const e = normEmail(d.email);
  if (d.action === 'remove-email') {
    if (!u.emails.includes(e)) return json({ error: 'This e-mail is not on your account.' }, 400);
    if (u.emails.length <= 1) return json({ error: 'Your account needs at least one e-mail address.' }, 400);
    await db.del(TABLES.emails, { email: S(e) });
    const rest = u.emails.filter((x) => x !== e);
    await db.update(TABLES.users, key, e === u.primaryEmail ? 'DELETE emails :e SET primaryEmail = :p' : 'DELETE emails :e',
      { ':e': { SS: [e] }, ...(e === u.primaryEmail ? { ':p': S(rest[0]) } : {}) });
    await audit(db, 'remove-email', u.userId, request, { email: e });
    return json({ ok: true });
  }
  if (d.action === 'make-primary') {
    if (!u.emails.includes(e)) return json({ error: 'This e-mail is not on your account.' }, 400);
    await db.update(TABLES.users, key, 'SET primaryEmail = :p', { ':p': S(e) });
    await audit(db, 'make-primary', u.userId, request, { email: e });
    return json({ ok: true });
  }
  return json({ error: 'Bad request.' }, 400);
}

// --- Bug reports (sushilaai-bugs: PK bugId, SK item = "bug" | "c#<time>#<id>"; indexes list-index, reporter-index) ---
const newBugId = () => 'B-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + hex(crypto.getRandomValues(new Uint8Array(3)));
function bugFrom(it) {
  return { bugId: str(it, 'bugId'), title: str(it, 'title'), description: str(it, 'description'), category: str(it, 'category'), severity: str(it, 'severity'),
    status: str(it, 'status'), where: str(it, 'where') === '-' ? '' : str(it, 'where'), reporterUserId: str(it, 'reporterUserId'), reporterEmail: str(it, 'reporterEmail'),
    createdAt: str(it, 'createdAt'), updatedAt: str(it, 'updatedAt'), comments: num(it, 'comments') };
}
async function notifyAdmins(env, db, subject, text) {  // best effort: e-mail every admin's primary address
  try {
    if (!env.RESEND_API_KEY) return;
    const admins = (await db.scanAll(TABLES.users, { FilterExpression: 'isAdmin = :t', ExpressionAttributeValues: { ':t': { BOOL: true } } })).map(userFrom);
    await Promise.all(admins.map((a) => sendEmail(env, a.primaryEmail, subject, text).catch(() => {})));
  } catch (e) { console.error('notifyAdmins', e.message); }
}
async function bugsApi(request, env, db, user, path) {
  if (!user) return json({ error: 'Please sign in.', signin: true }, 401);
  const url = new URL(request.url);
  const m = path.match(/^\/api\/bugs(?:\/([A-Za-z0-9-]{4,40}))?(\/comments)?$/);
  if (!m) return json({ error: 'Not found.' }, 404);
  const [, bugId, comments] = m;
  if (request.method === 'GET' && !bugId) {
    const q = clean(url.searchParams.get('q'), 100).toLowerCase(), status = clean(url.searchParams.get('status'), 20);
    const size = 25;
    let items = user.isAdmin && url.searchParams.get('mine') !== '1'
      ? await (async () => { const out = []; let start; do { const r = await db.request('Query', { TableName: TABLES.bugs, IndexName: 'list-index', KeyConditionExpression: 'listKey = :k',
          ExpressionAttributeValues: { ':k': S('bug') }, ScanIndexForward: false, ...(start ? { ExclusiveStartKey: start } : {}) }); out.push(...(r.Items || [])); start = r.LastEvaluatedKey; } while (start && out.length < 20000); return out; })()
      : await db.query(TABLES.bugs, 'reporterUserId = :u', { ':u': S(user.userId) }, { IndexName: 'reporter-index', ScanIndexForward: false });
    let bugs = items.map(bugFrom);
    if (status) bugs = bugs.filter((b) => b.status === status);
    if (q) bugs = bugs.filter((b) => [b.bugId, b.title, b.description, b.category, user.isAdmin ? b.reporterEmail : ''].join(' ').toLowerCase().includes(q));
    bugs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const total = bugs.length, pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(Math.max(Number(url.searchParams.get('page')) || 1, 1), pages);
    return json({ total, page, pages, bugs: bugs.slice((page - 1) * size, page * size).map(({ description, ...b }) => (user.isAdmin ? b : { ...b, reporterEmail: '' })) });
  }
  if (request.method === 'POST' && !bugId) {
    if (!sameOriginJson(request)) return json({ error: 'Bad request.' }, 400);
    if (limited(request, 'bug-new', 5)) return json({ error: 'Too many reports. Please wait a minute.' }, 429);
    let d; try { d = await body(request); } catch { return json({ error: 'Report too long.' }, 400); }
    const title = clean(d.title, 140), description = String(d.description || '').replace(/\u0000/g, '').trim().slice(0, 8000);
    if (title.length < 5) return json({ error: 'Please give the report a title (at least 5 characters).' }, 400);
    if (description.length < 10) return json({ error: 'Please describe what happened.' }, 400);
    const category = BUG_CATEGORY.includes(d.category) ? d.category : 'Other', severity = BUG_SEVERITY.includes(d.severity) ? d.severity : 'medium';
    const now = new Date().toISOString(), id = newBugId();
    await db.put(TABLES.bugs, { bugId: S(id), item: S('bug'), listKey: S('bug'), title: S(title), description: S(description), category: S(category), severity: S(severity),
      status: S('open'), where: S(clean(d.where, 300) || '-'), reporterUserId: S(user.userId), reporterEmail: S(user.primaryEmail),
      userAgent: S(clean(request.headers.get('user-agent'), 300) || '-'), createdAt: S(now), updatedAt: S(now), comments: N(0) }, 'attribute_not_exists(bugId)');
    await audit(db, 'bug-new', user.userId, request, { bugId: id });
    await notifyAdmins(env, db, `[sushila.ai bug ${id}] ${title}`, `${user.primaryEmail} reported a ${severity} bug (${category}):\n\n${title}\n\n${description}\n\nhttps://sushila.ai/bugs/${id}`);
    return json({ ok: true, bugId: id });
  }
  const bugItem = await db.get(TABLES.bugs, { bugId: S(bugId), item: S('bug') });
  if (!bugItem) return json({ error: 'Report not found.' }, 404);
  const bug = bugFrom(bugItem);
  if (!user.isAdmin && bug.reporterUserId !== user.userId) return json({ error: 'Report not found.' }, 404);
  if (request.method === 'GET' && !comments) {
    const rows = await db.query(TABLES.bugs, 'bugId = :b AND begins_with(#i, :c)', { ':b': S(bugId), ':c': S('c#') }, { ExpressionAttributeNames: { '#i': 'item' } });
    const out = rows.map((c) => ({ at: str(c, 'at'), author: user.isAdmin || str(c, 'authorUserId') === user.userId ? str(c, 'authorName') : (bool(c, 'isAdmin') ? 'Sushila team' : str(c, 'authorName')),
      isAdmin: bool(c, 'isAdmin'), text: str(c, 'text') === '-' ? '' : str(c, 'text'), status: str(c, 'status') === '-' ? '' : str(c, 'status') }));
    return json({ bug: user.isAdmin ? bug : { ...bug, reporterEmail: '' }, comments: out });
  }
  if (request.method === 'POST' && comments) {
    if (!sameOriginJson(request)) return json({ error: 'Bad request.' }, 400);
    if (limited(request, 'bug-comment', 20)) return json({ error: 'Too many comments. Please wait a minute.' }, 429);
    let d; try { d = await body(request); } catch { return json({ error: 'Comment too long.' }, 400); }
    const text = String(d.text || '').replace(/\u0000/g, '').trim().slice(0, 4000);
    const status = user.isAdmin && BUG_STATUS.includes(d.status) && d.status !== bug.status ? d.status : '';
    if (!text && !status) return json({ error: 'Please write a comment.' }, 400);
    const now = new Date().toISOString();
    await db.put(TABLES.bugs, { bugId: S(bugId), item: S(`c#${now}#${randomId()}`), at: S(now), authorUserId: S(user.userId),
      authorName: S(`${user.firstName} ${user.lastName === '-' ? '' : user.lastName}`.trim() || user.primaryEmail), isAdmin: { BOOL: user.isAdmin },
      text: S(text || '-'), status: S(status || '-') });
    await db.update(TABLES.bugs, { bugId: S(bugId), item: S('bug') }, status ? 'SET updatedAt = :t, #s = :s ADD comments :one' : 'SET updatedAt = :t ADD comments :one',
      { ':t': S(now), ':one': N(1), ...(status ? { ':s': S(status) } : {}) }, status ? { '#s': 'status' } : undefined);
    await audit(db, 'bug-comment', user.userId, request, { bugId, ...(status ? { status } : {}) });
    if (user.isAdmin && bug.reporterUserId !== user.userId) {
      const rep = await db.get(TABLES.users, { userId: S(bug.reporterUserId) });
      if (rep && env.RESEND_API_KEY) await sendEmail(env, str(rep, 'primaryEmail'), `[sushila.ai bug ${bugId}] ${status ? `status: ${status}` : 'new comment'}`,
        `${status ? `Your report "${bug.title}" is now: ${status}.\n\n` : ''}${text ? `The Sushila team commented on "${bug.title}":\n\n${text}\n\n` : ''}https://sushila.ai/bugs/${bugId}`).catch(() => {});
    } else if (!user.isAdmin) {
      await notifyAdmins(env, db, `[sushila.ai bug ${bugId}] new comment`, `${user.primaryEmail} commented on "${bug.title}":\n\n${text}\n\nhttps://sushila.ai/bugs/${bugId}`);
    }
    return json({ ok: true });
  }
  return json({ error: 'Bad request.' }, 400);
}

// --- Model catalog: sushilaai-models (managed on the admin page); the built-in HOSTED list until the table has rows ---
let catalogCache = null;
function modelFrom(it) {
  const m = { modelId: str(it, 'modelId'), name: str(it, 'name'), quant: str(it, 'quant'), file: str(it, 'file'), bytes: num(it, 'bytes'),
    sha256: str(it, 'sha256'), license: str(it, 'license'), licenseUrl: str(it, 'licenseUrl'), hf: str(it, 'hf'), artifacts: str(it, 'artifacts'),
    note: str(it, 'note'), order: num(it, 'order'), visible: bool(it, 'visible'), updatedAt: str(it, 'updatedAt') };
  m.id = m.modelId; m.tuned = !!m.artifacts;
  return m;
}
const builtin = () => HOSTED.map((h, i) => ({ ...h, modelId: h.id, artifacts: h.tuned ? 'precomputed artifacts measured in the paper' : '', note: h.note || '', order: (i + 1) * 10, visible: true }));
function modelItem(m) {
  return { modelId: S(m.modelId), name: S(m.name), quant: S(m.quant), file: S(m.file), bytes: N(m.bytes), sha256: S(m.sha256), license: S(m.license),
    licenseUrl: S(m.licenseUrl), hf: S(m.hf || '-'), artifacts: S(m.artifacts || '-'), note: S(m.note || '-'), order: N(m.order || 0),
    visible: { BOOL: !!m.visible }, updatedAt: S(new Date().toISOString()) };
}
async function catalog(db, fresh = false) {
  if (!db.configured) return builtin();
  if (!fresh && catalogCache && catalogCache.until > Date.now()) return catalogCache.items;
  let items;
  try {
    const rows = await db.scanAll(TABLES.models);
    items = rows.length ? rows.map(modelFrom).map((m) => ({ ...m, hf: m.hf === '-' ? '' : m.hf, artifacts: m.artifacts === '-' ? '' : m.artifacts, note: m.note === '-' ? '' : m.note, tuned: !!(m.artifacts && m.artifacts !== '-') })) : builtin();
  } catch (e) { console.error('catalog', e.message); items = builtin(); }
  items.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  catalogCache = { items, until: Date.now() + 30000 };
  return items;
}
const visibleModels = async (db) => (await catalog(db)).filter((m) => m.visible);

// --- Admin "Compare Speeds": Sushila vs Ollama on a fresh RunPod GPU pod --------------------------------------------
// The worker creates one pod per comparison from the stock SGLang 0.5.21 image. The pod installs Ollama 0.35.1, downloads
// the model (SGLang and Ollama files) and our precomputed draft head from B2 (a read-only token limited to that model's
// folder; every file is checked against CHECKSUMS.json), then times each prompt on both engines
// (scripts/compare/compare_pod.py, copied to B2 at tools/compare/). Pods are deleted after the comparison, on request,
// or by the cron job (scheduled() below): idle 15 min, setup over 60 min, failed, or older than 3 h. Needs RUNPOD_API_KEY.
const COMPARE = {
  image: 'lmsysorg/sglang:v0.5.21-cu130',                 // the SGLang version measured in the paper
  script: 'tools/compare/compare_pod.py',
  gpuTypes: ['NVIDIA A100 80GB PCIe', 'NVIDIA A100-SXM4-80GB', 'NVIDIA H100 80GB HBM3', 'NVIDIA H100 PCIe'],  // first available wins
  podPrefix: 'sushila-cmp-',
  maxActive: 2,                                            // spend guard: at most two comparison pods at once
  idleMinutes: 15, setupMinutes: 60, maxHours: 3, failedMinutes: 10,
};
const rpBase = 'https://rest.runpod.io/v1';
async function runpod(env, method, path, bodyObj) {
  if (!env.RUNPOD_API_KEY) throw new Error('RUNPOD_API_KEY is not set on the worker');
  const r = await fetch(rpBase + path, { method, headers: { authorization: `Bearer ${env.RUNPOD_API_KEY}`, 'content-type': 'application/json', 'user-agent': 'sushila.ai-worker/1.0' },  // RunPod answers 403 without a user agent
    ...(bodyObj ? { body: JSON.stringify(bodyObj) } : {}) });
  const t = await r.text(); let d; try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t }; }
  if (!r.ok) { const e = new Error(`RunPod ${method} ${path}: ${r.status} ${(d && (d.error || d.message)) || t.slice(0, 200)}`); e.status = r.status; throw e; }
  return d;
}
const twoGpus = (model) => /(^|[^0-9])(65|70|72)b/i.test(model);  // a 70B model does not fit twice on one 80 GB GPU
const podUrl = (podId, path) => `https://${podId}-8000.proxy.runpod.net${path}`;
async function podCall(run, path, bodyObj, ms = 15000) {
  const r = await fetch(podUrl(run.podId, path), { method: bodyObj ? 'POST' : 'GET', signal: AbortSignal.timeout(ms),
    headers: { 'x-sushila-token': run.token, 'content-type': 'application/json' }, ...(bodyObj ? { body: JSON.stringify(bodyObj) } : {}) });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = { error: `pod answered ${r.status}` }; }
  if (!r.ok) throw new Error(d.error || `pod answered ${r.status}`);
  return d;
}
const runFrom = (it) => it && ({ runId: str(it, 'runId'), podId: str(it, 'podId'), model: str(it, 'model'), ngpu: num(it, 'ngpu'), gpu: str(it, 'gpu'),
  costPerHr: num(it, 'costPerHr'), createdAt: str(it, 'createdAt'), createdBy: str(it, 'createdBy'), keep: bool(it, 'keep'), status: str(it, 'status'),
  deletedAt: str(it, 'deletedAt'), deleteReason: str(it, 'deleteReason'), token: str(it, 'token'),
  results: (() => { try { return JSON.parse(str(it, 'results') || '[]'); } catch { return []; } })() });
const publicRun = (r) => { const { token, ...rest } = r; return { ...rest, hours: hoursOf(r), cost: Math.round(hoursOf(r) * r.costPerHr * 100) / 100 }; };
const hoursOf = (r) => ((r.deletedAt ? Date.parse(r.deletedAt) : Date.now()) - Date.parse(r.createdAt)) / 3600e3;

async function compareModels(b2) {  // every model in B2 with a precomputed draft head
  const a = await b2.auth();
  const r = await fetch(`${a.apiUrl}/b2api/v3/b2_list_file_names`, { method: 'POST', headers: { authorization: a.token, 'content-type': 'application/json' },
    body: JSON.stringify({ bucketId: a.bucketId, prefix: 'precomputed/', delimiter: '/', maxFileCount: 1000 }) });
  if (!r.ok) throw new Error('B2 list: ' + r.status);
  const dirs = ((await r.json()).files || []).map((f) => f.fileName).filter((n) => n.endsWith('/')).map((n) => n.slice('precomputed/'.length, -1));
  const out = [];
  await Promise.all(dirs.map(async (m) => {
    try {
      const f = await fetch(b2.fileUrl(a.downloadUrl, `precomputed/${m}/CHECKSUMS.json`), { headers: { authorization: a.token } });
      if (!f.ok) return;
      const c = await f.json();
      const head = (c.files || []).filter((x) => x.path.startsWith('draft-head/'));
      if (!c.draft_head || !head.length) return;
      out.push({ model: m, sglang: c.bound_to?.sglang_target?.repo, ollama: c.bound_to?.ollama_gguf?.tag, savedUtc: c.saved_utc,
        headBytes: head.reduce((s, x) => s + (x.bytes || 0), 0), ngpu: twoGpus(m) ? 2 : 1 });
    } catch { /* unreadable index: not offered */ }
  }));
  return out.sort((x, y) => x.model.localeCompare(y.model));
}

async function deletePod(env, db, run, reason) {
  try { await runpod(env, 'DELETE', `/pods/${run.podId}`); }
  catch (e) { if (e.status !== 404) throw e; }  // already gone
  await db.update(TABLES.compare, { runId: S(run.runId) }, 'SET #s = :s, deletedAt = :t, deleteReason = :r',
    { ':s': S('deleted'), ':t': S(new Date().toISOString()), ':r': S(reason) }, { '#s': 'status' });
}

async function compareApi(request, env, db, b2, user, path) {
  const url = new URL(request.url);
  if (path === '/api/admin/compare/models' && request.method === 'GET') {
    return json({ models: await compareModels(b2), runpod: !!env.RUNPOD_API_KEY });
  }
  if (path === '/api/admin/compare/runs' && request.method === 'GET') {
    const runs = (await db.scanAll(TABLES.compare, {}, 500)).map(runFrom).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25);
    return json({ runs: runs.map(publicRun) });
  }
  if (path === '/api/admin/compare/status' && request.method === 'GET') {
    const run = runFrom(await db.get(TABLES.compare, { runId: S(clean(url.searchParams.get('runId'), 40)) }));
    if (!run) return json({ error: 'No such comparison.' }, 404);
    let pod = null, server = null;
    if (run.status !== 'deleted') {
      try { pod = await runpod(env, 'GET', `/pods/${run.podId}`); } catch (e) { pod = { error: e.message }; }
      try { server = await podCall(run, '/status', null, 8000); } catch (e) { server = { stage: 'pod starting (image download, about 3-5 minutes)', unreachable: true }; }
      if (server && server.ready && run.status !== 'ready') await db.update(TABLES.compare, { runId: S(run.runId) }, 'SET #s = :s', { ':s': S('ready') }, { '#s': 'status' });
      if (server && server.error && run.status !== 'failed') await db.update(TABLES.compare, { runId: S(run.runId) }, 'SET #s = :s', { ':s': S('failed') }, { '#s': 'status' });
    }
    return json({ run: publicRun(run), pod: pod && { desiredStatus: pod.desiredStatus, gpu: pod.machine?.gpuTypeId || run.gpu, error: pod.error }, server });
  }
  if (request.method !== 'POST') return json({ error: 'Not found.' }, 404);
  if (!sameOriginJson(request)) return json({ error: 'Bad request.' }, 400);
  let d; try { d = await body(request); } catch { return json({ error: 'Bad request.' }, 400); }

  if (path === '/api/admin/compare/start') {
    const model = clean(d.model, 80);
    const m = (await compareModels(b2)).find((x) => x.model === model);
    if (!m) return json({ error: 'That model has no precomputed draft head in B2.' }, 400);
    const active = (await db.scanAll(TABLES.compare, {}, 500)).map(runFrom).filter((r) => r.status !== 'deleted');
    if (active.length >= COMPARE.maxActive) return json({ error: `Already ${active.length} comparison pods running; delete one first (spend guard).` }, 409);
    const a = await b2.auth();
    const grant = async (prefix) => {
      const r = await fetch(`${a.apiUrl}/b2api/v3/b2_get_download_authorization`, { method: 'POST', headers: { authorization: a.token, 'content-type': 'application/json' },
        body: JSON.stringify({ bucketId: a.bucketId, fileNamePrefix: prefix, validDurationInSeconds: COMPARE.maxHours * 3600 }) });
      if (!r.ok) throw new Error('B2 download authorization: ' + r.status);
      return (await r.json()).authorizationToken;
    };
    const runId = 'cmp-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '-' + randomId().slice(0, 6).toLowerCase();
    const token = randomId() + randomId();
    const base = `${a.downloadUrl}/file/${env.B2_BUCKET_NAME}`;
    const start = `set -e; mkdir -p /workspace; curl -fsSL -H "Authorization: $B2_TOOLS_AUTH" "$B2_FILE_BASE/${COMPARE.script}" -o /compare_pod.py; `
      + `python3 /compare_pod.py 2>&1 | tee /workspace/compare.log`;
    const pod = await runpod(env, 'POST', '/pods', {
      name: COMPARE.podPrefix + runId.slice(4), imageName: COMPARE.image, gpuTypeIds: COMPARE.gpuTypes, gpuCount: m.ngpu, cloudType: 'SECURE',
      containerDiskInGb: m.ngpu > 1 ? 250 : 150, volumeInGb: 0, minVCPUPerGPU: m.ngpu > 1 ? 8 : 16, minRAMPerGPU: 60, allowedCudaVersions: ['13.0'],
      ports: ['8000/http'], dockerEntrypoint: ['bash', '-c'], dockerStartCmd: [start],
      env: { SUSHILA_MODEL: model, SUSHILA_TOKEN: token, NGPU: String(m.ngpu), B2_FILE_BASE: base,
        B2_AUTH: await grant(`precomputed/${model}/`), B2_TOOLS_AUTH: await grant('tools/compare/') },
    });
    const run = { runId: S(runId), podId: S(pod.id), model: S(model), ngpu: N(m.ngpu), gpu: S(pod.machine?.gpuTypeId || (pod.gpu && pod.gpu.id) || ''),
      costPerHr: N(pod.costPerHr || pod.adjustedCostPerHr || 0), createdAt: S(new Date().toISOString()), createdBy: S(user.userId),
      keep: { BOOL: !!d.keep }, status: S('starting'), token: S(token), results: S('[]') };
    await db.put(TABLES.compare, run);
    await audit(db, 'compare-start', user.userId, request, { model, podId: pod.id });
    return json({ run: publicRun(runFrom(run)) });
  }
  const run = runFrom(await db.get(TABLES.compare, { runId: S(clean(d.runId, 40)) }));
  if (!run) return json({ error: 'No such comparison.' }, 404);
  if (path === '/api/admin/compare/prompt') {
    if (run.status === 'deleted') return json({ error: 'This comparison pod has been deleted. Start a new one.' }, 409);
    const prompt = String(d.prompt || '').trim().slice(0, 8000);
    if (!prompt) return json({ error: 'Type a prompt.' }, 400);
    const maxTokens = Math.min(Math.max(Number(d.maxTokens) || 256, 16), 1024);
    let res;
    try { res = await podCall(run, '/compare', { prompt, max_tokens: maxTokens }, 95000); }
    catch (e) { return json({ error: 'The pod could not run the comparison: ' + e.message }, 502); }
    const results = [...run.results, { at: new Date().toISOString(), prompt: prompt.slice(0, 2000), ...res }].slice(-20);
    let saved = JSON.stringify(results);
    while (saved.length > 300000 && results.length > 1) { results.shift(); saved = JSON.stringify(results); }  // DynamoDB items stay under 400 KB
    await db.update(TABLES.compare, { runId: S(run.runId) }, 'SET results = :r, lastActivity = :t', { ':r': S(saved), ':t': S(new Date().toISOString()) });
    let deleted = false;
    if (!run.keep && !d.keepThisTime) { await deletePod(env, db, run, 'after the comparison'); deleted = true; }
    return json({ result: res, deleted });
  }
  if (path === '/api/admin/compare/keep') {
    await db.update(TABLES.compare, { runId: S(run.runId) }, 'SET keep = :k', { ':k': { BOOL: !!d.keep } });
    return json({ ok: true });
  }
  if (path === '/api/admin/compare/stop') {
    if (run.status !== 'deleted') await deletePod(env, db, run, 'deleted by ' + (user.primaryEmail || user.userId));
    await audit(db, 'compare-stop', user.userId, request, { runId: run.runId });
    return json({ ok: true });
  }
  return json({ error: 'Not found.' }, 404);
}

// Cron (every 5 minutes; add the trigger in Cloudflare): delete comparison pods nobody needs, so none runs up a bill.
async function reapComparePods(env) {
  if (!env.RUNPOD_API_KEY) return;
  const db = new DynamoDB(env);
  const pods = (await runpod(env, 'GET', '/pods')) || [];
  const runs = new Map((await db.scanAll(TABLES.compare, {}, 1000)).map(runFrom).map((r) => [r.podId, r]));
  for (const p of (Array.isArray(pods) ? pods : pods.pods || [])) {
    if (!String(p.name || '').startsWith(COMPARE.podPrefix)) continue;  // only comparison pods, never anything else
    const run = runs.get(p.id);
    let why = null;
    if (!run) why = 'no comparison record';
    else {
      const ageMin = (Date.now() - Date.parse(run.createdAt)) / 60e3;
      let server = null; try { server = await podCall(run, '/status', null, 8000); } catch { /* not reachable yet */ }
      if (run.status === 'deleted') why = 'already marked deleted';
      else if (ageMin > COMPARE.maxHours * 60) why = `older than ${COMPARE.maxHours} h`;
      else if (server && server.error && ageMin > COMPARE.failedMinutes) why = 'setup failed: ' + String(server.error).slice(0, 120);
      else if (!(server && server.ready) && ageMin > COMPARE.setupMinutes) why = `not ready after ${COMPARE.setupMinutes} min`;
      else if (server && server.ready && server.idle_s > COMPARE.idleMinutes * 60) why = `idle ${COMPARE.idleMinutes} min`;
    }
    if (!why) continue;
    try {
      if (run) await deletePod(env, db, run, 'cron: ' + why);
      else await runpod(env, 'DELETE', `/pods/${p.id}`);
      console.log('compare reaper deleted', p.id, p.name, why);
    } catch (e) { console.error('compare reaper', p.id, e.message); }
  }
}

// --- Download log (sushilaai-download) ---------------------------------------------------------------------------------
// Every download of a Host Station installer, a Sushila.cpp build, a pack file or a hosted model file: which file, when,
// the IP address and country, the system (windows / mac / linux ...), and what kind of file. A resumed download (an HTTP
// Range that does not start at 0) is not counted again. Rows expire after 12 months; the '#count' row keeps the total.
function systemOf(request, hint) {
  if (hint) return hint;
  const ua = request.headers.get('user-agent') || '';
  const m = ua.match(/SushilaHostStation\/[\w.]+ \((\w+); (\w+)\)/);  // the desktop app names its system
  if (m) return `${m[1]}-${m[2]}`;
  return /Windows/.test(ua) ? 'windows' : /iPhone|iPad/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : /Mac OS X|Macintosh/.test(ua) ? 'mac' : /Linux|X11/.test(ua) ? 'linux' : 'other';
}
function firstRequest(request) {
  const r = request.headers.get('range');
  return !r || /^bytes=0-/.test(r);
}
async function logDownload(db, request, { file, kind, system, bytes, packId, userId }) {
  if (!db.configured || !firstRequest(request)) return;
  try {
    const now = new Date(), at = now.toISOString();
    await db.put(TABLES.download, { file: S(file), at: S(`${at}#${randomId()}`), day: S(at.slice(0, 10)), kind: S(kind), system: S(systemOf(request, system)),
      ip: S(request.headers.get('cf-connecting-ip') || '-'), country: S((request.cf && request.cf.country) || '-'),
      userAgent: S((request.headers.get('user-agent') || '-').slice(0, 200)), ...(bytes ? { bytes: N(bytes) } : {}),
      ...(packId ? { packId: S(packId) } : {}), ...(userId ? { userId: S(userId) } : {}), ttl: N(Math.floor(now.getTime() / 1000) + 365 * 86400) });
    await db.update(TABLES.download, { file: S(file), at: S('#count') }, 'ADD #n :one SET #l = :t, #k = :k', { ':one': N(1), ':t': S(at), ':k': S(kind) },
      { '#n': 'downloads', '#l': 'lastAt', '#k': 'kind' });
  } catch (e) { console.error('download log', e.message); }
}

// --- Sushila Host Station catalog (/hoststation/catalog.json) ------------------------------------------------------
// The desktop app (SushilaHostStation/) installs Sushila.cpp and model packs from this list. Each pack maps files in
// B2 precomputed/<model>/ to the folder layout Sushila.cpp reads (<model>.gguf + <model>.gguf.sushila/manifest.json);
// sizes and sha256 come from that model's CHECKSUMS.json, and links are B2 download links valid for 24 hours. Engine
// builds are listed in B2 hoststation/engine/LATEST.json ({version, builds: {<os>-<arch>: {file, sha256, bytes,
// archive, server}}}) once they are published.
const HOST_RUNTIMES = ['image-nunchaku'];
const HOST_PACKS = [
  { id: 'qwen2.5-0.5b-q4km', category: 'Text (LLM)', name: 'Qwen2.5 0.5B Instruct (4-bit)', model: 'precomputed/qwen2.5-0.5b-q4km', minRamGB: 2,
    description: 'Small and fast; runs on any computer. With the precomputed output-layer landscape: CPU decoding 1.07-1.26x faster, with the same greedy output on our test prompts (top-1 agreement 99.4-100% by domain).',
    license: 'Apache-2.0', licenseUrl: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/blob/main/LICENSE', artifacts: ['output-layer landscape'],
    files: [['weights/gguf/qwen2.5-0.5b-q4km.gguf', 'qwen2.5-0.5b-q4km.gguf', 'weights'],
      ['landscape/manifest.json', 'qwen2.5-0.5b-q4km.gguf.sushila/manifest.json', 'manifest'],
      ['landscape/landscape.mclp', 'qwen2.5-0.5b-q4km.gguf.sushila/landscape.mclp', 'landscape'],
      ['landscape/LICENSE.txt', 'qwen2.5-0.5b-q4km.gguf.sushila/LICENSE.txt', 'license']],
    serve: { model: 'qwen2.5-0.5b-q4km.gguf', args: [] } },
  { id: 'qwen3-4b-instruct-2507', category: 'Text (LLM)', name: 'Qwen3 4B Instruct 2507 (chat, 4-bit)', model: 'precomputed/qwen3-4b-instruct-2507', minRamGB: 6,
    description: 'A capable private chat model that runs on almost any computer (2.5 GB). Default of Sushila ChatGen on computers with less than 24 GB of memory.',
    license: 'Apache-2.0', licenseUrl: 'https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507', artifacts: [],
    files: [['weights/gguf/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', 'weights']],
    serve: { model: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', args: [] } },
  { id: 'qwen3-coder-30b-a3b', category: 'Code', name: 'Qwen3-Coder 30B-A3B Instruct (coding, 4-bit)', model: 'precomputed/qwen3-coder-30b-a3b', minRamGB: 24,
    description: 'A strong open coding model (mixture of experts: 3B active, so it is fast even on a CPU): writes, explains and fixes programs in many languages. Default of Sushila CodeGen with 24 GB+ of memory.',
    license: 'Apache-2.0', licenseUrl: 'https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct', artifacts: [],
    files: [['weights/gguf/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf', 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf', 'weights']],
    serve: { model: 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf', args: [] } },
  { id: 'qwen2.5-coder-7b', category: 'Code', name: 'Qwen2.5-Coder 7B Instruct (coding, 4-bit)', model: 'precomputed/qwen2.5-coder-7b', minRamGB: 8,
    description: 'A compact coding model (4.7 GB) for computers with 8-24 GB of memory: code in many languages, with explanations.',
    license: 'Apache-2.0', licenseUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct', artifacts: [],
    files: [['weights/gguf/qwen2.5-coder-7b-instruct-q4_k_m.gguf', 'qwen2.5-coder-7b-instruct-q4_k_m.gguf', 'weights']],
    serve: { model: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf', args: [] } },
  // VideoGen (sushilaVideoGen.cpp, released 2026-10-06): Wan 2.2 TI2V-5B, text or a start picture to video
  { id: 'wan2.2-ti2v-5b', category: 'Video', kind: 'video', name: 'Wan 2.2 TI2V-5B (text or picture to video, 8-bit)', model: 'precomputed/wan2.2-ti2v-5b', minRamGB: 24,
    description: 'Short videos (2-5 s, up to 720p, 24 fps) from a sentence, or from a starting picture. Needs a GPU with 12 GB+ for comfortable speed; minutes per clip.',
    license: 'Apache-2.0', licenseUrl: 'https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B', artifacts: [],
    files: [['weights/diffusion/Wan2.2-TI2V-5B-Q8_0.gguf', 'Wan2.2-TI2V-5B-Q8_0.gguf', 'weights'],
      ['weights/text-encoder/umt5-xxl-encoder-Q8_0.gguf', 'umt5-xxl-encoder-Q8_0.gguf', 'text-encoder'],
      ['weights/vae/wan2.2_vae.safetensors', 'wan2.2_vae.safetensors', 'vae']],
    serve: { engine: 'image', model: 'Wan2.2-TI2V-5B-Q8_0.gguf',
      args: ['--diffusion-model', '{pack}/Wan2.2-TI2V-5B-Q8_0.gguf', '--t5xxl', '{pack}/umt5-xxl-encoder-Q8_0.gguf', '--vae', '{pack}/wan2.2_vae.safetensors', '--diffusion-fa', '--offload-to-cpu'],
      // Accelerated: Sushila's precomputed cache plan for this model (EasyCache 0.2: 1.62x median at 1280x704, 50 steps, frame SSIM 0.93)
      turboRequest: { cache_mode: 'easycache', cache_option: 'threshold=0.2' } } },
  { id: 'ace-step-15', category: 'Music', kind: 'music', name: 'ACE-Step 1.5 (songs from lyrics and a style)', model: 'precomputed/ace-step-15', minRamGB: 12,
    description: 'Full songs with vocals from your lyrics and a style description (stereo 48 kHz MP3), up to several minutes; 8-step turbo model with the 4B song-writing model. Runs on GPUs with 8 GB+, slower on CPU.',
    license: 'MIT', licenseUrl: 'https://huggingface.co/ACE-Step/Ace-Step1.5', artifacts: [],
    files: [['weights/acestep-v15-turbo-Q8_0.gguf', 'acestep-v15-turbo-Q8_0.gguf', 'weights'], ['weights/acestep-5Hz-lm-4B-Q8_0.gguf', 'acestep-5Hz-lm-4B-Q8_0.gguf', 'lm'],
      ['weights/Qwen3-Embedding-0.6B-Q8_0.gguf', 'Qwen3-Embedding-0.6B-Q8_0.gguf', 'text-encoder'], ['weights/vae-BF16.gguf', 'vae-BF16.gguf', 'vae']],
    // Accelerated: the Sushila fast sampler (same sampling distribution, song writing 1.34x faster on an RTX 4090; needs engine >= 0.1.1)
    serve: { engine: 'music', model: 'acestep-v15-turbo-Q8_0.gguf', args: [], turboArgs: ['--fast-sampler'] } },
  { id: 'z-image-turbo', category: 'Images', kind: 'image', name: 'Z-Image-Turbo (image generation, 4-bit)', model: 'precomputed/z-image-turbo', minRamGB: 12,
    description: 'Photorealistic images from a text prompt in 8 steps (#1 open-weight image model on Artificial Analysis at release); English and Chinese text in images. Runs on most GPUs with 6 GB+, slower on CPU.',
    license: 'Apache-2.0', licenseUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo', artifacts: [],
    files: [['weights/diffusion/z_image_turbo-Q4_K.gguf', 'z_image_turbo-Q4_K.gguf', 'weights'],
      ['weights/text-encoder/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', 'text-encoder'],
      ['weights/vae/ae.safetensors', 'ae.safetensors', 'vae']],
    serve: { engine: 'image', model: 'z_image_turbo-Q4_K.gguf',
      args: ['--diffusion-model', '{pack}/z_image_turbo-Q4_K.gguf', '--llm', '{pack}/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', '--vae', '{pack}/ae.safetensors',
        '--cfg-scale', '1.0', '--steps', '8', '--diffusion-fa', '--offload-to-cpu'],
      // Accelerated: Sushila's precomputed cache plan for Z-Image (EasyCache 0.2: 1.10x on held-out prompts, SSIM 0.98)
      turboRequest: { cache_mode: 'easycache', cache_option: 'threshold=0.2' } } },
  { id: 'z-image-turbo-nvidia', category: 'Images', kind: 'image', name: 'Z-Image-Turbo for NVIDIA GPUs (Accelerated: under 1 second)', model: 'precomputed/z-image-turbo-nvidia', minRamGB: 16,
    variantOf: 'z-image-turbo', requires: { gpu: 'nvidia', minCompute: 7.5, maxCompute: 11.9 },
    description: 'Z-Image-Turbo with Nunchaku 4-bit kernels for NVIDIA RTX 20/30/40-series: a 768x768 image in about 0.8 s on an RTX 4090 (Accelerated: 6 steps), or the published 1024x1024 / 8 steps (Standard). Installs the Sushila image runtime for NVIDIA (PyTorch + Nunchaku) once.',
    license: 'Apache-2.0', licenseUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo', artifacts: ['Nunchaku SVDQuant int4 transformer'],
    files: [['weights/model_index.json', 'model_index.json', 'config'],
      ['weights/scheduler/scheduler_config.json', 'scheduler/scheduler_config.json', 'config'],
      ['weights/text_encoder/config.json', 'text_encoder/config.json', 'config'],
      ['weights/text_encoder/generation_config.json', 'text_encoder/generation_config.json', 'config'],
      ['weights/text_encoder/model-00001-of-00003.safetensors', 'text_encoder/model-00001-of-00003.safetensors', 'weights'],
      ['weights/text_encoder/model-00002-of-00003.safetensors', 'text_encoder/model-00002-of-00003.safetensors', 'weights'],
      ['weights/text_encoder/model-00003-of-00003.safetensors', 'text_encoder/model-00003-of-00003.safetensors', 'weights'],
      ['weights/text_encoder/model.safetensors.index.json', 'text_encoder/model.safetensors.index.json', 'config'],
      ['weights/tokenizer/merges.txt', 'tokenizer/merges.txt', 'config'],
      ['weights/tokenizer/tokenizer.json', 'tokenizer/tokenizer.json', 'config'],
      ['weights/tokenizer/tokenizer_config.json', 'tokenizer/tokenizer_config.json', 'config'],
      ['weights/tokenizer/vocab.json', 'tokenizer/vocab.json', 'config'],
      ['weights/transformer/config.json', 'transformer/config.json', 'config'],
      ['weights/vae/config.json', 'vae/config.json', 'config'],
      ['weights/vae/diffusion_pytorch_model.safetensors', 'vae/diffusion_pytorch_model.safetensors', 'weights'],
      ['weights/transformer/svdq-int4_r128-z-image-turbo.safetensors', 'transformer/svdq-int4_r128-z-image-turbo.safetensors', 'weights']],
    serve: { engine: 'image-nunchaku', model: 'model_index.json', args: ['--model-dir', '{pack}/model_index.json', '--transformer', '{pack}/transformer/svdq-int4_r128-z-image-turbo.safetensors'] } },
  { id: 'z-image-turbo-nvidia-fp4', category: 'Images', kind: 'image', name: 'Z-Image-Turbo for NVIDIA RTX 50-series (Accelerated: under 1 second)', model: 'precomputed/z-image-turbo-nvidia-fp4', minRamGB: 16,
    variantOf: 'z-image-turbo', requires: { gpu: 'nvidia', minCompute: 12.0 },
    description: 'Z-Image-Turbo with Nunchaku FP4 kernels for NVIDIA RTX 50-series (Blackwell). Accelerated: 768x768 in 6 steps; Standard: the published 1024x1024 / 8 steps. Installs the Sushila image runtime for NVIDIA (PyTorch + Nunchaku) once.',
    license: 'Apache-2.0', licenseUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo', artifacts: ['Nunchaku SVDQuant fp4 transformer'],
    files: [['weights/model_index.json', 'model_index.json', 'config'],
      ['weights/scheduler/scheduler_config.json', 'scheduler/scheduler_config.json', 'config'],
      ['weights/text_encoder/config.json', 'text_encoder/config.json', 'config'],
      ['weights/text_encoder/generation_config.json', 'text_encoder/generation_config.json', 'config'],
      ['weights/text_encoder/model-00001-of-00003.safetensors', 'text_encoder/model-00001-of-00003.safetensors', 'weights'],
      ['weights/text_encoder/model-00002-of-00003.safetensors', 'text_encoder/model-00002-of-00003.safetensors', 'weights'],
      ['weights/text_encoder/model-00003-of-00003.safetensors', 'text_encoder/model-00003-of-00003.safetensors', 'weights'],
      ['weights/text_encoder/model.safetensors.index.json', 'text_encoder/model.safetensors.index.json', 'config'],
      ['weights/tokenizer/merges.txt', 'tokenizer/merges.txt', 'config'],
      ['weights/tokenizer/tokenizer.json', 'tokenizer/tokenizer.json', 'config'],
      ['weights/tokenizer/tokenizer_config.json', 'tokenizer/tokenizer_config.json', 'config'],
      ['weights/tokenizer/vocab.json', 'tokenizer/vocab.json', 'config'],
      ['weights/transformer/config.json', 'transformer/config.json', 'config'],
      ['weights/vae/config.json', 'vae/config.json', 'config'],
      ['weights/vae/diffusion_pytorch_model.safetensors', 'vae/diffusion_pytorch_model.safetensors', 'weights'],
      ['weights/transformer/svdq-fp4_r128-z-image-turbo.safetensors', 'transformer/svdq-fp4_r128-z-image-turbo.safetensors', 'weights']],
    serve: { engine: 'image-nunchaku', model: 'model_index.json', args: ['--model-dir', '{pack}/model_index.json', '--transformer', '{pack}/transformer/svdq-fp4_r128-z-image-turbo.safetensors'] } },
  { id: 'z-image-turbo-q8', category: 'Images', kind: 'image', name: 'Z-Image-Turbo (image generation, 8-bit, best quality)', model: 'precomputed/z-image-turbo-q8', minRamGB: 16,
    description: 'The same model at 8 bits: near-original image quality, a bit slower and larger than the 4-bit pack. Best with a GPU with 10 GB+.',
    license: 'Apache-2.0', licenseUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo', artifacts: [],
    files: [['weights/diffusion/z_image_turbo-Q8_0.gguf', 'z_image_turbo-Q8_0.gguf', 'weights'],
      ['weights/text-encoder/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', 'text-encoder'],
      ['weights/vae/ae.safetensors', 'ae.safetensors', 'vae']],
    serve: { engine: 'image', model: 'z_image_turbo-Q8_0.gguf',
      args: ['--diffusion-model', '{pack}/z_image_turbo-Q8_0.gguf', '--llm', '{pack}/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', '--vae', '{pack}/ae.safetensors',
        '--cfg-scale', '1.0', '--steps', '8', '--diffusion-fa', '--offload-to-cpu'],
      // Accelerated: the Z-Image cache plan (same model, 8-bit file)
      turboRequest: { cache_mode: 'easycache', cache_option: 'threshold=0.2' } } },
  { id: 'qwen3-30b-a3b-q4km', category: 'Text (LLM)', name: 'Qwen3 30B-A3B (mixture of experts, 4-bit)', model: 'precomputed/qwen3-30b-a3b', minRamGB: 24, ollamaGguf: 'qwen3-30b-a3b-q4km.gguf',
    description: 'Fast for its size: only 3B parameters are active per token. The exact file measured in the paper.', license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen3-30B-A3B/blob/main/LICENSE', artifacts: [], serve: { model: 'qwen3-30b-a3b-q4km.gguf', args: [] } },
  { id: 'qwen3-32b-q4km', category: 'Text (LLM)', name: 'Qwen3 32B (4-bit)', model: 'precomputed/qwen3-32b', minRamGB: 24, ollamaGguf: 'qwen3-32b-q4km.gguf',
    description: 'A strong dense 32B model; best with a 24 GB+ GPU.', license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/Qwen/Qwen3-32B/blob/main/LICENSE', artifacts: [], serve: { model: 'qwen3-32b-q4km.gguf', args: [] } },
  { id: 'deepseek-r1-distill-llama-70b-q4km', category: 'Text (LLM)', name: 'DeepSeek-R1-Distill-Llama-70B (reasoning, 4-bit)', model: 'precomputed/deepseek-r1-distill-llama-70b', minRamGB: 48,
    ollamaGguf: 'deepseek-r1-distill-llama-70b-q4km.gguf', description: 'Reasons step by step before answering; needs 48 GB+ of GPU or unified memory.',
    license: 'MIT and the Llama 3.3 Community License', licenseUrl: 'https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Llama-70B', artifacts: [],
    serve: { model: 'deepseek-r1-distill-llama-70b-q4km.gguf', args: [] } },
];
let hostCatalogCache = null;  // per isolate, 10 minutes (links stay valid for 24 hours)
// Every file users download is served from the bucket's public/ folder through files.sushila.ai (a Cloudflare Worker
// that lets nothing else out of the private bucket; Bandwidth Alliance: no B2 egress). Copies are made with
// scripts/b2_publish_public.py; links never show the storage provider and need no tokens.
const FILES_BASE = 'https://files.sushila.ai/public/';
const publicUrl = (key) => FILES_BASE + key.split('/').map(encodeURIComponent).join('/');
async function hostCatalog(env, b2, origin = 'https://sushila.ai') {
  if (hostCatalogCache && hostCatalogCache.until > Date.now() && hostCatalogCache.origin === origin) return hostCatalogCache.body;
  const direct = {};  // "<pack id>/<file index>" or "engine/<system>" -> B2 link (24 h)
  const a = await b2.auth();
  const grant = async (prefix) => {
    const r = await fetch(`${a.apiUrl}/b2api/v3/b2_get_download_authorization`, { method: 'POST', headers: { authorization: a.token, 'content-type': 'application/json' },
      body: JSON.stringify({ bucketId: a.bucketId, fileNamePrefix: prefix, validDurationInSeconds: 24 * 3600 }) });
    if (!r.ok) throw new Error('B2 download authorization: ' + r.status);
    return (await r.json()).authorizationToken;
  };
  const getText = async (key) => { const r = await fetch(b2.fileUrl(a.downloadUrl, key), { headers: { authorization: a.token } }); return r.ok ? r.text() : null; };
  const getJson = async (key) => { const t = await getText(key); return t ? JSON.parse(t) : null; };
  const packs = [];
  for (const p of HOST_PACKS) {
    if (p.hidden && env.SHOW_HIDDEN_PACKS !== '1') continue;  // packs not released yet
    try {
      // the signed index travels with the pack: the app checks the signature, then every file against the index
      const text = await getText(`${p.model}/CHECKSUMS.json`), signature = await getText(`${p.model}/CHECKSUMS.json.sig`);
      if (!text || !signature) continue;  // unsigned packs are never offered
      const c = JSON.parse(text);
      const byPath = Object.fromEntries((c.files || []).map((f) => [f.path, f]));
      let map = p.files || [];
      if (p.ollamaGguf) {  // the Ollama file measured in the paper, mirrored in B2 (weights/ollama/blobs/)
        const sha = c.bound_to && c.bound_to.ollama_gguf && c.bound_to.ollama_gguf.sha256;
        if (!sha) continue;
        map = [[`weights/ollama/blobs/sha256-${sha.replace(/^sha256[-:]/, '')}`, p.ollamaGguf, 'weights']];
      }
      const files = map.map(([src, path, role], i) => {
        const f = byPath[src];
        if (!f) return null;
        direct[`${p.id}/${i}`] = { url: publicUrl(`${p.model}/${src}`), file: path.split('/').pop(), bytes: f.bytes };
        return { path, src, role, bytes: f.bytes, sha256: f.sha256, url: `${origin}/hoststation/get/${p.id}/${i}` };  // counted, then -> files.sushila.ai
      });
      if (files.some((f) => !f)) continue;  // a file is not in B2 (yet): do not offer a broken pack
      const { model, files: _f, ollamaGguf, hidden, ...pub } = p;
      const packBytes = 512 + 0 + files.reduce((a, f) => a + 512 + f.bytes + pad512(f.bytes), 0) + 1024;  // approximate (+ metadata)
      packs.push({ ...pub, files, index: { text, signature: signature.trim() }, packUrl: `${origin}/hoststation/pack/${p.id}.sushilapack`, packBytes });
    } catch (e) { console.error('hoststation pack', p.id, e.message); }
  }
  let engine = null;
  try {
    const ltext = await getText('hoststation/engine/LATEST.json'), lsig = await getText('hoststation/engine/LATEST.json.sig');
    const latest = ltext && lsig ? JSON.parse(ltext) : null;
    if (latest && latest.version && latest.builds) {
      engine = { version: latest.version, index: { text: ltext, signature: lsig.trim() }, builds: Object.fromEntries(Object.entries(latest.builds).map(([k, b]) => {
        direct[`engine/${k}`] = { url: publicUrl(`hoststation/engine/${latest.version}/${b.file}`), file: b.file, bytes: b.bytes, github: b.github, githubAsset: b.githubAsset };
        return [k, { ...b, url: `${origin}/hoststation/get/engine/${k}` }];
      })) };
    }
  } catch (e) { console.error('hoststation engine', e.message); }
  // runtimes the app installs on demand (e.g. image-nunchaku: Python + PyTorch + Nunchaku for the NVIDIA image packs)
  const runtimes = {};
  for (const name of HOST_RUNTIMES) {
    try {
      const ltext = await getText(`hoststation/runtime/${name}/LATEST.json`), lsig = await getText(`hoststation/runtime/${name}/LATEST.json.sig`);
      const latest = ltext && lsig ? JSON.parse(ltext) : null;
      if (!latest || !latest.version || !latest.builds) continue;
      const pre = `hoststation/runtime/${name}/${latest.version}/`;
      const link = (key, i, f) => {
        direct[`runtime/${name}/${key}/${i}`] = { url: publicUrl(pre + f.path), file: f.path.split('/').pop(), bytes: f.bytes };
        return { ...f, url: `${origin}/hoststation/get/runtime/${name}/${key}/${i}` };
      };
      runtimes[name] = { version: latest.version, index: { text: ltext, signature: lsig.trim() }, builds: Object.fromEntries(Object.entries(latest.builds).map(([key, b]) => {
        const files = [b.python, b.server, ...b.wheels];
        const linked = files.map((f, i) => link(key, i, f));
        return [key, { bytes: b.bytes, python: { ...linked[0], exe: b.python.exe }, server: { ...linked[1], script: b.server.script }, wheels: linked.slice(2) }];
      })) };
    } catch (e) { console.error('hoststation runtime', name, e.message); }
  }
  const body = { version: 1, generated: new Date().toISOString(), filesBase: FILES_BASE, engine, runtimes, packs };
  hostCatalogCache = { body, direct, origin, until: Date.now() + 10 * 60 * 1000 };
  return body;
}

// Host Station installers: B2 hoststation/app/LATEST.json = {version, files: [{platform, label, file, sha256, bytes}]}
// (written when installers are published); each file gets a 24-hour download link.
// Streams a released file (GitHub Releases of the main repository) through sushila.ai: same origin for the install
// wizard's pause/resume, and the only site the apps download programs from. Every fetch counts as a download on GitHub.
// While the repository is private, the asset is fetched through the API with GITHUB_RELEASE_TOKEN (a fine-grained,
// read-only token for syncaissa/sushila.cpp); once it is public, the plain release link works. null: use the B2 copy.
const RELEASES = 'https://github.com/syncaissa/sushila.cpp/releases/download/';
const RELEASE_API = 'https://api.github.com/repos/syncaissa/sushila.cpp/releases/assets/';
async function fromGithub(env, entry, request, file, sha256) {
  const link = String(entry.github || ''), api = String(entry.githubAsset || '');
  if (!link.startsWith(RELEASES)) return null;
  try {
    const range = request.headers.get('range');
    let r;
    if (env.GITHUB_RELEASE_TOKEN && api.startsWith(RELEASE_API)) {
      // the API answers with a redirect to short-lived storage, which must be fetched without the token
      const a = await fetch(api, { headers: { authorization: `Bearer ${env.GITHUB_RELEASE_TOKEN}`, accept: 'application/octet-stream', 'user-agent': 'sushila.ai' }, redirect: 'manual' });
      const loc = a.headers.get('location');
      if (!loc) return null;
      r = await fetch(loc, { headers: range ? { range } : {} });
    } else {
      r = await fetch(link, { headers: { 'user-agent': 'sushila.ai', ...(range ? { range } : {}) }, redirect: 'follow' });
    }
    if (!(r.status === 200 || r.status === 206)) return null;
    const out = new Headers({ 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${String(file).replace(/"/g, '')}"`,
      'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-source': 'github-releases', ...(sha256 ? { 'x-sha256': sha256 } : {}), ...SEC });
    for (const k of ['content-length', 'content-range']) if (r.headers.get(k)) out.set(k, r.headers.get(k));
    return new Response(r.body, { status: r.status, headers: out });
  } catch (_) { return null; }
}

async function hostApp(env, b2) {
  const a = await b2.auth();
  const r = await fetch(b2.fileUrl(a.downloadUrl, 'hoststation/app/LATEST.json'), { headers: { authorization: a.token } });
  if (!r.ok) return null;
  const latest = await r.json();
  latest.files = (latest.files || []).map((f) => ({ ...f, url: publicUrl(`hoststation/app/${latest.version}/${f.file}`) }));
  return latest;
}

const HOSTSTATION = (env, app, packs = []) => () => {
  const REPO = String(env.REPO_URL || REPO_DEFAULT).replace(/\/+$/, '');
  const table = (product) => (app && app.files || []).filter((f) => (f.product || 'host-station') === product).map((f) => `
    <tr><td><b>${esc(f.label || f.platform)}</b></td><td class="num">${gb(f.bytes || 0)}</td>
      <td class="act"><a class="btn small" href="/hoststation/download/${product === 'host-station' ? '' : product + '/'}${esc(f.platform)}">Download</a> <button class="copy" data-copy="${esc(f.sha256)}" title="Copy sha256">sha256</button></td></tr>`).join('');
  const rows = table('host-station');
  const product = (key, file, title, text) => { const r = table(key); return `
<h2 id="${key}">${title} <span class="muted" style="font-size:.6em">${file}</span></h2>
<p>${text}</p>
${r ? `<div class="tablewrap"><table><thead><tr><th>System</th><th class="num">Size</th><th></th></tr></thead><tbody>${r}</tbody></table></div>` : '<p class="note">These installers are being built and signed. Check back soon.</p>'}`; };
  return `
<h1>Sushila Host Station</h1>
<p class="lead">A free desktop app for Windows, macOS and Linux. It installs Sushila.cpp and model packs with a few clicks, runs models on your own computer, and opens a chat page in your browser. No command prompt needed. When apps are installed locally, you are the King (or Queen!)</p>
<p>ChatGen, CodeGen, ImageGen and MusicGen below are this same app, each set up for one job. Install a second one and it only adds its model: one engine and one model store per computer.</p>

<p><a class="btn hsget" href="#" data-start="welcome">Install step by step</a></p>
${HS_WIZARD(app, packs)}
<h2>Download${app ? ` (version ${esc(app.version)})` : ''}</h2>
${rows ? `<div class="tablewrap"><table><thead><tr><th>System</th><th class="num">Size</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="note">Check the sha256 of your download against the one listed here. Installers are code-signed by the Sushila project.</p>`
    : '<p class="note">The first installers are being built and signed. Check back soon.</p>'}

${product('chatgen', 'sushilaChatGen.cpp', 'Sushila ChatGen', 'A private assistant: after you install it, it installs Sushila.cpp and a chat model that fits your computer (Qwen3 30B-A3B with 24 GB+ of memory, Qwen3 4B otherwise), starts it, and opens a chat. Nothing you type leaves your computer. <b>Maximize</b> shows only the conversation.')}
${product('codegen', 'sushilaCodeGen.cpp', 'Sushila CodeGen', 'Write programs in many languages, locally: Qwen3-Coder 30B-A3B with 24 GB+ of memory (Qwen2.5-Coder 7B otherwise). Answers show code blocks with a Copy button.')}
${product('imagegen', 'sushilaImageGen.cpp', 'Sushila ImageGen', 'Pictures from a sentence: it installs Sushila.cpp and Z-Image-Turbo (the fast Accelerated pack on NVIDIA RTX cards: a 768x768 image in under a second on an RTX 4090), starts it, and makes a first image ("Two bears dancing in a forest near a river") with a Download button.')}
${product('musicgen', 'sushilaMusicGen.cpp', 'Sushila MusicGen', 'Songs from lyrics and a style: it installs Sushila.cpp and ACE-Step 1.5, starts it, and makes a first song. Then type <b>1. Lyrics</b> and <b>2. Style</b> and press <b>Generate</b>: a full song with vocals, with a Download button.')}
${product('videogen', 'sushilaVideoGen.cpp', 'Sushila VideoGen', 'Short videos from a sentence or a start picture: it installs Sushila.cpp and Wan 2.2 TI2V-5B (Apache-2.0), starts it, and makes a first clip. A 5-second 1280x704 video with the settings Wan recommends (50 steps) takes about 15 minutes on an RTX 4090 in Standard, and Accelerated (our precomputed cache plan) is about 1.6x faster (889 s against 549 s, median of 5 prompts); 24 GB+ of memory recommended. Every finished clip has a Download button, and long jobs can run in the background queue.')}

<h2>Install, then four clicks</h2>
<ol>
  <li><b>Install the app.</b> On Windows, run the installer and choose <i>Only for me</i> or <i>All users</i>. On macOS, drag it to Applications. On Linux, open the .deb, .rpm or AppImage.</li>
  <li><b>Install Sushila.cpp</b> on the Home screen. If it is already on your computer, choose <i>Find an existing installation</i>.</li>
  <li><b>Add a model pack</b>: in the app, or with <a href="/#packs">Install in Host Station</a> on this website. The app shows the pack, its size and license, and asks before installing.</li>
  <li><b>Start</b> the model, then <b>Launch Inference Page</b>: a chat page opens at <code>http://127.0.0.1:8765/</code>, running entirely on your computer.</li>
</ol>

<h2>Safe by design</h2>
<ul>
  <li>Every pack and engine build is listed with sha256 checksums and <b>signed by Sushila</b>. The app refuses anything whose signature or checksums do not match.</li>
  <li>Packs contain <b>only data</b>: model weights (GGUF, safetensors) and the precomputed landscape and head files. Programs, scripts and pickle files are refused, and nothing from a pack is ever run.</li>
  <li>Everything stays inside the app's own folder, and the chat page and model server listen only on your own computer.</li>
</ul>
<p>The step-by-step guide: <a href="${REPO}/blob/main/deleteItIn2027/hoststation-desktop/HOW_TO_INSTALL.md">HOW_TO_INSTALL.md</a>. Sushila is an open-source research project; the software is provided as is, without warranty (<a href="/terms">terms</a>).</p>
<script>
document.querySelectorAll('.copy').forEach(b => b.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'copied'; } catch (e) { prompt('sha256', b.dataset.copy); }
  setTimeout(() => b.textContent = 'sha256', 1500);
}));
</script>`;
};

// Step-by-step "install Sushila Host Station first" wizard, shared by the home page (Install in Host Station buttons)
// and /hoststation. A web page cannot see whether an app is installed: when a sushila:// link does not open anything,
// the wizard asks, then guides the visitor through download and install for their system, and finally sends them back
// to the pack they chose. `app` is hostApp() (installers in B2) or null while none are published.
const HS_WIZARD = (app, packs = []) => {
  const files = (app && app.files || []).filter((f) => (f.product || 'host-station') === 'host-station').map(({ platform, label, file, sha256, bytes, url }) => ({ platform, label, file, sha256, bytes, url }));
  const plist = packs.map((p) => ({ id: p.id, name: p.name, category: p.category || 'Other', description: p.description || '', license: p.license,
    bytes: (p.files || []).reduce((a, f) => a + (f.bytes || 0), 0), minRamGB: p.minRamGB || 0 }));
  const data = JSON.stringify({ version: app ? app.version : null, files, packs: plist }).replace(/</g, '\\u003c');
  return `
<style>
#hswiz{border:1px solid var(--line);border-radius:14px;padding:0;max-width:620px;width:calc(100% - 32px);background:var(--card);color:var(--fg)}
#hswiz::backdrop{background:rgba(0,0,0,.45)}#hswiz .in{padding:22px 24px}#hswiz h2{margin:0 0 6px;font-size:21px}
#hswiz .steps{counter-reset:s;list-style:none;padding:0;margin:14px 0}#hswiz .steps li{counter-increment:s;margin:10px 0;padding-left:38px;position:relative}
#hswiz .steps li::before{content:counter(s);position:absolute;left:0;top:-2px;width:26px;height:26px;border-radius:50%;background:var(--accbg);color:var(--acc);font-weight:700;text-align:center;line-height:26px}
#hswiz .bar{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:18px}#hswiz .big{font-size:17px;padding:12px 22px}
#hswiz .os{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}#hswiz .os button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:6px 10px;cursor:pointer;font:inherit;font-size:14px}
#hswiz .os button[aria-pressed=true]{border-color:var(--acc);background:var(--accbg);color:var(--acc);font-weight:600}
#hswiz .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--acc);margin-right:6px}#hswiz kbd{border:1px solid var(--line);border-radius:5px;padding:0 5px;font:inherit;font-size:13px}
#hswiz .pk{display:block;width:100%;text-align:left;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:10px;padding:10px 12px;margin:8px 0;cursor:pointer;font:inherit}
.hsdl-fab{position:fixed;right:16px;bottom:16px;z-index:50;box-shadow:0 6px 18px rgba(0,0,0,.25)}
.hsdl-panel{position:fixed;right:16px;bottom:64px;width:min(420px,calc(100vw - 32px));max-height:60vh;overflow:auto;z-index:50;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
.hsdl-item{border-top:1px solid var(--line);padding:8px 0}.hsdl-bar{height:8px;background:var(--line);border-radius:99px;overflow:hidden;margin:6px 0}.hsdl-bar i{display:block;height:100%;background:var(--acc)}
.hsdl-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.hsdl-row .sub{flex:1}
#hswiz .pk:hover,#hswiz .pk[aria-pressed=true]{border-color:var(--acc);background:var(--accbg)}#hswiz .pk b{display:block}#hswiz .cat{margin:14px 0 2px;font-weight:700;font-size:14px;color:var(--mut)}
</style>
<dialog id="hswiz" aria-labelledby="hswiz-t"><div class="in" id="hswiz-body"></div></dialog>
<script>
(function () {
  const APP = ${data};
  const dlg = document.getElementById('hswiz'), body = document.getElementById('hswiz-body');
  if (!dlg) return;
  const E = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} } };
  const SYSTEMS = { 'windows-x86_64': 'Windows', 'macos-aarch64': 'Mac (Apple M1–M4)', 'macos-x86_64': 'Mac (Intel)', 'linux-deb': 'Ubuntu / Debian', 'linux-rpm': 'Fedora', 'linux-appimage': 'Other Linux' };
  let sys = /Windows/.test(navigator.userAgent) ? 'windows-x86_64' : /Mac/.test(navigator.userAgent) ? 'macos-aarch64' : /Fedora|Red Hat/.test(navigator.userAgent) ? 'linux-rpm' : 'linux-deb';
  if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues && sys.startsWith('macos')) {
    navigator.userAgentData.getHighEntropyValues(['architecture']).then(v => { if (v.architecture === 'x86') sys = 'macos-x86_64'; }).catch(() => {});
  }
  let pack = null;  // {id, name} the visitor wanted, or null
  const link = () => pack ? 'sushila://install-pack/' + encodeURIComponent(pack.id) : 'sushila://open';
  const STEPS = {
    'windows-x86_64': ['Click <b>Download</b> above. The installer is a few megabytes.', 'Open the downloaded file: click it in your browser\\'s download bar or <b>Downloads</b> list.',
      'If Windows shows <i>“Windows protected your PC”</i>, click <b>More info</b> → <b>Run anyway</b>. (This appears only until the installer has built a download reputation.)',
      'Choose <b>Only for me</b> (no administrator password) → <b>Next</b> → <b>Install</b> → <b>Finish</b>.', 'Sushila Host Station opens by itself, and it is in the Start menu from now on.'],
    'macos-aarch64': ['Click <b>Download</b> above.', 'Open the downloaded <b>.dmg</b> file.', 'Drag <b>Sushila Host Station</b> onto the <b>Applications</b> folder.',
      'Open it from <b>Launchpad</b> or <b>Applications</b>. If macOS asks <i>“Are you sure you want to open it?”</i>, click <b>Open</b>.'],
    'linux-deb': ['Click <b>Download</b> above (the .deb file).', 'Double-click it; <b>Software</b> opens. Click <b>Install</b> and enter your password.', 'Open <b>Sushila Host Station</b> from your applications menu.'],
    'linux-rpm': ['Click <b>Download</b> above (the .rpm file).', 'Double-click it; <b>Software</b> opens. Click <b>Install</b>.', 'Open <b>Sushila Host Station</b> from your applications menu.'],
    'linux-appimage': ['Click <b>Download</b> above (the .AppImage file).', 'Right-click the file → <b>Properties</b> → <b>Permissions</b> → tick <b>Allow executing file as program</b>.', 'Double-click the file to start Sushila Host Station.'],
  };
  STEPS['macos-x86_64'] = STEPS['macos-aarch64'];
  const fileFor = (k) => APP.files.find(f => f.platform === k);
  const gb = (b) => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB';

  function ask() {
    body.innerHTML = '<h2 id="hswiz-t">Did Sushila Host Station open?</h2>' +
      '<p>' + (pack ? 'To install <b>' + E(pack.name) + '</b>, this website hands it to the free <b>Sushila Host Station</b> app on your computer.' : 'Sushila Host Station is the free app that runs model packs on your computer.') +
      ' If your browser asked to open it, choose <b>Open</b>.</p>' +
      '<div class="bar"><button class="btn ghost" data-a="close">Yes, it opened</button><button class="btn big" data-a="download">No: install Host Station first</button></div>';
  }
  function download() {
    const f = fileFor(sys);
    body.innerHTML = '<h2 id="hswiz-t">Step 1 of 3 · Download Sushila Host Station</h2><p>Your system:</p><div class="os">' +
      Object.entries(SYSTEMS).map(([k, v]) => '<button data-sys="' + k + '" aria-pressed="' + (k === sys) + '">' + E(v) + '</button>').join('') + '</div>' +
      (f ? '<p><button class="btn big" data-a="fetch">Download for ' + E(SYSTEMS[sys]) + '</button> <span class="sub">' + gb(f.bytes || 0) + ' · version ' + E(APP.version) + '</span></p>' +
           '<div id="hswiz-dl"></div><p class="sub">sha256 ' + E(f.sha256) + ' · <a href="/hoststation/download/' + E(sys) + '">download directly instead</a></p>' +
           '<div class="bar"><button class="btn ghost" data-a="ask">Back</button><button class="btn" data-a="install">I downloaded it: next</button></div>'
         : '<div class="note" style="border:1px solid var(--line);border-radius:10px;padding:12px;margin:10px 0"><b>Not published yet.</b> The Host Station installer for ' + E(SYSTEMS[sys]) +
           ' is still being built and code-signed, so there is nothing to download today. Leave your e-mail and we will tell you the day it is ready, or use the manual install meanwhile.</div>' +
           '<div class="bar" style="justify-content:flex-start"><input type="email" id="hswiz-email" placeholder="you@example.com" style="flex:1;min-width:200px"><button class="btn" data-a="notify">Email me when it is ready</button></div>' +
           '<div class="sub" id="hswiz-nmsg"></div>' +
           '<div class="bar"><button class="btn ghost" data-a="ask">Back</button><a class="btn ghost" href="/manual">Use the manual install</a><button class="btn ghost" data-a="close">Close</button></div>');
  }
  function install() {
    body.innerHTML = '<h2 id="hswiz-t">Step 2 of 3 · Install it</h2><ol class="steps">' + STEPS[sys].map(s => '<li>' + s + '</li>').join('') + '</ol>' +
      '<p class="sub">Everything Host Station installs is signed by Sushila and checked before use. Model packs contain only data, never programs.</p>' +
      '<div class="bar"><button class="btn ghost" data-a="download">Back</button><button class="btn big" data-a="' + (pack ? 'done' : 'choose') + '">Host Station is open: next</button></div>';
  }
  function welcome() {
    body.innerHTML = '<h2 id="hswiz-t">Run AI models on your own computer, free</h2>' +
      '<p>Three steps, mostly clicks:</p><ol class="steps"><li><b>Download</b> Sushila Host Station, the free app for Windows, Mac and Linux.</li>' +
      '<li><b>Install</b> it: open the download and click through.</li><li><b>Choose a model pack</b>: Host Station installs it and opens a chat page in your browser.</li></ol>' +
      '<p class="sub">Text models (LLMs) are ready now; music packs are coming soon. Everything runs on your computer: free, private, and offline once installed.</p>' +
      '<div class="bar"><button class="btn ghost" data-a="close">Not now</button><button class="btn ghost" data-a="choose">I already have Host Station</button><button class="btn big" data-a="download">Start</button></div>';
  }
  function choose() {
    const cats = [...new Set(APP.packs.map(p => p.category))];
    body.innerHTML = '<h2 id="hswiz-t">Step 3 of 3 · Which model pack do you want?</h2>' +
      (APP.packs.length ? cats.map(c => '<div class="cat">' + E(c) + '</div>' + APP.packs.filter(p => p.category === c).map(p =>
        '<button class="pk" data-pick="' + E(p.id) + '" aria-pressed="' + (pack && pack.id === p.id) + '"><b>' + E(p.name) + '</b><span class="sub">' + E(p.description) + '</span><br><span class="sub">' +
        gb(p.bytes) + (p.minRamGB ? ' · needs ' + p.minRamGB + ' GB memory' : '') + ' · ' + E(p.license) + '</span></button>').join('')).join('') +
        '<div class="cat">Music</div><p class="sub">Music packs are coming soon.</p>'
        : '<p class="note">The pack list is unavailable right now; Host Station shows every pack in its Model Packs tab.</p>') +
      '<div class="bar"><button class="btn ghost" data-a="install">Back</button>' + (APP.packs.length ? '' : '<a class="btn" href="sushila://open" data-a="sent">Open Host Station</a>') + '</div>';
  }
  function done() {
    body.innerHTML = '<h2 id="hswiz-t">' + (pack ? 'Install ' + E(pack.name) : 'Ready') + '</h2>' +
      (pack ? '<p>Click the button. Host Station shows the pack, its size and license, and asks you to confirm. It installs the Sushila.cpp engine first if needed, then the pack.</p>'
            : '<p>In Host Station, follow the four steps on its Home screen: install Sushila.cpp, add a model pack, start it, and open the chat page.</p>') +
      '<div class="bar"><button class="btn ghost" data-a="' + (APP.packs.length ? 'choose' : 'close') + '">' + (APP.packs.length ? 'Pick another pack' : 'Close') + '</button><a class="btn big" href="' + E(link()) + '" data-a="sent">' + (pack ? 'Install ' + E(pack.name) + ' in Host Station' : 'Open Host Station') + '</a></div>';
  }
  const views = { ask, welcome, download, install, choose, done };
  body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-a],[data-sys],[data-pick]'); if (!t) return;
    if (t.dataset.sys) { sys = t.dataset.sys; download(); return; }
    if (t.dataset.pick) { const p = APP.packs.find(x => x.id === t.dataset.pick); pack = { id: p.id, name: p.name }; store.set('hs-has-app', '1'); done(); return; }
    const a = t.dataset.a;
    if (a === 'close') { if (t.textContent.startsWith('Yes')) store.set('hs-has-app', '1'); dlg.close(); return; }
    if (a === 'fetch') { const f = fileFor(sys); DL.start({ id: sys, name: f.file, url: '/hoststation/download/' + sys, bytes: f.bytes, label: 'Sushila Host Station for ' + SYSTEMS[sys], onDone: () => { if (dlg.open) install(); } }); return; }
    if (a === 'notify') {
      const email = (document.getElementById('hswiz-email').value || '').trim(), m = document.getElementById('hswiz-nmsg');
      fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, model: 'hoststation-installer:' + sys }) })
        .then(r => r.json()).then(j => { if (j.mailto) location.href = j.mailto; m.textContent = j.ok ? 'Thanks. We will e-mail you when the installer is ready.' : (j.error || 'Something went wrong.'); })
        .catch(() => { m.textContent = 'Network error. Please try again.'; });
      return;
    }
    if (a === 'sent') { store.set('hs-has-app', '1'); setTimeout(() => dlg.close(), 600); return; }
    if (a === 'done') store.set('hs-has-app', '1');
    e.preventDefault(); (views[a] || ask)();
  });
  // ---------- downloads on this page: progress, pause / resume (HTTP Range), cancel; saved when complete
  const DL = (function () {
    const items = {};
    const fab = document.createElement('button'); fab.className = 'btn hsdl-fab'; fab.hidden = true;
    const panel = document.createElement('div'); panel.className = 'hsdl-panel'; panel.hidden = true;
    document.body.append(fab, panel);
    fab.addEventListener('click', () => { panel.hidden = !panel.hidden; draw(); });
    const fmt = (d) => {
      const pct = d.total ? (100 * d.done / d.total).toFixed(0) + '%' : '';
      const left = d.state === 'running' && d.rate > 0 && d.total ? (d.total - d.done) / d.rate : 0;
      return [pct, gb(d.done) + (d.total ? ' of ' + gb(d.total) : ''), d.state === 'running' ? (d.rate ? (d.rate / 1e6).toFixed(1) + ' MB/s' : 'starting…') : d.state,
        left ? (left > 60 ? Math.round(left / 60) + ' min left' : Math.round(left) + ' s left') : ''].filter(Boolean).join(' · ');
    };
    function row(d) {
      return '<div class="hsdl-item" data-id="' + E(d.id) + '"><b>' + E(d.label) + '</b><div class="hsdl-bar"><i style="width:' + (d.total ? (100 * d.done / d.total).toFixed(1) : 0) + '%"></i></div>' +
        '<div class="hsdl-row"><span class="sub">' + E(fmt(d)) + '</span>' +
        (d.state === 'running' ? '<button class="btn small ghost" data-dl="pause">Pause</button>' : d.state === 'paused' || d.state === 'failed' ? '<button class="btn small" data-dl="resume">Resume</button>' : '') +
        (d.state !== 'done' ? '<button class="btn small ghost" data-dl="cancel">Cancel</button>' : '<button class="btn small" data-dl="save">Save again</button>') + '</div></div>';
    }
    function draw() {
      const list = Object.values(items), active = list.filter(d => d.state !== 'done').length;
      fab.hidden = !list.length; fab.textContent = 'Downloads' + (active ? ' (' + active + ')' : '');
      panel.innerHTML = '<div class="hsdl-row" style="margin-bottom:6px"><b style="flex:1">Downloads</b><button class="btn small ghost" data-dl="close">Close</button></div>' +
        (list.length ? list.map(row).join('') : '<p class="sub">Nothing is downloading.</p>');
      const w = document.getElementById('hswiz-dl'); if (w) w.innerHTML = list.filter(d => d.state !== 'done').map(row).join('');
    }
    async function run(d) {
      d.state = 'running'; d.ctrl = new AbortController(); d.t = Date.now(); d.at = d.done; draw();
      try {
        const r = await fetch(d.url, { signal: d.ctrl.signal, headers: d.done ? { range: 'bytes=' + d.done + '-' } : {} });
        if (!r.ok) throw new Error(r.status === 404 ? 'not published yet' : 'HTTP ' + r.status);
        if (d.done && r.status !== 206) { d.chunks = []; d.done = 0; }  // the server ignored the range: start over
        const rd = r.body.getReader();
        for (;;) {
          const { done, value } = await rd.read(); if (done) break;
          d.chunks.push(value); d.done += value.length;
          const now = Date.now(); if (now - d.t > 800) { d.rate = (d.done - d.at) / ((now - d.t) / 1000); d.t = now; d.at = d.done; draw(); }
        }
        d.state = 'done'; d.blob = new Blob(d.chunks, { type: 'application/octet-stream' }); d.chunks = []; save(d); draw();
        if (d.onDone) d.onDone();
      } catch (e) {
        if (e.name === 'AbortError') { if (d.state === 'cancelled') { delete items[d.id]; } draw(); return; }
        d.state = 'failed'; d.error = String(e.message || e); draw();
      }
    }
    function save(d) { const a = document.createElement('a'); a.href = URL.createObjectURL(d.blob); a.download = d.name; document.body.append(a); a.click(); a.remove(); }
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dl]'); if (!b) return;
      const act = b.dataset.dl; if (act === 'close') { panel.hidden = true; return; }
      const d = items[b.closest('.hsdl-item').dataset.id]; if (!d) return;
      if (act === 'pause' && d.state === 'running') { d.state = 'paused'; d.ctrl.abort(); }
      else if (act === 'resume') run(d);
      else if (act === 'cancel' && confirm('Cancel this download?')) { if (d.state === 'running') { d.state = 'cancelled'; d.ctrl.abort(); } else { delete items[d.id]; } }
      else if (act === 'save') save(d);
      draw();
    });
    return { start(o) { if (items[o.id] && items[o.id].state !== 'cancelled') { panel.hidden = false; draw(); return; } items[o.id] = Object.assign({ done: 0, total: o.bytes || 0, chunks: [], rate: 0 }, o); run(items[o.id]); }, items };
  })();
  window.hsDownloads = DL;

  window.hsWizard = (p, start) => { pack = p; (views[start] || ask)(); if (!dlg.open) dlg.showModal(); };
  // "Install in Host Station": try the app; when nothing takes the link, open the wizard
  document.querySelectorAll('.hsinstall').forEach(a => a.addEventListener('click', () => {
    const p = { id: a.getAttribute('href').split('/').pop(), name: a.dataset.name };
    let left = false; const away = () => { left = true; };
    window.addEventListener('blur', away, { once: true }); document.addEventListener('visibilitychange', away, { once: true });
    setTimeout(() => { if (!left) window.hsWizard(p, 'ask'); }, 1800);
  }));
  document.querySelectorAll('.hsget').forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); window.hsWizard(null, b.dataset.start || 'download'); }));
})();
</script>`;
};

// --- .sushilapack: one file per model pack (a plain tar) --------------------------------------------------------------
// sushila-pack.json (the catalog entry: files with sha256, the Sushila-signed index) followed by every pack file at its
// install path. Streamed from B2 with an exact Content-Length, and resumable: a Range request starts at the right byte,
// even inside a file. Host Station installs it after checking the signature and every sha256.
function tarHeader(name, size) {
  const h = new Uint8Array(512), enc = new TextEncoder();
  const put = (off, len, str) => h.set(enc.encode(str).slice(0, len), off);
  let prefix = '';
  if (name.length > 100) { const i = name.lastIndexOf('/', 155); prefix = name.slice(0, i); name = name.slice(i + 1); }
  put(0, 100, name); put(100, 8, '0000644\0'); put(108, 8, '0000000\0'); put(116, 8, '0000000\0');
  if (size < 8589934592) put(124, 12, size.toString(8).padStart(11, '0') + '\0');
  else { h[124] = 0x80; let v = BigInt(size); for (let i = 135; i >= 125; i--) { h[i] = Number(v & 255n); v >>= 8n; } }  // GNU base-256: files over 8 GB
  put(136, 12, Math.floor(Date.UTC(2026, 0, 1) / 1000).toString(8).padStart(11, '0') + '\0');
  h[156] = 48;  // '0': regular file
  put(257, 6, 'ustar\0'); put(263, 2, '00'); put(345, 155, prefix);
  for (let i = 148; i < 156; i++) h[i] = 32;
  let sum = 0; for (const b of h) sum += b;
  put(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}
const pad512 = (n) => (512 - (n % 512)) % 512;

async function packLayout(env, b2, origin, id) {
  const cat = await hostCatalog(env, b2, origin);
  const p = cat.packs.find((x) => x.id === id);
  if (!p) return null;
  const meta = new TextEncoder().encode(JSON.stringify({ format: 1, id: p.id, name: p.name, kind: p.kind || 'text', category: p.category, license: p.license,
    licenseUrl: p.licenseUrl, description: p.description, artifacts: p.artifacts || [], serve: p.serve, minRamGB: p.minRamGB,
    files: p.files.map(({ path, src, role, bytes, sha256 }) => ({ path, src, role, bytes, sha256 })), index: p.index }, null, 1));
  const segs = [{ data: tarHeader('sushila-pack.json', meta.length) }, { data: meta }, { data: new Uint8Array(pad512(meta.length)) }];
  p.files.forEach((f, i) => {
    const d = hostCatalogCache.direct[`${p.id}/${i}`];
    segs.push({ data: tarHeader(f.path, f.bytes) }, { url: d.url, size: f.bytes }, { data: new Uint8Array(pad512(f.bytes)) });
  });
  segs.push({ data: new Uint8Array(1024) });
  let off = 0;
  for (const s of segs) { s.start = off; s.size = s.size ?? s.data.length; off += s.size; }
  return { pack: p, segs, total: off, file: `${p.id}.sushilapack` };
}

function packStream(layout, from) {
  const parts = layout.segs.filter((s) => s.start + s.size > from && s.size > 0);
  let i = 0, reader = null;
  return new ReadableStream({
    async pull(ctl) {
      for (;;) {
        if (reader) {
          const { done, value } = await reader.read();
          if (!done) { ctl.enqueue(value); return; }
          reader = null; i++;
          continue;
        }
        if (i >= parts.length) { ctl.close(); return; }
        const s = parts[i], skip = Math.max(0, from - s.start);
        if (s.data) { ctl.enqueue(skip ? s.data.slice(skip) : s.data); i++; return; }
        const r = await fetch(s.url, skip ? { headers: { range: `bytes=${skip}-` } } : {});
        if (!r.ok) { ctl.error(new Error('B2 ' + r.status)); return; }
        reader = r.body.getReader();
      }
    },
    cancel() { if (reader) reader.cancel(); },
  });
}

async function servePack(request, env, b2, db, ctx, origin, id) {
  const layout = await packLayout(env, b2, origin, id);
  if (!layout) return new Response('Not found', { status: 404, headers: SEC });
  const m = (request.headers.get('range') || '').match(/^bytes=(\d+)-$/);
  const from = m ? Math.min(+m[1], layout.total) : 0;
  ctx.waitUntil(logDownload(db, request, { file: layout.file, kind: 'pack', packId: id, bytes: layout.total }));
  const len = layout.total - from;
  let body = packStream(layout, from);
  if (typeof FixedLengthStream !== 'undefined') { const fl = new FixedLengthStream(len); body.pipeTo(fl.writable); body = fl.readable; }
  const h = { 'content-type': 'application/x-tar', 'content-disposition': `attachment; filename="${layout.file}"`, 'accept-ranges': 'bytes',
    'content-length': String(len), 'cache-control': 'no-store', ...SEC };
  if (from) h['content-range'] = `bytes ${from}-${layout.total - 1}/${layout.total}`;
  return new Response(body, { status: from ? 206 : 200, headers: h });
}

// --- Admin APIs (isAdmin on the user's row; set it with makeUserAdmin.py) ---
async function adminApi(request, env, db, user, path) {
  if (!user || !user.isAdmin) return json({ error: 'Admins only.' }, 403);
  const url = new URL(request.url);
  if (path.startsWith('/api/admin/compare/')) return await compareApi(request, env, db, new B2(env), user, path);
  if (path === '/api/admin/users' && request.method === 'GET') {
    const q = clean(url.searchParams.get('q'), 100).toLowerCase(), admins = url.searchParams.get('admins') === '1';
    const size = Math.min(Math.max(Number(url.searchParams.get('size')) || 25, 5), 100);
    let users = (await db.scanAll(TABLES.users)).map(userFrom);
    if (admins) users = users.filter((u) => u.isAdmin);
    if (q) users = users.filter((u) => [u.userId, u.firstName, u.lastName, u.organization, ...u.emails].join(' ').toLowerCase().includes(q));
    users.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const total = users.length, pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(Math.max(Number(url.searchParams.get('page')) || 1, 1), pages);
    const slice = users.slice((page - 1) * size, page * size);
    await Promise.all(slice.map(async (u) => {
      u.downloads = (await db.request('Query', { TableName: TABLES.downloads, KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': S(u.userId) }, Select: 'COUNT' })).Count || 0;
    }));
    return json({ total, page, pages, users: slice });
  }
  if (path === '/api/admin/models' && request.method === 'GET') {
    if (!(await db.scanAll(TABLES.models, { Limit: 1 }, 1)).length) {  // first visit: copy the built-in list into the table
      for (const m of builtin()) await db.put(TABLES.models, modelItem(m), 'attribute_not_exists(modelId)').catch(() => {});
    }
    const models = await catalog(db, true);
    await Promise.all(models.map(async (m) => {
      m.downloads = (await db.request('Query', { TableName: TABLES.downloads, IndexName: 'modelId-downloadedAt-index', KeyConditionExpression: 'modelId = :m',
        ExpressionAttributeValues: { ':m': S(m.modelId) }, Select: 'COUNT' }).catch(() => ({}))).Count || 0;
    }));
    return json({ models });
  }
  if (path === '/api/admin/models' && request.method === 'POST') {
    if (!sameOriginJson(request)) return json({ error: 'Bad request.' }, 400);
    let d; try { d = await body(request); } catch { return json({ error: 'Bad request.' }, 400); }
    const id = clean(d.modelId || (d.model && d.model.modelId), 80);
    if (!/^[a-z0-9][a-z0-9.\-]*$/.test(id)) return json({ error: 'Model id: lower-case letters, digits, dots and dashes.' }, 400);
    if (d.action === 'visible') {
      await db.update(TABLES.models, { modelId: S(id) }, 'SET visible = :v, updatedAt = :t', { ':v': { BOOL: !!d.visible }, ':t': S(new Date().toISOString()) });
      await audit(db, d.visible ? 'model-show' : 'model-hide', user.userId, request, { modelId: id });
      catalogCache = null;
      return json({ ok: true });
    }
    if (d.action === 'save') {
      const m = d.model || {};
      const model = { modelId: id, name: clean(m.name, 100), quant: clean(m.quant, 30), file: clean(m.file, 200), bytes: Number(m.bytes),
        sha256: clean(m.sha256, 64).toLowerCase(), license: clean(m.license, 100), licenseUrl: clean(m.licenseUrl, 300), hf: clean(m.hf, 300),
        artifacts: clean(m.artifacts, 300), note: clean(m.note, 200), order: Number(m.order) || 0, visible: !!m.visible };
      if (!model.name || !model.quant) return json({ error: 'Name and quantization are required.' }, 400);
      if (!/^[A-Za-z0-9._\-]+$/.test(model.file)) return json({ error: 'File name: letters, digits, dots, dashes and underscores.' }, 400);
      if (!(model.bytes > 0)) return json({ error: 'Size in bytes must be a positive number.' }, 400);
      if (!/^[0-9a-f]{64}$/.test(model.sha256)) return json({ error: 'sha256 must be 64 hex characters.' }, 400);
      if (!model.license || !/^https:\/\//.test(model.licenseUrl)) return json({ error: 'License and an https license URL are required.' }, 400);
      if (model.hf && !/^https:\/\//.test(model.hf)) return json({ error: 'Hugging Face URL must start with https://' }, 400);
      try { await db.put(TABLES.models, modelItem(model), d.isNew ? 'attribute_not_exists(modelId)' : undefined); }
      catch (e) { if (e.type.includes('ConditionalCheckFailed')) return json({ error: 'A model with this id already exists. Use Edit.' }, 400); throw e; }
      await audit(db, d.isNew ? 'model-add' : 'model-edit', user.userId, request, { modelId: id });
      catalogCache = null;
      return json({ ok: true });
    }
  }
  return json({ error: 'Bad request.' }, 400);
}

// --- Downloads: signed-in users accept the model's license; each download is recorded, then sent straight to B2 ---
async function createDownload(request, env, db, b2, session) {
  if (!sameOriginJson(request)) return json({ error: 'Bad request.' }, 400);
  if (!session) return json({ error: 'Please sign in to download.', signin: true }, 401);
  if (limited(request, 'download', 30)) return json({ error: 'Too many requests. Please wait a minute.' }, 429);
  let d; try { d = await body(request); } catch { return json({ error: 'Bad request.' }, 400); }
  const user = await loadUser(db, session);
  if (!user) return json({ error: 'Please sign in to download.', signin: true }, 401);
  const m = (await catalog(db)).find((x) => x.file === d.file && (x.visible || user.isAdmin));
  if (!m) return json({ error: 'Unknown file.' }, 404);
  if (d.accept !== true) return json({ error: 'Please accept the license first.' }, 400);
  if (!b2.configured) return json({ url: m.hf, external: true });
  const now = new Date().toISOString();
  await db.put(TABLES.downloads, { userId: S(user.userId), downloadedAt: S(`${now}#${randomId()}`), email: S(user.primaryEmail), modelId: S(m.modelId),
    modelName: S(`${m.name} ${m.quant}`), file: S(m.file), b2Key: S(b2ModelKey(m, m.file)), bytes: N(m.bytes), sha256: S(m.sha256),
    license: S(m.license), licenseAccepted: S(now), country: S((request.cf && request.cf.country) || '-') });
  await audit(db, 'download', user.userId, request, { file: m.file });
  await logDownload(db, request, { file: m.file, kind: 'model', bytes: m.bytes, userId: user.userId });
  return json({ url: await b2.signedUrl(b2ModelKey(m, m.file), B2_LINK_SECONDS, m.file) });
}

async function media(request, env, b2, file) {
  if (file !== VIDEO.key || !b2.configured) return new Response('Not found', { status: 404 });
  const r = await b2.fetchFile(B2_MEDIA_KEY, request);
  if (!r.ok && r.status !== 206) return new Response('Not found', { status: 404 });
  const h = new Headers(SEC);
  for (const k of ['content-length', 'content-range', 'etag', 'last-modified']) if (r.headers.get(k)) h.set(k, r.headers.get(k));
  h.set('content-type', VIDEO.type); h.set('accept-ranges', 'bytes'); h.set('cache-control', 'public, max-age=86400');
  return new Response(request.method === 'HEAD' ? null : r.body, { status: r.status, headers: h });
}

async function waitlist(request, env, db) {
  if (!sameOriginJson(request)) return json({ ok: false, error: 'Bad request.' }, 400);
  if (limited(request, 'waitlist', 10)) return json({ ok: false, error: 'Too many requests. Please wait a minute.' }, 429);
  let d; try { d = await body(request); } catch { return json({ ok: false, error: 'Invalid request.' }, 400); }
  const email = normEmail(d.email), model = clean(d.model, 300);
  if (!validEmail(email)) return json({ ok: false, error: 'Please enter a valid e-mail address.' }, 400);
  if (!db.configured) {
    const contact = env.CONTACT || DEFAULT_CONTACT;
    return json({ ok: true, mailto: `mailto:${contact}?subject=${encodeURIComponent('Sushila serverless API: early access')}&body=${encodeURIComponent(`Please add ${email} to the early-access list.${model ? `\nModels: ${model}` : ''}`)}` });
  }
  await db.put(TABLES.waitlist, { email: S(email), models: S(model || '-'), at: S(new Date().toISOString()), country: S((request.cf && request.cf.country) || '-') });
  return json({ ok: true });
}

// Short, safe error codes for users and the health check (details go to the worker log).
function errorCode(e) {
  const t = String((e && (e.type || e.message)) || '');
  if (/ResourceNotFound/.test(t)) return 'DB_TABLES_MISSING';
  if (/UnrecognizedClient|InvalidSignature|MissingAuthenticationToken|SignatureDoesNotMatch/.test(t)) return 'DB_CREDENTIALS';
  if (/AccessDenied/.test(t)) return 'DB_PERMISSIONS';
  if (/^Resend/.test(t)) return /\b403\b|domain/i.test(t) ? 'EMAIL_DOMAIN_NOT_VERIFIED' : 'EMAIL_SEND';
  if (/^B2/.test(t)) return 'STORAGE';
  if (/^DynamoDB/.test(t)) return 'DB_ERROR';
  return 'INTERNAL';
}

// GET /api/health: which services are configured and reachable (no secrets are returned).
async function health(env, db, b2) {
  const out = { session: !!env.SESSION_SECRET, resend: { key: !!env.RESEND_API_KEY, from: env.RESEND_FROM || null },
    dynamodb: { configured: db.configured, region: env.AWS_REGION || null, tables: {} }, b2: { configured: b2.configured, bucket: env.B2_BUCKET_NAME || null } };
  if (db.configured) {
    const keys = { users: { userId: S('-') }, emails: { email: S('-') }, otps: { email: S('-') }, downloads: { userId: S('-'), downloadedAt: S('-') },
      models: { modelId: S('-') }, bugs: { bugId: S('-'), item: S('-') }, waitlist: { email: S('-') }, audit: { day: S('-'), at: S('-') } };
    await Promise.all(Object.entries(TABLES).map(async ([k, t]) => {
      try { await db.get(t, keys[k]); out.dynamodb.tables[t] = 'ok'; } catch (e) { out.dynamodb.tables[t] = errorCode(e); }
    }));
  }
  if (b2.configured) { try { await b2.auth(); out.b2.reachable = true; } catch (e) { out.b2.reachable = false; out.b2.error = errorCode(e); } }
  const ok = out.session && out.resend.key && db.configured && Object.values(out.dynamodb.tables).every((v) => v === 'ok') && (!b2.configured || out.b2.reachable);
  return json({ ok, ...out }, ok ? 200 : 503);
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(reapComparePods(env).catch((e) => console.error('compare reaper', e.message))); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname, method = request.method;
    const db = new DynamoDB(env), b2 = new B2(env);
    const session = await readSession(request, env);
    const html = (b, extra = {}) => new Response(b, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': session ? 'private, no-store' : 'public, max-age=300', ...SEC, ...extra } });
    try {
      if (method === 'POST') {
        if (p === '/api/waitlist') return await waitlist(request, env, db);
        if (p === '/api/auth/send-code') return await sendCode(request, env, db, session);
        if (p === '/api/auth/verify-code') return await verifyCode(request, env, db, session);
        if (p === '/api/auth/sign-out') return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': clearCookie() } });
        if (p === '/api/account') return await account(request, env, db, session);
        if (p === '/api/download') return await createDownload(request, env, db, b2, session);
      if (p.startsWith('/api/admin/')) return await adminApi(request, env, db, await loadUser(db, session), p);
      if (p.startsWith('/api/bugs')) return await bugsApi(request, env, db, await loadUser(db, session), p);
        return new Response('Not found', { status: 404, headers: SEC });
      }
      if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      if (p === '/api/account') return await account(request, env, db, session);
      if (p === '/api/health') return await health(env, db, b2);
      const user = session ? await loadUser(db, session) : null;
      if (p.startsWith('/api/admin/')) return await adminApi(request, env, db, user, p);
      if (p.startsWith('/api/bugs')) return await bugsApi(request, env, db, user, p);
      if (p === '/bugs' || p === '/bugs/' || p === '/bugs/new' || p.startsWith('/bugs/')) {
        if (!user) return Response.redirect(`${url.origin}/signin?next=${encodeURIComponent(p + url.search)}`, 302);
        if (p === '/bugs' || p === '/bugs/') return html(docPage(env, 'Bug reports', 'Your sushila.ai bug reports.', BUGS(user), user));
        if (p === '/bugs/new') return html(docPage(env, 'Report a bug', 'Report a bug in Sushila.cpp or sushila.ai.', BUG_NEW(url), user));
        const id = decodeURIComponent(p.slice('/bugs/'.length));
        if (!/^[A-Za-z0-9-]{4,40}$/.test(id)) return new Response('Not found', { status: 404, headers: SEC });
        return html(docPage(env, 'Bug report', 'A sushila.ai bug report.', BUG_VIEW(user, id), user));
      }
      if (p === '/admin' || p === '/admin/') {
        if (!user) return Response.redirect(`${url.origin}/signin?next=/admin`, 302);
        if (!user.isAdmin) return new Response('Admins only.', { status: 403, headers: SEC });
        return html(docPage(env, 'Admin', 'sushila.ai administration.', ADMIN(), user));
      }
      if (p === '/' || p === '/index.html') {
        let packs = [], app = null;
        try { if (b2.configured) [packs, app] = await Promise.all([hostCatalog(env, b2, url.origin).then((c) => c.packs), hostApp(env, b2)]); } catch (e) { console.error('packs', e.message); }
        return html(page(env, user, await visibleModels(db), packs, app));
      }
      if (p.startsWith('/hoststation/pack/') && p.endsWith('.sushilapack')) {
        if (!b2.configured) return new Response('Not available.', { status: 503, headers: SEC });
        return await servePack(request, env, b2, db, ctx, url.origin, decodeURIComponent(p.slice('/hoststation/pack/'.length, -'.sushilapack'.length)));
      }
      if (p.startsWith('/hoststation/get/')) {  // a pack file, engine build or runtime file: count it, then hand over to files.sushila.ai/public/
        if (!b2.configured) return new Response('Not available.', { status: 503, headers: SEC });
        await hostCatalog(env, b2, url.origin);
        const key = decodeURIComponent(p.slice('/hoststation/get/'.length));
        const d = hostCatalogCache && hostCatalogCache.direct[key];
        if (!d) return new Response('Not found', { status: 404, headers: SEC });
        const [first] = key.split('/');
        ctx.waitUntil(logDownload(db, request, { file: d.file, kind: first === 'engine' || first === 'runtime' ? first : 'pack', packId: first === 'engine' || first === 'runtime' ? '' : first, bytes: d.bytes }));
        if (d.github && url.searchParams.get('from') !== 'b2') {  // released files: served from GitHub Releases (counted there), B2 if GitHub fails
          const r = await fromGithub(env, d, request, d.file);
          if (r) return r;
        }
        // streamed through sushila.ai from files.sushila.ai/public/ (every app version downloads from sushila.ai; Range passes
        // through, so downloads resume)
        const h = {}; if (request.headers.get('range')) h.range = request.headers.get('range');
        const r = await fetch(d.url, { headers: h });
        if (!(r.status === 200 || r.status === 206)) return new Response('Not available right now.', { status: 502, headers: SEC });
        const out = new Headers({ 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${String(d.file).replace(/"/g, '')}"`,
          'accept-ranges': 'bytes', 'cache-control': 'no-store', ...SEC });
        for (const k of ['content-length', 'content-range']) if (r.headers.get(k)) out.set(k, r.headers.get(k));
        return new Response(r.body, { status: r.status, headers: out });
      }
      if (p.startsWith('/hoststation/download/')) {
        const rest = p.slice('/hoststation/download/'.length).split('/');
        const product = ({ 'image-generator': 'imagegen', 'music-generator': 'musicgen' })[rest[0]] || (rest.length > 1 ? rest[0] : 'host-station'), platform = rest[rest.length - 1];
        const app = b2.configured ? await hostApp(env, b2).catch(() => null) : null;
        const f = app && app.files.find((x) => x.platform === platform && (x.product || 'host-station') === product);
        if (!f) return new Response('No installer is published for this system yet.', { status: 404, headers: SEC });
        ctx.waitUntil(logDownload(db, request, { file: f.file, kind: 'installer', system: platform, bytes: f.bytes }));
        if (f.github && url.searchParams.get('from') !== 'b2') {  // the GitHub release copy (counted there); the B2 copy if GitHub fails
          const g = await fromGithub(env, f, request, f.file, f.sha256);
          if (g) return g;
        }
        const h = {}; if (request.headers.get('range')) h.range = request.headers.get('range');
        const r = await fetch(f.url, { headers: h });
        const out = new Headers({ 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${f.file.replace(/"/g, '')}"`,
          'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-sha256': f.sha256, ...SEC });
        for (const k of ['content-length', 'content-range']) if (r.headers.get(k)) out.set(k, r.headers.get(k));
        return new Response(r.body, { status: r.status, headers: out });
      }
      if (p === '/manual' || p === '/manual/') return html(page(env, user, await visibleModels(db), [], null, 'manual'));
      if (p === '/docs' || p === '/docs/') return new Response(SUSHILA_DOCS_HTML.replaceAll('href="/"', 'href="http://localhost:8765/"').replaceAll('href="/#admin"', 'href="http://localhost:8765/#admin"'), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });  // the same page sushila serves at /docs; Use/Admin point to the visitor's own Sushila
      if (p === '/hoststation' || p === '/hoststation/') {
        let app = null;
        try { if (b2.configured) app = await hostApp(env, b2); } catch (e) { console.error('hostApp', e.message); }
        let hpacks = [];
        try { if (b2.configured) hpacks = (await hostCatalog(env, b2, url.origin)).packs; } catch (e) { console.error('packs', e.message); }
        return html(docPage(env, 'Sushila Host Station', 'Install Sushila.cpp and model packs with a few clicks, and run models on your own computer.', HOSTSTATION(env, app, hpacks), user));
      }
      if (p === '/terms' || p === '/terms/') return html(docPage(env, 'Terms of Service', 'Terms of Service for sushila.ai, Sushila.cpp and the Sushila serverless API.', TERMS(env), user));
      if (p === '/privacy' || p === '/privacy/') return html(docPage(env, 'Privacy Policy', 'How the Sushila project handles personal data on sushila.ai and the Sushila serverless API.', PRIVACY(env), user));
      if (p === '/signin' || p === '/signin/') return html(docPage(env, 'Sign in', 'Sign in to sushila.ai with a one-time code sent to your e-mail.', SIGNIN(url), user));
      if (p === '/account' || p === '/account/') {
        if (!user) return Response.redirect(`${url.origin}/signin?next=/account`, 302);
        return html(docPage(env, 'Your account', 'Your sushila.ai account.', ACCOUNT(user), user));
      }
      if (p.startsWith('/download/')) {
        const m = (await catalog(db)).find((x) => x.file === decodeURIComponent(p.slice('/download/'.length)) && (x.visible || (user && user.isAdmin)));
        if (!m) return new Response('Not found', { status: 404, headers: SEC });
        if (!user) return Response.redirect(`${url.origin}/signin?next=${encodeURIComponent(p)}`, 302);
        return html(docPage(env, `Download ${m.name} ${m.quant}`, 'Download a model file.', DOWNLOAD(m), user));
      }
      if (p === '/hoststation/catalog.json') {
        if (!b2.configured) return json({ version: 1, engine: null, packs: [], error: 'catalog unavailable' }, 503);
        return json(await hostCatalog(env, b2, url.origin), 200, { 'access-control-allow-origin': '*' });
      }
      if (p === '/models.json') {
        return json({
          hosted: (await visibleModels(db)).map(({ modelId, name, quant, file, bytes, sha256, license, hf, artifacts }) =>
            ({ id: modelId, name, quant, bytes, sha256, license, artifacts, url: `${url.origin}/download/${file}`, b2Key: `models/${modelId}/${file}`, source: hf })),
          huggingface: LISTED,
        });
      }
      if (p.startsWith('/media/')) return await media(request, env, b2, decodeURIComponent(p.slice('/media/'.length)));
      if (IMAGES[p]) {
        const bytes = Uint8Array.from(atob(IMAGES[p]), (c) => c.charCodeAt(0));
        return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' } });
      }
      if (p === '/robots.txt') return new Response('User-agent: *\nAllow: /\nDisallow: /download/\nDisallow: /account\nDisallow: /admin\nDisallow: /bugs\nDisallow: /api/\n', { headers: { 'content-type': 'text/plain' } });
      return new Response('Not found', { status: 404, headers: SEC });
    } catch (e) {
      console.error(p, e && e.stack || e);
      const code = errorCode(e);
      return p.startsWith('/api/') ? json({ error: `Something went wrong (${code}). Please try again later.`, code }, 500)
        : new Response(`Something went wrong (${code}). Please try again later.`, { status: 500, headers: SEC });
    }
  },
};

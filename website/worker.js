/**
 * sushila.ai — single-file Cloudflare Worker front end for Sushila.cpp.
 *
 * Routes
 *   GET  /                    the site (what Sushila.cpp does, downloads, models, serverless API)
 *   GET  /models.json         the model list as JSON
 *   GET  /download/<file>     a model file we host (streamed from the R2 bucket bound as MODELS)
 *   POST /api/waitlist        serverless-API early-access sign-up (stored in the KV namespace bound as WAITLIST)
 *   GET  /terms, /privacy     Terms of Service and Privacy Policy
 *   GET  /favicon.svg, /robots.txt
 *
 * Optional bindings and variables (Workers dashboard or wrangler.toml); the site works without any of them:
 *   MODELS    R2 bucket holding the hosted .gguf files under the key given in HOSTED[].file. Without it,
 *             hosted downloads fall back to the public source (Hugging Face).
 *   WAITLIST  KV namespace for sign-ups. Without it, the form falls back to e-mail.
 *   RELEASED  "true" once the Sushila.cpp repository is public; until then the download buttons say "with the paper".
 *   CONTACT   contact e-mail (default below).
 *   GOVERNING_LAW  governing law for the Terms, e.g. "the State of Delaware, USA" (confirm with counsel).
 *
 * Deploy: npx wrangler deploy worker.js --name sushila --compatibility-date 2026-10-01
 */

const REPO = 'https://github.com/syncaissa/sushila.cpp';
const DEFAULT_CONTACT = 'syncaissa@outlook.com';

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
  { id: 'qwen3-30b-a3b-q4km', name: 'Qwen3 30B-A3B (MoE)', quant: 'Q4_K_M', file: 'qwen3-30b-a3b-q4_k_m.gguf', bytes: 18556685856,
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

// Measured speedups (paper, Table "Speed at a glance"); same output as the stock engine unless marked.
const RESULTS = [
  ['Llama 3.3 70B, 4-bit', 'A100, SGLang', '34.3', '80.4', '2.51×', 'day-0 draft head on EAGLE-3 trees'],
  ['Llama 3.1 70B, 4-bit', 'A100, llama.cpp', '22.1', '58.9', '2.66×', '1B draft model, chosen on day 0'],
  ['Llama 3.1 70B, 4-bit', 'CPU, 30 threads', '2.73', '6.22', '2.28×', '1B draft model, chosen on day 0'],
  ['Llama 3.1 8B, 16-bit', 'A100, SGLang', '89.5', '193', '2.29×', 'day-0 draft head on EAGLE-3 trees'],
  ['Llama 3.1 8B, 4-bit', 'A100, llama.cpp', '153', '199', '1.30×', 'day-0 head, tree verification, kernel setting'],
  ['Llama 3.1 8B, 4-bit', 'CPU, 30 threads', '19.9', '24.0', '1.21×', 'day-0 head with a landscape inside it'],
  ['Qwen2.5 0.5B, 4-bit', 'CPU, 8 threads', '145.5', '183.3', '1.26×', 'output-layer landscape'],
];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = (b) => (b / 1e9).toFixed(b < 1e10 ? 1 : 0) + ' GB';

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f766e"/><path d="M42 20c-3-3-7-4-11-4-7 0-12 4-12 10 0 13 25 7 25 19 0 6-6 9-12 9-5 0-9-2-12-5" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/></svg>`;

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
nav .links{margin-left:auto;display:flex;gap:18px;font-size:15px}
nav .links a{color:var(--mut);text-decoration:none}
nav .links a:hover{color:var(--fg)}
.hero{padding:64px 0 40px}
.hero h1{font-size:clamp(30px,5vw,48px);line-height:1.15;margin:0 0 16px;letter-spacing:-.02em}
.hero p{font-size:19px;color:var(--mut);max-width:680px;margin:0 0 28px}
.btn{display:inline-block;background:var(--acc);color:var(--bg);padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;border:0;font-size:15px;cursor:pointer}
.btn:hover{background:var(--acc2)}
.btn.ghost{background:transparent;color:var(--acc);border:1px solid var(--line)}
.btn.small{padding:6px 12px;font-size:14px}
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
@media (max-width:640px){nav .links{gap:12px;font-size:14px}nav .links .hide{display:none}.hero{padding:40px 0 28px}th,td{padding:8px 10px}}
.doc{max-width:760px;padding:40px 0 56px}
.doc h1{font-size:34px;margin:0 0 4px;letter-spacing:-.02em}
.doc h2{font-size:20px;margin:32px 0 8px}
.doc p,.doc li{color:var(--fg)}
.doc .meta{color:var(--mut);margin:0 0 24px}
`;

const brand = () => `<a class="brand" href="/">${FAVICON.replace('<svg ', '<svg width="26" height="26" ')} Sushila.cpp</a>`;

const footer = (contact) => `<footer><div class="wrap row" style="justify-content:space-between">
  <span>© ${new Date().getUTCFullYear()} Syncaissa Systems Inc.</span>
  <span><a href="/#disclaimer">Disclaimer</a> · <a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Policy</a> · <a href="mailto:${esc(contact)}">${esc(contact)}</a></span>
</div></footer>`;

function docPage(env, title, desc, body) {
  const contact = env.CONTACT || DEFAULT_CONTACT;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Sushila.cpp</title>
<meta name="description" content="${esc(desc)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
${STYLE}</style>
</head>
<body>
<header><div class="wrap"><nav>
  ${brand()}
  <div class="links"><a href="/">Home</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a></div>
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
const law = (env) => env.GOVERNING_LAW || 'the jurisdiction in which Syncaissa Systems Inc. is incorporated';

const TERMS = (env) => (contact) => `
<h1>Terms of Service</h1>
<p class="meta">Effective ${EFFECTIVE}</p>
<p>These Terms of Service ("Terms") govern your use of the sushila.ai website, the Sushila.cpp software and scripts, the model
files we host, and the Sushila serverless API (together, the "Services"), provided by Syncaissa Systems Inc. ("Syncaissa", "we",
"us"). By using the Services you agree to these Terms. If you use the Services for an organization, you agree on its behalf and
confirm that you may do so. If you do not agree, do not use the Services.</p>

<h2>1. The website and downloads are free</h2>
<p>The website, Sushila.cpp and the downloads are free of charge. Sushila.cpp is open-source software licensed under the MIT License;
that license, not these Terms, governs your rights to the source code. The model files are made by third parties (such as Meta and
Alibaba Cloud) and are governed by their own licenses and acceptable use policies, which you must read and follow. Llama models are
licensed under the applicable Llama Community License. "Built with Llama."</p>

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
<p>TO THE FULLEST EXTENT PERMITTED BY LAW, SYNCAISSA, ITS CONTRIBUTORS AND SUPPLIERS ARE NOT LIABLE FOR ANY INDIRECT, INCIDENTAL,
SPECIAL, CONSEQUENTIAL, EXEMPLARY OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF DATA, PROFITS, REVENUE OR BUSINESS, ARISING FROM OR RELATED
TO THE SERVICES, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. OUR TOTAL LIABILITY FOR ALL CLAIMS RELATED TO THE SERVICES IS
LIMITED TO THE GREATER OF (A) THE AMOUNTS YOU PAID US FOR THE SERVICES IN THE 12 MONTHS BEFORE THE CLAIM AND (B) US$100.</p>

<h2>8. Indemnity</h2>
<p>You will defend and indemnify Syncaissa against third-party claims, and the resulting losses and costs (including reasonable
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
<p>Syncaissa Systems Inc., <a href="mailto:${esc(contact)}">${esc(contact)}</a>.</p>
`;

const PRIVACY = (env) => (contact) => `
<h1>Privacy Policy</h1>
<p class="meta">Effective ${EFFECTIVE}</p>
<p>This policy explains what personal data Syncaissa Systems Inc. ("we") collects through sushila.ai, the model downloads and the
Sushila serverless API, why, and your choices. We collect as little as we can.</p>

<h2>1. What we collect</h2>
<ul>
<li><b>Early-access sign-up:</b> the e-mail address and the optional list of models you enter, the time of sign-up and the country
of your connection (derived by our hosting provider from your IP address). If you choose to e-mail us instead, we receive what you
send.</li>
<li><b>Requests to the website and downloads:</b> our hosting provider, Cloudflare, processes your IP address, browser user agent,
the pages and files requested and the time, to deliver the site, prevent abuse and keep it secure.</li>
<li><b>Serverless API (when you use it):</b> your account and billing details, API usage (such as token counts and times) for
billing and capacity, and the Inputs and Outputs needed to answer each request.</li>
</ul>
<p>The website uses no advertising, no tracking cookies and no third-party analytics scripts. Copying a checksum uses your browser's
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
Cloudflare (website hosting, storage and network), GPU cloud providers that run the API, a payment processor for billing, and e-mail
providers; with professional advisers; when the law requires it; or as part of a merger or sale of our business, under this policy.</p>

<h2>5. International transfers</h2>
<p>Our providers may process data in the United States and other countries. Where required, we use legal safeguards such as the
European Commission's Standard Contractual Clauses.</p>

<h2>6. How long we keep it</h2>
<p>Sign-up data is kept until you ask us to delete it or until early access ends and you have not become a customer, whichever is
first. API account and billing records are kept for as long as your account is open and then as long as tax and accounting laws
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
<p>Syncaissa Systems Inc., <a href="mailto:${esc(contact)}">${esc(contact)}</a>.</p>
`;

function page(env) {
  const released = String(env.RELEASED || '').toLowerCase() === 'true';
  const contact = env.CONTACT || DEFAULT_CONTACT;
  const dl = (path, label) => released
    ? `<a class="btn" href="${REPO}${path}">${label}</a>`
    : `<span class="btn off" title="The source is released together with the paper">${label} — with the paper</span>`;

  const hostedRows = HOSTED.map((m) => `
    <tr>
      <td><b>${esc(m.name)}</b>${m.tuned ? ' <span class="tag">day-0 tuned</span>' : ''}${m.note ? `<div class="sub">${esc(m.note)}</div>` : ''}</td>
      <td>${esc(m.quant)}</td>
      <td class="num">${gb(m.bytes)}</td>
      <td><a href="${esc(m.licenseUrl)}">${esc(m.license)}</a></td>
      <td class="act"><a class="btn small" href="/download/${esc(m.file)}">Download</a>
        <button class="copy" data-copy="${m.sha256}" title="Copy sha256">sha256</button></td>
    </tr>`).join('');

  const listedRows = LISTED.map((m) => `
    <tr><td><b>${esc(m.name)}</b></td><td>${esc(m.license)}</td>
      <td class="act"><a class="btn small ghost" href="${esc(m.hf)}">Hugging Face ↗</a></td></tr>`).join('');

  const resultRows = RESULTS.map((r) => `
    <tr><td>${r[0]}</td><td>${r[1]}</td><td class="num">${r[2]}</td><td class="num">${r[3]}</td>
      <td class="num"><b>${r[4]}</b></td><td class="sub">${r[5]}</td></tr>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sushila.cpp — faster LLM inference, same model files</title>
<meta name="description" content="Sushila.cpp: a llama.cpp-based engine that precomputes per-model artifacts once on release day so every token costs less. Same GGUF files, same output.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
${STYLE}</style>
</head>
<body>
<header><div class="wrap"><nav>
  ${brand()}
  <div class="links"><a href="#how">How</a><a href="#results" class="hide">Results</a><a href="#download">Download</a><a href="#models">Models</a><a href="#api">API</a></div>
</nav></div></header>

<main class="wrap">
<div class="hero">
  <h1>Faster LLM inference.<br>Same model files, same answers.</h1>
  <p>Sushila.cpp is a llama.cpp-based engine that does the expensive work once per model on release day,
  so every token you generate afterwards costs less. Open models run up to 2.66× faster on a GPU and 2.28× on a CPU,
  with exactly the output of the stock engine.</p>
  <div class="row">${dl('', 'Get Sushila.cpp')}<a class="btn ghost" href="#models">Download models</a><a class="btn ghost" href="#api">Serverless API</a></div>
</div>

<section id="how">
  <h2>What Sushila.cpp does</h2>
  <p class="lead">Decoding is limited by how many bytes of weights the hardware reads per token. Sushila
  (<b>S</b>elf-tuning <b>U</b>pstream <b>S</b>earch for <b>H</b>ybrid <b>I</b>nference in <b>L</b>LM <b>A</b>cceleration)
  computes small artifacts once per model so each token reads fewer bytes or the model runs fewer passes.</p>
  <div class="grid">
    <div class="card"><h3>Landscapes</h3><p>A precomputed map of each model's output layer: a cheap preview picks a short list of candidate tokens,
      which are then scored exactly. About 13–15% of the layer is read, with the same top token.</p></div>
    <div class="card"><h3>Day-0 draft heads</h3><p>A small head fitted on the model's own answers proposes several tokens; the full model checks them all
      in one pass. Accepted tokens are exactly what the model would have produced.</p></div>
    <div class="card"><h3>Landscape hunt</h3><p>Each model gets the stack that suits it. New models first try the existing landscapes,
      and a new one is searched for only if none fits.</p></div>
    <div class="card"><h3>Kernels</h3><p>Tree verification in llama.cpp and a tuned GPU kernel switch make checking 5–8 drafted tokens 18–38% cheaper.</p></div>
  </div>
  <p class="note">Sushila.cpp also uses established methods, including EAGLE-3 draft heads, small draft models and fast 4-bit kernels,
  and combines them with its own. The paper credits each method and reports how much it adds.</p>
</section>

<section id="results">
  <h2>Measured speed</h2>
  <p class="lead">Tokens per second, greedy decoding, compared with the stock engine on the same hardware and model file.</p>
  <div class="tablewrap"><table>
    <thead><tr><th>Model</th><th>Hardware, engine</th><th class="num">Stock</th><th class="num">Sushila</th><th class="num">Speedup</th><th>How</th></tr></thead>
    <tbody>${resultRows}</tbody>
  </table></div>
  <p class="note">The output is identical to the stock engine in every row. The full method, scripts and raw logs are in the repository.</p>
</section>

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
  Full guide: <a href="${REPO}/blob/main/INSTALL.md">INSTALL.md</a>. Provided as is, without warranty (<a href="#disclaimer">disclaimer</a>).</p>
</section>

<section id="models">
  <h2>Models</h2>
  <p class="lead">We host these files ourselves. Each is byte-identical to the public release, so check its sha256 after you download it.
  Models tagged <span class="tag">day-0 tuned</span> come with measured Sushila artifacts.</p>
  <div class="tablewrap"><table>
    <thead><tr><th>Model</th><th>Quant</th><th class="num">Size</th><th>License</th><th></th></tr></thead>
    <tbody>${hostedRows}</tbody>
  </table></div>
  <p class="note">Downloads are provided as is, with no warranty; you assume all risks of use (see the <a href="#disclaimer">disclaimer</a>).</p>
  <p class="note">Built with Llama. The Llama models are distributed under their community licenses and Meta's acceptable use policy.</p>

  <h3 style="margin:32px 0 6px">More models: download from Hugging Face</h3>
  <p class="lead" style="margin-bottom:16px">Any GGUF model runs with Sushila.cpp. Download these directly from their publishers.</p>
  <div class="tablewrap"><table>
    <thead><tr><th>Model</th><th>License</th><th></th></tr></thead>
    <tbody>${listedRows}</tbody>
  </table></div>
</section>

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
  <p><b>Use at your own risk.</b> Sushila.cpp, the model files, scripts, benchmarks, the serverless API and everything else on this
  website are provided <b>"as is" and "as available", without warranty of any kind</b>, express or implied. This includes, without
  limitation, any warranty of merchantability, fitness for a particular purpose, accuracy, reliability, availability, security or
  non-infringement. No warranty is implied or given by anything on this website or in any communication from Syncaissa Systems Inc.</p>
  <p>By downloading or using any of it, you <b>assume all risks</b> of that use, including the risk of incorrect, harmful or offensive
  model output, data loss, hardware or system damage, security issues and costs. You are responsible for checking what the
  software and models produce before you rely on it, and for complying with each model's license and acceptable use policy.</p>
  <p>To the fullest extent permitted by law, Syncaissa Systems Inc., its contributors and its suppliers are not liable for any direct,
  indirect, incidental, special, consequential or punitive damages, or any loss of data, profits or business, arising from or related
  to the use of, or inability to use, anything provided here, even if advised of the possibility of such damages.</p>
  <p>Speed figures are measurements on specific hardware and settings; your results may differ. Models are made by third parties
  and are governed by their own licenses; Syncaissa does not endorse or take responsibility for their content. Some jurisdictions do
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

const SEC = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 1), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...SEC } });
}

async function download(request, env, file) {
  const m = HOSTED.find((x) => x.file === file);
  if (!m) return new Response('Not found', { status: 404 });
  if (!env.MODELS) return Response.redirect(m.hf, 302); // no bucket bound: send users to the public source
  const range = request.headers.get('range');
  const obj = await env.MODELS.get(m.file, range ? { range: request.headers } : {});
  if (!obj) return Response.redirect(m.hf, 302);
  const h = new Headers(SEC);
  obj.writeHttpMetadata(h);
  h.set('content-type', 'application/octet-stream');
  h.set('content-disposition', `attachment; filename="${m.file}"`);
  h.set('accept-ranges', 'bytes');
  h.set('etag', obj.httpEtag);
  h.set('x-sha256', m.sha256);
  h.set('cache-control', 'public, max-age=86400');
  if (range && obj.range) {
    const off = obj.range.offset ?? 0;
    const len = obj.range.length ?? obj.size - off;
    h.set('content-range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    h.set('content-length', String(len));
    return new Response(request.method === 'HEAD' ? null : obj.body, { status: 206, headers: h });
  }
  h.set('content-length', String(obj.size));
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers: h });
}

async function waitlist(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid request.' }, 400); }
  const email = String(body.email || '').trim().slice(0, 200);
  const model = String(body.model || '').trim().slice(0, 300);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: 'Please enter a valid e-mail address.' }, 400);
  const contact = env.CONTACT || DEFAULT_CONTACT;
  if (!env.WAITLIST) {
    const subject = encodeURIComponent('Sushila serverless API: early access');
    const text = encodeURIComponent(`Please add ${email} to the early-access list.${model ? `\nModels: ${model}` : ''}`);
    return json({ ok: true, mailto: `mailto:${contact}?subject=${subject}&body=${text}` });
  }
  await env.WAITLIST.put(`signup:${email.toLowerCase()}`, JSON.stringify({
    email, model, at: new Date().toISOString(), country: request.cf?.country || null,
  }));
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (request.method === 'POST' && p === '/api/waitlist') return waitlist(request, env);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    if (p === '/' || p === '/index.html') {
      return new Response(page(env), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', ...SEC } });
    }
    const html = (body) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', ...SEC } });
    if (p === '/terms' || p === '/terms/') return html(docPage(env, 'Terms of Service', 'Terms of Service for sushila.ai, Sushila.cpp and the Sushila serverless API.', TERMS(env)));
    if (p === '/privacy' || p === '/privacy/') return html(docPage(env, 'Privacy Policy', 'How Syncaissa Systems handles personal data on sushila.ai and the Sushila serverless API.', PRIVACY(env)));
    if (p === '/models.json') {
      return json({
        hosted: HOSTED.map(({ id, name, quant, file, bytes, sha256, license, hf, tuned }) =>
          ({ id, name, quant, bytes, sha256, license, tuned, url: `${url.origin}/download/${file}`, source: hf })),
        huggingface: LISTED,
      });
    }
    if (p.startsWith('/download/')) return download(request, env, decodeURIComponent(p.slice('/download/'.length)));
    if (p === '/favicon.svg' || p === '/favicon.ico') {
      return new Response(FAVICON, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=604800' } });
    }
    if (p === '/robots.txt') return new Response('User-agent: *\nAllow: /\nDisallow: /download/\n', { headers: { 'content-type': 'text/plain' } });
    return new Response('Not found', { status: 404, headers: SEC });
  },
};

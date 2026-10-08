# sushila.ai website

`worker.js` is the whole sushila.ai site as one Cloudflare Worker. It serves:

- **Pages:** the home page (what Sushila.cpp does, measured speed, install steps for Linux, macOS and Windows, models,
  serverless API sign-up, and a disclaimer stating that Sushila is a research project), `/terms` and `/privacy`.
- **Accounts:** passwordless sign-in at `/signin` (a 6-digit code is e-mailed), and `/account` (profile, several linked
  e-mail addresses, download history).
- **Downloads:** each hosted model file has a license page at `/download/<file>`. A signed-in user accepts the license,
  the download is recorded, and the user gets a personal 24-hour link straight to Backblaze B2.
- **Logo:** the logo and icons are embedded in the file, made from `assets/logo/SushilaLogoWithBaseG.jpg`. The hero swan
  is two layers (`/logo-swan.png`, `/logo-base.png`). It rocks on its base, like the logo animation, whenever the visitor
  moves the mouse, touches, scrolls or uses the wheel. The animation file stays in B2 at `media/` (route `/media/…`) but
  is not shown on the page.

## Services and settings

The worker reads these Cloudflare secrets and variables:

| Name | Used for |
|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | DynamoDB. Every table is named `sushilaai-*`. |
| `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET_NAME` (`sushila-ai`) | Backblaze B2, for downloads and media |
| `RESEND_API_KEY`, `RESEND_FROM` (`sushila.ai <support@sushila.ai>`) | sign-in e-mails |
| `SESSION_SECRET` | signs session cookies and hashes sign-in codes; use a long random value |
| `RELEASED` (`"true"`), `REPO_URL`, `CONTACT`, `GOVERNING_LAW` | optional: download buttons, source link, contact e-mail, Terms |
| `RUNPOD_API_KEY` | admin **Compare Speeds**: creates and deletes GPU pods on RunPod (secret) |
| `DEEPINFRA_API_KEY`, `DEEPSEEK_PLATFORM_API_KEY` | reserved for the serverless API; not used yet |

**Graceful fallback:** without the AWS, B2 or Resend settings the site still works. Sign-in is unavailable, downloads
go to Hugging Face, and the waitlist falls back to e-mail. Open `/api/health` after deploying: it lists each
`sushilaai-*` table as `ok` or with an error code (`DB_TABLES_MISSING`, `DB_CREDENTIALS`, `DB_PERMISSIONS`), and
whether B2 and Resend are configured. Errors shown to users carry the same codes.

**DynamoDB tables and indexes** are defined in `setup/dynamodb_tables.py`. It checks what exists and creates or updates
it to match (`--dry-run` shows the plan). The worker's key needs only `setup/iam_policy.json`.

| Table | Key | Holds |
|---|---|---|
| `sushilaai-users` | `userId` (random, permanent) | primary e-mail, linked e-mails (set), name, organization, `isAdmin`, created, last sign-in |
| `sushilaai-emails` | `email`; index `userId-index` | every verified e-mail → `userId` of its account |
| `sushilaai-otps` | `email` | the pending code as a keyed hash, its purpose, expiry and attempts; removed by TTL |
| `sushilaai-downloads` | `userId` + `downloadedAt`; index `modelId-downloadedAt-index` | model, file, B2 key, sha256, license accepted, country |
| `sushilaai-models` | `modelId` | hosted models, their precomputed artifacts, and the `visible` flag |
| `sushilaai-bugs` | `bugId` + `item`; indexes `list-index`, `reporter-index` | bug reports (`item` = `bug`) and their comments (`item` = `c#<time>#<id>`) |
| `sushilaai-waitlist` | `email` | serverless-API early access |
| `sushilaai-audit` | `day` + `at` | sign-ups, sign-ins, e-mail changes, downloads |
| `sushilaai-reportabuse` | `reportId` | reports from sushila.ai/reportabuse: link, reason, details, optional e-mail, time, IP, country |
| `sushilaai-file-views` | `url` | one row per shared link `/c/<12 hex>`: owner `userId` and `views` (the row is made first, so link ids are unique) |

**Backblaze B2 layout** (bucket `sushila-ai`; upload with `setup/b2_upload.sh`):

| Path | Content |
|---|---|
| `models/<model id>/<file>` | the model file, byte-identical to the Ollama registry blob; the script checks its sha256 before uploading |
| `precomputed/<model>/` | that model's precomputed artifacts, one folder per model: `CHECKSUMS.json` (what they are bound to, and the sha256 of every file), `draft-head/`, `checkpoints/`, `training-data/`, `config.env` |
| `results/<model>/` | timings, outputs and logs of the run that produced them |
| `media/SushilaLogoWithBaseG.mp4` | the logo animation |

**Sign-in rules:**
- **Codes:** 6 digits, valid for 5 minutes, at most one every 10 seconds per e-mail, and 5 wrong guesses discard the
  code. Codes are stored only as a keyed hash.
- **Sessions:** a signed, HttpOnly, Secure, SameSite=Lax cookie lasting 30 days.
- **E-mails:** an account is identified by a permanent `userId`, not an e-mail. It can have up to 5 verified e-mails;
  any of them signs in, and any can be made primary or removed (one must remain).
- **Requests:** state-changing calls must be same-origin JSON, and every route is rate-limited per IP.

## Bug reports

Signed-in users report bugs at `/bugs/new` (title, category, severity, description, page or command), follow them at
`/bugs`, and comment on them. Every page footer links to "Report a bug".

- **Visibility:** users see only their own reports; admins see all of them, with filters and pages.
- **Admin actions:** admins comment and set the status (open, in progress, fixed, closed, won't fix).
- **E-mail:** a new report or a user's comment e-mails every admin. An admin's comment or status change e-mails the
  reporter. Messages go through Resend.

## Admins

`setup/makeUserAdmin.py --region <region> <e-mail>` gives an account admin rights (`--revoke` removes them, and `--list`
lists admins). Admins see an **Admin** menu with two tabs:

- **Users:** every account, with a filter (e-mail, name, organization, user id, admins only) and pages of 25–100.
- **Models:** the hosted models with their precomputed artifacts and download counts. Admins can add a model, edit it,
  and toggle **visible**; only visible models are shown to regular users. On the first visit, the built-in list is
  copied into `sushilaai-models`.
- **Compare Speeds:** times one prompt on Sushila and on vanilla Ollama, side by side. It lists every model whose
  precomputed draft head is in B2 (`precomputed/<model>/CHECKSUMS.json`). **Start comparison pod** creates a fresh RunPod
  pod from `lmsysorg/sglang:v0.5.21-cu130` (2 GPUs for 70B models, so both engines stay loaded). The pod runs
  `scripts/compare/compare_pod.py` (copied to B2 at `tools/compare/`), installs Ollama 0.35.1, and downloads the model's
  files and draft head from B2. B2 grants the pod a read-only token for that one model's folder, and every file is
  checked by sha256. Models without a B2 copy of their weights fall back to Hugging Face and the Ollama registry. Each
  prompt returns both replies, their milliseconds, tokens/s and the speedup, and is stored in `sushilaai-compare`.
  - **Pod deletion:** the pod is deleted after the comparison, unless "keep" is ticked. A cron trigger (every
    5 minutes) also deletes comparison pods that have been idle for 15 minutes, failed setup, are not ready after
    60 minutes, or are older than 3 hours. It only touches pods named `sushila-cmp-*`.
  - **Spend guard:** at most two comparison pods at once. Setup takes about 10–20 minutes. A100 pods cost about
    $1.59/h per GPU; when no A100 is free, an H100 is used at about $3.49/h per GPU.

## Deploy

```sh
python3 setup/dynamodb_tables.py --region <region>        # creates or updates tables and indexes
python3 setup/makeUserAdmin.py --region <region> you@example.com   # first admin
bash setup/b2_upload.sh media                              # logo animation
bash setup/b2_upload.sh model llama3.2-1b-q8               # each hosted model (see the list in the script)
npx wrangler deploy worker.js --name sushila --compatibility-date 2026-10-01
```

For **Compare Speeds**, add the `RUNPOD_API_KEY` secret and a cron trigger `*/5 * * * *` (Workers → sushila → Settings →
Triggers), and upload the pod script: `python3 scripts/precompute/b2_save.py tree scripts/compare tools/compare`.
To keep model weights in B2 (no Hugging Face or Ollama downloads), run `scripts/precompute/mirror_weights.sh` on a pod.

Then attach the `sushila.ai` domain under Workers → sushila → Domains. In Resend, verify `sushila.ai` as a sending
domain so `support@sushila.ai` can send.

The Terms of Service and Privacy Policy are templates. Have them reviewed by counsel before charging for the API.

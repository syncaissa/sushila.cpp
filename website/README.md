# sushila.ai website

`worker.js` is the entire sushila.ai site as one Cloudflare Worker: the home page (what Sushila.cpp does,
measured speed, install steps for Linux, macOS and Windows, models, serverless API sign-up, disclaimer),
`/terms`, `/privacy`, `/models.json`, `/download/<file>`, and the logo and icons (`/logo.png`, `/favicon.png`,
`/favicon-32.png`, `/favicon.ico`, `/apple-touch-icon.png`), which are embedded in the file (made from
`assets/logo/SushilaLogo.png`: background made transparent, cropped, resized to a 256-colour palette).

Deploy:

```sh
npx wrangler deploy worker.js --name sushila --compatibility-date 2026-10-01
```

Then attach the `sushila.ai` domain in the Cloudflare dashboard (Workers → sushila → Domains).

Optional settings (Workers → sushila → Settings); the site works without any of them:

| Name | Kind | Purpose |
|---|---|---|
| `MODELS` | R2 bucket binding | hosted `.gguf` files, keyed by the file names in `HOSTED`; without it, downloads redirect to Hugging Face |
| `WAITLIST` | KV namespace binding | API early-access sign-ups; without it, the form opens an e-mail |
| `RELEASED` | variable, `"true"` | turns on the download buttons once this repository is public |
| `CONTACT` | variable | contact e-mail (default `syncaissa@outlook.com`) |
| `GOVERNING_LAW` | variable | governing law named in the Terms of Service |

The Terms of Service and Privacy Policy are templates; have them reviewed by counsel before charging for the API.

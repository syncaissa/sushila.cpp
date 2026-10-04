# sushila.ai website

`worker.js` is the entire sushila.ai site as one Cloudflare Worker: the home page (what Sushila.cpp does,
measured speed, install steps for Linux, macOS and Windows, models, serverless API sign-up, disclaimer),
`/terms`, `/privacy`, `/models.json`, `/download/<file>`, and the logo and icons (`/logo.png`, `/favicon.png`,
`/favicon-32.png`, `/favicon.ico`, `/apple-touch-icon.png`, and `/logo-swan.png` + `/logo-base.png`, the two layers
that let the hero swan rock on its base when the pointer moves over it or it is touched, like the logo animation),
which are embedded in the file (made from
`assets/logo/SushilaLogoWithBase.jpg`: background made transparent, cropped, resized to a 256-colour palette).
The logo animation (`assets/logo/SushilaLogoWithBase.mp4`, 4.5 MB) is too large to embed: upload it to an R2 bucket
and bind that bucket as `MEDIA` (or reuse `MODELS`); the page shows it under the headline only when it is available:

```sh
npx wrangler r2 bucket create sushila-media
npx wrangler r2 object put sushila-media/SushilaLogoWithBase.mp4 --file ../assets/logo/SushilaLogoWithBase.mp4 --content-type video/mp4 --remote
```

Deploy:

```sh
npx wrangler deploy worker.js --name sushila --compatibility-date 2026-10-01
```

Then attach the `sushila.ai` domain in the Cloudflare dashboard (Workers → sushila → Domains).

Optional settings (Workers → sushila → Settings); the site works without any of them:

| Name | Kind | Purpose |
|---|---|---|
| `MODELS` | R2 bucket binding | hosted `.gguf` files, keyed by the file names in `HOSTED`; without it, downloads redirect to Hugging Face |
| `MEDIA` | R2 bucket binding | the logo animation `SushilaLogoWithBase.mp4`; without it (and without `MODELS`) the page leaves the video out |
| `WAITLIST` | KV namespace binding | API early-access sign-ups; without it, the form opens an e-mail |
| `RELEASED` | variable, `"true"` | turns on the download buttons once this repository is public |
| `CONTACT` | variable | contact e-mail (default `syncaissa@outlook.com`) |
| `GOVERNING_LAW` | variable | governing law named in the Terms of Service |

The Terms of Service and Privacy Policy are templates; have them reviewed by counsel before charging for the API.

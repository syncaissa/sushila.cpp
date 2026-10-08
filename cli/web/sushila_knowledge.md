# Sushila: how it works (technical notes for the built-in assistant)

These notes are what the built-in assistant ("Ask Sushila") uses to answer questions. Each section starts with `## `
so it can be found and quoted by its title. Commands are exact; if something is not here or in the command
documentation, the assistant should say it does not know.

## What Sushila is
Sushila runs AI models on your own computer: chat, coding, images, music and video. It is one program, `sushila`
(Windows: `sushila.exe`), with the same commands on Windows, macOS and Linux. It installs an inference engine
(Sushila.cpp, built on llama.cpp, stable-diffusion.cpp and acestep.cpp) and model packs, and serves a page in your
browser plus an OpenAI-compatible API. Prompts and outputs stay on your computer. Nothing is sent anywhere except the
downloads of the engine and model packs from files.sushila.ai.

## First start
Double-click `sushila` (or run `sushila serve`). A terminal window opens and prints the addresses:
Inference http://localhost:8765/, Admin http://localhost:8765/admin (this computer only), Documentation
http://localhost:8765/docs, API http://localhost:8765/v1, and the home folder. On the first start it asks for an Admin
password, downloads the engine for your GPU, installs a default chat model and opens your browser. The default model
depends on the computer: Qwen3 4B (`qwen3-4b-instruct-2507`, about 2.5 GB) with an NVIDIA GPU of 8 GB or more, another
GPU reporting 8 GB or more, a Mac with Apple silicon and 16 GB or more, or no GPU but 16 GB of memory or more (and
enough free disk); otherwise Qwen2.5 0.5B (`qwen2.5-0.5b-q4km`, about 535 MB). The log says which and why.
`sushila selftest` uses the small model (fast), or the 4B model if it is already installed. Type `?` in that window for the important commands; type `stop` or press Ctrl+C to stop.

## The home folder
Everything Sushila keeps is in one home folder: model-packs/, the engine, settings (state.json), logs, the queue and
the Admin password hash. The program remembers where it is in one small file in your settings folder
(Windows %APPDATA%\sushila\home, macOS ~/Library/Application Support/sushila/home, Linux ~/.config/sushila/home).
`sushila home` shows it; `sushila home <folder>` changes it; `sushila home --reset` searches again. If several homes
exist, Sushila asks which one to use. Deleting the home folder removes all models and settings.

## Model packs
A model pack is a folder in model-packs/ with the model files, a signed index (sushila-pack.json) listing every file
with its SHA-256, and, where available, precomputed files that make it faster. Install from the Admin tab (Packs) or
with `sushila install <pack>`; see what exists with `sushila packs` or `sushila search <words>`. A pack folder dropped
into model-packs/ is found within seconds, without a restart. Your own model: put a .gguf file in model-packs/ or run
`sushila install hf:<repo>/<file.gguf>`; it runs in Standard mode (no precomputed files), unless its checksum matches a
pack Sushila knows, in which case it is treated as that pack. Every download is checked by SHA-256 before use.

## Installing a model
Find a pack: `sushila search <words>`, or by kind: `sushila search --kind chat|code|image|music|video`; add `--fits` to
list only packs that fit this computer. Install it: `sushila install <pack>` (for example a coding model:
`sushila search --kind code`, then `sushila install qwen2.5-coder-7b`), or click Install on the Admin tab, Packs.
`sushila show <pack>` lists its files, license and what Accelerated does. The download is checked (Sushila's signature
and every file's SHA-256) before the pack is used. While a server runs, the new pack appears on the page without a
restart; start it with `sushila start <pack>` or on the Admin tab.

## Using Sushila from a phone or another computer
1. `sushila share on` (or start with `sushila serve --public`), then restart the server: `sushila stop`, then
`sushila serve`. 2. Make an access key for the phone: `sushila keys add phone` (it is shown once). 3. `sushila share qr`
prints a QR code of this computer's address (for example http://192.168.1.20:8765/); open it on the phone, which must
be on the same network, and enter the key once. If the phone cannot connect, a firewall may block the port:
`sushila doctor` prints the command to open it. `sushila share on --open` needs no key (trusted networks only);
`sushila share off` stops sharing. The Admin tab is never available from other machines. For the internet use HTTPS:
`sushila https <domain>` writes a Caddy configuration and prints the steps.

## The server window
The window where `sushila serve` runs (it opens when you double-click `sushila`) takes typed lines. A sushila command,
with or without the word sushila (for example `ps`, `status`, `install qwen3-4b-instruct-2507`), runs right there;
commands that delete or change things (remove, uninstall, clean, update, restore, import, share on, keys remove,
password --reset, home <folder>) ask for a yes first. A question (for example "how do I add a coding model?")
is answered by the Sushila assistant. A mistyped command gets a suggestion ("Did you mean `sushila install ...`?")
that runs only if you answer y. `?` lists the important commands, `urls` the addresses, `stop` stops the server.
The window is one screen: the output scrolls in the top part, the `sushila>` input line stays fixed above the last
line, with a blinking block cursor, and typing is never mixed with output. Everything printed stays in the terminal:
scroll up with the mouse wheel or the scroll bar, select and copy. Up/Down bring back earlier lines, Esc clears the
line, `clear` empties the window, `!<command>` runs a command of the system shell (`!dir`, `!ls`). Commands typed here
run in the background, so questions are answered while something installs. Downloads show one bar per job (a pack,
the image runtime) above the input line: the whole job's percentage, then the current file's. `copy` puts the last answer on the clipboard (`copy urls`:
the addresses); any text can be selected with the mouse and copied with a right-click (or Enter), and pasted with a
right-click or Ctrl+V (Windows console: also the window menu, Edit). Downloads show a bar that fills as they go.
Commands that run until Ctrl+C (top, logs -f, watch) belong in another terminal: Ctrl+C in this window stops the server.
Optional (off unless `sushila config set ticker on`): the bottom line of the window is a scrolling ticker: one sentence for every command, with live news in between (models
running, queue progress, GPU memory). It has no keys of its own. `ticker off` hides it in this window;
`sushila config set ticker off` keeps it off.

## Ask Sushila
The Sushila helper answers questions about Sushila from these notes and the documentation, with live facts about this
computer (GPU, installed packs, which packs fit). Use it from the ☰ menu of the page (Ask Sushila), with
`sushila assistant "<question>"` (or `sushila assistant` to keep asking), or by typing a question in the server window.
It needs no language model and never starts one (that would stop the pack in use): questions about this computer
(what is installed or running, where pictures are saved, which packs fit, the GPU, the version) come straight from the
live state; "how do I make a picture / song / video / code" gets the steps with the packs installed here; other
questions get the best one or two sections of these notes and the commands in them. If a chat model of 3B or more is
running, it answers those other questions in its own words instead; if none runs, the answer ends with how to start
one (for example `sushila start qwen3-4b-instruct-2507`) and which running pack that would stop.

## Which pack fits my computer
Rough rule for text models in 4-bit: the model needs about 0.6 GB of memory per billion parameters, plus room for
the conversation. On a GPU with 8 GB: models up to about 8B; 12 GB: up to about 14B; 24 GB: up to about 32B; 80 GB:
70B. Without a GPU, use small models (0.5B to 4B); they run on the CPU, slower. Apple silicon uses the shared memory:
a Mac with 16 GB runs up to about 8B comfortably, 32 GB up to about 14B. Images (Z-Image-Turbo) need about 8 GB of GPU
memory; video (Wan 2.2 TI2V-5B) works best with 24 GB; music (ACE-Step) about 8 GB. The Packs list marks packs that
do not fit. On an NVIDIA GPU, `sushila install z-image-turbo` installs the variant made for NVIDIA (z-image-turbo-nvidia)
when that one fits.

## Standard and Accelerated
Every model has two modes: Standard runs the plain model, as Ollama or the reference engine would. Accelerated adds
Sushila's precomputed files and methods for that model, for example a draft head that lets the engine check several
tokens at once, a precomputed output-layer landscape, or a cache plan for images and video. For text, Accelerated
gives the model's own answers (up to rare numerical near-ties) faster. For images and video the cache plan is slightly
lossy (measured similarity about 0.93-0.98 to Standard); choose Standard if you see a difference. The model picker on
the Inference page lists each pack in both modes, e.g. "Z-Image-Turbo (Accelerated)"; or `sushila mode <pack> standard|accelerated`.

## The Inference page and running models
The Inference page (http://localhost:8765/) has one model picker: every installed pack, once per mode, with what it
does (Chat, Code, Image, Music, Video) and whether it runs. Choosing one that is stopped asks first and starts it; ■ Stop
stops it. Chips by kind (Chat, Image, ...) jump to that kind. One model pack runs at a time: starting one stops the
others, on the page, the Admin page and with `sushila start` alike (all show the same state). The terminal and Ask
Sushila need no model: the Sushila helper answers questions about this computer (what is installed or running, where
pictures are saved, which packs fit, the GPU) from the live state, turns "how do I make a picture / song / video" into
the steps with the packs installed here, and quotes these notes for the rest. When a chat model runs, it answers
free-form questions in its own words; when none runs, the helper says how to start one and what that would stop. Pictures made on the page are also saved in the home folder (outputs/images/<date>/);
under each one, Show in folder opens it in Explorer or Finder and Copy path copies its location. Sizes go up to
2048x2048 for every image model (34 s at 2048 on an RTX 3090 with the NVIDIA 4-bit pack, Accelerated); 4K (3840x2160)
for the standard image engine only (about 3 minutes on a 24 GB GPU; measured once on an RTX 3090).

## What speed to expect
The speedups measured for the paper (same computer, same prompts): Llama-3.3-70B 4.05x over vanilla Ollama on an A100
(through Sushila's NVIDIA serving path); on a regular computer with llama.cpp, the engine-level gains are about
1.1-1.3x, and 2x or more for 70B models with a small draft model. Images on an NVIDIA GPU with the 4-bit kernels: about 0.9 s for a 768x768 image on a desktop RTX 4090 (0.7 s on an RTX 5090); on GPUs with less than 18 GB (laptops, 8-12 GB cards) much longer, often half a minute, because the 4B text encoder and the image model are moved between system and GPU memory for every image; Accelerated (768x768, 6 steps) is the faster setting there. Video: a 5-second 720p clip takes about 15 minutes on an RTX 4090 in Standard
and about 9 minutes in Accelerated. Music: a 60-second ACE-Step song takes about 4-5 seconds on an RTX 4090. Measure
your own computer with `sushila bench <pack>`.

## GPU use
Sushila installs the engine build for your GPU automatically: CUDA on NVIDIA, Vulkan on AMD and Intel graphics, Metal
on Apple silicon; the CPU build only when there is no usable GPU. Text models are loaded fully on the GPU when they
fit. `sushila selftest` checks the whole chain and fails if a GPU is present but not used (it reports, for example,
"25/25 layers on the GPU"). `sushila doctor` checks drivers, disk, ports and signatures and prints fixes.

## The Admin tab and security
The Admin page (http://localhost:8765/admin) installs and removes packs, updates the engine, shows the queue, logs and
crashes, and changes settings. It works only on this computer and needs the Admin password, stored as a hash. Change
it with `sushila password` (asks the current one); lost it? run `sushila password --reset` in a terminal on this
computer. Other machines can use the Inference page and API only when you share the server (`sushila serve --public`
or `sushila share on`) and give them an access key (`sushila keys add <name>`).

## Using the API
The API is OpenAI-compatible at http://localhost:8765/v1 (chat completions, completions, images, models). On this
computer the page's token is used automatically; from other machines send `Authorization: Bearer <key>`.
`sushila example <pack> curl|python|js` prints a working snippet.

## Long jobs and the queue
Videos and long songs run in a background queue, one job at a time. Close the browser and come back later; finished
jobs keep their output with a Download button. `sushila queue` lists, pauses, resumes and cancels jobs.

## Crashes and logs
If the server crashes, Sushila restarts it within a second and records why (Admin tab, Logs, Crashes). `sushila logs
-f` follows the log. `sushila report` collects versions, GPU information and recent logs, without secrets, for a bug
report.

## Updating and removing
`sushila update` installs a newer signed engine and changed packs (`--check` only lists them). `sushila remove <pack>`
deletes a pack. `sushila clean` removes leftovers of interrupted downloads and old engine versions. `sushila uninstall`
removes the background service and the home pointer; `--all` also deletes the home folder after asking.

## Starting with the computer
`sushila service install` starts Sushila at login (Windows Task Scheduler, macOS launchd, Linux systemd);
`sushila service remove` undoes it.

## Common problems
Port 8765 busy: another Sushila is running (`sushila status`) or another program uses the port (`sushila serve --port
8800`). Slow or "0 layers on GPU": update the graphics driver, then `sushila engine install` and `sushila selftest`.
Model does not start: not enough memory; pick a smaller pack or close other GPU programs. macOS says the program
cannot be opened: right-click it and choose Open once (the program is not yet notarized by Apple). Windows SmartScreen:
"More info" then "Run anyway". Download stopped: run the same install again; it resumes and checks every file.

## The research behind it
Sushila comes from the SUSHILA paper (Scalable Upstream Synthesis for Hybrid Inference in Large-model Acceleration):
test the published speed-up methods on each model, keep the ones that help, and add precomputed per-model files,
built once right after a model's release, without retraining the model. Every result in the paper can be rerun; the
guide is docs/REPLICATE_ALL.md in the repository, and `sushila reproduce` prints the commands.

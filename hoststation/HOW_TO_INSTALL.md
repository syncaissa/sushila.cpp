# Installing Sushila Host Station

Sushila Host Station runs AI models on your own computer: text models today, and other kinds (music, images) as
packs become available. Everything is done with the mouse; you never need a command prompt.

**What you need**

- Windows 10 or 11, macOS 12 or later, or a recent Linux (Ubuntu 22.04+, Fedora 38+, or similar).
- Free disk space for the model packs you choose: 0.5 GB for the smallest, 20–45 GB for large ones.
- Enough memory for the pack. Each pack lists what it needs, and the app warns you if your computer is too small.
- An internet connection while installing. After that, models run offline.

## 1. Download

Go to **https://sushila.ai** → **Download** → **Sushila Host Station**, and pick your system:

| System | File |
|---|---|
| Windows | `Sushila Host Station_x.y.z_x64-setup.exe` (or the `.msi`) |
| macOS (Apple silicon: M1–M4) | `Sushila Host Station_x.y.z_aarch64.dmg` |
| macOS (Intel) | `Sushila Host Station_x.y.z_x64.dmg` |
| Linux | `.deb` (Ubuntu, Debian), `.rpm` (Fedora), or `.AppImage` (any) |

The download page lists a sha256 checksum for every file, so you can confirm your copy is genuine.

## 2. Install the app

**Windows**
1. Double-click the downloaded file.
2. Choose **Only for me** (no administrator password) or **For all users** (Windows asks for permission).
3. Click **Next** → **Install** → **Finish**. Sushila Host Station opens and appears in the Start menu.

**macOS**
1. Double-click the `.dmg`.
2. Drag **Sushila Host Station** onto **Applications**.
3. Open it from Applications or Launchpad.

**Linux**
- **Ubuntu or Debian:** double-click the `.deb`, then click **Install** in Software.
- **Fedora:** double-click the `.rpm`.
- **AppImage:** right-click the file → **Properties** → **Permissions** → tick **Allow executing as program**, then
  double-click it.

## 3. First start: four clicks

The **Home** screen walks you through four steps.

1. **Install Sushila.cpp** → **Install**. This is the engine that runs the models; it downloads and installs itself.
   If Sushila.cpp is already on your computer, click **Find an existing installation**, and the app uses it instead of
   installing a second copy.
2. **Add a model pack** → **Choose a pack**. Packs are grouped by kind, for example **Text (LLM)** today and **Music**
   later.
   - Each pack shows its size, its license, and the memory it needs.
   - Click **Install**, accept the license, and wait for the progress bar.
   - A pack contains the model and its precomputed files: a landscape and draft-head parameters that make it faster.
3. **Start a model**: choose the pack and click **Start**. The first start takes a few seconds to a minute while the
   model loads.
4. **Launch Inference Page.** Your normal web browser opens a chat page at `http://127.0.0.1:8765/`. Type a message;
   the answer is produced on your computer, and the page shows its speed in tokens per second.

To add more packs later, open **Model Packs**. Installed packs keep working without the internet.

## Safety: what the app protects you from

- **Signed by Sushila.** Every pack and engine build comes with a list of its files and their sha256 checksums, signed
  with Sushila's private key. The app has the matching public key built in. If the signature or any checksum does not
  match, it refuses the download and installs nothing. This holds even if a website or a download server has been
  tampered with.
- **Data only.** Model packs may contain only data files: model weights (`.gguf`, `.safetensors`), the precomputed
  landscape and head files, and `.json` and license texts.
  - The app refuses programs, scripts, and Python "pickle" files, which can run code when loaded.
  - Nothing from a pack is ever run or marked as a program.
- **Contained.** Downloads go only into the app's own folder, file paths cannot escape it, and the app can only delete
  files inside its own folder.
- **Local only.** The chat page and the model server listen only on your own computer (`127.0.0.1`). Other websites
  cannot use them: requests need the private session token that the **Launch Inference Page** button gives the page.
- **Check anytime.** In **Model Packs**, **Verify** re-checks every installed file against its checksum.

## Settings you may want

- **Install for:**
  - **Only me** is the default and needs no password.
  - **All users** installs into `C:\Program Files\Sushila`, `/Library/Application Support/Sushila` or `/opt/sushila`,
    and asks for an administrator password once per install.
- **Ports:** 8765 for the chat page and 8766 for the engine. Change them if another program uses those ports.
- **CPU threads, context length, GPU layers:** the defaults suit most computers. Set GPU layers to 0 to run on the
  processor only.

## Removing

- **A pack:** Model Packs → **Remove**.
- **The app on Windows:** Settings → Apps → Sushila Host Station → **Uninstall**.
- **The app on macOS:** drag it from Applications to the Trash.
- **The app on Linux:** remove it in Software, or delete the AppImage.

Your packs are in the data folder shown in **Settings**; delete that folder to free all the space.

## If something goes wrong

- **"The Sushila signature does not match":** the download was changed somewhere along the way. Nothing was
  installed. Try again later, and report it at https://sushila.ai/bugs/new.
- **The model does not start:** open **Run & Logs**. The log shows what the engine reported, often that there is not
  enough memory for this pack.
- **Your browser or Windows warns about the installer:** download it only from https://sushila.ai and compare its
  sha256 with the one on the download page.

Sushila is an open-source research project. The software is provided as is, without warranty; see
https://sushila.ai/terms.

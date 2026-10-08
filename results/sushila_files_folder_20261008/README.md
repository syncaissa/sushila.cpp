# Files folder (build 27): live test

`test27.sh` ran on a Linux pod with the build-27 `sushila` binary; `test27.out` is its output (18/18 PASS).
It starts from an install laid out as before build 27 (home in `~/.local/share/ai.sushila.hoststation`, files in
its `outputs/images` and `outputs/music`, the index with prompts). It then checks:
- the server moves the home by itself;
- the one question (`old`) appears;
- Move puts the files in `~/Documents/Sushila/Images` and `Music`, with the index paths updated;
- the Library, file serving, and trash/restore work in the new folder;
- choosing another folder (with the files moved) and going back to Documents both work;
- a relative path and a foreign Host are refused.

Rust tests: 37 passed. Page tests (jsdom): all passed.

Not covered here: Windows' Controlled folder access. The test runs as root, which ignores permissions, so the blocked
path was not run. Real Windows testing is still pending.

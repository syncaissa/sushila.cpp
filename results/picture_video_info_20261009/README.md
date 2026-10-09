# Picture vs video: free tag and information (2026-10-09, RTX 4090, the real page in Chromium)

User report: a video shows "100% FREE, generated locally!" and a lot of information; a picture does not. compare.py
makes one picture (Z-Image NVIDIA, 768x768) and one video (Wan 2.2 5B, 832x480, 2 s) through the page and records the
Recent tile, its information window and the queue entry.
- Engine 35: the tag on both (tile, window, queue), but cut off on the tile ("...locally" without "!"); the picture's
  window had no Size row and only prompt/seed/size settings; neither showed the mode or the time taken.
- Engine 36: the same rows for both (Made with, Mode, Prompt, Size, Seed, Took, Created, Cost, All settings; videos
  also Length); the tag wraps on the tile; the queue's Open window shows the same table.

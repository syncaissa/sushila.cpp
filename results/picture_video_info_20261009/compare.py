"""Makes one picture and one video through the real page (http://127.0.0.1:7874/, as on this computer) and records what
each screen shows: the Recent tile, its information window, the queue entry and its Open window. Screenshots and texts
in /workspace/free/out/."""
import json, time, os, requests
from playwright.sync_api import sync_playwright
OUT = '/workspace/free/out'; os.makedirs(OUT, exist_ok=True)
tok = json.load(open('/workspace/home/state.json'))['token']; H = {'x-sushila-token': tok}
def lib(kind): return [x for x in requests.get('http://127.0.0.1:7874/api/library', headers=H, timeout=30).json().get('items', []) if x.get('kind') == kind]
def queue(): q = requests.get('http://127.0.0.1:7874/api/queue', headers=H, timeout=30).json(); return q.get('jobs', q) if isinstance(q, dict) else q
res = {}
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1400, 'height': 1000})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    for kind, view, fill in [('image', 'pictures', lambda: (pg.fill('#ip', 'A red fox in fresh snow, morning light'), pg.click('#igo'))),
                             ('video', 'video', lambda: (pg.fill('#vp', 'A paper boat drifting down a rainy street, cinematic'), pg.select_option('#vsize', '832x480'), pg.select_option('#vlen', '49'),
                                                        pg.click('text=Make the video')))]:
        n0 = len(lib(kind))
        pg.goto('http://127.0.0.1:7874/#' + view); pg.wait_for_timeout(4000)
        fill(); t0 = time.time()
        while len(lib(kind)) <= n0 and time.time() - t0 < 2400: time.sleep(5)
        res[kind] = {'seconds': round(time.time() - t0), 'library_item': lib(kind)[0] if lib(kind) else None}
        pg.goto('http://127.0.0.1:7874/#' + view); pg.reload(); pg.wait_for_timeout(5000)
        pg.screenshot(path=f'{OUT}/{kind}-page.png', full_page=True)
        tile = pg.locator('.gallery .tile').first
        res[kind]['tile_text'] = tile.inner_text() if tile.count() else None
        res[kind]['tile_has_free'] = tile.locator('.freetag').count() if tile.count() else None
        if tile.count():
            tile.locator('button[title=Information]').click(); pg.wait_for_timeout(2500)
            sh = pg.locator('#sheet'); res[kind]['info_text'] = sh.inner_text(); res[kind]['info_has_free'] = sh.locator('.freetag').count()
            pg.screenshot(path=f'{OUT}/{kind}-info.png'); pg.keyboard.press('Escape'); pg.mouse.click(5, 5); pg.wait_for_timeout(800)
        # the queue entry and its Open window
        pg.goto('http://127.0.0.1:7874/#queue'); pg.wait_for_timeout(4000)
        job = [j for j in queue() if j.get('kind') == kind and j.get('status') == 'ready']
        res[kind]['queue_job'] = job[-1] if job else None
        items = pg.locator('#view .item').filter(has_text=('Picture' if kind == 'image' else 'Video'))
        res[kind]['queue_items_text'] = [items.nth(i).inner_text() for i in range(min(items.count(), 3))]
        pg.screenshot(path=f'{OUT}/{kind}-queue.png', full_page=True)
    res['page_errors'] = errs
    b.close()
json.dump(res, open(f'{OUT}/compare.json', 'w'), indent=1, default=str)
print(json.dumps(res, indent=1, default=str)[:12000])

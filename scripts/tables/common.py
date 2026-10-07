"""Shared helpers for the table scripts (scripts/tables/tab_*.py).

Every table script builds its cells from the raw result files under results/ and never from the paper. The paper's
values are used only by --check, which compares each recomputed cell with the value printed in the paper. Those
values live in scripts/tables/expected/<script>.json and every one of them is verified to occur, as printed, inside
the table's block in paper.tex (so the expected files cannot silently drift from the paper).

Comparison rule: a paper value printed with d decimals MATCHES when the recomputed value lies within half a unit of
its last digit (|x - p| <= 0.5 * 10^-d). Ties (x exactly half-way) therefore match whichever way the paper rounded.

Statuses per cell:
  MATCH           recomputed value rounds to the paper's value
  MISMATCH        it does not (the paper value, the recomputed value and the raw source are printed)
  NOT DERIVABLE   no raw file holds the number (the reason is printed)
  BY DEFINITION   a reference value that is not a measurement (e.g. the stock engine reads 100%); not counted
"""
import argparse
from decimal import Decimal, ROUND_HALF_UP
import json
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, '..', '..'))                  # forGithub/
RESULTS = os.path.join(REPO, 'results')
RESEARCH = os.path.join(RESULTS, 'research')
PAPER_TEX = os.environ.get('SUSHILA_PAPER_TEX',
                           os.path.normpath(os.path.join(REPO, '..', 'Paper', 'latex', 'paper.tex')))
EXPECTED_DIR = os.path.join(HERE, 'expected')

MATCH, MISMATCH, NOTDER, BYDEF = 'MATCH', 'MISMATCH', 'NOT DERIVABLE', 'BY DEFINITION'


# ----------------------------------------------------------------------------------------------- raw-file parsers
def rel(path):
    """Path relative to the repository root, for printing sources."""
    return os.path.relpath(path, REPO)


def read(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        return f.read()


def llama_eval_tps(path):
    """Decode speed (tokens/s) of a llama.cpp run: the last 'eval time' line that is not 'prompt eval time'."""
    lines = [l for l in re.findall(r'^.*\beval time\b.*$', read(path), re.M) if 'prompt eval' not in l]
    if not lines:
        raise ValueError(f'no eval-time line in {rel(path)}')
    return float(re.search(r'([\d.]+) tokens per second', lines[-1]).group(1))


def spec_simple(path):
    """llama-speculative-simple output: decode speed, tokens drafted, tokens accepted, acceptance %."""
    s = read(path)
    m = re.search(r'decoded\s+(\d+) tokens in\s+([\d.]+) seconds, speed:\s+([\d.]+) t/s', s)
    if not m:
        raise ValueError(f'no "decoded ... speed" line in {rel(path)}')
    return {'tokens': int(m.group(1)), 'seconds': float(m.group(2)), 'tps': float(m.group(3)),
            'drafted': int(re.search(r'n_drafted\s*=\s*(\d+)', s).group(1)),
            'accepted': int(re.search(r'n_accept\s*=\s*(\d+)', s).group(1)),
            'accept_pct': float(re.search(r'\baccept\s*=\s*([\d.]+)%', s).group(1))}


def sushila_tree(path):
    """llama-sushila-tree output: generated t/s and the ms/cycle breakdown."""
    s = read(path)
    m = re.search(r'generated (\d+) tokens in ([\d.]+) s, ([\d.]+) t/s', s)
    d = re.search(r'ms/cycle draft ([\d.]+) verify ([\d.]+)', s)
    if not m:
        raise ValueError(f'no "generated ... t/s" line in {rel(path)}')
    return {'tokens': int(m.group(1)), 'tps': float(m.group(3)),
            'draft_ms': float(d.group(1)) if d else None, 'verify_ms': float(d.group(2)) if d else None}


def svd_grid(path):
    """sim_svdsoftmax.py output: {'tokens': n, 'grid': {(W, N): {'read','top1','recall40','tv40'}}} (as printed)."""
    s = read(path)
    tok = int(re.search(r'tokens=(\d+)', s).group(1))
    grid = {}
    for m in re.finditer(r'^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s*$', s, re.M):
        w, n = int(m.group(1)), int(m.group(2))
        num = lambda x: None if x == '-' else float(x)
        grid[(w, n)] = {'read': float(m.group(3)), 'top1': float(m.group(4)),
                        'recall40': num(m.group(5)), 'tv40': num(m.group(6))}
    return {'tokens': tok, 'grid': grid}


def sim_topk(path):
    """sim_topk.py output: {'tokens': n, 'K': k, 'methods': {name: {'top1','recall','tv07','tv10','read'}}} (as printed)."""
    s = read(path)
    hdr = re.search(r'tokens=(\d+), K=(\d+)', s)
    out = {'tokens': int(hdr.group(1)), 'K': int(hdr.group(2)), 'methods': {}}
    pat = (r'^\s+(\S+)\s+top1\s+([\d.]+)%\s+recall@\d+\s+([\d.]+)%\s+TV\(T=0\.7\)\s+([\d.]+)\s+'
           r'TV\(T=1\.0\)\s+([\d.]+)\s+read\s+([\d.]+)%')
    for m in re.finditer(pat, s, re.M):
        out['methods'][m.group(1)] = {'top1': float(m.group(2)), 'recall': float(m.group(3)),
                                      'tv07': float(m.group(4)), 'tv10': float(m.group(5)),
                                      'read': float(m.group(6))}
    return out


def ppl_final(path_or_text, is_text=False):
    s = path_or_text if is_text else read(path_or_text)
    return float(re.search(r'Final estimate: PPL = ([\d.]+)', s).group(1))


def round_half_up(v, dec):
    """Print v with dec decimals, rounding halves up on its shortest decimal form (97.35 -> 97.4, 7.5345 -> 7.535)."""
    q = Decimal(1).scaleb(-dec)
    return str(Decimal(repr(float(v))).quantize(q, rounding=ROUND_HALF_UP))


def mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs)


def per_prompt_mean(tps):
    """{prompt: [tokens/s of each repetition]} -> {prompt: mean tokens/s}."""
    return {p: mean(v) for p, v in tps.items()}


def stock_summary(stock):
    """Stock speed as reported in captions: median (and range) over prompts of each prompt's mean tokens/s."""
    m = per_prompt_mean(stock)
    return {'median': median(m.values()), 'min': min(m.values()), 'max': max(m.values()), 'per_prompt': m}


def speedup_over_stock(runs, stock):
    """THE speedup definition used by every table that reports speedup over stock (paper, Section 'How We Test'):
    per prompt, the run's tokens/s divided by that prompt's stock tokens/s, each averaged (mean) over its
    repetitions; then the median and the range (min-max) over prompts.
    runs, stock: {prompt: [tokens/s of each repetition]} with the same prompts."""
    assert set(runs) == set(stock), (sorted(runs), sorted(stock))
    r, s = per_prompt_mean(runs), per_prompt_mean(stock)
    ratio = {p: r[p] / s[p] for p in r}
    return {'median': median(ratio.values()), 'min': min(ratio.values()), 'max': max(ratio.values()),
            'per_prompt': ratio}


def median(xs):
    return statistics.median(list(xs))


# ------------------------------------------------------------------------------------------------------ the table
class Table:
    def __init__(self, label, title):
        self.label, self.title, self.cells = label, title, []

    def add(self, row, col, value, dec, source, note=None, unit=''):
        """A recomputed cell. dec: decimals used when printing it."""
        self.cells.append({'row': row, 'col': col, 'value': value, 'dec': dec, 'source': source,
                           'note': note, 'unit': unit, 'status': None})

    def na(self, row, col, reason):
        """A cell no raw file can produce."""
        self.cells.append({'row': row, 'col': col, 'value': None, 'dec': 0, 'source': None,
                           'note': reason, 'unit': '', 'status': NOTDER})

    def bydef(self, row, col, text, reason):
        self.cells.append({'row': row, 'col': col, 'value': text, 'dec': 0, 'source': None,
                           'note': reason, 'unit': '', 'status': BYDEF})

    # --- printing
    def fmt(self, c):
        if c['status'] == NOTDER:
            return 'n/a'
        if c['status'] == BYDEF:
            return str(c['value'])
        v = c['value']
        return (round_half_up(v, c['dec']) if isinstance(v, float) else str(v)) + c['unit']

    def print_table(self):
        print(f'== {self.label}: {self.title}')
        rows, cols = [], []
        for c in self.cells:
            if c['row'] not in rows:
                rows.append(c['row'])
            if c['col'] not in cols:
                cols.append(c['col'])
        by = {(c['row'], c['col']): c for c in self.cells}
        rw = max(len(r) for r in rows)
        # print in chunks of columns so wide tables stay readable
        chunk = 7
        for k in range(0, len(cols), chunk):
            cs = cols[k:k + chunk]
            widths = [max(len(cc), *(len(self.fmt(by[(r, cc)])) for r in rows if (r, cc) in by)) for cc in cs]
            print('  ' + ' ' * rw + ' | ' + ' | '.join(cc.rjust(w) for cc, w in zip(cs, widths)))
            for r in rows:
                if not any((r, cc) in by for cc in cs):
                    continue
                vals = [self.fmt(by[(r, cc)]) if (r, cc) in by else '' for cc in cs]
                print('  ' + r.ljust(rw) + ' | ' + ' | '.join(v.rjust(w) for v, w in zip(vals, widths)))
            print()


# -------------------------------------------------------------------------------------------- the paper and check
def table_block(label, tex=None):
    """The LaTeX source of the table environment that holds \\label{label}."""
    tex = tex if tex is not None else read(PAPER_TEX)
    i = tex.find('\\label{%s}' % label)
    if i < 0:
        return None
    a = tex.rfind('\\begin{table', 0, i)
    b = tex.find('\\end{table', i)
    return tex[a:b]


def clean_tex(s):
    s = re.sub(r'\\textbf\{([^{}]*)\}', r'\1', s)
    s = re.sub(r'\\textbf\{([^{}]*)\}', r'\1', s)
    s = s.replace('{,}', ',').replace('$\\times$', 'x').replace('\\,', ' ').replace('\\%', '%')
    return s


def in_text(paper_value, text):
    """Is the number string paper_value printed in text (not as part of a longer number)?"""
    pv = re.escape(paper_value)
    return re.search(r'(?<![\d.])' + pv + r'(?![\d])', text) is not None


def decimals(s):
    s = s.replace(',', '')
    return len(s.split('.')[1]) if '.' in s else 0


def compare(value, paper_value):
    p = float(paper_value.replace(',', ''))
    d = decimals(paper_value)
    return abs(value - p) <= 0.5 * 10 ** (-d) + 1e-9


def check(table, expected_path, paper_tex=PAPER_TEX, quiet=False):
    """Compare every cell with the paper. Returns a summary dict."""
    exp = json.load(open(expected_path))
    tex = read(paper_tex) if os.path.exists(paper_tex) else None
    blocks = {}
    by = {(c['row'], c['col']): c for c in table.cells}
    res = {'label': table.label, MATCH: 0, MISMATCH: 0, NOTDER: 0, BYDEF: 0, 'missing': 0,
           'not_in_paper': 0, 'mismatches': [], 'notder': []}
    out = []
    for e in exp['cells']:
        key = (e['row'], e['col'])
        pv = e['paper']
        where = e.get('where', table.label)                 # a table label, or 'text' for the running text
        if tex is not None:
            if where not in blocks:
                blocks[where] = clean_tex(tex if where == 'text' else (table_block(where, tex) or ''))
            if not in_text(pv, blocks[where]):
                res['not_in_paper'] += 1
                out.append(f'  !! expected value {pv!r} for {key} not found in paper.tex ({where}); expected file is stale')
        c = by.get(key)
        if c is None:
            res['missing'] += 1
            out.append(f'  ?? no recomputed cell for {key} (paper {pv})')
            continue
        c['checked'] = True
        if c['status'] == NOTDER:
            res[NOTDER] += 1
            res['notder'].append((key, pv, c['note']))
            out.append(f'  NOT DERIVABLE  {e["row"]} | {e["col"]}: paper {pv}; {c["note"]}')
            continue
        if c['status'] == BYDEF:
            res[BYDEF] += 1
            out.append(f'  BY DEFINITION  {e["row"]} | {e["col"]}: paper {pv}; {c["note"]}')
            continue
        ok = compare(float(c['value']), pv)
        st = MATCH if ok else MISMATCH
        c['status'] = st
        res[st] += 1
        d = decimals(pv)
        rec = f'{float(c["value"]):.{max(d + 2, 2)}f}'.rstrip('0').rstrip('.') if isinstance(c['value'], float) else str(c['value'])
        line = f'  {st:<14} {e["row"]} | {e["col"]}: paper {pv}, recomputed {rec}  [{c["source"]}]'
        if isinstance(c['value'], float) and abs(abs(float(c['value']) - float(pv.replace(',', ''))) - 0.5 * 10 ** (-d)) < 1e-9:
            line += '  (exactly half-way: rounds either way)'
        if c.get('note'):
            line += f'\n                 note: {c["note"]}'
        out.append(line)
        if not ok:
            res['mismatches'].append({'cell': f'{e["row"]} | {e["col"]}', 'paper': pv, 'recomputed': rec,
                                      'source': c['source'], 'note': c.get('note')})
    unchecked = [c for c in table.cells if not c.get('checked') and c['status'] not in (BYDEF,)]
    if not quiet:
        print('\n'.join(out))
        if unchecked:
            print(f'  ({len(unchecked)} recomputed cells have no paper value to compare: '
                  + ', '.join(f'{c["row"]}|{c["col"]}' for c in unchecked) + ')')
        print(f'  -- {table.label}: {res[MATCH]} match, {res[MISMATCH]} mismatch, {res[NOTDER]} not derivable, '
              f'{res[BYDEF]} by definition' + (f', {res["missing"]} missing' if res['missing'] else '')
              + (f', {res["not_in_paper"]} expected values NOT FOUND in paper.tex' if res['not_in_paper'] else '')
              + ('' if tex is not None else ' (paper.tex not found: expected values not verified against it)'))
    return res


def main(build, script_file, argv=None):
    """CLI for one table script: prints the table; --check compares it with the paper."""
    ap = argparse.ArgumentParser(description=(build.__doc__ or '').strip().split('\n')[0])
    ap.add_argument('--check', action='store_true', help='compare every cell with the paper')
    ap.add_argument('--quiet', action='store_true', help='with --check: summary only')
    a = ap.parse_args(argv)
    table = build()
    table.print_table()
    if a.check:
        name = os.path.splitext(os.path.basename(script_file))[0]
        r = check(table, os.path.join(EXPECTED_DIR, name + '.json'), quiet=a.quiet)
        if a.quiet:
            print(f'{table.label}: {r[MATCH]} match, {r[MISMATCH]} mismatch, {r[NOTDER]} not derivable, '
                  f'{r[BYDEF]} by definition')
            for m in r['mismatches']:
                print(f'  MISMATCH {m["cell"]}: paper {m["paper"]}, recomputed {m["recomputed"]} [{m["source"]}]')
        return r
    return None

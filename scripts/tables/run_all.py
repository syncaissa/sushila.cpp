#!/usr/bin/env python3
"""Run every table script with --check and print a summary: cells matched / mismatched / not derivable per table,
then every MISMATCH (paper value, recomputed value, raw source) and every NOT DERIVABLE cell with its reason.

Usage (from the repository root):  python3 scripts/tables/run_all.py [--verbose]
  --verbose   also print each table and every cell's comparison
Exit code: 0 if no cell mismatches and every expected value was found in paper.tex, 1 otherwise.
"""
import argparse
import contextlib
import importlib
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C

SCRIPTS = ['tab_output', 'tab_confirm', 'tab_domains', 'tab_domains_qwen', 'tab_domains_70b', 'tab_speed',
           'tab_kernel', 'tab_moe', 'tab_spec70b', 'tab_cpu70b', 'tab_dayzero', 'tab_eagle', 'tab_draftls']


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args()
    print(f'paper:   {C.PAPER_TEX}' + ('' if os.path.exists(C.PAPER_TEX) else '  (NOT FOUND: values not verified against it)'))
    print(f'results: {C.RESULTS}\n')
    results, errors = [], []
    for name in SCRIPTS:
        mod = importlib.import_module(name)
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf if not a.verbose else sys.stdout):
                table = mod.build()
                if a.verbose:
                    table.print_table()
                r = C.check(table, os.path.join(C.EXPECTED_DIR, name + '.json'), quiet=not a.verbose)
        except Exception as e:                                    # a broken parser must not hide the other tables
            errors.append((name, repr(e)))
            continue
        r['script'] = name
        results.append(r)
        if a.verbose:
            print()

    hdr = f'{"table":<18} {"script":<20} {"match":>6} {"mismatch":>9} {"not deriv.":>10} {"by def.":>8}'
    print(hdr)
    print('-' * len(hdr))
    tot = {C.MATCH: 0, C.MISMATCH: 0, C.NOTDER: 0, C.BYDEF: 0}
    for r in results:
        print(f'{r["label"]:<18} {r["script"] + ".py":<20} {r[C.MATCH]:>6} {r[C.MISMATCH]:>9} {r[C.NOTDER]:>10} {r[C.BYDEF]:>8}'
              + (f'   {r["missing"]} expected cells without a recomputed value' if r['missing'] else '')
              + (f'   {r["not_in_paper"]} expected values NOT in paper.tex' if r['not_in_paper'] else ''))
        for k in tot:
            tot[k] += r[k]
    print('-' * len(hdr))
    print(f'{"total":<18} {"":<20} {tot[C.MATCH]:>6} {tot[C.MISMATCH]:>9} {tot[C.NOTDER]:>10} {tot[C.BYDEF]:>8}')

    mm = [(r['label'], m) for r in results for m in r['mismatches']]
    if mm:
        print(f'\nMISMATCHES ({len(mm)}):')
        for label, m in mm:
            print(f'  {label}: {m["cell"]}\n      paper {m["paper"]}   recomputed {m["recomputed"]}\n      raw: {m["source"]}')
            if m.get('note'):
                print(f'      note: {m["note"]}')
    nd = [(r['label'], x) for r in results for x in r['notder']]
    if nd:
        print(f'\nNOT DERIVABLE ({len(nd)}):')
        for label, (key, pv, why) in nd:
            print(f'  {label}: {key[0]} | {key[1]} (paper {pv}): {why}')
    if errors:
        print('\nSCRIPT ERRORS:')
        for name, e in errors:
            print(f'  {name}.py: {e}')
    bad = mm or errors or any(r['not_in_paper'] or r['missing'] for r in results)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())

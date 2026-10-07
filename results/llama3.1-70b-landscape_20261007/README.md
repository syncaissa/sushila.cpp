# Llama-3.1-70B output-layer landscape, rebuilt 2026-10-07 (scripts/day0_landscape.sh, A100 pod CPUs, 13 threads)

Preview landscape for `llama3.1:70b` Q4_K_M (sha256 de20d2cf...44c9): width 1376, 4,096 candidates, q4_0 preview.
Gate passed (mode `preview`): on held-out test text (never used to choose) the next token equals the full output layer's
on 99.9-100% of tokens in every domain (prose, web, code, chat, multilingual), top-40 recall 98.7-99.9%, while reading
about 18.8% of the output layer's bytes. Saved: b2://sushila-ai/precomputed/llama3.1-70b-q4km/ (26 files, MANIFEST.json).
manifest.json here = the full validation and test tables.

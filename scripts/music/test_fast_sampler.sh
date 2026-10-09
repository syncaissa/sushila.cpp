#!/usr/bin/env bash
# The ACE-Step fast sampler draws from the same distribution as the stock one (paper: Beyond Text, music;
# results/music_spec_20261006/README.md: largest total-variation difference 0.0008 over 200 random 65,536-way
# distributions, 3.7x faster per draw). CPU only, no model, ~1 minute.
# It clones acestep.cpp at the pinned commit, applies our patches (hoststation/patches/acestep), takes the stock
# sample_top_k_p (src/sampling.h, turned into a function that returns its probabilities instead of drawing) and our
# spec_probs (src/pipeline-lm.cpp) unchanged, and compares them on 200 random distributions (temperature 0.85, top-p 0.9).
#   bash scripts/music/test_fast_sampler.sh [work dir]
# Passes when the largest total-variation difference is below 0.001 (float rounding).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd); W=${1:-${TMPDIR:-/tmp}/fast_sampler}; mkdir -p "$W"
if [ ! -d "$W/acecpp" ]; then
  git clone -q https://github.com/ServeurpersoCom/acestep.cpp "$W/acecpp"
  git -C "$W/acecpp" checkout -q 694ef0f2f7cbf1b8a45b061a1ff0a817f451420c
  git -C "$W/acecpp" -c user.email=s@s -c user.name=s am -q --whitespace=nowarn "$REPO"/hoststation/patches/acestep/*.patch
fi
python3 - "$W" <<'PY'
import sys
w = sys.argv[1]
src = open(f'{w}/acecpp/src/pipeline-lm.cpp').read()
a = src.index("static void spec_probs(float * logits, int V, float temperature, float top_p, int top_k, float * p) {\n    // Same")
fast = src[a:src.index("static int spec_draw(")]
samp = open(f'{w}/acecpp/src/sampling.h').read()
stock = samp[samp.index("static int sample_top_k_p("):samp.index("// BPE decode")]
# the stock sampler's distribution: stop where it would draw, return the normalised weights instead
stock = stock.replace("static int sample_top_k_p(float * logits, int V, float temperature, float top_p, int top_k, std::mt19937 & rng) {",
                      "static void stock_probs(float * logits, int V, float temperature, float top_p, int top_k, float * out) {")
stock = stock.replace(stock[stock.index("    std::uniform_real_distribution<float> dist(0.0f, sum);"):],
                      "    for (int i = 0; i < V; i++) out[i] = logits[i] / sum;\n}\n")
stock = stock.replace("return (int) (std::max_element(logits, logits + V) - logits);", "return;")
main = r'''
int main() {
    std::mt19937 g(1); const int V = 65536; double worst = 0, ts = 0, tf = 0;
    for (int trial = 0; trial < 200; trial++) {
        std::normal_distribution<float> n(0, 1.0f + (trial % 5)); std::vector<float> l(V);
        for (auto & x : l) x = n(g);
        if (trial % 3 == 0) for (int i = 0; i < 50; i++) l[g() % V] += 8;   // a few strong candidates
        std::vector<float> a = l, b = l, pa(V), pb(V);
        auto t0 = std::chrono::steady_clock::now(); stock_probs(a.data(), V, 0.85f, 0.9f, 0, pa.data());
        auto t1 = std::chrono::steady_clock::now(); spec_probs(b.data(), V, 0.85f, 0.9f, 0, pb.data());
        auto t2 = std::chrono::steady_clock::now();
        ts += std::chrono::duration<double, std::milli>(t1 - t0).count(); tf += std::chrono::duration<double, std::milli>(t2 - t1).count();
        double tv = 0; for (int i = 0; i < V; i++) tv += fabs(pa[i] - pb[i]); worst = std::max(worst, tv / 2);
    }
    printf("largest total-variation difference %.4f over 200 distributions (paper: 0.0008); stock %.2f ms, fast %.2f ms per call (%.1fx)\n",
           worst, ts / 200, tf / 200, ts / tf);
    printf(worst < 1e-3 ? "PASS: same distribution\n" : "FAIL\n");
    return worst < 1e-3 ? 0 : 1;
}
'''
head = "#include <vector>\n#include <random>\n#include <algorithm>\n#include <cmath>\n#include <cstring>\n#include <cstdio>\n#include <chrono>\nstruct TokenProb { int id; float prob; };\n"
open(f'{w}/samp_test.cpp', 'w').write(head + stock + fast + main)
PY
g++ -O2 -o "$W/samp_test" "$W/samp_test.cpp"
"$W/samp_test"

// Tree-based speculative decoding with an EAGLE-3 draft head (greedy).
//
// Each cycle the draft head grows a token tree: a seed step predicts the next token, then each depth expands the
// K most probable frontier nodes (by cumulative log-probability), each node in its own draft sequence copied from
// its parent's. The NT most probable nodes form the tree. The target model verifies the whole tree in one batch:
// every leaf owns a sequence and each node is tagged with the sequences of the leaves below it, so with a unified KV
// cache a node attends exactly to the committed prefix and its ancestors. The longest path that matches the target's
// own greedy choices is accepted, plus the target's next token; the accepted path is copied into sequence 0 and all
// branch sequences are dropped. Output equals the target's greedy output (up to batch/single-token rounding).
//
//   --spec-draft-n-max D    tree depth (draft steps per cycle)
//   SUSHILA_TREE_K=8        frontier width per depth (top-k)
//   SUSHILA_TREE_NT=32      tree size (draft tokens verified per cycle)
//   SUSHILA_OUT=file        generated token ids, one per line

#include "arg.h"
#include "common.h"
#include "log.h"
#include "llama.h"
#include "speculative.h"
#include "../src/llama-ext.h"

#include <algorithm>
#include <clocale>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

struct node {
    llama_token tok;
    int         parent;   // index in nodes, -1: root
    int         depth;    // root 0
    float       score;    // cumulative log-probability under the draft
    int         dseq;     // draft sequence holding this node's ancestors (set when expanded)
    std::vector<float> prenorm;   // draft pre-norm state after this node (set when expanded)
};

// Top-k tokens with log-probabilities. One pass keeps the 32 largest logits (k <= 32); the normalizer is taken over
// them, which is exact up to the probability mass outside the top 32 (negligible for ranking draft branches).
static void topk_logprobs(const float * logits, int n_vocab, int k, std::vector<std::pair<float, llama_token>> & out) {
    constexpr int M = 32;
    float v[M]; llama_token id[M];
    int n = 0, imin = 0;
    for (int i = 0; i < n_vocab; i++) {
        const float x = logits[i];
        if (n < M) {
            v[n] = x; id[n] = i; n++;
            if (n == M) { imin = 0; for (int j = 1; j < M; j++) { if (v[j] < v[imin]) { imin = j; } } }
        } else if (x > v[imin]) {
            v[imin] = x; id[imin] = i;
            imin = 0; for (int j = 1; j < M; j++) { if (v[j] < v[imin]) { imin = j; } }
        }
    }
    float mx = -INFINITY;
    for (int j = 0; j < n; j++) { mx = std::max(mx, v[j]); }
    double s = 0;
    for (int j = 0; j < n; j++) { s += std::exp((double) v[j] - mx); }
    const float lse = mx + (float) std::log(s);
    out.clear();
    for (int j = 0; j < n; j++) { out.push_back({ v[j] - lse, id[j] }); }
    std::sort(out.begin(), out.end(), [](const auto & a, const auto & b) { return a.first > b.first; });
    if ((int) out.size() > k) { out.resize(k); }
}

int main(int argc, char ** argv) {
    std::setlocale(LC_NUMERIC, "C");
    common_params params;
    common_init();
    if (!common_params_parse(argc, argv, params, LLAMA_EXAMPLE_SPECULATIVE)) {
        return 1;
    }
    const int D  = std::max(1, params.speculative.draft.n_max);
    const int K  = getenv("SUSHILA_TREE_K")  ? atoi(getenv("SUSHILA_TREE_K"))  : 8;
    const int NT = getenv("SUSHILA_TREE_NT") ? atoi(getenv("SUSHILA_TREE_NT")) : 32;
    const int n_gen = params.n_predict > 0 ? params.n_predict : 256;
    // fusing the commit pairs into the next seed decode lowers acceptance (measured 4.55 -> 2.98 tokens/cycle): off by default
    const bool fuse = getenv("SUSHILA_TREE_FUSE") != nullptr && atoi(getenv("SUSHILA_TREE_FUSE")) != 0;
    // chain verification in sequence 0 only (no leaf sequences), to measure the cost of multi-sequence verification
    const bool one_seq = K == 1 && getenv("SUSHILA_TREE_ONESEQ") != nullptr;

    // target: one sequence per leaf (at most NT) plus the committed sequence 0, unified KV cache
    params.n_parallel = NT + 1;
    params.kv_unified = true;
    params.n_outputs_max = 0;
    params.n_outputs_max_per_seq = 0;
    llama_backend_init();
    llama_numa_init(params.numa);
    auto init_tgt = common_init_from_params(params);
    llama_model   * model_tgt = init_tgt->model();
    llama_context * ctx_tgt   = init_tgt->context();
    const llama_vocab * vocab = llama_model_get_vocab(model_tgt);
    const int n_vocab = llama_vocab_n_tokens(vocab);

    // draft: 2K scratch sequences (double-buffered frontier) plus sequence 0
    common_params params_d = params;
    params_d.n_parallel = 2 * K + 1;
    common_params pdft = common_base_params_to_speculative(params_d);
    auto init_dft = common_speculative_init_from_params(pdft, model_tgt, ctx_tgt);
    llama_context * ctx_dft = init_dft->context();
    GGML_ASSERT(ctx_dft && "draft context");
    const llama_model * model_dft = llama_get_model(ctx_dft);
    const int n_vocab_dft = llama_vocab_n_tokens(llama_model_get_vocab(model_dft));

    const int32_t * layer_ids = llama_model_target_layer_ids(model_dft);
    const uint32_t  n_layer_ids = llama_model_target_layer_ids_n(model_dft);
    GGML_ASSERT(n_layer_ids == 3 && "draft model is not EAGLE-3");
    const int n_layer_tgt = llama_model_n_layer(model_tgt);
    const int n_embd_tgt = llama_model_n_embd(model_tgt);
    const int n_embd_dec = llama_model_n_embd(model_dft);
    const int n_embd_enc = 3 * n_embd_tgt;
    for (uint32_t k = 0; k < n_layer_ids; k++) {
        if (layer_ids[k] < n_layer_tgt) { llama_set_embeddings_layer_inp(ctx_tgt, (uint32_t) layer_ids[k], true); }
        else                            { llama_set_embeddings_nextn(ctx_tgt, true, false); }
    }
    llama_set_embeddings_nextn(ctx_dft, true, true);
    llama_memory_t mem_tgt = llama_get_memory(ctx_tgt), mem_dft = llama_get_memory(ctx_dft);

    // target features of batch rows [rows] -> draft encoder output g [rows.size()][n_embd_dec]
    std::vector<float> feat, g;
    auto encode_rows = [&](const std::vector<int> & rows) -> bool {
        const int n = (int) rows.size();
        feat.assign((size_t) n * n_embd_enc, 0.0f);
        for (uint32_t k = 0; k < 3; k++) {
            const float * L = layer_ids[k] < n_layer_tgt ? llama_get_embeddings_layer_inp(ctx_tgt, (uint32_t) layer_ids[k])
                                                         : llama_get_embeddings_nextn(ctx_tgt);
            GGML_ASSERT(L);
            for (int i = 0; i < n; i++) {
                std::memcpy(feat.data() + (size_t) i * n_embd_enc + k * (size_t) n_embd_tgt, L + (size_t) rows[i] * n_embd_tgt,
                            sizeof(float) * n_embd_tgt);
            }
        }
        g.assign((size_t) n * n_embd_dec, 0.0f);
        const int ub = (int) llama_n_ubatch(ctx_dft);
        for (int i = 0; i < n; i += ub) {
            const int nc = std::min(ub, n - i);
            llama_batch eb = { nc, nullptr, feat.data() + (size_t) i * n_embd_enc, nullptr, nullptr, nullptr, nullptr };
            if (llama_encode(ctx_dft, eb) != 0) { return false; }
            std::memcpy(g.data() + (size_t) i * n_embd_dec, llama_get_embeddings_nextn(ctx_dft), sizeof(float) * nc * n_embd_dec);
        }
        return true;
    };

    // draft batch with both tokens and embeddings
    const int nb_dft = std::max((int) llama_n_batch(ctx_dft), 2 * K + 2);
    llama_batch bd = llama_batch_init(nb_dft, n_embd_dec, 1);
    bd.token = (llama_token *) malloc(sizeof(llama_token) * nb_dft);
    auto bd_add = [&](llama_token t, llama_pos p, llama_seq_id s, const float * e, bool logits) {
        common_batch_add(bd, t, p, { s }, logits);
        std::memcpy(bd.embd + (size_t) (bd.n_tokens - 1) * n_embd_dec, e, sizeof(float) * n_embd_dec);
    };

    // prompt: target, then draft pairs (token[P+1], g[P]) for P = 0..N-2; g[N-1] is the pending boundary
    std::vector<llama_token> inp = common_tokenize(ctx_tgt, params.prompt, true, true);
    const int N = (int) inp.size();
    GGML_ASSERT(N >= 2 && N <= (int) llama_n_batch(ctx_tgt));
    llama_batch bt = llama_batch_init(std::max(N, NT + 1), 0, NT + 1);
    for (int i = 0; i < N; i++) { common_batch_add(bt, inp[i], i, { 0 }, i == N - 1); }
    if (llama_decode(ctx_tgt, bt) != 0) { LOG_ERR("prompt decode failed\n"); return 1; }
    llama_token cur = (llama_token) (std::max_element(llama_get_logits_ith(ctx_tgt, N - 1), llama_get_logits_ith(ctx_tgt, N - 1) + n_vocab)
                                     - llama_get_logits_ith(ctx_tgt, N - 1));
    {
        std::vector<int> rows(N);
        for (int i = 0; i < N; i++) { rows[i] = i; }
        if (!encode_rows(rows)) { LOG_ERR("encode failed\n"); return 1; }
        common_batch_clear(bd);
        for (int p = 0; p <= N - 2; p++) { bd_add(inp[p + 1], p, 0, g.data() + (size_t) p * n_embd_dec, false); }
        if (bd.n_tokens > 0 && llama_decode(ctx_dft, bd) != 0) { LOG_ERR("draft prompt decode failed\n"); return 1; }
    }
    std::vector<float> pending(g.begin() + (size_t) (N - 1) * n_embd_dec, g.begin() + (size_t) N * n_embd_dec);
    int L = N;   // committed tokens 0..L-1 are in both caches; cur (position L) is not yet in the target cache
    // draft pairs of the last commit, decoded together with the next seed (one draft call instead of two)
    std::vector<llama_token> pend_tok;
    std::vector<llama_pos>   pend_pos;
    std::vector<float>       pend_g;

    std::vector<llama_token> out = { cur };
    int n_cycles = 0, n_accepted = 0, n_tree = 0;
    double us_draft = 0, us_verify = 0, us_commit = 0, us_vdec = 0;
    std::vector<std::pair<float, llama_token>> top;
    const int64_t t0 = ggml_time_us();
    while ((int) out.size() < n_gen && !llama_vocab_is_eog(vocab, cur)) {
        // ---- 1. draft a tree ----
        const int64_t c0 = ggml_time_us();
        std::vector<node> nodes;
        nodes.push_back({ cur, -1, 0, 0.0f, 0, {} });
        // seed: the last commit's pairs, then (cur, pending) at draft position L-1 in sequence 0 -> children of the root
        llama_memory_seq_rm(mem_dft, 0, pend_pos.empty() ? L - 1 : pend_pos[0], -1);
        common_batch_clear(bd);
        for (size_t i = 0; i < pend_tok.size(); i++) { bd_add(pend_tok[i], pend_pos[i], 0, pend_g.data() + i * n_embd_dec, false); }
        pend_tok.clear(); pend_pos.clear(); pend_g.clear();
        bd_add(cur, L - 1, 0, pending.data(), true);
        const int i_seed = bd.n_tokens - 1;
        if (llama_decode(ctx_dft, bd) != 0) { LOG_ERR("draft seed failed\n"); return 1; }
        nodes[0].prenorm.assign(llama_get_embeddings_nextn_ith(ctx_dft, i_seed), llama_get_embeddings_nextn_ith(ctx_dft, i_seed) + n_embd_dec);
        topk_logprobs(llama_get_logits_ith(ctx_dft, i_seed), n_vocab_dft, K, top);
        std::vector<int> frontier;
        for (auto & [lp, t] : top) { nodes.push_back({ t, 0, 1, lp, -1, {} }); frontier.push_back((int) nodes.size() - 1); }
        int buf = 0;
        for (int d = 1; d < D; d++) {
            // expand the K best frontier nodes, each in a fresh draft sequence copied from its parent's
            std::sort(frontier.begin(), frontier.end(), [&](int a, int b) { return nodes[a].score > nodes[b].score; });
            if ((int) frontier.size() > K) { frontier.resize(K); }
            common_batch_clear(bd);
            for (size_t j = 0; j < frontier.size(); j++) {
                node & x = nodes[frontier[j]];
                const llama_seq_id s = 1 + buf * K + (llama_seq_id) j;
                llama_memory_seq_rm(mem_dft, s, -1, -1);
                llama_memory_seq_cp(mem_dft, nodes[x.parent].dseq, s, -1, -1);
                x.dseq = s;
                bd_add(x.tok, L - 1 + x.depth, s, nodes[x.parent].prenorm.data(), true);
            }
            if (llama_decode(ctx_dft, bd) != 0) { LOG_ERR("draft step failed\n"); return 1; }
            std::vector<int> next;
            for (size_t j = 0; j < frontier.size(); j++) {
                const int xi = frontier[j];
                nodes[xi].prenorm.assign(llama_get_embeddings_nextn_ith(ctx_dft, (int) j), llama_get_embeddings_nextn_ith(ctx_dft, (int) j) + n_embd_dec);
                topk_logprobs(llama_get_logits_ith(ctx_dft, (int) j), n_vocab_dft, K, top);
                for (auto & [lp, t] : top) { nodes.push_back({ t, xi, nodes[xi].depth + 1, nodes[xi].score + lp, -1, {} }); next.push_back((int) nodes.size() - 1); }
            }
            frontier.swap(next);
            buf ^= 1;
        }
        for (llama_seq_id s = 1; s <= 2 * K; s++) { llama_memory_seq_rm(mem_dft, s, -1, -1); }

        // keep the NT most probable nodes (ancestors are at least as probable, ties broken by depth)
        std::vector<int> cand;
        for (int i = 1; i < (int) nodes.size(); i++) { cand.push_back(i); }
        std::sort(cand.begin(), cand.end(), [&](int a, int b) {
            return nodes[a].score != nodes[b].score ? nodes[a].score > nodes[b].score : nodes[a].depth < nodes[b].depth; });
        if ((int) cand.size() > NT) { cand.resize(NT); }
        std::vector<char> in_tree(nodes.size(), 0);
        in_tree[0] = 1;
        for (int i : cand) { in_tree[i] = 1; }
        std::vector<int> tree = { 0 };   // BFS order by depth
        for (int dd = 1; dd <= D; dd++) { for (int i : cand) { if (nodes[i].depth == dd && in_tree[nodes[i].parent]) { tree.push_back(i); } } }
        std::vector<int> row_of(nodes.size(), -1);
        for (size_t r = 0; r < tree.size(); r++) { row_of[tree[r]] = (int) r; }
        std::vector<char> has_child(nodes.size(), 0);
        for (size_t r = 1; r < tree.size(); r++) { has_child[nodes[tree[r]].parent] = 1; }

        const int64_t c1 = ggml_time_us();
        // ---- 2. verify the tree in one target batch ----
        std::vector<std::vector<llama_seq_id>> seqs(tree.size());
        llama_seq_id n_leaf = 0;
        for (size_t r = 1; r < tree.size(); r++) {
            if (has_child[tree[r]]) { continue; }
            if (one_seq) { continue; }
            const llama_seq_id s = ++n_leaf;
            for (int x = tree[r]; x >= 0; x = nodes[x].parent) { seqs[row_of[x]].push_back(s); }
            llama_memory_seq_rm(mem_tgt, s, -1, -1);
            llama_memory_seq_cp(mem_tgt, 0, s, -1, -1);
        }
        seqs[0].push_back(0);
        if (one_seq) { for (size_t r = 1; r < tree.size(); r++) { seqs[r] = { 0 }; } }
        common_batch_clear(bt);
        for (size_t r = 0; r < tree.size(); r++) { common_batch_add(bt, nodes[tree[r]].tok, L + nodes[tree[r]].depth, seqs[r], true); }
        const int64_t cd0 = ggml_time_us();
        if (llama_decode(ctx_tgt, bt) != 0) { LOG_ERR("verify decode failed\n"); return 1; }
        llama_synchronize(ctx_tgt);
        us_vdec += ggml_time_us() - cd0;

        // walk the tree along the target's greedy choices
        std::vector<int> acc_rows = { 0 };
        int x = 0;
        llama_token next_tok;
        for (;;) {
            const float * lg = llama_get_logits_ith(ctx_tgt, row_of[x]);
            next_tok = (llama_token) (std::max_element(lg, lg + n_vocab) - lg);
            int child = -1;
            for (size_t r = 1; r < tree.size(); r++) { if (nodes[tree[r]].parent == x && nodes[tree[r]].tok == next_tok) { child = tree[r]; break; } }
            if (child < 0 || llama_vocab_is_eog(vocab, next_tok)) { break; }
            out.push_back(next_tok);
            acc_rows.push_back(row_of[child]);
            x = child;
            if ((int) out.size() >= n_gen) { break; }
        }
        const int m = (int) acc_rows.size() - 1;
        const int64_t c2 = ggml_time_us();
        n_cycles++; n_accepted += m; n_tree += (int) tree.size() - 1;

        // ---- 3. commit: accepted path into sequence 0, drop the branches ----
        if (one_seq) {
            llama_memory_seq_rm(mem_tgt, 0, L + m + 1, -1);
        } else if (m > 0) {
            llama_seq_id s_star = -1;
            for (size_t r = 1; r < tree.size(); r++) {   // any leaf below the deepest accepted node
                if (!has_child[tree[r]]) {
                    for (int y = tree[r]; y >= 0; y = nodes[y].parent) { if (y == x) { s_star = seqs[row_of[tree[r]]][0]; break; } }
                }
                if (s_star >= 0) { break; }
            }
            GGML_ASSERT(s_star > 0);
            llama_memory_seq_cp(mem_tgt, s_star, 0, L + 1, L + m + 1);
        }
        for (llama_seq_id s = 1; s <= n_leaf; s++) { llama_memory_seq_rm(mem_tgt, s, -1, -1); }

        // draft: pairs (token[P+1], g[P]) for the root and accepted nodes, P = L .. L+m-1; g[L+m] becomes pending
        if (!encode_rows(acc_rows)) { LOG_ERR("encode failed\n"); return 1; }
        for (int i = 0; i < m; i++) {   // decoded with the next seed
            pend_tok.push_back(nodes[tree[acc_rows[i + 1]]].tok);
            pend_pos.push_back(L + i);
            pend_g.insert(pend_g.end(), g.begin() + (size_t) i * n_embd_dec, g.begin() + (size_t) (i + 1) * n_embd_dec);
        }
        if (!fuse && !pend_tok.empty()) {   // reference: decode the commit pairs now
            common_batch_clear(bd);
            for (size_t i = 0; i < pend_tok.size(); i++) { bd_add(pend_tok[i], pend_pos[i], 0, pend_g.data() + i * n_embd_dec, false); }
            if (llama_decode(ctx_dft, bd) != 0) { LOG_ERR("draft commit failed\n"); return 1; }
            pend_tok.clear(); pend_pos.clear(); pend_g.clear();
        }
        pending.assign(g.begin() + (size_t) m * n_embd_dec, g.begin() + (size_t) (m + 1) * n_embd_dec);

        L += m + 1;
        cur = next_tok;
        const int64_t c3 = ggml_time_us();
        us_draft += c1 - c0; us_verify += c2 - c1; us_commit += c3 - c2;
        if ((int) out.size() < n_gen) { out.push_back(cur); }
    }
    const double dt = (ggml_time_us() - t0) / 1e6;

    std::string text;
    for (auto id : out) { text += common_token_to_piece(ctx_tgt, id); }
    LOG("\n%s\n\n", text.c_str());
    LOG_INF("sushila-tree: depth=%d k=%d nt=%d generated %zu tokens in %.3f s, %.3f t/s; cycles=%d accepted/cycle=%.2f tokens/cycle=%.2f tree=%.1f\n",
            D, K, NT, out.size(), dt, (out.size() - 1) / dt, n_cycles, n_cycles ? (double) n_accepted / n_cycles : 0.0,
            n_cycles ? (double) (n_accepted + n_cycles) / n_cycles : 0.0, n_cycles ? (double) n_tree / n_cycles : 0.0);
    if (n_cycles > 0) {
        LOG_INF("sushila-tree: ms/cycle draft %.2f verify %.2f (target decode %.2f) commit %.2f\n", us_draft / n_cycles / 1e3, us_verify / n_cycles / 1e3, us_vdec / n_cycles / 1e3, us_commit / n_cycles / 1e3);
    }
    if (const char * f = getenv("SUSHILA_OUT")) {
        FILE * fo = fopen(f, "w");
        for (auto id : out) { fprintf(fo, "%d\n", id); }
        fclose(fo);
    }
    free(bd.token);
    bd.token = nullptr;
    llama_batch_free(bd);
    llama_batch_free(bt);
    llama_backend_free();
    return 0;
}

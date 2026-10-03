// Self-speculative greedy decoding with an input-sparse draft (SUSHILA portfolio algorithm).
//
// The model drafts --draft-max tokens with the input-sparse kernel on (GGML_SPARSE, landscape-sparse.h), then
// verifies them in one batch with the stock kernels and keeps the longest prefix that matches its own greedy choice,
// plus the next token. Every emitted token is the stock model's greedy token given the emitted prefix, so the output
// is the stock greedy output (up to floating-point differences between batch and single-token kernels). Only one
// model and one KV cache are used: draft entries are overwritten by the verification batch.
//
//   --draft-max 0          plain greedy decoding with the sparse kernel off (reference speed and output)
//   SUSHILA_LOSSY=1        plain greedy decoding with the sparse kernel on (approximate output)
//   SUSHILA_OUT=file       write the generated token ids (one per line)

#include "arg.h"
#include "common.h"
#include "log.h"
#include "llama.h"
#include "ggml-cpu.h"

#include <algorithm>
#include <clocale>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

static llama_token argmax(llama_context * ctx, int i, int n_vocab) {
    const float * z = llama_get_logits_ith(ctx, i);
    return (llama_token) (std::max_element(z, z + n_vocab) - z);
}

int main(int argc, char ** argv) {
    std::setlocale(LC_NUMERIC, "C");
    common_params params;
    common_init();
    if (!common_params_parse(argc, argv, params, LLAMA_EXAMPLE_SPECULATIVE)) {
        return 1;
    }
    params.n_outputs_max = 0;           // every token of a verification batch needs its logits
    params.n_outputs_max_per_seq = 0;
    llama_backend_init();
    llama_numa_init(params.numa);
    auto init = common_init_from_params(params);
    llama_model   * model = init->model();
    llama_context * ctx   = init->context();
    const llama_vocab * vocab = llama_model_get_vocab(model);
    const int n_vocab = llama_vocab_n_tokens(vocab);
    llama_memory_t mem = llama_get_memory(ctx);

    const int  k     = params.speculative.draft.n_max;
    const bool lossy = getenv("SUSHILA_LOSSY") != nullptr;
    const int  n_gen = params.n_predict > 0 ? params.n_predict : 256;

    std::vector<llama_token> inp = common_tokenize(ctx, params.prompt, true, true);
    GGML_ASSERT((int) inp.size() + n_gen + k + 1 < (int) llama_n_ctx(ctx) && (int) inp.size() <= (int) llama_n_batch(ctx));

    // prompt: stock kernels (the sparse kernel only handles one-token matmuls anyway)
    ggml_cpu_sparse_set_enabled(false);
    llama_batch batch = llama_batch_init(std::max((int) inp.size(), k + 1), 0, 1);
    common_batch_clear(batch);
    for (size_t i = 0; i < inp.size(); i++) { common_batch_add(batch, inp[i], (llama_pos) i, { 0 }, i + 1 == inp.size()); }
    if (llama_decode(ctx, batch) != 0) { LOG_ERR("prompt decode failed\n"); return 1; }
    llama_token cur = argmax(ctx, batch.n_tokens - 1, n_vocab);
    llama_pos   pos = (llama_pos) inp.size();       // position of cur

    if (getenv("GGML_SPARSE") && (k > 0 || lossy)) {
        // warm-up: one sparse decode builds the column-major copies (once per weight), then is discarded
        const int64_t tw = ggml_time_us();
        ggml_cpu_sparse_set_enabled(true);
        common_batch_clear(batch);
        common_batch_add(batch, cur, pos, { 0 }, true);
        if (llama_decode(ctx, batch) != 0) { LOG_ERR("warm-up decode failed\n"); return 1; }
        llama_memory_seq_rm(mem, 0, pos, -1);
        ggml_cpu_sparse_set_enabled(false);
        LOG_INF("sushila-spec: copies built in %.1f s (not counted)\n", (ggml_time_us() - tw) / 1e6);
    }

    std::vector<llama_token> out = { cur };
    int n_drafted = 0, n_accept = 0, n_cycles = 0;
    const int64_t t0 = ggml_time_us();
    while ((int) out.size() < n_gen && !llama_vocab_is_eog(vocab, cur)) {
        if (k == 0 || lossy) {
            ggml_cpu_sparse_set_enabled(lossy);
            common_batch_clear(batch);
            common_batch_add(batch, cur, pos, { 0 }, true);
            if (llama_decode(ctx, batch) != 0) { LOG_ERR("decode failed\n"); return 1; }
            cur = argmax(ctx, 0, n_vocab);
            pos++;
            out.push_back(cur);
            continue;
        }
        // 1. draft k tokens with the sparse kernel
        ggml_cpu_sparse_set_enabled(true);
        std::vector<llama_token> draft;
        llama_token t = cur;
        for (int i = 0; i < k; i++) {
            common_batch_clear(batch);
            common_batch_add(batch, t, pos + i, { 0 }, true);
            if (llama_decode(ctx, batch) != 0) { LOG_ERR("draft decode failed\n"); return 1; }
            t = argmax(ctx, 0, n_vocab);
            draft.push_back(t);
            if (llama_vocab_is_eog(vocab, t)) { break; }
        }
        // 2. verify [cur, d1..dk] in one batch with the stock kernels, over the draft's KV entries
        ggml_cpu_sparse_set_enabled(false);
        llama_memory_seq_rm(mem, 0, pos, -1);
        common_batch_clear(batch);
        common_batch_add(batch, cur, pos, { 0 }, true);
        for (size_t i = 0; i < draft.size(); i++) { common_batch_add(batch, draft[i], pos + 1 + (llama_pos) i, { 0 }, true); }
        if (llama_decode(ctx, batch) != 0) { LOG_ERR("verify decode failed\n"); return 1; }
        // 3. keep the matching prefix and the model's own next token
        int m = 0;
        llama_token next = argmax(ctx, 0, n_vocab);
        while (m < (int) draft.size() && draft[m] == next) {
            out.push_back(next);
            m++;
            next = argmax(ctx, m, n_vocab);
            if (llama_vocab_is_eog(vocab, out.back()) || (int) out.size() >= n_gen) { break; }
        }
        n_drafted += (int) draft.size();
        n_accept  += m;
        n_cycles++;
        if (llama_vocab_is_eog(vocab, out.back()) || (int) out.size() >= n_gen) { cur = out.back(); break; }
        out.push_back(next);
        // KV entries for positions pos .. pos + m (cur and the accepted drafts) are exact; drop the rest
        llama_memory_seq_rm(mem, 0, pos + m + 1, -1);
        cur = next;
        pos += m + 1;
    }
    const double dt = (ggml_time_us() - t0) / 1e6;

    std::string text;
    for (auto id : out) { text += common_token_to_piece(ctx, id); }
    LOG("\n%s\n\n", text.c_str());
    LOG_INF("sushila-spec: mode=%s generated %zu tokens in %.3f s, %.3f t/s\n",
            lossy ? "lossy-sparse" : (k == 0 ? "stock" : "self-speculative"), out.size(), dt, (out.size() - 1) / dt);
    if (k > 0 && !lossy) {
        LOG_INF("sushila-spec: draft-max=%d cycles=%d drafted=%d accepted=%d accept=%.3f tokens/cycle=%.2f\n",
                k, n_cycles, n_drafted, n_accept, n_drafted ? (double) n_accept / n_drafted : 0.0,
                n_cycles ? (double) (n_accept + n_cycles) / n_cycles : 0.0);
    }
    if (const char * f = getenv("SUSHILA_OUT")) {
        FILE * fo = fopen(f, "w");
        for (auto id : out) { fprintf(fo, "%d\n", id); }
        fclose(fo);
    }
    llama_batch_free(batch);
    llama_backend_free();
    return 0;
}

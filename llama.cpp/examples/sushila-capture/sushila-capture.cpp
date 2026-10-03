// Capture EAGLE-3 training features from the model file users actually run (e.g. a 4-bit GGUF), for a day-0 draft
// head fitted to that file. For each token sequence: the outputs of three layers (the draft head's inputs) and the
// final normalized hidden state (the target logits come from it), as bf16.
//
//   SUSHILA_IN=tokens.bin      records: int32 n, then n int32 token ids
//   SUSHILA_OUT=features.bin   records: int32 n, int32 h, then n x 3h bf16 (layers), then n x h bf16 (final)
//   SUSHILA_LAYERS=1,15,28     layers whose outputs are captured (default: 1, n_layer/2 - 1, n_layer - 4, as SpecForge)

#include "arg.h"
#include "common.h"
#include "log.h"
#include "llama.h"
#include "ggml.h"
#include "ggml-backend.h"

#include <clocale>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

struct capture {
    std::vector<std::string>          names;   // l_out-a, l_out-b, l_out-c, result_norm
    std::vector<std::vector<float>>   data;    // per name: [n_tokens][h]
    std::vector<bool>                 seen;
};

static bool cb_eval(struct ggml_tensor * t, bool ask, void * user_data) {
    auto * c = (capture *) user_data;
    int k = -1;
    for (size_t i = 0; i < c->names.size(); i++) { if (c->names[i] == t->name) { k = (int) i; } }
    if (ask) {
        return k >= 0;
    }
    if (k < 0) {
        return true;
    }
    GGML_ASSERT(t->type == GGML_TYPE_F32 && ggml_is_contiguous(t));
    c->data[k].resize(ggml_nelements(t));
    ggml_backend_tensor_get(t, c->data[k].data(), 0, ggml_nbytes(t));
    c->seen[k] = true;
    return true;
}

int main(int argc, char ** argv) {
    std::setlocale(LC_NUMERIC, "C");
    common_params params;
    common_init();
    if (!common_params_parse(argc, argv, params, LLAMA_EXAMPLE_COMMON)) {
        return 1;
    }
    const char * in_path = getenv("SUSHILA_IN"), * out_path = getenv("SUSHILA_OUT");
    if (!in_path || !out_path) { LOG_ERR("set SUSHILA_IN and SUSHILA_OUT\n"); return 1; }

    capture cap;
    params.cb_eval = cb_eval;
    params.cb_eval_user_data = &cap;
    params.n_outputs_max = 0;                 // every token needs its final hidden state
    params.n_outputs_max_per_seq = 0;
    params.warmup = false;
    llama_backend_init();
    llama_numa_init(params.numa);

    auto init = common_init_from_params(params);
    llama_context * ctx = init->context();
    {   // the callback only fires while decoding, so the names can be set once the model is loaded
        const int nl = llama_model_n_layer(init->model());
        std::vector<int> layers = { 1, nl / 2 - 1, nl - 4 };
        if (const char * s = getenv("SUSHILA_LAYERS")) {
            layers.clear();
            for (const char * p = s; *p; ) { layers.push_back(atoi(p)); while (*p && *p != ',') { p++; } if (*p) { p++; } }
        }
        GGML_ASSERT(layers.size() == 3);
        for (int l : layers) { cap.names.push_back("l_out-" + std::to_string(l)); }
        cap.names.push_back("result_norm");
        cap.data.resize(cap.names.size());
        cap.seen.resize(cap.names.size());
    }
    const int h = llama_model_n_embd(init->model());
    llama_memory_t mem = llama_get_memory(ctx);

    FILE * fi = fopen(in_path, "rb"), * fo = fopen(out_path, "wb");
    GGML_ASSERT(fi && fo);
    llama_batch batch = llama_batch_init((int) llama_n_batch(ctx), 0, 1);
    std::vector<int32_t> toks;
    std::vector<uint16_t> row;
    int32_t n;
    int n_rec = 0, n_skip = 0;
    const int64_t t0 = ggml_time_us();
    while (fread(&n, 4, 1, fi) == 1) {
        toks.resize(n);
        GGML_ASSERT(fread(toks.data(), 4, n, fi) == (size_t) n);
        if (n > (int) llama_n_batch(ctx) || n > (int) llama_n_ubatch(ctx)) { n_skip++; continue; }
        llama_memory_clear(mem, true);
        common_batch_clear(batch);
        for (int i = 0; i < n; i++) { common_batch_add(batch, toks[i], i, { 0 }, true); }
        std::fill(cap.seen.begin(), cap.seen.end(), false);
        if (llama_decode(ctx, batch) != 0) { LOG_ERR("decode failed on record %d\n", n_rec); return 1; }
        for (size_t k = 0; k < cap.names.size(); k++) {
            if (!cap.seen[k] || (int64_t) cap.data[k].size() != (int64_t) n * h) {
                LOG_ERR("tensor %s not captured for all %d tokens\n", cap.names[k].c_str(), n);
                return 1;
            }
        }
        fwrite(&n, 4, 1, fo);
        fwrite(&h, 4, 1, fo);
        row.resize((size_t) 3 * h);
        for (int i = 0; i < n; i++) {            // n x 3h: the three layers concatenated per token
            for (int k = 0; k < 3; k++) {
                const float * src = cap.data[k].data() + (size_t) i * h;
                for (int j = 0; j < h; j++) { row[(size_t) k * h + j] = ggml_fp32_to_bf16(src[j]).bits; }
            }
            fwrite(row.data(), 2, (size_t) 3 * h, fo);
        }
        row.resize(h);
        for (int i = 0; i < n; i++) {            // n x h: final normalized state
            const float * src = cap.data[3].data() + (size_t) i * h;
            for (int j = 0; j < h; j++) { row[j] = ggml_fp32_to_bf16(src[j]).bits; }
            fwrite(row.data(), 2, h, fo);
        }
        n_rec++;
    }
    fclose(fi);
    fclose(fo);
    LOG_INF("sushila-capture: %d records (%d skipped as longer than the batch) in %.1f s; layers %s %s %s\n", n_rec, n_skip,
            (ggml_time_us() - t0) / 1e6, cap.names[0].c_str(), cap.names[1].c_str(), cap.names[2].c_str());
    llama_batch_free(batch);
    llama_backend_free();
    return 0;
}

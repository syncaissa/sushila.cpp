#include "sushila.h"

#include "common.h"
#include "log.h"

#include <nlohmann/json.hpp>

extern "C" {
#include "hash/sha256/sha256.h"
}

#include <sys/stat.h>
#ifndef S_ISREG
#define S_ISREG(m) (((m) & S_IFMT) == S_IFREG)
#endif

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

std::string sha256_file(const std::string & path) {
    FILE * f = fopen(path.c_str(), "rb");
    if (!f) { return ""; }
    sha256_t ctx;
    sha256_init(&ctx);
    std::vector<unsigned char> chunk(8 << 20);
    size_t r;
    while ((r = fread(chunk.data(), 1, chunk.size(), f)) > 0) { sha256_update(&ctx, chunk.data(), r); }
    fclose(f);
    unsigned char d[32];
    sha256_final(&ctx, d);
    char out[65];
    for (int i = 0; i < 32; i++) { snprintf(out + 2 * i, 3, "%02x", d[i]); }
    return std::string(out, 64);
}

bool file_stat(const std::string & path, long long & size, long long & mtime) {
    struct stat st;
    if (stat(path.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) { return false; }
    size = (long long) st.st_size; mtime = (long long) st.st_mtime;
    return true;
}

bool is_file(const std::string & path) { long long s, m; return file_stat(path, s, m); }

std::string basename_of(const std::string & p) {
    size_t i = p.find_last_of("/\\");
    return i == std::string::npos ? p : p.substr(i + 1);
}

std::string dirname_of(const std::string & p) {
    size_t i = p.find_last_of("/\\");
    return i == std::string::npos ? "." : p.substr(0, i);
}

// The model file is checked against the manifest's sha256 once; the result is cached next to the manifest,
// keyed by the model's size and modification time, so later runs start instantly.
bool model_matches(const std::string & model, const std::string & dir, const std::string & want) {
    long long size, mtime;
    if (!file_stat(model, size, mtime)) { return false; }
    const char * v = getenv("SUSHILA_VERIFY");
    if (v && strcmp(v, "0") == 0) { return true; }
    const std::string stamp = dir + "/.verified-" + want.substr(0, 16);
    const std::string key = std::to_string(size) + " " + std::to_string(mtime);
    {
        std::ifstream in(stamp);
        std::string line;
        if (in && std::getline(in, line) && line == key) { return true; }
    }
    LOG_INF("sushila: checking %s against its precomputed artifacts (once; cached afterwards)...\n", basename_of(model).c_str());
    if (sha256_file(model) != want) { return false; }
    std::ofstream out(stamp);
    if (out) { out << key << "\n"; }
    return true;
}

std::string find_manifest(const std::string & model) {
    std::vector<std::string> dirs;
    if (const char * d = getenv("SUSHILA_ARTIFACTS")) { dirs.emplace_back(d); }
    dirs.push_back(model + ".sushila");
    std::string stem = basename_of(model);
    if (stem.size() > 5 && stem.compare(stem.size() - 5, 5, ".gguf") == 0) {
        dirs.push_back(dirname_of(model) + "/" + stem.substr(0, stem.size() - 5) + ".sushila");
    }
    for (const auto & d : dirs) {
        if (is_file(d + "/manifest.json")) { return d; }
    }
    return "";
}

void set_env(const char * name, const std::string & value) {
#ifdef _WIN32
    _putenv_s(name, value.c_str());
#else
    setenv(name, value.c_str(), 1);
#endif
}

} // namespace

void common_sushila_apply(common_params & params) {
    const std::string model = params.model.path;
    if (model.empty() || !is_file(model)) {
        return;  // nothing loaded from a local file yet (e.g. router mode); the engine runs as usual
    }
    const std::string name = basename_of(model);
    const char * off = getenv("SUSHILA");
    if (off && strcmp(off, "0") == 0) {
        LOG_INF("sushila: precomputed artifacts turned off (SUSHILA=0); using the original workflow\n");
        return;
    }
    const std::string dir = find_manifest(model);
    if (dir.empty()) {
        LOG_INF("sushila: no precomputed artifacts found for %s; using the original workflow\n", name.c_str());
        return;
    }
    try {
        std::ifstream in(dir + "/manifest.json");
        const json m = json::parse(in);
        const std::string want = m.value("model_sha256", "");
        if (want.size() != 64 || !model_matches(model, dir, want)) {
            LOG_INF("sushila: the precomputed artifacts in %s are for a different model file; using the original workflow\n", dir.c_str());
            return;
        }
        std::vector<std::string> used;

        // output-layer landscape (preview mode); a value the user exported already is left alone
        if (m.value("mode", "") == "preview" && m.contains("landscape")) {
            const std::string ls = dir + "/" + m.value("landscape", "");
            if (getenv("GGML_LANDSCAPE")) {
                used.push_back("output-layer landscape set by GGML_LANDSCAPE");
            } else if (is_file(ls) && (!m.contains("landscape_sha256") || sha256_file(ls) == m.value("landscape_sha256", ""))) {
                set_env("GGML_LANDSCAPE", ls);
                set_env("GGML_LANDSCAPE_W", std::to_string(m.value("width", 0)));
                set_env("GGML_LANDSCAPE_N", std::to_string(m.value("candidates", 0)));
                set_env("GGML_LANDSCAPE_PREVIEW_TYPE", m.value("preview_type", "q8_0"));
                used.push_back("output-layer landscape (preview " + std::to_string(m.value("width", 0)) + ", " +
                               std::to_string(m.value("candidates", 0)) + " candidates)");
            } else {
                LOG_INF("sushila: landscape file in %s is missing or changed; skipping it\n", dir.c_str());
            }
        }

        // draft model or draft head chosen for this model; only if the user did not ask for speculative decoding
        if (m.contains("draft_model") && !params.speculative.has_dft()) {
            const std::string dm = dir + "/" + m.value("draft_model", "");
            if (is_file(dm) && (!m.contains("draft_sha256") || sha256_file(dm) == m.value("draft_sha256", ""))) {
                const std::string type = m.value("draft_type", "simple");
                params.speculative.draft.mparams.path = dm;
                params.speculative.types = { type == "eagle3" ? COMMON_SPECULATIVE_TYPE_DRAFT_EAGLE3 : COMMON_SPECULATIVE_TYPE_DRAFT_SIMPLE };
                params.speculative.draft.n_max = m.value("draft_n_max", params.speculative.draft.n_max);
                used.push_back(std::string(type == "eagle3" ? "draft head " : "draft model ") + basename_of(dm) +
                               " (up to " + std::to_string(params.speculative.draft.n_max) + " tokens)");
            } else {
                LOG_INF("sushila: draft file in %s is missing or changed; skipping it\n", dir.c_str());
            }
        }

        if (used.empty()) {
            LOG_INF("sushila: no usable precomputed artifacts for %s; using the original workflow\n", name.c_str());
            return;
        }
        std::string list;
        for (size_t i = 0; i < used.size(); i++) { list += (i ? ", " : "") + used[i]; }
        LOG_INF("sushila: using precomputed artifacts for %s: %s\n", name.c_str(), list.c_str());
    } catch (const std::exception & e) {
        LOG_INF("sushila: could not read %s/manifest.json (%s); using the original workflow\n", dir.c_str(), e.what());
    }
}

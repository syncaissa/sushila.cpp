#pragma once

// Sushila: precomputed artifacts (output-layer landscapes, draft heads) for a model file, found automatically.
//
// After the command line is parsed, common_sushila_apply() looks for a manifest.json next to the model:
//   $SUSHILA_ARTIFACTS/manifest.json        (a directory given explicitly)
//   <model file>.sushila/manifest.json      (e.g. llama3.1-8b.gguf.sushila/)
//   <model dir>/<model stem>.sushila/manifest.json
// The manifest binds the artifacts to one model file by sha256 (checked once, then cached by size and mtime).
// When it matches, the artifacts are enabled; otherwise one console line says so and the stock engine runs unchanged:
//   "sushila: no precomputed artifacts found for <model>; using the original workflow"
// Nothing here ever stops a run. SUSHILA=0 turns the lookup off.

struct common_params;

void common_sushila_apply(common_params & params);

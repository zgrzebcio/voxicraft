<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.

## Project layout (since alpha 0.0605)

The game is split into classic deferred scripts sharing one global scope (NOT ES modules — no import/export between game files). index.html holds only HTML + a THREE-global shim; styles in `css/style.css`; code in `js/` in load order:

`00-config` (clampi + settings) · `01-textures-data` (base64 blobs) · `02-voxel-core` (VOXEL_CORE + WORKER_MAIN, stringified into the worker — must stay closure-free) · `03-atlas` · `04-materials` (shaders) · `05-icons` · `06-renderer` · `07-sky` · `08-light-glow` · `09-light-sky` · `10-workers` · `11-chunks` (chunk manager + get/setBlock) · `12-player` (physics) · `13-actions` (break/place + slot model) · `14-mining` · `15-drops` · `16-worlds` (saves/menus) · `17-input` · `18-hud` · `19-vitals` · `20-inventory-ui` · `21-spawn` · `22-main-loop` · `23-boot`

Rules: top-level init code that calls a function must live in a file numbered AFTER the definition (no cross-file hoisting). Bump the `#version` div in index.html on every change (~100 changed lines = +0.0001).
<!-- CODEGRAPH_END -->

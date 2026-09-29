# Figure 3D semantics

User-facing behaviour (X-ray, colour modes, value fields, Shape/Frame) is described in
[Figure mode](../modes/figure.qmd#3d-models). The implementation keeps these rules:

- X-ray and the Inspector share the ordinary part adapters; several selected models
  expose their common parts. Composite colorbars, legends and scale bars keep their
  data colours when only their text colour changes.
- **Uniform** colour takes precedence over part colours. Switching to source colours
  is an explicit action because it can restore source colours on sibling meshes.
- Value-field edits recolour directly and never execute Python. Min/Max clamp at the
  other endpoint; equal limits are allowed and normalize exactly as the Python source
  does. A field edit selects source colours; explicit part fills survive, and the
  visible Reset part colour action removes the inherited fills that hide a field.

Shape controls use stored GLB target names and optional manifest labels. Stored finite
weights stay unclamped (only the UI inputs cover 0–1); out-of-range combinations read
**Custom** and round-trip through persistence. A sequence's Frame is derived from the
ordered targets and never persisted. Reset restores valid source defaults, ignoring
names absent from the GLB. A drag or wheel edit is one undo transaction.

## Shared interfaces

- `semanticOps.ts`: `setModelField`, `setModelStates`, `setModelFrame`,
  `modelFrame`, `modelDefaultStates` and `modelStateWeight` are pure functions.
- `parts.ts`: `buildScene3dPartIndex` returns an effective index without changing
  source metadata. Explicit source parents remain authoritative. Synthetic IDs
  use reserved `@series:…`, `@field:…`, `@axes:x/y/z` and `@axes` namespaces.
  These cannot collide with contract-valid authored part IDs.
- `scene3dPartLineage` returns parent-first ancestry. `scene3dPartTargets`
  resolves concrete descendant mesh/furniture IDs for future animation and
  headless authoring. Parent fill is inherited, opacity multiplies, and a hidden
  parent hides its subtree. A local `hidden:false` can restore a source-hidden
  part; it does not override a hidden ancestor.
- `resolveScene3dPartStyle` accepts an optional prebuilt index. Renderer,
  furniture, poster keys and tree traversal build once per batch.
- Prototype-like GLB names remain ordinary own keys in state/override/poster
  maps. The schema and public source files are never rewritten by indexing.

The renderer still uses one context. Mesh poster keys include effective mesh
styles, fields and weights; furniture-only edits stay out of the mesh key.
Furniture is physical vector text/lines. At a perspective near-plane crossing,
invalid/crossing panes and edges are omitted so the SVG remains finite; this
is conservative visibility rather than polygon clipping at the near plane.

## Verification

Use scratch HOME/XDG and `FLUX_NO_MIGRATE=1`. Start a private Vite server with
`FLUX_URL` on a free port at least 1441, then run:

```
node scripts/run-verifies.mjs --group model3d-semantics
node scripts/run-verifies.mjs --group model3d-xray
node scripts/run-verifies.mjs --tier pure --only model3d-render-browser
```

The render gate self-hosts port 1443; reserve it before running. The UI gate
imports scratch fixtures through the public import path and uses real part
colour editing, X-ray eyes/common rows, field typing/picker, furniture fonts,
and Shape/Frame inputs with history assertions. The browser renderer gate checks unchanged
sibling pixels, effective parent fill/opacity/hide and source metadata identity.
Stage B animation remains deferred; this does not enable model3d in old decks.

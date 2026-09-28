# Figure 3D semantics

Select a model and press **Alt+R** to open its X-ray. The shared tree lists
named mesh parts, series, value fields with their missing part and colorbar,
and axes and other furniture. Multiple selected models expose common parts.
The eye and **x** hide a part; **Show Properties** or **f** opens the same part
controls used by the Inspector. A mesh exposes colour, opacity and visibility.
Text furniture exposes font and text colour; lines expose stroke controls.
Composite colorbars, legends and scale bars keep their data colours when their
text colour changes.

**Uniform** colour has precedence over part colours. Mesh part controls explain
this and offer **Use source colours** before a part colour can be edited. The
switch is explicit because it can restore source colours on sibling meshes.

Value fields use the existing colormap collection picker and Min/Max controls.
They recolour directly; they do not execute Python. Min/Max edits clamp at the
other endpoint. Equal limits are allowed and map to colormap zero, matching the
source/Python behavior. Editing a field selects Source colours. Explicit part
fills remain; a visible Reset part colour action removes the affected inherited
fill overrides when the field is hidden by them. Reset restores source field
settings.

The Shape block uses stored GLB target names and optional manifest labels.
Each weight has a slider and numeric input in the 0–1 UI range. Stored finite
weights remain unclamped for authored extrapolation; out-of-range combinations
read Custom and round-trip through persistence. A sequence's Frame is derived:
zero is the base, 1…N select the ordered targets, and fractional values blend
adjacent targets. A non-frame combination displays **Custom**. There is no
persisted frame property. Sequence weights are initially collapsed. Reset
restores valid source default weights, ignoring source names absent from the
GLB. A drag or wheel edit is one undo transaction.

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
and Shape/Frame inputs with history assertions. Screenshots are in
`test-results/model3d/semantics/`. The browser renderer gate checks unchanged
sibling pixels, effective parent fill/opacity/hide and source metadata identity.
Stage B animation remains deferred; this does not enable model3d in old decks.

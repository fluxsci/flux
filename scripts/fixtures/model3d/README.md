# Model3d fixtures

Regenerate the native deterministic fixtures with `node scripts/gen-model3d-fixtures.mjs`.
`--check` compares the exact bytes. Cube intentionally has no NORMAL, blob has 5,000
triangles and COLOR_0, two-part has contrasting colors, quantized uses normalized signed
short POSITION, textured exercises stripping, draco-flag and gltf-json exercise refusal.
field-valid distinguishes a real zero from a missing zero using padded `_VALID`; states
contains two named relative morph targets. No downloaded/user mesh is required.

`fluxplot/` is a byte-identical copy of the independently generated scene3d contract
fixtures/schema from the fluxplot `scene3d` branch. Regenerate there, test, then copy the
whole set; never hand-edit generated fixtures. SHA256SUMS.json records every fixture.

Topology hashes use logical index values encoded as uint32 little endian, including an
implicit ascending index sequence for unindexed primitives. Width, offset and stride do
not affect compatibility; vertex order and face index order do. The whole hash is cyrb53
of canonical JSON for the DFS default-scene primitive list. This refines the plan's
"index buffer bytes" phrase to accept uint16/uint32 representations of the same faces.

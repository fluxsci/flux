# Native model fixture

`neuron.glb` and `neuron.fluxplot.json` are unchanged output from the deterministic
`examples/scene3d_demo.py` in the fluxplot repository, commit `8a1d643`.
The generator builds a soma and capped branched tubes with named soma, axon and
dendrite meshes, a one-micrometre scale bar, title and legend. No external mesh
or user project is involved. Exact file hashes and the generation command are
in `PROVENANCE.json`.

The Electron gate copies these files into a scratch canonical Flux project and
imports them through the native picker/preload/IPC path. This compact fixture
qualifies interaction and export correctness; larger-mesh scaling belongs to
P7's separate performance scenarios.

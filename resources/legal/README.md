# Licence texts for work that does not come from npm

`scripts/build-legal.mjs` joins the text files here, in name order, with the licence files of
every npm package compiled into the app, and writes `THIRD_PARTY_LICENSES.txt`. That file,
`LICENSE` and `THIRD_PARTY_NOTICES.md` ship in the packaged app's `resources/legal/` folder.

Add a file here when Flux starts to carry work that npm does not deliver: copied icons,
colour data, ported code, data files built from someone else's. Name the work, say where it
is in Flux, and give the full licence text. `THIRD_PARTY_NOTICES.md` at the repository root
is the readable list; this folder holds the texts the licences ask to travel with copies.

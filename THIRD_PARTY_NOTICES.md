# Third-party notices and acknowledgements

Flux is MIT-licensed (see [`LICENSE`](LICENSE)). It is built on, bundles, or reproduces the work
listed here. Each item keeps its own licence; Flux's licence does not replace it. Thank you to
everyone who made and maintains this work.

This file names each component, its authors and its licence. It was compiled on 2026-11-25 from
the dependency tree at Flux 0.4.0. Update it when a dependency, bundled asset or ported algorithm
changes.

The licence texts travel with the app. An installed Flux has a `legal` folder in its resources
(on Linux `/opt/Flux/resources/legal`, on macOS `Flux.app/Contents/Resources/legal`) holding
Flux's `LICENSE`, this file, and `THIRD_PARTY_LICENSES.txt`: the full licence text of every
item below. `scripts/build-legal.mjs` writes that file at build time from the npm packages
compiled into the app and from the hand-kept texts in [`resources/legal/`](resources/legal).

The companion Python library, fluxplot, has its own
[notices](https://github.com/fluxsci/fluxplot/blob/main/THIRD_PARTY_NOTICES.md), with the full
licence texts of the colour collections below.

## Colormaps and colour palettes

The colour data in `src/lib/color/*.gen.ts` is generated from fluxplot's definition files. The
values also travel into what you export: a gradient or colour scale carries its map's colours.

| Collection | Authors and source | Licence |
|---|---|---|
| Flexoki palette | Steph Ango, <https://stephango.com/flexoki>. Flux's "green" ramp is the author's own, built around Paul Tol's bright green (`#228833`) as its main shade; Flexoki's green is kept under the name "olive". | MIT |
| Flexoki house maps (sequential, warm, diverging, terrain, spectrum) | Made for fluxplot as linear ramps through Flexoki colours. | MIT |
| matplotlib colormaps (86 maps) | The Matplotlib Development Team, <https://matplotlib.org>. J. D. Hunter (2007), Matplotlib: a 2D graphics environment, *Computing in Science & Engineering* 9, 90–95, doi:10.1109/MCSE.2007.55. | Matplotlib licence |
| Scientific colour maps (60 maps) | Fabio Crameri, <https://www.fabiocrameri.ch/colourmaps/>, through the cmcrameri package (Callum Rollo). Crameri, F. (2018), Scientific colour maps, Zenodo, doi:10.5281/zenodo.1243862. Crameri, F., Shephard, G. E. and Heron, P. J. (2020), The misuse of colour in science communication, *Nature Communications* 11, 5444, doi:10.1038/s41467-020-19160-7. | MIT |
| Paul Tol's colour schemes (20 maps, 9 colour sets) | Paul Tol, <https://personal.sron.nl/~pault/>, through the tol-colors package (Paul Tol, Clément Haëck). Tol, P., Colour Schemes, SRON Technical Note SRON/EPS/TN/09-002. | BSD-3-Clause |
| CMasher (57 maps) | Ellert van der Velden, <https://cmasher.readthedocs.io>. van der Velden, E. (2020), CMasher: scientific colormaps for making accessible, informative and 'cmashing' plots, *Journal of Open Source Software* 5(46), 2004, doi:10.21105/joss.02004. | BSD-3-Clause |
| ColorBrewer palettes | Cynthia Brewer, Mark Harrower and The Pennsylvania State University, <https://colorbrewer2.org>. Harrower, M. and Brewer, C. A. (2003), ColorBrewer.org: an online tool for selecting colour schemes for maps, *The Cartographic Journal* 40, 27–37, doi:10.1179/000870403235002042. | Apache-2.0 |

Several maps in the matplotlib collection have authors of their own:

| Maps | Authors and source | Licence |
|---|---|---|
| viridis, magma, inferno, plasma | Nathaniel J. Smith, Stéfan van der Walt and Eric Firing | CC0-1.0 |
| cividis | Nuñez, J. R., Anderton, C. R. and Renslow, R. S. (2018), Optimizing colormaps with consideration for color vision deficiency to enable accurate interpretation of scientific data, *PLOS ONE* 13, e0199239, doi:10.1371/journal.pone.0199239 | as matplotlib |
| turbo | Anton Mikhailov, Google LLC | Apache-2.0 |
| twilight, twilight_shifted | Bastian Bechtold | as matplotlib |
| The ColorBrewer maps (Blues … YlOrRd, the diverging sets, Accent … Set3) | Cynthia Brewer, Mark Harrower and The Pennsylvania State University | Apache-2.0 |
| gist_earth, gist_gray, gist_heat, gist_ncar, gist_rainbow, gist_stern, gist_yarg | From Yorick: The Regents of the University of California (Lawrence Livermore National Laboratory) | BSD-style |
| coolwarm | Kenneth Moreland (2009), Diverging color maps for scientific visualization, doi:10.1007/978-3-642-10520-3_9 | as matplotlib |
| cubehelix | D. A. Green (2011), A colour scheme for the display of astronomical intensity images, *Bulletin of the Astronomical Society of India* 39, 289–295 | as matplotlib |
| CMRmap | Carey Rappaport | as matplotlib |
| Wistia | Wistia, <https://github.com/wistia/heatmap-palette> | MIT |
| tab10, tab20, tab20b, tab20c | Categorical palettes from Vega, after Tableau | as matplotlib |
| berlin, managua, vanimo | Fabio Crameri | MIT |

## Fonts

| Font | Authors and source | Licence | Where it is used |
|---|---|---|---|
| Gelasio | The Gelasio Project Authors (Eben Sorkin), <https://github.com/SorkinType/Gelasio> | SIL Open Font License 1.1; text in [`resources/fonts/OFL.txt`](resources/fonts/OFL.txt) | The interface, and embedded in exported SVG, HTML decks and rasters. A font embedded in a document needs no licence text beside it (the licence's own FAQ, 1.10 to 1.12); the embedded font files keep their copyright and licence in their metadata. |
| KaTeX fonts | Khan Academy and other contributors, <https://katex.org> | MIT | Mathematics, in the editor and in exported HTML and PDF |
| Foxit fonts | The PDFium Authors, distributed with pdf.js | BSD-style | Reader, as stand-ins for the standard PDF fonts |
| Liberation Sans | Red Hat, distributed with pdf.js | GPL v2 with the font exception | Reader, as a stand-in for a standard PDF font |

## Icons

Most interface icons are drawn from [Lucide](https://lucide.dev) (ISC licence, Lucide
Contributors; parts are from Feather, MIT, Cole Bemis). The five mode icons, the Flux mark and
the cursors are Flux's own.

## Citation styles and reference handling

| Component | Authors and source | Licence |
|---|---|---|
| Nature citation style (`resources/csl/nature.csl`) | Michael Berkowitz, Patrick O'Brien; Citation Style Language project, [Zotero Style Repository](https://www.zotero.org/styles) | CC BY-SA 3.0 |
| Science citation style (`resources/csl/science.csl`) | Julian Onions, Sebastian Karcher, Greg Barendt; as above | CC BY-SA 3.0 |
| Cell citation style (`resources/csl/cell.csl`) | Adam Mark, Julian Onions, Aurimas Vinckevicius, Patrick O'Brien; as above | CC BY-SA 3.0 |
| citation.js | Lars Willighagen, <https://citation.js.org> | MIT |
| citeproc-js, with the APA, Vancouver and Harvard styles and five locales that citation.js bundles | Frank Bennett, <https://github.com/Juris-M/citeproc-js>; the styles and locales are from the Citation Style Language project | citeproc-js is offered under CPAL-1.0 or AGPL; Flux uses it, unmodified, under CPAL-1.0. CC BY-SA 3.0 (styles and locales) |
| Word reference documents (`resources/docx/`) | Built from the default reference document of [Pandoc](https://pandoc.org) (John MacFarlane) by `scripts/gen-reference-docx.mjs` | GPL-2.0-or-later, as Pandoc. It covers these four files only; they are data files beside the app, not part of its code. |

The citation style files are copied into a project unchanged, with their authors and licence
inside. Flux's default citation keys follow the pattern of
[Better BibTeX for Zotero](https://retorque.re/zotero-better-bibtex/) (Emiliano Heyns), and its
Word export writes the field format that [Zotero](https://www.zotero.org)'s Word plugin reads.

The journal export presets (Nature, Science, Cell, bioRxiv) follow those journals' public author
guidelines and templates. Flux is not affiliated with or endorsed by them.

## Programs that ship with Flux or that Flux installs

| Program | Authors and source | Licence |
|---|---|---|
| Electron, with Chromium and Node.js | Electron contributors and GitHub Inc.; The Chromium Authors; the Node.js contributors | MIT (Electron); Electron distributes Chromium's notices as `LICENSES.chromium.html` |
| FFmpeg 9.0.2 (slide video export) | The FFmpeg developers, <https://ffmpeg.org>. Static builds by BtbN (Linux, Windows) and Martin Riedl (macOS), including libx264. FFmpeg incorporates work of the Independent JPEG Group. | GPL v3; licence, readme and [notice](build/video-encoder-NOTICE.md) ship beside the executable |
| Quarto, with Pandoc (installed on request, for Word and Quarto rendering) | Posit Software, PBC, <https://quarto.org>; John MacFarlane, <https://pandoc.org> | Their own licences |
| TinyTeX (installed on request, for LaTeX PDF output) | Yihui Xie, <https://yihui.org/tinytex/> | Its own licence |

[GROBID](https://github.com/grobidOrg/grobid) (Apache-2.0) is not shipped; Flux can talk to a
server you run.

## Libraries compiled into the app

| Library | Authors and source | Licence |
|---|---|---|
| Svelte | Svelte contributors, <https://svelte.dev> | MIT |
| CodeMirror 6 and Lezer | Marijn Haverbeke and contributors, <https://codemirror.net> | MIT |
| @replit/codemirror-vim | Yunchi Luo and contributors | MIT |
| markdown-it, with the attrs, bracketed-spans, deflist and footnote plugins | Vitaly Puzrin, Alex Kocharin and contributors | MIT |
| KaTeX | Khan Academy and other contributors | MIT |
| pdf.js | Mozilla and contributors, <https://mozilla.github.io/pdf.js/> | Apache-2.0 |
| Bundled with pdf.js: Adobe CMaps; OpenJPEG; the PDFium JBIG2 decoder; qcms; QuickJS; an ICC profile | Adobe Systems; Université catholique de Louvain and contributors; The PDFium Authors; Mozilla; Fabrice Bellard and Charlie Gordon | BSD-style; BSD-2-Clause; BSD-style; MIT-style; MIT; CC0-1.0 |
| pdf-lib and @pdf-lib/standard-fonts | Andrew Dillon, <https://pdf-lib.js.org> | MIT |
| three.js | three.js authors, <https://threejs.org> | MIT; notice in `flux-model3d-THIRD-PARTY.txt` beside the 3D runtime |
| Harper (spelling and grammar) | Elijah Potter and Automattic, <https://writewithharper.com> | Apache-2.0 |
| resvg-js, with resvg | yisibl and contributors; the resvg authors | MPL-2.0 |
| opentype.js | Frederik De Bleser and contributors | MIT |
| Floating UI | Floating UI contributors, <https://floating-ui.com> | MIT |
| @lume/kiwi (the Cassowary constraint solver) | The Kiwi and Lume authors | BSD-3-Clause |
| css-tree, with mdn-data | Roman Dvornov and contributors; Mozilla | MIT; CC0-1.0 |
| linkedom | Andrea Giammarchi | ISC |
| Model Context Protocol SDK | Anthropic, PBC, <https://modelcontextprotocol.io> | MIT |
| ajv | Evgeny Poberezkin | MIT |
| zod | Colin McDonnell | MIT |
| fflate | Arjun Barrett | MIT |
| js-yaml, with argparse | Vitaly Puzrin, Vladimir Zapparov and contributors | MIT; Python-2.0 (argparse) |
| pako | Vitaly Puzrin and Andrei Tuputcyn | MIT and Zlib |
| chokidar and readdirp | Paul Miller, Elan Shanker, Thorsten Lorenz | MIT |
| @xmldom/xmldom | Christopher J. Brody, jindw and other contributors | MIT |
| approx-string-match | Robert Knight | MIT |
| tslib | Microsoft | 0BSD |

The full licence text of every library is in its package (`node_modules/<name>/LICENSE` after
`npm ci`) and at the link given. `package-lock.json` lists the complete dependency tree,
including the smaller packages these depend on.

## Methods and algorithms reproduced in Flux's own code

| What | Source |
|---|---|
| Colour-scale normalisation and lookup, tick location and labelling, the constrained-layout grid and legend placement, so that a plot edited in Flux matches what matplotlib would draw | Ported from Matplotlib 3.11 (The Matplotlib Development Team; Matplotlib licence) |
| Colour-vision-deficiency simulation | Machado, G. M., Oliveira, M. M. and Fernandes, L. A. F. (2009), A physiologically-based model for simulation of color vision deficiency, *IEEE Transactions on Visualization and Computer Graphics* 15, 1291–1298, doi:10.1109/TVCG.2009.113 |
| Colour interpolation in OKLab | Björn Ottosson (2020), A perceptual color space for image processing, <https://bottosson.github.io/posts/oklab/> |
| Smooth camera zoom and pan in slides | van Wijk, J. J. and Nuij, W. A. A. (2003), Smooth and efficient zooming and panning, *IEEE Symposium on Information Visualization*, 15–23, doi:10.1109/INFVIS.2003.1249004; after `interpolateZoom` in d3-interpolate (Mike Bostock, ISC) |
| Several easing curves and the vocabulary of some slide animations | After the rate functions and animations of [Manim Community](https://www.manim.community) (MIT) |
| Small hash and random-number routines (xmur3, mulberry32, cyrb53) | Widely circulated public-domain routines |

## Online services

Library and Reader look up references and open-access copies through the public services of
[Crossref](https://www.crossref.org), [OpenAlex](https://openalex.org),
[Unpaywall](https://unpaywall.org), [Semantic Scholar](https://www.semanticscholar.org),
[PubMed Central](https://pmc.ncbi.nlm.nih.gov) (NCBI), [arXiv](https://arxiv.org) and
[bioRxiv](https://www.biorxiv.org). No data from them is bundled.

## Documentation and screenshots

The offline documentation is a [Quarto](https://quarto.org) website and includes the web
libraries Quarto bundles (among them Bootstrap, Bootstrap Icons and Fuse.js). The screenshots in
`README.md` show figures made from public data; their sources are named beside them and listed in
full on the website's [visual and data credits](https://fluxsci.org/docs/visual-credits.html).

## Inspiration

Two apps shaped how Flux works: [Figma](https://www.figma.com/) was the main inspiration for
Figure, and [Obsidian](https://obsidian.md/) for Paper. Neither is open source; Flux contains no
code from either and is not affiliated with them.

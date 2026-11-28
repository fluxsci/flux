# Flux

A local-first desktop app for scientific work: turn plots into figures, figures into papers
and presentations, and keep your references and reading alongside them. Your projects stay
in ordinary files on your own machine.

**[fluxsci.org](https://fluxsci.org/)** · **[Visual tour](https://fluxsci.org/visual-tour/)** ·
[Install](#install) · [Documentation](https://fluxsci.org/docs/) ·
[Report an issue](https://github.com/fluxsci/flux/issues)

[![Flux Figure mode showing an eight-panel materials figure of editable plots and crystal structures, with its layers and figure controls](https://fluxsci.org/assets/media/figure-materials.webp)](https://fluxsci.org/visual-tour/)

*Assemble publication figures from plots you can still edit. Crystal structures in this figure:
[Crystallography Open Database](https://www.crystallography.net/cod/); Fermi surface: the MgB₂
example from [FermiSurfer](https://github.com/mitsuaki1987/fermisurfer); the other panels are
calculated or illustrative. Sources for everything shown on the website are in its
[visual credits](https://fluxsci.org/docs/visual-credits.html).*

## What it does

- **[Figure](https://fluxsci.org/docs/figure.html)**: assemble multi-panel figures from plots
  that stay editable, and keep your styling when the analysis runs again.
- **[Slide](https://fluxsci.org/docs/slides.html)**: reuse those figures in talks, animate the
  data, and export one self-contained HTML file or a video.
- **[Paper](https://fluxsci.org/docs/paper.html)**: write the manuscript with live figures,
  citations and tables; export to Word, PDF or HTML.
- **[Library](https://fluxsci.org/docs/library.html)**: keep references and PDFs across
  projects, with BibTeX, RIS and Zotero.
- **[Reader](https://fluxsci.org/docs/reader.html)**: read PDFs side by side, highlight and
  take notes.

A [Flux project is a folder](https://fluxsci.org/docs/projects-and-files.html) of readable
Markdown, JSON and SVG files, so Git, analysis scripts and other editors can work on it too.
[fluxplot](https://github.com/fluxsci/fluxplot), the companion Python library, makes plots
that keep their named series and data. A CLI and an MCP server let
[AI agents work in the open project](https://fluxsci.org/docs/connect.html).

## Install

Paste this into a terminal (macOS on Apple Silicon or Intel, or Debian/Ubuntu Linux):

```sh
curl -fsSL https://fluxsci.org/install.sh | bash
```

It downloads the latest release, verifies its checksum, installs Flux and opens it. A short
setup window then offers the optional extras. Flux updates itself the same way. The
[install page](https://fluxsci.org/install/) covers updating, uninstalling and troubleshooting.

> **Status:** v0.4.1, under active development. What changed in each release is in
> [CHANGELOG.md](CHANGELOG.md).

## See it and learn more

The website is the place to go from here:

- **[Visual tour](https://fluxsci.org/visual-tour/)**: short clips of the real app at work.
  Start here.
- **[A slide you can play in the browser](https://fluxsci.org/#slide-demo)**
- **[First project](https://fluxsci.org/docs/first-project.html)**: from a plot to a figure,
  a paper and a slide.
- **[Documentation](https://fluxsci.org/docs/)**: every mode, the keyboard shortcuts,
  fluxplot, and working with agents.

## Develop

Install **Git** and **Node.js 22 (22.15 or newer)**; the repository's `.nvmrc` selects it
for nvm. On macOS, install Xcode Command Line Tools once with `xcode-select --install`.

```sh
git clone https://github.com/fluxsci/flux.git
cd flux
npm ci
node node_modules/electron/install.js   # Electron 43 no longer downloads itself at install
npm run fetch:video-encoder
npm run electron:dev
```

This opens the desktop app with live reload; **Ctrl+C** stops it. Before contributing, read
[AGENTS.md](AGENTS.md) and the
[engineering guide](docs/AGENT_ENGINEERING_GUIDE-RUNNING.md), which cover the architecture,
the invariants and the test tiers (`npm run check`, `npm run test:pure`, `npm run test:ui`).
The website's [contributing page](https://fluxsci.org/docs/contributing.html) has the short
version. Bug reports and requests go to
[Issues](https://github.com/fluxsci/flux/issues); include your OS, the Flux version and
steps to reproduce.

[Lighttable](lighttable/README.md), the image-set viewer in `lighttable/`, is a separate
companion app with its own installation and tests.

## Acknowledgements

Flux builds on a great deal of open work: Electron, Svelte, CodeMirror, pdf.js, KaTeX, three.js,
Harper, citation.js and FFmpeg; the Gelasio typeface and the Lucide icons; and colour from
Flexoki (Steph Ango), Matplotlib, Fabio Crameri's Scientific colour maps, Paul Tol's colour
schemes, CMasher (Ellert van der Velden) and ColorBrewer (Cynthia Brewer and Mark Harrower).
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists everything Flux bundles or reproduces,
with authors, licences and the papers to cite.

Two apps shaped how Flux works: [Figma](https://www.figma.com/) was the main inspiration for
Figure, and [Obsidian](https://obsidian.md/) for Paper. Flux contains no code from either and
is not affiliated with them.

## License

[MIT](LICENSE) © Kort Driessen. Bundled third-party work keeps its own licences; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

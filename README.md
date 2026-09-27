# Flux

**[Visit the Flux website → fluxsci.github.io](https://fluxsci.github.io/)**

A local-first desktop studio for scientific work: turn plots into figures, figures
into papers and presentations, and keep your references and reading alongside them.
Your projects stay in ordinary files on your own machine.

[Install](#installation) · [User guide](docs/index.qmd) ·
[Interactive slide demo](https://fluxsci.github.io/#slides) ·
[Report an issue](https://github.com/fluxsci/flux/issues)

> **Status:** early v0.1, under active development. Start from source using the
> instructions below; public installers have not been published yet.

[![Flux Paper mode showing a scientific manuscript with an eight-panel neuroscience figure](https://fluxsci.github.io/assets/media/paper.webp)](https://fluxsci.github.io/#paper)

*Write with your figures, captions, and citations in context.*

## What you can do

- **[Paper](docs/modes/paper.qmd)** — write Markdown/Quarto manuscripts with live
  figures, citations, tables, and inline slides; export to HTML, Word, or PDF.
- **[Figure](docs/modes/figure.qmd)** — assemble multi-panel figures, edit plot
  parts, label and align panels, and keep styling when source plots regenerate.
- **[Slide](docs/modes/slide.qmd)** — reuse figures in presentations, animate plot
  elements and data transitions, add video clips, and export portable HTML or
  render a slide to MP4.
- **[Library](docs/modes/library.qmd)** — organize references and PDFs across
  projects, import BibTeX/RIS, connect Zotero, and search full text.
- **[Reader](docs/modes/reader.qmd)** — read PDFs side by side, highlight passages,
  attach notes, and export annotations.

[![Flux Figure mode showing editable neuroscience plots arranged in an eight-panel figure, with layers and styling controls](https://fluxsci.github.io/assets/media/figure.webp)](https://fluxsci.github.io/#figure)

*Assemble publication figures from plots you can still edit. Both screenshots use
the website's [neural-populations example project](https://fluxsci.github.io/#example-project).*

## Your files, your workflow

A [Flux project is a folder](docs/concepts/projects-and-files.qmd) containing
readable Markdown/Quarto, JSON, SVG, and media files. Flux autosaves and watches for
external edits, so analysis scripts, Git, and editors can work with the same project.
Local editing and reading work offline; online reference services and external
agent providers use their own connections.

For plots that retain named series, data, and regeneration recipes, use
[**fluxplot**](https://github.com/fluxsci/fluxplot), the companion Python library.
Flux also imports ordinary SVGs and raster images. See
[semantic plots](docs/concepts/semantic-plots.qmd) for the difference.

## Installation

### Run from source

Install **Git** and **Node.js 22 (22.15 or newer)**. The repository's `.nvmrc`
selects Node 22; if you use nvm, run `nvm install` and `nvm use` after cloning.
On macOS, install Xcode Command Line Tools once with `xcode-select --install`.

```sh
git clone https://github.com/fluxsci/flux.git
cd flux
npm ci
npm run fetch:video-encoder
npm run electron:dev
```

This opens the desktop app with live reload. Keep the terminal running while you
use it; press **Ctrl+C** to stop. The encoder download enables video import and MP4
export in a source checkout. Use the Electron window for the full desktop experience.

From the Home screen, create a project or open the
[example project from the website](https://fluxsci.github.io/#example-project).
The [getting-started walkthrough](docs/getting-started.qmd) takes you through a
first project, from reading a paper to exporting a manuscript.

### Add tools for your workflow

| Capability | Additional setup |
| --- | --- |
| Export manuscripts to HTML or Word | Install **Quarto**. |
| Export manuscripts to PDF | Install Quarto and a TeX distribution, such as **TinyTeX** (`quarto install tinytex`); see the install guide for SVG support and journal-style packages. |
| Generate semantic plots with Python | Set up **[fluxplot](https://github.com/fluxsci/fluxplot)** in your analysis environment. |
| Work with an assistant in Flux | Install and configure your preferred agent CLI; see [agent collaboration](docs/agents/collaboration.qmd). |

The **[full installation guide](docs/installation.qmd)** covers platform setup,
companion tools, and troubleshooting. There is also an
[agent-assisted macOS setup runbook](docs/for_agents/claude-install-flux-mac.md).

### Build a standalone app

Install Quarto, then run the command for your platform from the source checkout.
The build includes the existing user guide for offline access. Output goes into `release/`.

```sh
# macOS: DMG and ZIP for Apple Silicon and Intel
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac

# Linux: AppImage and Debian package
npm run dist:linux
```

For an unpacked app, use `npm run pack`. Windows installers are not currently
provided. Check [GitHub Releases](https://github.com/fluxsci/flux/releases) for
published builds as they become available.

Maintainers: [qualification procedure](docs/RELEASE_QUALIFICATION.md) and
[V0.2.0 implementation evidence](docs/V020_IMPLEMENTATION_PROGRESS.md) describe
the required checks and remaining platform qualifications. Building a package
does not publish or certify a release.

## Scripts and agents

Flux includes a CLI and a **Model Context Protocol (MCP)** server for working with
projects from scripts and assistants. They share operations with the desktop app;
the live bridge also lets an agent work with the current selection through
undoable edits.

```sh
# Run these from the Flux source checkout
npm run flux -- help
npm run flux -- list --root /path/to/project
npm run flux:mcp -- /path/to/project
```

See the [CLI reference](docs/reference/cli.qmd) and
[agent collaboration guide](docs/agents/collaboration.qmd) for figure composition,
plot regeneration, library access, exports, and live app controls.

## Documentation and contributing

- **[User guide](docs/index.qmd)** — all five modes, integrations, and concepts.
- **[Keyboard shortcuts](docs/reference/shortcuts.qmd)** — navigation and editing.
- **[Issues](https://github.com/fluxsci/flux/issues)** — bug reports and feature requests.
  Include your OS, Flux commit/version, and steps to reproduce; a small example
  project is especially useful.
- **[Engineering guide](docs/AGENT_ENGINEERING_GUIDE-RUNNING.md)** — architecture,
  invariants, and verification. Read it and [AGENTS.md](AGENTS.md) before contributing.

The app uses Electron, Svelte, and TypeScript. Useful development commands:

| Command | Purpose |
| --- | --- |
| `npm run electron:dev` | Desktop app with live reload. |
| `npm run check` | Svelte and TypeScript checks. |
| `npm run test:pure` | Core regression suite. |
| `npm run test:ui` | Browser-driven UI regression suite. |
| `npm run build` | Production renderer, extension, export assets, and CLI/MCP bundles. |
| `npm run release:check` | Packaging and release verification. |

Some checks need Chrome/Chromium; set `FLUX_CHROME` to its executable if it is not
at the default Linux path. The engineering guide explains the test tiers and
feature-specific gates. To browse the documentation locally, run `quarto preview docs`.

[Lighttable](lighttable/README.md), the image-set viewer in `lighttable/`, is a
separate companion app with its own installation and tests.

## License

[MIT](LICENSE) © Kort Driessen.

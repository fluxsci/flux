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
  attach notes, and export highlights.

[![Flux Figure mode showing editable neuroscience plots arranged in an eight-panel figure, with layers and styling controls](https://fluxsci.github.io/assets/media/figure.webp)](https://fluxsci.github.io/#figure)

*Assemble publication figures from plots you can still edit. Both screenshots use
the website's [neural-populations example project](https://fluxsci.github.io/#example-project).*

## Your files, your workflow

A [Flux project is a folder](docs/concepts/projects-and-files.qmd) containing
readable Markdown/Quarto, JSON, SVG, and media files. Flux autosaves and watches for
external edits, so analysis scripts, Git, and editors can work with the same project.
Local editing and reading work offline; online reference services and external
agents use their own connections. Ask runs your installed Claude Code or Codex CLI
with your existing login; usage counts against your plan.

For plots that retain named series, data, and regeneration recipes, use
[**fluxplot**](https://github.com/fluxsci/fluxplot), the companion Python library.
Flux also imports ordinary SVGs and raster images. See
[semantic plots](docs/concepts/semantic-plots.qmd) for the difference.

## Installation

Paste this into a terminal (macOS on Apple Silicon or Intel, or Debian/Ubuntu Linux):

```sh
curl -fsSL https://fluxsci.github.io/install.sh | bash
```

It downloads the latest release, verifies its checksum, installs Flux (into `/Applications`
on macOS; with `apt` on Linux), puts the `flux` command on your PATH and opens the app. On
first launch a short **setup window** offers the optional extras, each one button with no
admin rights: Quarto (Word export and `flux compile`) and TinyTeX, the `flux` command, and
connecting Claude Code or Codex. Flux updates itself the same way (**Update now** on macOS).

For plots, add **[fluxplot](https://github.com/fluxsci/fluxplot)** to your analysis
environment (`uv add fluxplot` or `pip install fluxplot`). From the Home screen, create a
project or open the [example project from the website](https://fluxsci.github.io/#example-project);
the [getting-started walkthrough](docs/getting-started.qmd) goes from reading a paper to
exporting a manuscript. The **[installation guide](docs/installation.qmd)** covers updating,
uninstalling, the companions and troubleshooting.

### Run from source (contributors)

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

This opens the desktop app with live reload; **Ctrl+C** stops it. Releases are built by CI
from a version tag (`.github/workflows/release.yml`); `npm run pack` makes an unpacked app
locally.

## Scripts and agents

Flux includes a CLI and a **Model Context Protocol (MCP)** server for working with
projects from scripts and assistants. They share operations with the desktop app;
the live bridge also lets an agent work with the current selection through
undoable edits.

Open Flux once to install its stable launcher, then use this quick start:

```sh
flux connect setup --dry-run             # preview the agent integration
flux connect setup                      # install skills and MCP registration
flux connect doctor                     # verify the connection tools
flux connect /path/to/project            # ask your agent to follow the brief and return its receipt
```

Restart open agent sessions after setup. In Claude Code invoke `/flux-connect <project>`;
in Codex invoke `$flux-connect <project>`. The launcher also provides `flux mcp` for stdio
MCP clients. If `flux` is not on PATH, use the full launcher path shown in the
[CLI guide](docs/reference/cli.qmd).

See [Working with AI agents](docs/agents/connect.qmd) for setup, reading coverage and
live pairing; [Annotations, comments and the inbox](docs/agents/annotations.qmd) explains
**Ctrl+Shift+M** Annotate, **Alt+Q** Inbox, and **Ctrl/Cmd+Shift+J** Ask.

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

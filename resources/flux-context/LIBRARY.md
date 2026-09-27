# FluxLib and the Reader (stock — shipped with Flux, do not edit)

Use FluxLib when the task needs papers, citations, PDFs or the user's reading notes.
A connection tells you what and where the library is; it does not ask you to read or
summarize every paper. Discover tools with `flux_verbs`; tools absent from core remain
available through `flux_verb {verb:"<tool-name>",args:{…}}`.

## Text is truth; citekeys join everything

`flux config` / `config_paths` reports the resolved library path. FluxLib is always
`<FluxConfig>/FluxLib`; do not invent a separate library-path setting.

```
<FluxLib>/
  library.bib                       # canonical reference text
  items/<citekey>/
    paper.pdf                       # stored PDF, or a managed link to one
    fulltext.txt                    # extracted text; pages separated by form-feed
    annotations.json                # Reader Highlights (storage name unchanged)
    ...                             # metadata and supplements
  pdfs_to_assign/                    # incoming PDFs awaiting identification
    _unresolved/                    # uncertain matches, with diagnostic notes
  .fluxlib/                         # indexes and organization metadata
```

Keep citekeys stable: they link bibliography, PDFs, Highlights, tags and citations.
Correct metadata without renaming keys. The project's `references/library.bib` is
its **cited subset**, materialized from FluxLib. A library import does not itself
cite the paper in a project. `cite-doi` and `add-reference` add to both; write
`[@key]` in prose. After manual citation edits, `reconcile` refreshes the subset,
promotes project-only entries and reports orphaned keys. Inspect that report.

Fulltext/search indexes can be rebuilt from source; tags, reading status, collections
and Highlights are authored data and must be preserved. Use the library tools for
changes instead of rewriting metadata or sidecars. Read MANUSCRIPT.md before export.

## Search before adding

| Need | CLI / MCP entry point |
|---|---|
| Search the existing library | `flux search 'author:smith year:2020'` / `search_references {query:…}` |
| Search stored PDF text | `flux search-text "synaptic scaling"` / `search_fulltext {query:…}` |
| Read a stored paper | `get_paper_text {key:"<citekey>"}`; extracted text is also in its item folder. |
| Discover papers beyond FluxLib | `search_world {query:…}` searches OpenAlex by text. |
| Search by meaning | `semantic_search {query:…}` searches OpenAlex semantically. |
| Follow similar papers or citations | `similar_papers {ref:…}` / `citing_works {ref:…}`; inspect schemas for OpenAlex/Semantic Scholar choices. |
| Find the user's notes | `flux highlights search "query"` / `search_highlights {query:…}` |

Reference queries accept bare text and fields such as `author:`, `year:`, `journal:`,
`title:` and `doi:`; organization is searchable with `tag:`, `status:` and
`collection:`. Check the returned title, authors, year and DOI before treating a hit
as the intended work. A title match is not evidence that two PDFs are the same paper.
Use `get_paper_text` to read the actual work; a discovery abstract is not the full paper.

## Add, cite and organize

```sh
"{{FLUX_CLI}}" lib-add 10.1038/nature12373
"{{FLUX_CLI}}" lib-add --file references.bib --attach-files
"{{FLUX_CLI}}" cite-doi 10.1038/nature12373 --root /path/to/project
"{{FLUX_CLI}}" zotero-sync
```

`lib-add` / `add_to_library` accepts one DOI, BibTeX text, or an import file; use
`--file` for BibTeX/RIS. `--attach-files` brings referenced PDF attachments along.
Imports deduplicate by DOI; inspect the returned keys and metadata rather than
assuming a preferred key was kept. `cite-doi` / `cite_doi` echoes the registry's
author/title/year: verify them, since automated deposits can contain poor metadata.

`zotero-sync` / `zotero_sync` pulls the configured Better-BibTeX auto-export and PDFs
one way into FluxLib. Unchanged exports are skipped; `--force` rescans and picks up
attachment backfill. `--attach copy|link` chooses storage, `--defer-fulltext` delays
PDF text extraction, and `--save` persists settings overrides. See CLI-REFERENCE.md
before changing machine-wide sync settings.

Use `tag`, `set-status`, `collection`, or MCP `organize_paper` for organization.
Reading statuses are unread, reading and read. Discover the exact argument schema
before a bulk change, and keep unrelated tags/collections intact.

## PDFs: fetch, ingest or identify

- `fetch-pdfs --key <citekey>` / `fetch_pdfs {keys:[…]}` tries open-access sources,
  stores a valid PDF and extracts fulltext. Without a key filter it covers the library;
  choose that scope deliberately. A missing open-access copy is not a missing reference.
- `ingest-pdf <file.pdf> --key <citekey>` / `ingest_pdf {filePath:…,key:…}` files a
  known local PDF. Check its identity first. CLI file paths are cwd-relative; MCP
  paths use the project default, or absolute paths when unbound.
- `assign-pdfs --dry-run` / `assign_pdfs {dryRun:true}` previews identification of
  files in `<FluxLib>/pdfs_to_assign/`. Apply the requested batch without dry-run once
  the preview has been checked. The app also watches this inbox.

Identify a PDF from its own contents, with DOI/title corroboration; never from its
filename alone. **Refuse rather than misassign.** Uncertain files go to `_unresolved/`
with notes. Network failures stay in the inbox as deferred; non-network failures
are reported as errors. Inspect counts and reasons: "scanned" does not mean "filed".
An existing reference with another PDF can keep the new file as a supplement;
byte-identical duplicates are handled by the tool. Do not manually discard an
uncertain paper or force an unrelated match to make a batch look complete.

## Highlights and what the user is reading

**Highlights** are Reader's PDF highlights and notes (Alt+A). They are separate
from Ctrl+Shift+M annotations in the project inbox. Read them with
`flux highlights --key <citekey>` or `list_highlights {key:…}`. Use `--md` / MCP
`markdown:true` for a page-grouped digest. Search across papers with
`search_highlights`, optionally narrowed by `key`.

`add-highlight --key <citekey> --page 3 --quote "exact text" --note "…"` /
`add_highlight` adds a Highlight with a 1-based page and exact quote. Include
`prefix`/`suffix` when needed to disambiguate the passage. Use the user's requested
note; never turn unverified inference into a quotation from the paper.

When the user asks about what they are reading, start with `get_reading_context`
(through `flux_verb` in core mode). It returns the paper, page, current selection,
Highlights and captured context metadata. Check its freshness/foreground state;
a last-captured selection is not evidence the user is still looking at it. Read the
surrounding paper text before explaining it. Cite the paper and page you inspected.

## Snips: bring paper evidence into a figure or slide

`flux snip-paper <citekey> --page 3 --rect x1,y1,x2,y2` / `snip_paper` captures a PDF
region to `plots/paper_snips/`. Omit the rectangle for the full page. Coordinates
are PDF points, y-up, and pages are 1-based; a Reader snip's stored rectangle can
be reused directly. The PNG carries physical DPI and embedded provenance; its
`.snip.json` sidecar records the source. Keep them together.

Look at the snip before composing it, and keep its citation with the figure or slide.
`cite <citekey>` / `get_citation` supplies a short formatted citation. A missing
bibliography entry is reported; do not present a bare key as a verified citation.

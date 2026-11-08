# Journal export — implementation notes and judgment calls (2026-11-07)

Companion to `docs/journal_styleguide.md` (the rules) for the owner's review. Branch
`journal-export`. Each entry: what was decided, and why.

## Architecture

- **Flux literalizes citations for Nature, Science and Cell instead of using pandoc+CSL.**
  CSL cannot split Nature's Methods reference list, cannot move a superscript across a full
  stop (Cell sets it after, Nature/Science before), and cannot turn Science notes into list
  entries. bioRxiv has no style, so it keeps the document's own CSL (citeproc). The vendored
  `science.csl` / `cell.csl` exist only so Zotero live fields know their style identity.
- **Render settings moved from the `--profile` file into the prepared copy's front matter.**
  Found on the owner's molecular paper: Quarto ignores a profile for a document below its
  project directory, so the existing Nature export had silently rendered with no
  reference.docx and no line numbers for nested manuscripts. Gate contract updated with the
  evidence (`verify-journal-assets.ts`).
- **Figures are 300-dpi PNGs in submission manuscripts**, not SVG. Dense-plot SVGs are
  10–15 MB each: 44 MB .docx / 26 MB PDF before, 0.6 MB / 1.5 MB after. Every venue accepts
  300 dpi at submission; the vector files are uploaded separately later.
- **The PDF path is Quarto → LaTeX (lualatex)**, the engine Flux already ships/installs
  (TinyTeX "Add PDF support"), not LibreOffice (unmanaged, huge) or the in-app renderer (would
  need a second citation engine). Fonts go through fallback chains so a machine without Times
  New Roman still renders (TeX Gyre Termes).

## Judgment calls

- **Science section labels.** Science asks authors to "begin each section with the specific
  key words". The 2022 template's own example lines show no "Title:"/"Authors:" labels but
  keep "Abstract:", "One-Sentence Summary:" and "Main Text:" inside the styled paragraphs —
  Flux follows the template exactly, and uses the template's STYLE NAMES (Head, Authors,
  AbstractSummary, Referencesandnotes…) so Science's extraction recognises each block.
- **Science Methods** stay in the main file under "Materials and Methods" after the main
  text (the extended-format position); the summary says standard articles move them to the
  SM. Flux does not split the manuscript into two files.
- **Science DOIs** are appended to reference entries ("doi:…", the template's own example),
  per ruling 16. **Nature** journal articles carry none (0/4,627 in print).
- **Nature headings.** "Introduction" and "Results" headings are dropped in the export and
  the Results subheadings promoted; "Discussion" stays (16/20 papers print it).
- **Cell STAR Methods.** The author's Methods subsections (## headings, or run-in bold leads
  like `***Animals.***`) are grouped under the fixed STAR headings by their titles (animals /
  mice / participants → EXPERIMENTAL MODEL…; statistics → QUANTIFICATION…; rest → METHOD
  DETAILS). The summary always asks the author to check the grouping.
- **Cell lead-contact sentence** is written from the front matter (Cell's fixed wording) —
  the one generated statement, because it is pure metadata. Materials availability and the
  third data/code bullet are never written; they are reported.
- **A hand-written title block** (the molecular paper has one) is kept as written and the
  front-matter title/authors are not rendered a second time; the summary suggests moving the
  authors into front matter so the venue's title page can be set.
- **Footnotes** are reported for Nature ("does not use footnotes") and Cell (footnote numbers
  collide with superscript citations), and become numbered notes for Science.
- **Cell legends** set the title alone on its first line (no full stop), then any further
  sentences, then each panel on its own line — the printed form.
- **Paragraph-initial figure references** spell out "Figure" for Science only (template rule);
  Nature keeps "Fig." (865 sentence-initial "Fig." vs 19 "Figure" in print).
- **bioRxiv layout** (11 pt Arial, 1.5 spacing, line numbers) is a Flux choice; bioRxiv sets none.

## Surprises found and fixed along the way

- Packaged builds never shipped `resources/csl` or `resources/docx` (electron-builder
  allowlist), so journal exports outside dev had no venue assets at all. Fixed and pinned.
- Journal Check's hand-typed-reference regex read "Figure 2 and" as panel "a", and told Cell
  authors to abbreviate their correct "Figure". Fixed; advice now uses each venue's grammar.
- PubMed-style BibTeX ("Wilson, D. M., 3rd") puts the generational suffix in the given-name
  slot; reference formatting now swaps it back.

## Not built (listed in the export summary instead)

Separate final figure files per venue, Science's Combined PDF + SM file, Cell's Highlights/eTOC
Word file + graphical abstract + Key Resources Table, Nature's Reporting Summary (a PDF form),
cross-document numbering (Science SM-only references continuing the main list), and merging
adjacent citation groups. Cell/Science live author pages sit behind Cloudflare bot checks
(not bypassed); their rules come from archived/official template copies and the FluxLib corpus.

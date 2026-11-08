# Journal styleguide: submitting to Nature, Science, Cell and bioRxiv

**Status:** IMPLEMENTED for Flux 0.3.0 (2026-11-07). Written 2026-11-02; the owner's rulings
(§5) were applied and bioRxiv added (§4b). Each preset in `src/lib/style/journalPresets.ts`
cites the section of this document behind every value; §7 maps the rules to the code and gates.

**Purpose.** This is the specification behind Flux 0.3.0's "export my manuscript as a submittable
Nature / Science / Cell file" feature. It lists what each journal requires for a research-paper submission:
- document order and exact headings;
- citation and reference formats;
- how figures, tables and supplementary items are cross-referenced;
- legend rules;
- figure-file specs;
- supplementary-material structure;
- required statements;
- the traps a naive exporter falls into.

**The governing distinction: submission, not print.** Flux exports what the journal asks authors to
*submit*, not what the journal later *prints* after copyediting. The two differ:
- Science prints "First et al." but requires every author at submission.
- Nature prints its summary paragraph in regular weight but asks for a "bold first paragraph".
- Cell prints "STAR★METHODS" but the submitted heading is plain "STAR METHODS".

Where the official pages are silent we fall back on what the journal prints, measured over the papers in
FluxLib, and say so.

---

## How to read this document

**Provenance tags.** Every requirement carries a tag:

| Tag | Meaning |
|---|---|
| **[D]** | Stated on an official journal page or official template, read directly (source keys per journal) |
| **[M]** | Official Cell Press text read from a third-party mirror (the Cell Press LaTeX template v1.10) |
| **[Sn]** | Official page seen only as a search-engine snippet (cell.com blocked fetching). The fact is from the official URL, but the exact wording is unconfirmed |
| **[P n/N]** | Not stated officially; **measured in print**: n occurrences, or n of N published papers in FluxLib. "[P 852/25]" means 852 occurrences across 25 papers |
| **[?]** | Could not be confirmed. Treat as a default, not a rule |
| ⚠ | **Official sources contradict each other.** The recommended default is given, and the item is repeated in §5 (Owner decisions) |

**Research depth.** The full research files, with verbatim quotes, every URL, snapshot dates and corpus
methods, are in `notes/journal_styleguide_research/{nature,science,cell}.md`. They are local only:
`notes/` is gitignored. Use them to check any line below.

**How solid each journal's sources are:**

| Journal | Official pages | Print corpus (FluxLib, published typeset versions only) | Confidence |
|---|---|---|---|
| Nature | **Read live** 2026-11-02 (nature.com), including a new **July 2026 "Formatting Rules and Manuscript Essentials" checklist** | 80 papers, 2020–2026 | High |
| Science | Live science.org returns 403 to automated fetches. Read the **newest clean archived copies**: instructions **Aug 2025**, editorial policies **Jun 2026**, LaTeX page **Jul 2026**, Word template **Nov 2022** | 25 Research Articles, 2020–2026 | Good. The July 2024 Word template and 2025 figure guide could not be retrieved |
| Cell | cell.com/Elsevier return 403. Read the **official LaTeX template v1.10 (Dec 2024) via mirror**, the Cell Press blog and star-methods.com directly. Everything else from search snippets | 12 papers, 2023–2026 (plus 15 older ones for history) | **Moderate.** Owner verification needed (§6) |

The print corpus is mostly neuroscience, so it under-samples physical-science conventions.

---

## 1. At a glance

| | **Nature** (Article) | **Science** (Research Article) | **Cell** (Article) |
|---|---|---|---|
| Title limit | 75 chars incl. spaces, no punctuation | 96 chars incl. spaces | 145 chars incl. spaces |
| Abstract | "Summary paragraph": ideally ≤200 words, **≤230 hard**, must cite ≥1 reference | ≤125 words, one paragraph, **no citations, no abbreviations** | "Summary": ≤150 words, one paragraph |
| Extra front matter | — | One-sentence summary ≤125 chars (status unclear ⚠) | Highlights (3–4 × ≤85 chars), eTOC blurb (≤50 words), graphical abstract, keywords (≤10, optional) |
| Main text | ~2,500 words (6 pp, 4 items) or ~4,300 words (8 pp, 5–6 items), **summary included** | ≤3,000 words (extended online format: ≤6,000) | <7,000 words incl. main legends |
| Display items | 4 or 5–6, **+ ≤10 Extended Data** | 3–5 (extended: ≤6) | ≤7 figures + tables |
| References | ~50 in the main text (Methods refs not counted) | ~50 in the main text (SM-only not counted; extended: ≤100) | no limit stated |
| Legend limit | ≤300 words (one page says <250 ⚠); ED legends ≤1,000 | ≤200 words | none stated |
| Methods live in | **Methods** section after legends, in the main file | **Supplementary Materials** (standard format) | **STAR Methods** at the end of the main file |
| In-text citation | superscript, **before** punctuation: `text¹,².` | italic number in roman parentheses, **before** punctuation: `text (*1*, *2*).` | superscript, **after** punctuation: `text.¹,²` |
| Two consecutive refs | `1,2` | `(*1*, *2*)` | `1,2` |
| Range (≥3 consecutive) | `1–3` | `(*1*–*3*)` | `1–3` |
| Reference list authors | ≤5 all; ≥6 → `First, A. et al.` | **all authors** at submission (no et al.) | ≤10 all; ≥11 → first 10 + `, et al.` |
| Reference shape | `Smith, J. & Lee, K. Title. *Nat. Neurosci.* **12**, 1–9 (2020).` | `J. Smith, K. Lee, Title. *Nat. Neurosci.* **12**, 1–9 (2020).` | `Smith, J., and Lee, K. (2020). Title. Nat. Neurosci. *12*, 1–9. https://doi.org/…` |
| Figure ref | `Fig. 1a` · `Fig. 1a,b` · `Fig. 1a–c` | `Fig. 1A` · `Fig. 1, A and B` · `Fig. 1, A to C` | `Figure 1A` · `Figures 1A and 1B` · `Figures 1A–1C` |
| Supplementary ref | `Extended Data Fig. 1` · `Supplementary Table 1` · `Supplementary Video 1` | `fig. S1` · `table S1` · `movie S1` (lowercase) | `Figure S1` · `Table S1` · `Video S1` |
| Legend lead | `**Fig. 1 \| Title.**` then `a, …` | `**Fig. 1. Title.**` then `(**A**) …` | `**Figure 1. Title**` (no period) then `(A) …` |
| Panel letters in figures | 8 pt bold lowercase `a` | 10 pt bold capital `A` | capital `A` |
| Page setup | double-spaced, 12 pt Times New Roman, line numbers | **single-spaced**, Times New Roman, US Letter, page numbers, line numbers encouraged | not specified (template: 12 pt sans, line numbers) |
| Figure widths | 89 / 120–136 / 183 mm | 5.7 / 12.1 / 18.4 cm | 85 / 114 / 174 mm |
| Initial submission | one Word or PDF file, figures inline | **.docx with figures + a "Combined PDF" + an SM file + cover letter** | format-free; one PDF ≤20 MB |
| Final figure files | editable vector only (no JPG/PNG/TIF) | PDF/EPS/AI, or TIFF ≥300 dpi | TIFF or PDF preferred |
| Spelling | British/OED ("Acknowledgements") | US ("Acknowledgments") | US ("ACKNOWLEDGMENTS") |
| Extra forms | Reporting Summary (life sciences) | MDAR checklist (printed, request route unknown), author COI form | Declaration of Interests form, Key Resources Table |

**Two submission stages per journal.** All three journals treat the first submission and the
revision/acceptance files differently. Flux should offer, for each journal:
- **Initial submission**: one self-contained file with figures inline.
- **Revision / final**: a package of the text file plus separate figure files and the supplementary files.

---

## 2. Nature

### 2.0 Sources

All read live on 2026-11-02. URLs are in the research file.

| Key | Document |
|---|---|
| FG | Formatting guide, `nature.com/nature/for-authors/formatting-guide` |
| IS | Initial submission, `…/for-authors/initial-submission` |
| FS | Final submission, `…/for-authors/final-submission` |
| SI | Supplementary information, `…/for-authors/supp-info` |
| **CK** | **"Formatting Rules and Manuscript Essentials" checklist, `nature.com/documents/nature-manuscript-checklist-research.pdf`, dated 2026-07-07: the newest official document** |
| SP | "How to construct a Nature summary paragraph" (2019) |
| RFG | Nature research figure guide, `research-figure-guide.nature.com` |
| EDG | Extended Data formatting guidelines (2022) |
| EP-* | Editorial policies (AI, authorship, competing interests, funding, image integrity, reporting standards) |

**Precedence when pages conflict (proposed):**
- Final files: CK > RFG > FS > FG > IS.
- Initial submission: IS and FG.

### 2.1 Article type and limits

Articles are the only primary-research format. **Letters are retired** [D FG] (0 Letters among 78 papers
since 2020 [P]).

| Item | Requirement | Tag |
|---|---|---|
| Title | ≤75 characters including spaces, "with no punctuation included"; normally no numbers, acronyms or abbreviations; avoid technical terms and active verbs | [D FG, CK, IS] |
| Summary paragraph | "ideally" ≤200 words [D FG]; **≤230 words hard limit** [D CK 2026]; up to 300 only with editor-approved "broader perspective" sentences [D SP]. **Must cite ≥1 reference** [D CK]; "fully referenced" [D FG, IS] | ⚠ (three numbers) |
| Summary structure | 2–3 sentences of basic introduction → background and rationale → main conclusions introduced by "**Here we show**" (or equivalent) → 2–3 sentences of general context. Aimed at readers outside the field; no numbers, abbreviations, acronyms or measurements unless essential; separate from the main text | [D FG, SP]; "Here we" in 74/78 [P] |
| Main text | ~2,500 words for a 6-page paper with 4 modest display items (physical sciences); ~4,300 words for 8 pages with 5–6 items (biological, clinical, social sciences). **The summary paragraph counts toward this**; title, authors, acknowledgements and references do not | [D FG] |
| Methods | ≤~3,000 words (guideline; "may be longer if necessary") | [D FG, IS] |
| References | ≤~50 in the main text (guideline). Methods-only and SI references are not counted. **One publication per number** | [D FG, IS] |
| Display items | 4 (6-page) or 5–6 (8-page) | [D FG] |
| Extended Data | ≤10 items, figures and tables combined | [D FG, EDG, CK] |
| Figure legend | **≤300 words** [D FG, CK] vs "<250 words" [D IS] | ⚠ |
| ED legend | ≤1,000 words | [D CK only] |
| Subheadings | ≤40 characters including spaces | [D FG, CK] |
| SI video legend | one-sentence title + ≤100 words, no citations | [D SI] |

### 2.2 Submission stages and the files Flux must produce

**Initial submission.** "The Nature journals are flexible with regard to the format of initial submissions"
[D IS].
- **One Word or PDF file** (≤30 MB) containing the text and figures [D IS, FG].
- Each figure legend sits **with its figure, on the same page** [D FG, IS].
- PDFs **must be line-numbered**; the system numbers Word files itself [D IS].
- LaTeX users submit a **PDF** until acceptance [D IS].
- High-resolution figures are not needed [D IS].
- Extended Data may sit in the body or in the SI at this stage [D IS].
- The reference list includes article titles [D IS].
- Cover letter: optional and confidential, but the place to declare related manuscripts [D IS].

**Final submission** (after acceptance in principle):
- **Text file**: Word, "with the style tags removed" [D FS, FG]. It contains:
  - the text, references and main tables;
  - main figure legends, listed one after another after the main reference list;
  - Methods and Methods references;
  - statements;
  - Extended Data figure legends and Extended Data table titles/legends, at the end of the file.

  **No figures inside it** [D CK, FS]. Or LaTeX: a single `.tex` with standard classes, the `.bbl`
  contents pasted in, numeric citations only, compiling without warnings, plus a compiled PDF [D FS, CK].
- **Main figures**: one file each, **editable vector with editable layers**: `.ai`, `.eps`, `.pdf` preferred;
  plain `.svg`, `.ps` and layered `.psd` acceptable. **Not** `.jpg`, `.png`, `.tif`. ≤50 MB each
  [D CK, RFG]. ⚠ IS still lists tif/png/jpg as acceptable.
  **Flux default: PDF, live text, fonts embedded as Type 42, RGB.**
- **Extended Data figures**: one file each.
  - Format: **JPEG (preferred), TIFF or EPS**, RGB, ≤300 ppi, ≤10 MB, flattened [D FS, RFG, EDG].
  - Named `<CorrespondingAuthorSurname>_EDfig1.jpg` [D FS].
- **Extended Data tables**: supplied as **images, not Word tables**. Named `<Surname>_EDtable1.jpg`. Their
  titles and legends stay in the Word file [D FG, CK].
- **Source Data** (where provided): `.xlsx`/`.xls`/`.csv` (<30 MB). **One workbook per figure, one sheet
  per panel**, sheets named after the panel [D CK].
- **Supplementary Information**: text-based SI as a **single PDF with a title page** [D CK].
  - If there are several SI files, include an SI Guide listing each file's title and a ≤50-word summary
    [D SI, CK].
  - ≤10 files; ≤30 MB per file; ≤150 MB total. Video in H.264, 16:9 [D SI, CK].
- **Forms** (outside Flux):
  - Reporting Summary;
  - licence to publish;
  - third-party rights table;
  - structure tables for cryo-EM/NMR/X-ray, which go in Extended Data [D FD, CK, FG].
- **ORCID**: CK (2026) says **every author** must link an ORCID before formal acceptance; FS and EP-AUTH
  say only corresponding authors [⚠].

### 2.3 Document order and exact headings

**Recommended order:** the Formatting guide's, which also matches print in 77 of 77 papers. Main-text
section names are **sentence case**.

1. **Title**
2. **Authors**, with superscript affiliation numbers.
   - Corresponding authors are marked with an asterisk [D IS].
   - Equal contribution: a symbol plus "These authors contributed equally to this work" directly under the
     address list. More than three equal authors → say so in Author contributions instead [D FG].
   - One set of equal-contribution and one set of jointly-supervising authors is allowed [D EP-AUTH].
   - Present addresses are marked with a dagger [D FG].
   - ⚠ FG and IS both use an asterisk (one for equal contribution, one for corresponding).
3. **Affiliations** (plus present addresses).
4. **Summary paragraph.** No heading. The docs still call it the "bold first paragraph" [D FG, FS], though
   print sets it in regular weight [P 78/78]. Recommend: **emit it bold**, since that matches the
   instruction text.
5. **Main text.**
   - Sections are separated by short subheadings (≤40 characters).
   - **No "Introduction" or "Results" headings** [P 0/61]. This is print practice only; no page forbids
     them.
   - A closing **"Discussion"** heading is common [P 16/20].
6. **References**: the main list.
7. **Tables**: main tables, each on its own page [D FG, FS]. ⚠ CK does not list tables in its order.
8. **Figure legends**: at final submission. At initial submission the legends sit beside their figures.
9. **Methods**.
   - Short bold subheadings; a **statistics subsection is required** [D IS]; subsections for reagents and
     animal models are encouraged [D FG].
   - **The Methods may not contain figures or tables** [D FG].
   - LLM use is documented here [D IS].
10. **Data availability**: mandatory for all original research [D EP-RS].
11. **Code availability**: when custom code is central to the conclusions [D EP-RS].
12. **Methods references**: numbering continues from the main list; no separate heading in print.
    - ⚠ CK (2026) orders "methods → methods references → data and code availability", i.e. it puts items
      10–11 *after* item 12. FG, FS, the code policy page and print (77/77) all put them before.
      Recommend: FG order.
13. **Acknowledgements** (British spelling) [D CK; P 77/78].
14. **Funding**: a separate statement [D FG, CK, EP-FUND].
15. **Author contributions** [D FG].
16. **Competing interests** [D EP-CI].
17. **Ethics Statement**: new in CK only [D CK]. ⚠ Recommend emitting it when the author supplies one.
18. **Additional information**, in this order [D FG]:
    - "Supplementary Information is available for this paper."
    - "Correspondence and requests for materials should be addressed to <name>."

    **Do not write** "Peer review information", "Reprints and permissions" or the "Online content" block;
    Nature adds these [D FG].
19. **Extended Data figure legends**, then **Extended Data table titles and footnotes**.
    - References unique to Extended Data continue the numbering and are appended after the Methods
      references [D FG, FS].

### 2.4 Page formatting (the Word/PDF manuscript)

| Property | Requirement | Tag |
|---|---|---|
| Spacing | **double-spaced** | [D FG] |
| Font | "preferably 12-point Times New Roman"; symbols in normal text or Symbol font | [D FG, FS] |
| Line numbers | required in a PDF; the system adds them to Word files | [D FG, IS] |
| Page numbers, margins | **not specified anywhere** | [D absence] |
| Paragraphs | a single return between paragraphs; **no first-line indents**; no page breaks at section ends; no double space after full stops | [D FS] |
| Super/subscripts | real super/subscript formatting, not "raised/lowered" text | [D FS] |
| Word fields | **no linked fields** (EndNote and similar): citations must be plain text | [D FG, FS] |
| Footnotes | **do not use footnotes** | [D CK] |
| Styles | "Microsoft Word with the style tags removed" (exact meaning for a generated .docx is unclear; most likely Normal-based styles only) | [D FG, FS] [?] |
| Typography | italics for variables, genes, non-English words; **bold vectors**; define abbreviations at first use | [D CK] |
| Spelling | English as in the Oxford English Dictionary | [D FG] |
| Equations | must be editable; use the Word equation editor only for what normal or Symbol font cannot do | [D CK, FG, FS] |
| Units | SI, with a space between number and unit; thousands separated by commas (1,000) | [D FG] |

### 2.5 In-text citations

- **Numbered in order of first appearance**: text, tables, boxes, figure legends, Methods, Extended Data
  tables, Extended Data legends [D FG].
- **Superscript numerals, not brackets**, "unless they are likely to be confused with a superscript
  number" (e.g. after an exponent) [D FG].
- Separator **`,` with no space**: `¹,²` [P 1,203 vs 0].
- Range: en dash for ≥3 consecutive (`¹–³`) [P 1,072 vs 0]. Two consecutive are listed (`¹,²`).
- Placement: **before** the full stop or comma: `…proteins¹,².` [P 1,202 vs 0; SP's example]. No page
  states this as a rule.
- **Methods references continue the numbering** in a second list after the Methods [D FG, CK]. References
  first cited in Extended Data legends continue after that [D FG]. SI references are discouraged; if used,
  they continue the numbering [D SI].
- Not citable in the list: papers in preparation, which are mentioned in the text with their author list;
  grant details; acknowledgements text [D FG]. Citing unpublished work requires the authors' written
  permission [D EP-AUTH].

### 2.6 Reference list

**Rules** [D FG]:
- All authors if ≤5; if >5, **first author only + "et al."**.
- Surname, then a comma, then initials.
- **"&" before the last author, with no comma** (official examples).
- Article titles are **required**: upright, sentence case as published, ending with a full stop.
- Journal names *italic* and abbreviated "according to common usage".
- **Volume bold**.
- Only published or accepted work, or preprints on recognised servers, may be listed. Datasets with DOIs,
  numbered patents and conference abstracts are allowed.

**From print, not stated in the docs:**
- **No DOI on ordinary journal articles** [P 0/4,627].
- "et al." **upright, not italic** [P 164/164].
- En-dash page ranges.

Templates. Lines marked [P] are measured from print where Nature gives no example:

```
Journal (≤5 authors)  Smith, J. A., Lee, K. & Patel, R. Title in sentence case. *Nat. Neurosci.* **23**, 112–120 (2020).
Journal (≥6 authors)  Smith, J. A. et al. Title in sentence case. *Nature* **580**, 245–251 (2020).
Article number        Smith, J. A. et al. Title. *Science* **364**, eaav7893 (2019).
Preprint   [D]        Babichev, S. A., Ries, J. & Lvovsky, A. I. Quantum scissors: teleportation of single-mode optical states by means of a nonlocal single photon. Preprint at http://arXiv.org/quant-ph/0208066 (2002).
Preprint   [P 87/124 since 2023]   Smith, J. A. et al. Title. Preprint at bioRxiv https://doi.org/10.1101/2024.01.01.123456 (2024).
Dataset    [D]        Hao, Z., AghaKouchak, A., Nakhjiri, N. & Farahmand, A. Global Integrated Drought Monitoring and Prediction System (GIDMaPS) data sets. figshare http://dx.doi.org/10.6084/m9.figshare.853801 (2014).
Software   [P]        Smith, J. A. owner/repo. Zenodo https://doi.org/10.5281/zenodo.1234567 (2024).
Book       [D FG]     Smith, J. A. *Title In Title Case* (Publisher, City, 2009).       ⚠ print omits the city [P 0/84]
Chapter    [P]        Smith, J. A. in *Book Title* (eds Lee, K. & Patel, R.) 45–78 (Publisher, 2003).
Proceedings [P]       Smith, J. A. et al. Title. In *Proc. Advances in Neural Information Processing Systems* Vol. 29 (eds Lee, D. et al.) 4448–4456 (Curran Associates, 2016).
Thesis     [P]        Dueck, D. Affinity Propagation: Clustering Data by Passing Messages. PhD thesis, Univ. Toronto (2009).
Website    [D FG]     authors if known, title of the page, full URL, (year of posting).
Web-only journal [D]  authors, title, journal name, full URL or DOI, (year).
```

- Datasets and software need the **repository name before the URL**, and identifiers as **full DOI URLs**
  [D FG, EP-RS].
- Code must be deposited in a DOI-minting repository (Zenodo, Code Ocean) and cited [D EP-RS].
- Deposited protocols are cited too [D IS].

### 2.7 Cross-referencing figures, tables and supplementary items

| Item | Form | Tag |
|---|---|---|
| Main figure | `Fig. 1` (always abbreviated, even sentence-initially in most papers) | [P 865 sentence-initial "Fig." vs 19 "Figure"] |
| Panels | lowercase, attached: `Fig. 1a`; list `Fig. 1a,b` (no space, the 2022+ style); range `Fig. 1a–c` (≥3) | [P, see `journalPresets.ts`] |
| Plural | `Figs. 1 and 2`, `Figs. 1–3` | [P 31×, 17×] |
| Main table | `Table 1` | [P] |
| Extended Data | `Extended Data Fig. 1`, `Extended Data Figs. 2 and 3`, `Extended Data Table 1` | [D FG; P 3,601×] |
| Supplementary | `Supplementary Table 1`, `Supplementary Video 1` (**never "Movie"**), `Supplementary Note 1`, `Supplementary Data 1`, `Supplementary Information`, `Supplementary Methods` | [P] |
| Supplementary figure | `Supplementary Fig. 1`, but **officially SI "should not contain figures"**: extra figures belong in Extended Data [D FG, FS]. Print uses them anyway [P 19/80 papers]. Flux should **warn, not block** | ⚠ |
| Equation | not researched | [?] |

Supplementary tables are numbered separately ("Supplementary Table 1…") [D SI]. Every discrete SI item must
be cited at least once in the main text [D SI]. Extended Data items are cited in numerical order, like main
figures [D CK, EDG].

### 2.8 Figure legends

- Lead: **`Fig. 1 | Title sentence.`**: the label and title are bold [D CK "brief title in bold"; P 395/78;
  "Figure 1 |" 0].
- Panels: `a, Description. b, Description.` [P 347/347].
- The legend describes **what is shown, not results or methods**; no Methods details if the paper has a
  Methods section; it should be understandable on its own [D FG, IS].
- **Statistics**: define error bars (s.d., s.e.m.), give **exact n**, define replicates, give exact P values
  (significant and non-significant), F values and degrees of freedom for ANOVAs, t values and degrees of
  freedom for t-tests [D CK, IS, FG].
- Image-processing disclosures go here (rearranged lanes, per-channel adjustments) [D EP-II].
- Prefer keys and keylines in the figure over colour descriptions in the legend [D RFG].
- Extended Data: `Extended Data Fig. 1 | Title.` [P 1,015/78]; `Extended Data Table 1 | Title.` [P 37/18].

### 2.9 Figure files

| Spec | Requirement | Tag |
|---|---|---|
| Width | **89 mm** single, **120–136 mm** 1.5-column, **183 mm** double | [D FS, RFG, ART] ⚠ FG and IS say 90/180 |
| Max height | **170 mm**, leaving room for the legend | [D RFG, FG, IS] ⚠ FS: page depth 247 mm |
| Extended Data page | 180 × 170 mm, one item per page | [D EDG, RFG] ⚠ FS: 18 × 24 cm |
| Typeface | sans-serif, **Arial or Helvetica**, the same font in all figures; Symbol font for Greek | [D FS, IS] |
| Text size | **5–7 pt** | [D FS, EDG, RFG] |
| Panel labels | **8 pt bold, upright, lowercase** a, b, c | [D FS, RFG] |
| Lines | 0.25–1 pt at final size | [D FS, EDG] |
| Text handling | do not rasterize or outline text; embed fonts as TrueType 2/42 (matplotlib `pdf.fonttype = 42`) | [D FS, RFG] |
| Lettering | sentence case, no full stop; axis labels with units in parentheses, e.g. "Data (unit)"; include axis lines and ticks | [D FG, RFG] |
| Colour | **RGB**; avoid red/green contrast and rainbow scales; Wong/Okabe–Ito palette suggested; text contrast >4.5:1 | [D IS, FS, RFG] |
| Avoid | gridlines, drop shadows, patterns, coloured text, overlapping text | [D RFG] |
| Resolution | images ≥300 dpi at maximum size (RFG suggests ≥450); ED ≤300 ppi | [D FS, IS, RFG] ⚠ |
| Scale | scale bars, not magnification factors | [D FG] |
| Integrity | minimal processing; adjustments applied to the whole image; uncropped blots/gels in the SI at final submission; **no generative AI in figures at all** (including Photoshop content-aware tools) | [D EP-II, RFG] |

### 2.10 Tables

- **Main tables**: each on its own page, portrait and upright; a short **one-line bold title**; as small as
  possible; symbols and abbreviations defined directly below, double-spaced [D FG]. Footnotes allowed
  [D IS]. Editable tables at final submission [D FS].
- **Extended Data tables**: **images**. Sans-serif 7 pt; rules above and below the column headings and at
  the bottom; footnotes with superscript letters, **footnotes only in the legend, not in the table**
  [D EDG, CK].

### 2.11 Statements and declarations

| Statement | What to emit | Tag |
|---|---|---|
| Data availability | Required. Use the templated sentences, e.g. "Source data are provided with this paper." Datasets are formally cited in the reference list | [D EP-RS, DAS] |
| Code availability | Required when custom code is central; cite the DOI | [D EP-RS] |
| Acknowledgements | Brief. No thanks to referees or editors; no effusive adjectives | [D FG, EP-ACK] |
| Funding | Separate statement, e.g. "A.B.C. discloses support for the research of this work from Funder [grant number]. … G.H.I. declares no relevant funding." | [D EP-FUND] |
| Author contributions | **Free text with author initials.** CRediT is not used or mentioned | [D FG, IS] |
| Competing interests | "The authors declare no competing interests." or "The authors declare the following competing interests: …"; include patents (number, scope, applicant) | [D EP-CI, CK] |
| Ethics Statement | When applicable | [D CK] |
| AI use | LLMs cannot be authors; document use in Methods [D IS]. New three-tier policy: green = language/formatting, permitted; amber = permitted with disclosure; red = forbidden [D EP-AI] | ⚠ location unspecified in the new policy |
| Reporting Summary | Required for life-science, behavioural/social and EEE papers; a PDF form Flux cannot generate, so **remind the author** | [D EP-RS] |
| Editorial Policy Checklist | **Removed** (Jan 2026). Do not ask for it | [D] |

### 2.12 Nature traps (checklist)

1. The summary paragraph **counts** toward the 2,500/4,300 words and **must cite ≥1 reference**.
2. Citations are **superscript before** the full stop. Commas with no spaces.
3. Reference "et al." comes after **one** author, once there are ≥6. No DOI on journal articles; a DOI URL
   on datasets and preprints.
4. Methods references **continue** the numbering in a **second list** after the Methods.
5. No Introduction or Results headings. The Methods heading is "Methods", not "Materials and methods".
6. **Initial** submission: legends sit beside their figures. **Final**: legends come after the references
   and the figures are separate files.
7. Main figures are **editable vector**. Extended Data figures are **JPEG/TIFF/EPS ≤300 ppi**. Extended Data
   tables are **images**.
8. "Supplementary Video", never "Movie". Supplementary figures are officially not allowed.
9. No footnotes, no linked citation fields, no paragraph indents.
10. Do not write Nature's own boilerplate (Peer review information, Reprints, Online content).

---

## 3. Science

### 3.0 Sources

science.org author pages return HTTP 403 to automated fetching. These are the newest clean archived copies.

| Key | Document | Copy read |
|---|---|---|
| INIT | Instructions for preparing an initial manuscript, `science.org/content/page/instructions-preparing-initial-manuscript` | Aug 2025 (identical to Jul 2024 and Jan 2025) |
| REV | Instructions for preparing a revised manuscript | Mar 2025 |
| IFA | Science information for authors | Aug 2025 |
| POL | Science journals editorial policies | **Jun 2026** |
| LTX | Preparing manuscripts using LaTeX | Jul 2026 |
| TPL | Science Word manuscript template | **Nov 2022** (INIT now links a July 2024 version that could not be retrieved) |
| SMT | Supplementary Materials Word template | 2022 (still the file linked in 2025) |
| FIG | Author figure preparation guide | 2022 (INIT now links a 2025 guide that could not be retrieved) |
| AI | Science journals AI-use guidelines table | 2026 |

### 3.1 Article type and limits

**Research Article is the only primary-research type.** **"Reports" were retired at the end of 2022** [D IFA
history; P 0/25 since 2020]. Flux should not offer a Report preset.

| Item | Standard Research Article | Tag |
|---|---|---|
| Title | **≤96 characters** including spaces; avoid jargon and abbreviations | [D INIT, TPL] |
| Short title | ≤40 characters, entered in the submission system (not in the file) | [D IFA] |
| Abstract | **≤125 words** (TPL: 100–125), one paragraph, **no citations, no abbreviations**. Structure (content, not headings): broad background → specific background → objectives/methods → results → conclusions | [D INIT, TPL] |
| One-sentence summary | ≤125 characters | ⚠ [D TPL 2022 only; absent from the 2025 instructions] |
| Main text | **≤3,000 words.** What counts is undefined; "for the main text" suggests body text only | [D IFA] [?] |
| Display items | **3–5** figures or tables | [D IFA] |
| References | ~50 in the main text; SM-only references are not counted | [D IFA, TPL] |
| Figure caption | **≤200 words** each | [D INIT] |
| Materials and Methods | **in the Supplementary Materials** | [D IFA] |

**Extended online format** (chosen at submission; the cover letter must justify it):
- ≤6,000 words, ≤6 display items (videos allowed), ≤100 main-text references [D IFA].
- A ~500-word print summary with four sections headed **Introduction / Rationale / Results / Conclusion**,
  plus a summary figure with a ≤65-word caption [D IFA].
- Methods "run after the main text as part of the article" [D IFA], but 7 of 12 such papers still put them
  in the SM [P]. **Flux should let the author choose.**

### 3.2 Submission stages and the files Flux must produce

**Initial submission.** Uploading both of the first two items is required [D IFA]:
1. **Manuscript .docx** with **all figures and tables embedded** [D INIT].
2. **Combined PDF**: main text + figures + tables + Supplementary Materials in one PDF [D IFA].
3. **Supplementary Materials**: a single .docx or PDF, **≤50 MB** [D INIT]. Auxiliary files: ≤10 files,
   ≤25 MB total. Movies ≤50 MB each [D INIT].
4. **Cover letter**: the only required "related document" (§3.11).

Notes:
- Figures embedded at **300 dpi** to keep files small [D INIT].
- LaTeX users upload three PDFs (combined, main, SM) [D LTX].

**Revision** [D REV]:
- **One .docx** with the text, references, figure legends and tables. **No figures inside it** ("we cannot
  accept figures embedded in Microsoft Word files").
- **Figures as separate files**: PDF, EPS or AI (vector, preferred); TIFF ≥300 dpi for raster; PDF or EPS
  for combinations. **No PowerPoint.**
- Supplementary Materials: ⚠ "a separate PDF file" [REV] vs "a single docx or PDF" [INIT].
- **Remove every "data not shown".**
- LaTeX: the PDFs plus a zip with `.tex`, `.sty`, `.bib` and, **required**, the `.bbl` [D LTX].
- **ORCID required for first and corresponding authors** [D IFA].
- License to Publish (click-through) and an authorship/COI form from every author [D POL, FORMS].

### 3.3 Document order and exact headings

Science's submission system **extracts metadata from labelled sections**. INIT: "Please begin each section
with the specific key words listed below". Emit these labels literally [D INIT, TPL]:

```
Title:                      (no paragraph breaks)
Authors:                    (one paragraph, no breaks)
Affiliations:               (each affiliation its own paragraph)
Abstract:                   (one paragraph, no breaks)
One-Sentence Summary:       (TPL 2022 only — optional ⚠)
Main Text:
References and Notes
Acknowledgments:            (unnumbered, directly after the final numbered reference)
Supplementary Materials     (the list)
Fig. 1. …                   (each caption a new paragraph)
Table 1. …                  (each caption a new paragraph)
```

⚠ INIT spells it "Acknowledgements:" and "List of Supplementary Materials:". The template, the policy pages
and print use **"Acknowledgments"** and **"Supplementary Materials"**. Recommend the template forms.

**Title page:**
- **Authors**: given name or initials, then family name, separated by commas. Affiliations are linked by
  **superscript numbers**.
- **Corresponding author(s)**: `*`. Other notes use **non-superscript** symbols, in order of first use:
  `†, ‡, §, ¶, #, **, ††, ‡‡`. Example: `T. Crow1,2*, J. Russo3†`, with the 1, 2, 3 superscript and the
  symbols on the baseline [D INIT].
- **No "co-first" or "co-senior" designations.** Use only "These authors contributed equally to this work."
  [D INIT].
- **Affiliations**: each one its own paragraph, ending with a period; a semicolon separates the institution
  from its address; city and country only. Example:
  `1Department of X, Example University; City, Postal Code, Country.` [D TPL]
- The affiliation is where the work was done. A present-address footnote is **required** if the
  corresponding author has moved [D INIT, POL].
- Then: `*Corresponding author. Email: name@example.org` [D TPL].
- No footnotes for professional titles or data contacts; those go in Acknowledgments [D TPL].

**Main text:**
- Starts with a brief introduction. **No heading before the first paragraph** [D TPL].
- **Subheadings are required.** They are descriptive clauses, not full sentences [D INIT, TPL].
- Up to three levels: **bold** → ***bold italic*** → *italic*, each on its own line [D INIT].
- Avoid closing statements of future work, priority claims and repeated conclusions [D TPL].

**Back matter order:**
1. References and Notes.
2. Acknowledgments.
3. Supplementary Materials list.
4. Figure captions.
5. Tables ("Tables should be included after the references") [D INIT].

Figures and captions may instead sit inline near their first citation, **but not both inline and at the
end** [D TPL]. Never place figures in text boxes [D TPL].

### 3.4 Page formatting

| Property | Requirement | Tag |
|---|---|---|
| Paper | **US Letter**, 8.5 × 11 in | [D INIT, REV] |
| Spacing | **single spacing** throughout: text, tables, captions, references | [D INIT, REV] |
| Font | **Times New Roman**; avoid Symbol font | [D INIT, REV] |
| Size and styles (template) | body 12 pt with a 0.5 in first-line indent and 6 pt before; title 14 pt bold centred; author line centred; references with a 0.5 in hanging indent | [D TPL] |
| Margins (template) | 0.9 in top and bottom, 1.0 in left and right | [D TPL] |
| Page numbers | required ("include page numbers") | [D TPL] |
| Line numbers | encouraged; the template numbers every 5th line | [D TPL] |
| Running header (template) | "Submitted Manuscript: Confidential" | [D TPL] |
| Definitions | define technical terms, symbols, abbreviations and acronyms at first use | [D INIT] |
| Numbering | cite all tables, figures and references in numerical order | [D INIT] |

### 3.5 In-text citations

- **Italic numerals inside roman parentheses**: `(*1*)`, `(*2*, *3*)`, `(*4*–*6*)`, `(*18*, *20*–*22*)`
  [D INIT, TPL; P 1,169 italic vs 21 roman]. Never superscript, never brackets.
- **Two consecutive numbers take a comma, three or more an en dash**: `(*12*, *13*)`, `(*12*–*14*)`
  [P 212 vs 1]. The separator is comma + space.
- Placement: **before** the period or comma: `…shown (*12*).` [P 884 vs 12].
- **Numbering order**: (i) main text, (ii) boxes, (iii) figure and table captions, (iv) reference notes and
  acknowledgments, (v) Supplementary Materials [D INIT].
- **One combined reference list for the main text and the SM.**
  - SM-only references go at the end of the main list, numbered as if the SM continued the main text.
  - They are suppressed in print.
  - **No second reference list in the SM file** [D INIT, TPL].
- A dataset (with DOI) cited only in Acknowledgments takes **the last number before the SM-only
  references** [D INIT].
- **Notes** are allowed in "References and Notes" as numbered entries, e.g. "Materials and methods are
  available as supplementary materials." **Never combine a note and a reference under one number** [D INIT,
  TPL].
- Not allowed:
  - personal communications;
  - unpublished or "in press" work at publication (in-press work is allowed at submission);
  - ibid. and op. cit.;
  - unpublished material used to support significant conclusions.

  Preprints are allowed [D INIT]. Papers are held until "in press" citations are published or posted as
  preprints [D POL].
- Citations in tables use the same `(*n*)` form and point to the main list [D INIT].

### 3.6 Reference list

**At submission: list every author (no et al.), give full titles and full page ranges** [D INIT]. Print
later truncates to "First et al." and drops titles. **Do not imitate print.**

Style rules [D INIT]:
- **Initials first**, then family name, e.g. "A. B. Author". Authors are separated by **commas, not
  "and"**. No punctuation before name suffixes (Jr., III).
- The article title follows the authors, then a period.
- *Journal* in italics; **volume in bold**; **no comma before the volume or before "("**.
- Full page range with an en dash; an article number instead of pages where there are none; `(Year)`; the
  entry ends with a period.
- Journal abbreviation: not stated. Print uses ISO/NLM abbreviations ("Proc. Natl. Acad. Sci. U.S.A.",
  "Nat. Rev. Neurosci."). Recommend: abbreviate [?].
- DOI on ordinary articles: not required (the template example ends "doi:…") ⚠. Recommend: emit when known.

Official examples [D INIT]. Formatting follows the rules above: *journal italic*, **volume bold**.

```
Journal          A. B. Author, C. D. Author, Example article title. *Example Journal Name* **55**, 100–108 (2021).
Article number   A. B. Author, C. D. Author, Example article title. *Example Journal Name* **346**, e12345 (2022).
Supplement       A. B. Author, C. D. Author, Example article title. *Example Journal Name* **17** (suppl. 1), 62–66 (2020).
Online early     S. Author, M. Author, H. Author, Example article title. *Example Journal Name* DOI (2022).
Book             G. Y. Author, *Example Book Title* (Publisher, 2022).
Edited book      X. Editor, Y. Z. Editor, Q. Editor, Eds., *Example Book Title* (Publisher, 2021).
Edition          M. Author, T. Author, *Example Book Title* (Publisher, ed. 3, 2022).
Chapter          A. Author, Z. Author, "Optional: Example chapter title" in *Example Book Title* (Publisher, 2022), pp. 300–350.
Chapter (eds)    T. D. Author, U. R. Author, in *Example Book Title*, F. Editor, Ed. (Publisher, 2021), pp. 37–71.
Series           A. Author, B. Author, *Example Book Title*, vol. 5 of *Example Series Title* (Publisher, 2022).
Tech report      G. B. Author, "Example report title" (Tech. Rep. ABCD-12-34, Publisher, 2022).
Proceedings      A. Author, X. Author, G. Author, in *Proceedings of the 2019 Example Conference on Interesting Topic* (Publisher, 2022), pp. 6645–6649.
Meeting talk     M. Author, paper presented at the 25th Annual Meeting of Example Organization, Washington, DC, 10 to 13 October 2022.
Thesis           B. Author, thesis, Example University (2021).
arXiv            J. V. Author, E. Author, D. F. Author, Example preprint title. arXiv:1111.12345 [category] (2021).
bioRxiv etc.     D. Z. Author, K. Author, U. Author, M. R. Author, Example preprint title. bioRxiv 0123456 [Preprint] (2020). https://doi.org/10.1101/0123456.
Dataset          D. Author, Example dataset title, version 1, Example Repository Name (2021); https://doi.org/10.12345/ABC1234567.
Software         A. Author, B. Author, Example software title, version 2, Example Repository Name (2022); https://doi.org/10.12345/ABC000999.
```

Punctuation traps:
- arXiv takes **no** "[Preprint]"; other servers do.
- bioRxiv ends "(2020). https://…", with a period. ⚠ Print uses "; https://…".
- Datasets and software use "(2021); https://…", with a semicolon.
- Software is cited **in addition to**, not instead of, its descriptive article [D INIT].
- Every dataset with a DOI must be cited, following DataCite conventions [D POL, INIT].

### 3.7 Cross-referencing

| Item | Form | Tag |
|---|---|---|
| Figure | `Fig. 1` · `Figs. 1 and 2` | [D INIT; P] |
| Paragraph-initial | **"Figure 1 shows…"**: spell it out when a paragraph begins with a figure | [D TPL] |
| One panel | `Fig. 1A` (capital letter, attached) | [P 852/25; "Fig. 1a" 0] |
| Two panels | `Fig. 1, A and B` | [P 191/23] |
| Panel range | `Fig. 1, A to C`, with the word "to" | [P 124/19; "Fig. 1A–C" **0**] |
| Non-contiguous | `Fig. 1, A, C, and E` (serial comma) | [P 15/7] |
| Table | `Table 1` | [D INIT] |
| SM figure | **`fig. S1`** (lowercase f) · `figs. S1 to S3` · `fig. S1A` · `fig. S1, A and B` | [D INIT; P 592/25; "Fig. S1" 0] |
| SM table | **`table S1`** (lowercase t) | [D INIT; P 65/12] |
| Movies, data | `movie S1`, `data S1` | [P] |
| SM text | "supplementary text" | [D INIT] |
| Methods (in the SM) | "see materials and methods" (lowercase) or a numbered note | [D INIT; P 85/15] |
| Mixed | `(Fig. 2C and fig. S4)` | [P 139/24] |
| Equation | `Eq. 1`, `Eqs. 3 and 4` | [D REV] |

In the **Supplementary Materials list**, the labels are capitalised: `Figs. S1 to S4`, `Tables S1 and S2`,
`Movie S1`, `Data S1`, `References (26–32)` [D INIT].

### 3.8 Figure captions

- **`Fig. 1. Short bold title.`**: a short title in boldface as the first line, applying to the whole figure,
  with no citations of panels, references or other figures [D INIT, TPL; P 127/25 with the "Fig. 1." form].
  ⚠ INIT's keyword list writes "Fig. #:", with a colon.
- Panels: `(A) …`. **The first callout of each panel has a bold letter; later callouts are not bold**
  [D TPL]. Grouped panels: `(A and B)`, `(C to E)` [P 59/17, 27/12; "(A–C)" 0].
- **≤200 words**, single-spaced, in numerical order [D INIT].
- State **N, P and the specific statistical test** for each experiment [D INIT, POL]. Print uses "n =" and
  an uppercase "P" [P].
- Nonlinear image adjustments must be stated in the caption. Third-party images need a credit line
  [D INIT].
- The figure title belongs in the caption, **not inside the image** [D INIT].

### 3.9 Figure files

| Spec | Requirement | Tag |
|---|---|---|
| Widths | **5.7 cm (2.24 in)** 1-column, **12.1 cm (4.76 in)** 2-column, **18.4 cm (7.24 in)** 3-column | [D INIT, REV] ⚠ the 2022 figure guide says 5.5 / 12 / 18.3 cm |
| Max height, max file size | not stated | [?] |
| Typeface | sans-serif, **Helvetica preferred** | [D INIT] |
| Text size | ~7 pt (2.5 mm) after reduction, **never <5 pt**; avoid wide variation in size | [D INIT] |
| Panel labels | **capital letters, 10 pt bold**, upper-left corner; inside the frame if the panel is an image | [D INIT, FIG] |
| Sub-panels | avoid; if needed use lowercase letters (a, b), primes or roman numerals (i, ii) | [D INIT] |
| Lines | ≥0.5 pt at final size | [D INIT] ⚠ figure guide: ≥0.28 pt |
| Symbols | ≥6 pt; solid where possible | [D INIT] |
| Axes | no minor tick marks; scales must not extend beyond the data; don't repeat a left y-axis on the right | [D INIT] |
| Labels | capitalise only the first letter; units in parentheses, SI ("Pressure (MPa)"); "s", "min", but **"hours" not abbreviated**; leading zeros on decimals; italic variables | [D INIT] |
| Colour | avoid red with green, similar hues and coloured type; type over colour regions is bold; white type and scale bars over dark areas | [D INIT] |
| Colour mode | ⚠ the figure guide asks for **CMYK** (unless online-only); other pages are silent | [D FIG] |
| Formats | at revision, **PDF/EPS/AI** (vector) or **TIFF** (raster); no PowerPoint; no Word-embedded figures | [D REV] ⚠ figure guide also lists jpeg/png/svg |
| Resolution | ≥300 dpi at final size; **no upsampling** | [D REV, FIG] |
| Clean files | no hidden data in masks or layers; do not rasterize line art or text; keep labels on an editable layer | [D FIG, INIT] |
| Integrity | composites separated by lines or space; linear adjustments to the whole image; nonlinear ones declared; images may be screened with Proofig | [D INIT, POL] |
| AI images | **not permitted** without explicit editor permission | [D POL, AI] |

### 3.10 Tables

- After the references; caption **above**: `Table 1. Brief descriptive title.` [D INIT, TPL].
- **Every column has a heading with its unit in parentheses**; units never change within a column [D INIT].
- Footnote symbols in the order `*, †, ‡, §, ¶, #, **` [D INIT].
- Build tables with Word's table commands, never spaces or tabs [D TPL].

### 3.11 Supplementary Materials, Acknowledgments, declarations

**SM file** [D INIT, SMT]: one .docx or PDF, ≤50 MB, single-spaced. Cover page:

```
Supplementary Materials for
<Title>
<Full author list>
Corresponding author: name@example.org

The PDF file includes:
  Materials and Methods
  Supplementary Text
  Figs. S1 to S#
  Tables S1 to S#
  References (##–##)

Other Supplementary Materials for this manuscript include the following:
  Movies S1 to S#
  Audio S1 to S#
  Data S1 to S#
```

Rules for the SM body:
- Headings **"Materials and Methods"** and **"Supplementary Text"**. For clinical studies, the Methods start
  with "Study Design" [POL] or "Experimental Design" [INIT] ⚠.
- **Each figure on its own page, with its caption beneath**: `Fig. S1. …`. Tables: `Table S1.` caption
  [D SMT].
- **Do not add a second reference list.** The journal appends one [D TPL].
- No extra discussion or interpretation in the SM [D INIT, SMT].
- Tables are also supplied in a machine-readable format (csv/tsv/json/xml). Wide tables go in a separate
  .xlsx [D INIT, SMT].
- Video in MP4 (preferred) or MOV, H.264, ≤1920 × 1080. No animated GIFs [D INIT].
- Print lists an **"MDAR Reproducibility Checklist"** in the SM of 25 of 25 papers since 2020
  [P 25/25]. How it is requested is undocumented [?].

**Acknowledgments** [D INIT, TPL, POL]. Unnumbered, after the final numbered reference. Order:
1. Non-author contributions; disclose any editing services used.
2. Then these **run-in headings**, each its own paragraph:
   - **`Funding:`** agency names, grant numbers and recipient initials. The template puts each source in
     its own paragraph, e.g. "National Institutes of Health grant U12AB123456 (PV, CHO)".
   - **`Author contributions:`** CRediT encouraged. ⚠ The template wants one line per role with **no
     punctuation in initials** ("Conceptualization: SBB, DLA"); INIT's example and print use "J.S.". Default
     to the template form.
   - **`Diversity, equity, ethics, and inclusion:`** optional.
   - **`Competing interests:`** within 5 years of the start of the research; include patent applications
     (inventors, institutions, numbers). Default text: "Authors declare that they have no competing
     interests."
   - **`Data, code, and materials availability:`** ⚠ the 2025 instructions say "Data and materials
     availability:"; the 2026 policy and 2026 print use the new name. **Default to the 2026 name.**
     - MTAs and accession numbers go here. Archived data and code (DOIs) are cited in the main list.
     - If everything is in the paper: "All data are available in the main text or the supplementary
       materials."
     - A materials-availability statement is required even when no new materials were created [D POL].

**AI use** [D POL, AI]:

| Use of AI | Where to disclose |
|---|---|
| Drafting or writing text, translation, editing data visualizations | **Acknowledgments**, with model name and version |
| Code generation, data generation or analysis | **Methods**, with model name and version |
| Language polishing, literature search, formatting | not required |
| Illustrative images | **not allowed** |

Also disclose AI use in the cover letter.

**Cover letter** [D IFA]. It must contain:
- the title and main point;
- related manuscripts under consideration elsewhere;
- any pre-submission discussions;
- colleagues who have read the paper;
- the statement that the work is not published or under consideration elsewhere;
- human-subjects and animal-care statements;
- where the data are, or will be, deposited.

In the submission system: up to 5 suggested and 5 excluded reviewers.

**Equations** [D REV, TPL]:
- Long equations go on their own line, **numbered sequentially**, and are cited as "Eq. 1".
- MathType or the legacy equation editor is recommended. **"Do not use the native Word 2007, 2008, 2010,
  or 2011 equation editor."** ⚠ Flux's Word export produces native Office Math, and whether modern Office
  Math is acceptable is unconfirmed.

### 3.12 Science traps (checklist)

1. Citations are **(italic numbers)** in roman parentheses, before punctuation. Two consecutive → comma;
   three or more → en dash.
2. **One** reference list covering the main text and the SM; SM-only references come last; no list in the
   SM file.
3. **Full author lists** at submission, with initials before surnames and no "and".
4. Supplementary items are **lowercase**: fig. S1, table S1, movie S1. Panels: "Fig. 1, A to C", never
   "Fig. 1A–C".
5. **Single** spacing, US Letter, Times New Roman, page numbers. This is the **opposite of Nature**.
6. Labelled sections ("Title:", "Abstract:", "Main Text:") for metadata extraction. No heading before the
   first paragraph.
7. Methods go in the **SM** for standard articles.
8. Initial submission needs **both** the .docx with embedded figures **and** a Combined PDF. The revision
   .docx has **no** figures.
9. Acknowledgments carry the five run-in headings. The Funding paragraph is mandatory.
10. No "co-first author" wording. Symbols after affiliation numbers are **not** superscript.

---

## 4. Cell

### 4.0 Sources and their weakness

cell.com, the Elsevier CDN and ScienceDirect all return HTTP 403 to automated fetching, and the Internet
Archive was unreachable. Sources used:
- the **official Cell Press LaTeX article template v1.10** (changelog 2024-12-02), read in full from a
  GitHub mirror **[M]**;
- Cell Press's own blog (`crosstalk.cell.com`) **[D]**;
- the Key Resources Table webform (`star-methods.com`) **[D]**;
- search-engine snippets of cell.com pages **[Sn]**;
- print **[P]** (12 Cell papers, 2023–2026).

**Every [Sn] item should be checked by the owner in a browser** (§6).

### 4.1 The big change: numbered citations since late 2022

Cell Press moved Cell and its life-science journals **from author-year to superscript numbered citations**
for submissions from about **October 2022** [Sn cell.com/news-do/cell-press-referencing-style; M template;
P 15/15 author-year papers 2018–2022 vs 12/12 numbered papers 2023–2026]. Any "Cell style" built on
`(Smith et al., 2020)` is **obsolete**. The reference list is now **numbered in citation order**, not
alphabetical.

### 4.2 Article types and limits

| Item | Article | Short Article | Tag |
|---|---|---|---|
| Main text | **<7,000 words**, including main figure legends; excluding STAR Methods, supplemental legends and references | **≤4,000 words**, including title, authors, affiliations, summary and legends | [Sn article-types] |
| Display items | **≤7** figures and/or tables | ≤4 | [Sn] |
| Supplemental | no Cell-specific number found. Cell Press general guide: total supplemental items ≤2 × main display items, and ≤20 figures in all [Sn] | ≤4 supplemental figures, ≤8 supplemental items | [Sn] [?] |
| References | no limit stated | | [?] |
| Title | **≤145 characters** including spaces; avoid jargon and uncommon abbreviations | | [M; Sn] |
| Summary | **one paragraph, ≤150 words**. No citations [?; secondary sources only] | | [M; Sn] |
| Keywords | optional, **≤10**, comma-separated, **in the manuscript directly after the Summary**. Keywords typed into Editorial Manager are discarded | | [M; Sn] |
| Highlights | **3–4 bullets, each ≤85 characters** including spaces; results only; no abbreviations or jargon | | [D crosstalk; Sn] |
| eTOC blurb ("In brief") | **≤50 words**, third person ("Surname and colleagues show…"), plain language | | [Sn] ⚠ one snippet says 60 |
| Graphical abstract | one **square** panel, **1200 × 1200 px** at 300 dpi, **Arial 8–12 pt**; reads top-to-bottom or left-to-right; **no data**; distinct from the model figure; TIFF, PDF or JPG | | [Sn current guide] ⚠ the 2014 guide says 5.5 in square and 12–16 pt |

Resource and Theory articles exist; no Cell limits were found [?].

### 4.3 Submission stages and the files Flux must produce

**Initial submission is format-free** [Sn submit-manuscript; D crosstalk 2017]:
- Either **one combined PDF** or a Word file plus figures. LaTeX users upload a PDF.
- **≤20 MB in total**; keep figures to about 1–2 MB each.
- Must include the title, authors with affiliations and contact details, a summary, and enough experimental
  information to judge the work.
- Figures and their legends may run in with the text [M].
- **Cover letter** required. **Declaration of Interests form (PDF) required** [Sn].
- Optional at this stage: highlights, eTOC blurb, graphical abstract, STAR Methods formatting, Key Resources
  Table [D crosstalk; M].

**Revision / final** [Sn revise-manuscript, final-submission, Cell FFC; M]:
- **STAR Methods format is required at revision.**
- **Main text in editable Word**, preferred. LaTeX is allowed: all source files plus a checked PDF; it is
  converted to Word, which costs about 3 business days.
- **Figures**: one high-resolution file per figure with all panels together, named "Figure 1", "Figure 2"…
  Titles and legends go at the end of the text, **not** in the image.
- **Tables**: editable Word tables, not images.
- **Separate uploads**:
  - Highlights + eTOC blurb (one Word file);
  - graphical abstract;
  - **Key Resources Table** (its own Word file);
  - the supplemental PDF (**"Document S1"**);
  - Excel, data and video files.
- The Declaration of Interests form stays in the file set.

### 4.4 Document order and exact headings (revision / final)

Section headings are **ALL CAPS and unnumbered**. Subsection headings are sentence case and unnumbered
[M: "We do not number sections or subsections"].

1. **Title**
2. **Authors**: full first and last names, no degrees.
   - **Numbered** affiliation footnotes. Further numbered footnotes may give present address, "These authors
     contributed equally" or "Senior author".
   - **The last numbered footnote must read "Lead contact".** Exactly one lead contact, who must also be a
     corresponding author [M; P 12/12].
   - Corresponding authors are marked `*`, `**`, `***`, each with one line:
     `*Correspondence: name@example.org` [M; P 12/12].
   - Affiliations give at least department, institution, city, state/region and country [M].
3. **SUMMARY**: one paragraph, ≤150 words.
4. **KEYWORDS**: optional, ≤10.
5. **INTRODUCTION**: **no subheadings** [M].
6. **RESULTS**: unnumbered subheadings phrased as **informative findings sentences** [M].
7. **DISCUSSION**: subheadings permitted.
   - It **ends with the subsection "Limitations of the study"**: one or two paragraphs specific to this
     paper [Sn Cell revise page; P 12/12 papers since 2023 vs 1/15 before]. Treat it as **required**.
8. **RESOURCE AVAILABILITY**: **moved here from STAR Methods in August 2024** [M changelog; P 5/5 papers
   since Sep 2024]. It has exactly three subsections and no other text:
   - **Lead contact**: "Requests for further information and resources should be directed to and will be
     fulfilled by the lead contact, Name (email)."
   - **Materials availability**: e.g. "This study did not generate new materials."
   - **Data and code availability**: **three required bullets**:
     1. where the data are deposited, with identifiers, "publicly available as of the date of publication";
     2. "All original code has been deposited at <repository> under the DOI <doi> and is publicly available
        as of the date of publication." (or "This paper does not report original code." [?]);
     3. "Any additional information required to reanalyze the data reported in this paper is available from
        the lead contact upon request."
9. **ACKNOWLEDGMENTS**: non-author contributions **and funding** (with grant numbers). There is no separate
   Funding section [M].
10. **AUTHOR CONTRIBUTIONS**: CRediT encouraged, in sentence case with initials, semicolon-separated:
    "Conceptualization, S.C.P. and S.Y.W.; methodology, …; writing—original draft, …; writing—review &
    editing, …" [M]. Narrative statements are also accepted [Sn].
11. **DECLARATION OF INTERESTS**: **always present**. Default: "The authors declare no competing
    interests." [M; P 12/12]
12. **DECLARATION OF GENERATIVE AI AND AI-ASSISTED TECHNOLOGIES**: **only if** such tools were used in
    writing; omit the section otherwise. Grammar and spell checkers are exempt. Template text [M]:
    > During the preparation of this work, the author(s) used [NAME OF TOOL OR SERVICE] in order to [REASON].
    > After using this tool or service, the author(s) reviewed and edited the content as needed and take(s)
    > full responsibility for the content of the publication.

    ⚠ Policy pages append "IN THE WRITING PROCESS" to the heading.
13. ~~INCLUSION AND DIVERSITY~~: **paused by Cell Press in November 2023** [Sn; P 0/7 papers since 2024].
    Do not emit it by default.
14. **SUPPLEMENTAL INFORMATION**: a short index of the separate files, e.g.
    "Document S1. Figures S1–S7", "Table S1. Title (Excel)", "Video S1. Title, related to Figure 3" [M; Sn].
    ⚠ Its exact position relative to the legends is unconfirmed.
15. **MAIN FIGURE TITLES AND LEGENDS** [M].
16. **MAIN TABLES**, with titles and legends [M].
17. **REFERENCES**: one list, including the references cited in STAR Methods (§4.6).
18. **STAR METHODS**: "after the figure legends, main table(s) and table legend(s)" [M]. Use plain "STAR
    METHODS"; **not** the printed "STAR★METHODS", and not "Materials and Methods". Subsections, in order:
    - **KEY RESOURCES TABLE**: a pointer only; the table is a separate file (§4.10).
    - **EXPERIMENTAL MODEL AND STUDY PARTICIPANT DETAILS**: renamed in 2023 from "…SUBJECT DETAILS"
      [P 9/9 since late 2023]. Omit if there are no models or participants.
      - Each model or participant group under its own subheading: species/strain, genotype, age, **sex**;
        for humans, also gender, ancestry, race and ethnicity where reported; husbandry; approvals.
      - **The influence of sex/gender on the results must be reported, or its absence discussed as a
        limitation** [M; Sn].
    - **METHOD DETAILS**: required.
    - **QUANTIFICATION AND STATISTICAL ANALYSIS**: the tests and software; *where* the statistical details
      appear (e.g. the figure legends); exact n and what n represents; centre, dispersion and precision
      measures; how significance was defined; randomisation, blinding and sample-size estimation [M].
    - **ADDITIONAL RESOURCES**: only if applicable, e.g. a clinical trial registry number, formatted
      "Description: URL." [M].

In running text, write "(see STAR Methods)" [P 50/6].

### 4.5 Page formatting

**No official requirement for font, size, spacing, margins, or line and page numbers was found**, and the
initial submission is format-free [D crosstalk; Sn].

The official LaTeX template uses:
- 12 pt **sans-serif** (Helvetica);
- **line numbers on the right**;
- single spacing;
- the default page number;
- ALL-CAPS unnumbered section heads.

⚠ The template declares US Letter in one line and A4 in another.

**Proposed Flux default** (a house choice, not a Cell rule): 12 pt Arial, line numbers, page numbers,
1-inch margins, US Letter, double spacing.

### 4.6 In-text citations

- **Superscript numbers in order of first citation**, one reference per number. The list is ordered by
  number [Sn; M natbib `super,comma,sort&compress`].
- Placement: **after** periods and commas: `…observation.¹,²` and `…schema,²,³ undergoes` [P 554 vs 1].
  **This is the opposite of Nature.** The LaTeX `natbib super` default places the citation *before* the
  punctuation, so the exporter must move it.
- After a closing parenthesis: `(GRASP)⁴⁹` [P].
- Separator **`,` with no space**; numbers ascending within a group [P 318/12; 427/436].
- **En dash only for ≥3 consecutive numbers**. Two consecutive numbers are listed: `¹,²` [P 203 vs 0].
- With an author named: `Smith et al.¹`, with "et al." in roman [Sn; P].
- Unpublished data, submitted manuscripts and personal communications are cited **in the text only**, not
  in the list ("unpublished data", "A. Smith, personal communication"). Personal communications need a
  permission letter [M; Sn].
- Datasets, code and methods must be cited in the text and listed in the references [Sn].
- **STAR Methods references go in the same list**, continuing the numbering; they naturally take the
  highest numbers [P 11/12].
- **References cited only in the Supplemental Information go in the supplemental PDF's own list**, not the
  main list [Sn]. (Science differs: SM-only references join the main list. Nature: SI references continue
  the main numbering.)

### 4.7 Reference list

Cell keeps the **classic Cell entry format, with numbers added**. ⚠ The template calls it "AMA", but print
is not AMA [P 1,307/1,311 entries].

- **≤10 authors: all listed. ≥11: the first 10, then ", et al."** [Sn; cell.csl `et-al-min=11`;
  P 193 entries with exactly 10 names before et al.].
- Authors as `Surname, I.I.`, with **initials run together, no spaces** ("Moser, M.-B."). Separated by
  commas, with a **serial comma before "and"** [P 1,026 vs 0].
- **`(Year).`** directly after the authors.
- Title as published, no quotation marks, ending with a period.
- Journal abbreviated (ISO/NLM, with periods); one-word journals in full ("Nature", "Neuron").
- **Volume in italics**, then a comma and pages. No issue number.
- **Full page ranges** with an en dash ("801–806", never "801–6") [P 920 vs 0]. Article numbers replace
  pages.
- DOI as `https://doi.org/…` followed by a period [P 1,070/1,311]. ⚠ The official example shows a bare
  `10.…` DOI. Recommend the `https://doi.org/` form.

```
Journal        Sondheimer, N., and Lindquist, S. (2000). Rnq1: an epigenetic modifier of protein function in yeast. Mol. Cell *5*, 163–172. https://doi.org/10.1016/S1097-2765(00)80412-8.
≥11 authors    Surname1, A., Surname2, B., … Surname10, J., et al. (2013). Title. Nat. Neurosci. *16*, 1–10. https://doi.org/….
Article no.    Smith, J., and Lee, K. (2020). Title. Nat. Commun. *11*, 4783. https://doi.org/….
Preprint [M]   Kapoor, S., and Narayanan, A. (2022). Leakage and the reproducibility crisis in ML-based science. Preprint at arXiv. https://doi.org/10.48550/arXiv.2207.07048.
Book [P]       Piaget, J. (1926). The Language and Thought of the Child (Harcourt).
Chapter [Sn]   King, S.M. (2003). Dynein motors: Structure, mechanochemistry and regulation. In Molecular Motors, M. Schliwa, ed. (Wiley-VCH Verlag GmbH), pp. 45–78.
Proceedings [P]  Surname, A., … (2016). Title. In Computer Vision – ECCV, B. Leibe, …, eds. (Springer International Publishing), pp. 1–17.
Code/data [M]  Rizos, G. (2023). Code for the article "…". Zenodo. https://doi.org/10.5281/zenodo.10253149.
Software [Sn]  R Development Core Team (2008). R: A language and environment for statistical computing (R Foundation for Statistical Computing).
```

Books and chapters: publisher in parentheses, **no city**. A DOI is appended when one exists [P].

### 4.8 Cross-referencing

| Item | Form | Tag |
|---|---|---|
| Figure | **`Figure 1`**: always spelled out, **never "Fig."** | [P 0 "Fig."] |
| One panel | `Figure 1A` (capital letter, attached) | [P 404/12] |
| Two panels | **`Figures 1A and 1B`**: **plural "Figures"**, number **repeated** | [P 74/12; "Figures 1A and B" 0] |
| Panel range | **`Figures 4C–4E`**: number repeated, en dash | [P 96; "4C–E" **0**] |
| Lists | `Figures 5F, 5G, and S5G` (serial comma; main and supplemental mixed) | [P 23/7] |
| Whole figures | `Figures 1 and 2` | [P] |
| Mixed types in one parenthesis | separated by a **semicolon**: `(Figure 1A; Video S1)`, `(Figures 4C and 4E; Smith et al.⁶⁹)` | [P 14/6] |
| Supplemental | **`Figure S1`**, `Figures S3A–S3C`, `Table S1`, **`Video S1`** (not Movie), `Data S1`, `Methods S1` (rare). **Never "Supplemental Figure 1"** | [Sn; P] |
| Supplemental PDF | "Document S1" (the file's name, not cited in the text) | [Sn] |
| Table | `Table 1` | [P] |
| Equation | `Equation 1` (not "Eq.") | [M; P 95/2] |
| Methods | `(see STAR Methods)` | [P] |

Every supplemental item must be cited at least once in the main text [Sn].

### 4.9 Figure legends and figure files

**Legend format:**
- Lead: **`Figure 1. Title of the figure`**: the title states the overall finding, does not cite panels,
  and **has no final period** [M; P 0/75 with a period].
- Panels: **`(A) Description.`**, usually each on its own line. Grouped: `(C and D)`, `(E–G)` (en dash).
  Sub-locations: `(D) Left: … Right: …` [P 883/12].
- Statistics: name the tests, define the asterisks, define all scale and error bars, give n and what n
  represents [Sn figure-guidelines; M].
- **Close with "See also Figure S1."** (or "See also Figures S2–S4 and Table S1.") whenever there is related
  supplemental material [Sn FFC; P 10/12].
- Supplemental legends: **`Figure S1. Title, related to Figure 1`** (or "related to Figures 2 and 3",
  "related to Figure 1 and STAR Methods") [P 61/11].
- Video and Excel-table titles and legends also say "related to Figure N", and they live in the **main
  document** [Sn].
- No legend word limit was found. Main legends count toward the 7,000 words [Sn].

**Figure files** [Sn figure guidelines; secondary sources]:

| Spec | Requirement |
|---|---|
| Widths | **85 mm** (1 column), **114 mm** (1.5 column), **174 mm** (2 column) |
| Max size | 6.5 × 8 in (16.5 × 20 cm), one figure per page [Sn] |
| Resolution | ≥300 dpi for colour or greyscale; ≥500 dpi for black and white; ≥1,000 dpi for line art |
| Colour | RGB |
| Formats (final) | **TIFF or PDF preferred**; EPS, JPG, PSD, PNG also accepted |
| Font | **Arial**, embedded, about 6–8 pt at final size |
| Panel labels | **capital letters** (A, B, C) [P 883 "(A)" vs 2 "(a)"] |
| Scale bars | required on all microscopy images |
| Integrity | adjustments applied to the whole image; no selective changes; generative-AI image creation or editing prohibited unless it is part of the method [?, secondary] |

### 4.10 Tables and the Key Resources Table

**Main tables** [M]:
- Editable Word tables with one cell per value. Numbered `Table 1`, `Table 2`, **no sub-tables** ("Table
  1A").
- `Table 1. Title`, with an optional legend after the table.
- **Footnotes use superscript lowercase letters**. Never mark data with bold, italic, colour or shading.
- Tables count toward the 7 display items [Sn].

**Key Resources Table** [D star-methods.com; M; Sn]: a separate Word file, required at revision. It has
exactly three columns: **`REAGENT or RESOURCE` | `SOURCE` | `IDENTIFIER`**.

The fixed categories, in order. **No custom subheadings.**
1. Antibodies
2. Bacterial and virus strains
3. Biological samples
4. Chemicals, peptides, and recombinant proteins
5. Critical commercial assays
6. Deposited data
7. Experimental models: Cell lines
8. Experimental models: Organisms/strains
9. Oligonucleotides
10. Recombinant DNA
11. Software and algorithms
12. Other

Rules:
- Identifiers like `Cat#3879S`; RRIDs strongly recommended.
- New items: SOURCE = "This paper".
- **≤10 oligonucleotides.**
- Citations inside the table use the numbered style ("Smith et al.¹").
- Accession numbers and DOIs for deposited data go here.

### 4.11 Supplemental information

- **Document S1** (PDF) contains:
  - supplemental figures with their titles and legends;
  - schemes;
  - tables that fit on ≤3 pages;
  - supplemental notes;
  - **its own reference list for SI-only citations**.

  It must be publication-ready [Sn].
- Longer tables go in Excel (tabs allowed). Videos are separate files [Sn].
- **No methods in the SI.** All methods belong in STAR Methods [Sn].
- Everything in the SI must directly support the paper's conclusions [Sn].

### 4.12 Cell traps (checklist)

1. **Author-year is dead.** Use superscript numbers, **after** punctuation, with "1,2" for two and "1–3" for
   three or more.
2. Numbered list in citation order. Classic Cell entries: `(Year).` after the authors, ", and" before the
   last author, italic volume, full page ranges, `https://doi.org/`. Up to 10 authors, then ", et al.".
3. STAR Methods references go in the **main** list. SI-only references go in **Document S1's** list.
4. `Figure 1A`, `Figures 1A and 1B`, `Figures 1A–1C`, `Figure S1`. Never "Fig.", never "Supplemental
   Figure".
5. The legend title has **no period**. Legends end with "See also Figure S…". Supplemental legends say
   ", related to Figure N".
6. RESOURCE AVAILABILITY comes **after the Discussion**, not inside STAR Methods. Copying a pre-2024 paper
   gets this wrong.
7. "Limitations of the study" closes the Discussion.
8. ALL-CAPS unnumbered headings. INTRODUCTION has no subheadings. Use "EXPERIMENTAL MODEL AND STUDY
   PARTICIPANT DETAILS".
9. The lead contact is the **last numbered author footnote**.
10. Emit the AI declaration only when there is something to declare. Never emit Inclusion and Diversity.
    **Always** emit the Declaration of interests.
11. Highlights, eTOC blurb, graphical abstract and Key Resources Table are **separate files** at revision.
12. Keywords must be **in the manuscript text**.

---

## 4b. bioRxiv (preprint)

### 4b.0 Sources

Read live in a browser on 2026-11-07: `biorxiv.org/submit-a-manuscript` and `biorxiv.org/about/FAQ`.

### 4b.1 What bioRxiv requires

| Item | Requirement | Tag |
|---|---|---|
| File | "The simplest way to deposit a manuscript on bioRxiv is to upload a single PDF including the text and any figures/tables." A Word file plus separate figure files is the alternative (bioRxiv builds the PDF). LaTeX must be converted to PDF | [D] |
| Metadata | Title, author list, affiliations and abstract shown on the site are **extracted from the PDF** ("replaced with final metadata extracted from each PDF file") — the first page must carry them clearly | [D FAQ] |
| Style | **None.** Articles "are not typeset"; any citation style is accepted | [D] |
| Supplements | Separate files, posted as-is; large datasets go to community repositories | [D] |
| Language | English only | [D FAQ] |
| Images | No identifiable faces (blurring/pixelation is not enough) | [D FAQ] |
| AI | Use of generative AI "should be detailed in manuscripts"; AI is never an author | [D FAQ] |
| Submission form (outside the file) | Funders (ROR IDs + grant numbers), licence (CC BY … no reuse), co-author consent; clinical research goes to medRxiv | [D] |

### 4b.2 What Flux produces

A clean single PDF (or Word file): a title page bioRxiv can read (title; authors with
superscript affiliation numbers, `*` corresponding, `†` equal contribution; affiliations;
`*Corresponding author: email`), an **Abstract** heading, the author's own section order and
headings, figures **beside their legends** ("**Figure 1. Title.** …"), the document's own
citation style through pandoc+CSL, 11 pt Arial at 1.5 spacing with line numbers (for
reviewers' comments) and page numbers. bioRxiv sets no layout, so these are Flux's choices.

## 5. Owner rulings (2026-11-07)

**Ruling:** every recommendation below is adopted as the default. Word, abstract and legend
limits (and every other limit) raise **warnings only** — Flux never removes prose or refuses
to export. Anything ambiguous is surfaced in the **export summary** (§7) rather than decided
silently. The table records the question and the default that shipped.

| # | Journal | Question | Recommendation |
|---|---|---|---|
| 1 | Nature | Precedence when the new July 2026 checklist (CK) conflicts with the older web pages | CK > figure guide > FS > FG > IS for final files; IS and FG for initial submission |
| 2 | Nature | Data and Code availability **before** the Methods references (FG, FS, the code policy, print 77/77) or **after** them (CK 2026)? | Before. Matches print and three official pages. Revisit if Nature updates its web pages |
| 3 | Nature | Legend limit: 250 (IS) or 300 (FG and CK)? | 300 as the limit; warn from 250 on initial-submission exports |
| 4 | Nature | Abstract: 200 ideal / 230 hard / 300 with broader-perspective sentences | Advise at 200, error at 230, and mention the 300 exception |
| 5 | Nature | Figure sizes: 89/183 mm (FS, RFG) or 90/180 (FG, IS); maximum height 170 or 247 mm | 89 / 120–136 / 183 mm; height capped at 170 mm |
| 6 | Nature | Bold the summary paragraph? (Docs say "bold first paragraph"; print does not) | Bold it |
| 7 | Nature | Books: include the city (FG) or not (print, 0/84)? | Include it (documented rule) |
| 8 | Nature | Supplementary figures: officially banned, printed in 19/80 papers | Allow them; Journal Check suggests moving them to Extended Data |
| 9 | Nature | ORCID: corresponding authors only, or all authors (CK)? | Remind for all authors |
| 10 | Science | One-sentence summary: emit it? (in the 2022 template; absent from the 2025 instructions) | Emit only if the author wrote one; ≤125 chars |
| 11 | Science | Acknowledgments heading: "Data and materials availability" (2025 instructions) or "Data, code, and materials availability" (2026 policy and print) | The 2026 name |
| 12 | Science | CRediT initials: "SBB" (template) or "S.B.B." (instructions example, print) | Template form, one role per line |
| 13 | Science | Column widths: 5.7/12.1/18.4 cm (instructions) or 5.5/12/18.3 cm (2022 figure guide); line weight ≥0.5 or ≥0.28 pt | 5.7/12.1/18.4 cm; ≥0.5 pt |
| 14 | Science | SM at revision: PDF only (REV) or .docx/PDF (INIT) | PDF (satisfies both) |
| 15 | Science | Native Word (Office Math) equations: the pages warn against "the native Word 2007–2011 equation editor" | Keep native Office Math; flag it in Journal Check. A MathType route is impractical |
| 16 | Science | DOIs on ordinary journal references (optional) and journal-title abbreviation (unstated) | Emit DOIs when known; abbreviate journal titles |
| 17 | Science | Extended online format: methods in the article or in the SM? | Author's choice in the export dialog |
| 18 | Cell | Page setup is unspecified | 12 pt Arial, double-spaced, line and page numbers, US Letter, 1-inch margins |
| 19 | Cell | DOI form: bare `10.…` (official example) or `https://doi.org/…` (print, template) | `https://doi.org/` |
| 20 | Cell | eTOC blurb: 50 or 60 words; graphical abstract: 1200 px at 8–12 pt (current) or 5.5 in at 12–16 pt (2014) | 50 words; current graphical-abstract spec |
| 21 | All | Which submission stage(s) to build for 0.3.0: initial single file, revision/final package, or both | Both. Initial is the common case and the simpler build; ship it first if time is short |
| 22 | All | Things Flux cannot generate (Nature Reporting Summary, Cell Declaration of Interests form, Science author forms, MDAR checklist) | List them in the export summary as "still to do outside Flux" |

---

## 6. Verification still owed

Before this guide is treated as final, someone should open these in a normal browser. Automated fetching was
blocked.

**Cell (highest priority).**
- `https://www.cell.com/cell/information-for-authors` and its sub-pages: `/article-types`,
  `/submit-manuscript`, `/revise-manuscript`, `/final-submission`, `/journal-policies`.
- The current Cell **Final File Requirements** PDF.
- The Cell **STAR Methods guide** PDF.
- `https://www.cell.com/figureguidelines`.

These confirm every [Sn] line: limits, highlights and eTOC rules, the figure specs, the exact back-matter
order (especially where the supplemental index sits), supplemental-item limits and ORCID.

**Science.**
- The live INIT, REV and IFA pages (checked here only as of Aug 2025 / Mar 2025).
- The **July 2024 Word template**, which may change the labels, the one-sentence summary or the styles.
- The **2025 author figure-preparation guide**, which may settle the width and line-weight conflicts.

**Nature.** Read live and current. No action needed beyond the decisions in §5.

---

## 7. How Flux implements this (0.3.0)

| Rule area | Code | Gate |
|---|---|---|
| Venue descriptors (every value tagged with its source here) | `src/lib/style/journalPresets.ts`, schema in `journalStyle.ts` (`ManuscriptSpec`, panel grammar, page setup) | `verify-journalstyle.ts`, `verify-nature-style.ts` |
| Reference entries (§2.6, §3.6, §4.7) | `src/lib/style/journalRefs.ts` (CSL-JSON → markdown; all item types) | `verify-journal-refs.ts` |
| Citation marks, numbering, punctuation, Nature's Methods list, Science notes (§2.5, §3.5, §4.6) | `src/lib/style/journalCitations.ts` | `verify-journal-refs.ts`, `verify-journal-manuscript.ts` |
| Figure-reference grammar (§2.7, §3.7, §4.8) | `formatStyledFigureRef` in `journalStyle.ts`, used by `exportQmd.ts` | `verify-journal-refs.ts` |
| Legends (§2.8, §3.8, §4.9) | `src/lib/style/journalCaptions.ts` | `verify-journal-refs.ts` |
| Title page, abstract, section order/renames/drops, run-ins, Cell resource availability + STAR Methods, figure placement per stage | `src/lib/style/journalManuscript.ts`, run by `exportPrep.ts` in Paper and flux-core alike | `verify-journal-manuscript.ts`, `verify-journal-export-gui.mjs` (GUI ≡ flux-core) |
| Page setup (§2.4, §3.4, §4.5, §4b) | `resources/docx/<id>-reference.docx` (from `scripts/gen-reference-docx.mjs`), `journalAssets.journalRenderMeta` (LaTeX preamble), `resources/lua/flux-journal.lua` | `verify-journal-assets.ts`, `verify-journal-render.ts` |
| Figures at 300 dpi in the manuscript | `docxSvgFallback.ts` (raster-only), `journalFigures.ts` (PDF) | `verify-journal-render.ts` |
| Limits, missing statements, outside-Flux items, figure-file guidance | `src/lib/style/journalSummary.ts`, `ExportSummaryPanel.svelte`, `<name>.submission.md` | `verify-journal-manuscript.ts` |
| Journal Check advice in each venue's grammar | `src/lib/manuscript/compliance.ts` | `verify-journal-manuscript.ts`, `verify-nature-compliance.ts` |

**Corrections applied to the shipped Nature preset:** hard abstract limit 230 (2026
checklist); "tables" and the Ethics Statement in the order; ED legend limit 1,000; Extended
Data caption form promoted to measured; dataset/software/chapter/proceedings entries; "et al."
upright; 1.5-column width and 170 mm height noted in the figure guidance.

**Not done in 0.3.0 (the summary tells the author instead):** separate final figure files
(export each figure from Figure mode at the widths in §2.9/§3.9/§4.9), Science's Combined PDF
and SM file, Cell's Highlights/eTOC Word file, graphical abstract and Key Resources Table,
Nature's Reporting Summary, and merging adjacent citation groups ("[@a] [@b]").

### Original implementation notes (2026-11-02, superseded by the table above)


Brief notes for the implementation pass. The existing machinery is the journal-style descriptor
(`src/lib/style/journalStyle.ts`), the presets, the vendored CSL, the Word reference-doc and Journal Check.

**Corrections to the shipped `NATURE_STYLE`:**
- `abstractWordsHard` 300 → **230**. Add a "≥1 citation in the abstract" check.
- Correct the legend-limit comment: 250 is from IS; 300 is from FG and CK.
- Add an ED legend limit of 1,000 words.
- Add **"tables"** to `structure.order`, between references and figure legends. Add **Ethics Statement**.
- Promote the ED caption form from [INF] to measured.
- Add forms for Extended Data Table and Supplementary Table/Video/Note/Data.
- `nature.csl`: "et al." should be **upright**.
- `natureRefs.ts`: datasets and software currently fall into the book branch, giving "(Zenodo, 2024)".
  They need the `Repository https://doi.org/… (year).` form. Chapters and proceedings are unhandled.
- `journalSizing.ts`: add 1.5-column (120–136 mm) and a 170 mm height cap. "Nature full page (180 mm)" is
  really the Extended Data page width.

**Schema gaps the Science and Cell presets will hit:**
- Citation presentation needs an **italic-number-in-roman-parentheses** mode (Science) and an
  **after-punctuation** superscript placement (Cell; the enum already has it).
- Panel-reference grammar the current `PanelStyle` cannot express:
  - Science: "Fig. 1, A and B" / "Fig. 1, A to C";
  - Cell: plural "Figures" with the figure number repeated, "Figures 1A–1C".
- Science's two-consecutive rule (comma) versus ranges at ≥3 is already covered by
  `collapseRunsOfAtLeast: 3`.
- Reference layouts `science` (initials first, all authors, no "and") and `cell` (classic Cell entry,
  numbered, 10 + et al.).
- Three placements for supplementary-only references:
  - Science: continue the main numbering, listed last;
  - Cell: a separate list in the SI PDF;
  - Nature: continue after the Methods references.
- Front-matter blocks:
  - Science: section labels ("Abstract:") and an optional one-sentence summary;
  - Cell: Highlights, eTOC, Keywords, the lead-contact footnote;
  - Science: author symbols after affiliation numbers (not superscript).
- Heading case per journal: Cell ALL CAPS; Nature and Science sentence case.
- Legend title punctuation: Cell has no period; Nature uses "|".
- Science's run-in acknowledgment subheadings; Cell's fixed RESOURCE AVAILABILITY block and STAR Methods
  skeleton.
- Page setup per journal: Science single-spaced US Letter with page numbers; Nature double-spaced; Cell
  house default.
- A **package mode**: text file plus separately exported figure files with journal-specific names and
  formats (Nature: vector main figures and `Surname_EDfig1.jpg`; Science: PDF/EPS; Cell: TIFF/PDF), plus
  the side files (Science Combined PDF, Cell Highlights/eTOC and KRT .docx, SM/SI PDFs).

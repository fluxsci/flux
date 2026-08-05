// A CodeMirror 6 theme + markdown highlight style built from Flux tokens, so
// the editor matches the shell (serif body, accent, dark) and re-themes for
// free when tokens change.
//
// One tuned constraint lives here: the identical active/inactive metrics of
// .cm-flux-embedsrc/.cm-flux-tablesrc (any metric change on caret entry
// reflows the line and breaks goal-column navigation). Caret motion is the
// overlay caret's job (editing/caretFeel.ts) — the old .cm-cursor CSS
// transition glide and its Settings-driven duration var were retired with
// it, 2026-07-21 (verify-caret-feel.ts pins that they stay gone).

import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const fluxTheme = EditorView.theme(
  {
    "&": {
      color: "var(--c-tx)",
      backgroundColor: "transparent",
      height: "100%",
      fontFamily: "var(--font-serif)",
      fontSize: "17px",
    },
    ".cm-scroller": {
      overflow: "auto",
      lineHeight: "1.78",
      fontFamily: "var(--font-serif)",
    },
    ".cm-content": {
      // Reader-adjustable margins (Redesign v2): the two draggable handles set
      // --gutter-l / --gutter-r as fractions of the column. Undragged, the
      // fallback centers a 72ch measure exactly as before.
      maxWidth: "none",
      marginLeft: "var(--gutter-l, max(24px, (100% - 72ch) / 2))",
      marginRight: "var(--gutter-r, max(24px, (100% - 72ch) / 2))",
      padding: "var(--cm-pad-top, 96px) 32px 40vh",
      caretColor: "var(--c-accent)",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--c-accent)",
      borderLeftWidth: "2px",
    },
    ".cm-foldPlaceholder": {
      display: "inline-block",
      padding: "0 0.5em",
      margin: "0 0.2em",
      borderRadius: "var(--r-pill)",
      backgroundColor: "var(--c-accent-tint)",
      color: "var(--c-accent-bright)",
      border: "none",
      cursor: "pointer",
      fontFamily: "var(--font-serif)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground": {
      backgroundColor: "var(--c-accent-tint) !important",
    },
    "&.cm-focused .cm-selectionBackground": {
      backgroundColor: "var(--c-accent-tint) !important",
    },
    ".cm-gutters": { display: "none" },
    ".cm-line": { padding: "0" },

    /* YAML front-matter rendered as quiet metadata (livePreview.ts detects it) */
    ".cm-line.cm-frontmatter": {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      lineHeight: "1.65",
      color: "var(--c-tx-faint)",
    },
    ".cm-frontmatter *": {
      fontFamily: "var(--font-mono) !important",
      fontSize: "12px !important",
      fontWeight: "400 !important",
      fontStyle: "normal !important",
      color: "var(--c-tx-faint) !important",
      letterSpacing: "0 !important",
    },

    /* Embed/table SOURCE lines: always present + navigable (the rendered
       figure/table is a block widget below them). Metrics are identical whether
       or not the caret is on the line — never a layout shift on navigation. */
    ".cm-line.cm-flux-embedsrc, .cm-line.cm-flux-tablesrc, .cm-line.cm-flux-mathsrc": {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      lineHeight: "1.65",
      color: "var(--c-tx-faint)",
    },
    ".cm-flux-embedsrc *, .cm-flux-tablesrc *, .cm-flux-mathsrc *": {
      fontFamily: "var(--font-mono) !important",
      fontSize: "12px !important",
      fontWeight: "400 !important",
      fontStyle: "normal !important",
      color: "var(--c-tx-faint) !important",
      letterSpacing: "0 !important",
      /* lezer tags the whole ![…](…) image as a link → fluxHighlight underlines
         it; a revealed embed source line must read as plain mono, not a link. */
      textDecoration: "none !important",
    },
    /* Collapsed embed line: a compact accent chip carrying the figure NAME —
       the raw `![](path){#fig-x}` reveals only when the caret is on the line
       (chips.ts). Later + more specific than the faint reset above so the
       accent wins. display:inline + zero vertical padding/border: the chip
       must not change the 12px/1.65 source-line metrics (feel contract #3). */
    ".cm-flux-embedsrc .flux-embedchip": {
      display: "inline",
      color: "var(--c-accent-bright) !important",
      background: "var(--c-accent-tint, color-mix(in srgb, var(--c-accent) 12%, transparent))",
      borderRadius: "var(--r-1)",
      padding: "0 6px",
      cursor: "default",
    },
    ".cm-flux-embedsrc .flux-embedchip.unresolved": {
      color: "var(--c-tx-faint) !important",
      background: "transparent",
      borderBottom: "1px dotted var(--c-tx-faint)",
    },

    /* ---- math (2.1): inline chips + the display block widget ---------------- */
    ".flux-math": {
      /* Inherits the prose serif metrics; KaTeX brings its own inner fonts. The
         chip must not change the line's height — no padding/border. */
      display: "inline",
    },
    ".flux-math.pending": {
      fontFamily: "var(--font-mono)",
      fontSize: "0.85em",
      color: "var(--c-tx-faint)",
    },
    ".flux-mathblock": {
      position: "relative",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "10px 44px",
      margin: "2px 0 10px",
      borderRadius: "6px",
      background: "color-mix(in srgb, var(--c-surface) 55%, transparent)",
    },
    ".flux-mathblock .mb-body.pending": {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      color: "var(--c-tx-faint)",
      whiteSpace: "pre-wrap",
    },
    ".flux-mathblock .mb-num": {
      position: "absolute",
      right: "12px",
      color: "var(--c-tx-faint)",
      fontVariantNumeric: "tabular-nums",
      fontSize: "0.9em",
    },
    ".flux-mathblock .katex-display": {
      margin: "0",
    },

    /* ---- live-preview decoration classes (livePreview.ts) ---------------- */
    ".cm-flux-link": {
      color: "var(--c-accent-bright)",
      textDecoration: "underline",
      textUnderlineOffset: "2px",
      cursor: "pointer",
    },
    /* A color span parses as a shortcut link, so the highlighter's link tag
       (accent + underline) lands on inner spans — the span's own inline color
       must win inside. */
    ".cm-flux-colorspan span": {
      color: "inherit",
      textDecoration: "none",
    },
    ".cm-flux-quote": {
      borderLeft: "2px solid var(--c-accent-tint)",
      paddingLeft: "0.9em",
      color: "var(--c-tx-muted)",
      fontStyle: "italic",
    },
    ".cm-flux-codeblock": {
      fontFamily: "var(--font-mono)",
      fontSize: "0.9em",
      backgroundColor: "var(--c-surface)",
      color: "var(--c-tx-2)",
    },
    ".cm-flux-codeblock:first-of-type": {},
    ".cm-flux-bullet": {
      color: "var(--c-accent)",
      paddingRight: "0.1em",
    },
    ".cm-flux-hr": {
      display: "inline-block",
      width: "100%",
      height: "1px",
      verticalAlign: "middle",
      backgroundColor: "var(--c-line-strong)",
    },

    /* ---- science chips (@fig / @cite) ------------------------------------ */
    ".flux-chip": {
      borderRadius: "var(--r-1)",
      padding: "0 0.34em",
      fontSize: "0.94em",
      whiteSpace: "nowrap",
      cursor: "pointer",
      fontVariantNumeric: "tabular-nums",
    },
    ".flux-figref": {
      backgroundColor: "var(--c-accent-tint)",
      color: "var(--c-accent-bright)",
    },
    ".flux-figref:hover": {
      backgroundColor: "var(--c-accent)",
      color: "var(--c-on-accent)",
    },
    ".flux-cite": { color: "var(--c-accent-bright)", padding: "0" },
    ".flux-cite:hover": { textDecoration: "underline" },
    ".flux-chip.unresolved": {
      backgroundColor: "transparent",
      color: "var(--c-tx-faint)",
      borderBottom: "1px dotted var(--c-tx-faint)",
      borderRadius: "0",
      padding: "0",
    },

    /* ---- autocomplete (@ / slash) dropdown -------------------------------- */
    ".cm-tooltip.cm-tooltip-autocomplete": {
      border: "1px solid var(--c-line-strong)",
      borderRadius: "var(--r-2)",
      backgroundColor: "var(--c-surface)",
      boxShadow: "var(--elev-2)",
      overflow: "hidden",
      fontFamily: "var(--font-serif)",
    },
    ".cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--font-serif)",
      maxHeight: "16em",
    },
    ".cm-tooltip-autocomplete > ul > li": {
      padding: "4px 10px",
      color: "var(--c-tx-2)",
      display: "flex",
      alignItems: "baseline",
      gap: "0.5em",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--c-accent-tint)",
      color: "var(--c-tx-hi)",
    },
    ".cm-completionLabel": { fontSize: "0.95em" },
    ".cm-completionMatchedText": {
      textDecoration: "none",
      color: "var(--c-accent-bright)",
      fontWeight: "600",
    },
    ".cm-completionDetail": {
      marginLeft: "auto",
      fontStyle: "normal",
      fontSize: "0.8em",
      color: "var(--c-tx-faint)",
    },
    ".cm-completionIcon": {
      width: "1.1em",
      opacity: "0.7",
      marginRight: "0.1em",
    },
    ".cm-tooltip.cm-completionInfo": {
      border: "1px solid var(--c-line-strong)",
      borderRadius: "var(--r-2)",
      backgroundColor: "var(--c-surface)",
      color: "var(--c-tx-2)",
      padding: "var(--sp-2) var(--sp-3)",
      maxWidth: "260px",
      fontSize: "var(--ts-sm)",
      lineHeight: "1.45",
    },

    /* ---- figure embeds (B2/B4) ------------------------------------------- */
    ".flux-embed": {
      position: "relative",
      // Padding, not margin: block-widget height measurement is stable with
      // padding (margins can escape CodeMirror's widget measurement).
      margin: "0",
      padding: "0.7em 0 1.4em",
      userSelect: "none",
    },
    ".flux-embed-art": {
      position: "relative",
      background: "var(--flx-paper, #fdfcfa)",
      border: "1px solid var(--c-line)",
      borderRadius: "var(--r-2)",
      padding: "18px",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      overflow: "hidden",
    },
    ".flux-embed-art svg": {
      maxWidth: "100%",
      height: "auto",
      maxHeight: "440px",
    },
    /* Explicit width attr ({#fig-x width=60%}): the card is a fraction of the
       text column, the svg fills it, and the 440px cap yields to user intent. */
    ".flux-embed.sized .flux-embed-art": {
      width: "var(--embed-w)",
      margin: "0 auto",
    },
    ".flux-embed.sized .flux-embed-art svg": {
      width: "100%",
      height: "auto",
      maxHeight: "none",
    },
    ".flux-embed-grip": {
      position: "absolute",
      right: "4px",
      top: "50%",
      transform: "translateY(-50%)",
      width: "10px",
      height: "56px",
      borderRadius: "5px",
      border: "1px solid var(--c-line-strong)",
      background: "var(--c-surface)",
      cursor: "ew-resize",
      opacity: "0",
      transition: "opacity var(--dur-quick, 120ms) var(--ease-standard, ease)",
      touchAction: "none",
    },
    ".flux-embed:hover .flux-embed-grip": { opacity: "1" },
    ".flux-embed-grip:hover": { borderColor: "var(--c-accent)" },
    ".flux-embed-readout": {
      position: "absolute",
      right: "8px",
      bottom: "8px",
      fontFamily: "var(--font-mono)",
      fontSize: "11px",
      color: "var(--c-tx-2)",
      background: "var(--c-surface)",
      border: "1px solid var(--c-line-strong)",
      borderRadius: "var(--r-1)",
      padding: "2px 6px",
      pointerEvents: "none",
    },
    ".flux-embed-art.missing": {
      color: "var(--c-tx-faint)",
      fontStyle: "italic",
      fontSize: "0.9em",
      minHeight: "60px",
      background: "transparent",
      borderStyle: "dashed",
    },
    ".flux-embed-cap": {
      margin: "0.6em auto 0",
      maxWidth: "60ch",
      fontSize: "var(--ts-sm)",
      lineHeight: "1.5",
      color: "var(--c-tx-muted)",
      textAlign: "center",
    },
    /* A sized figure's caption box tracks the ART width (var(--embed-w) is set
       on the wrap by applyWidth) — a 91%-wide figure must not funnel its
       caption into a 60ch column. */
    ".flux-embed.sized .flux-embed-cap": {
      width: "var(--embed-w)",
      maxWidth: "none",
    },
    ".flux-embed-cap b": { color: "var(--c-accent-bright)", fontWeight: "700" },
    ".flux-embed-bar": {
      position: "absolute",
      top: "8px",
      right: "8px",
      opacity: "0",
      transition: "opacity var(--dur-quick, 120ms) var(--ease-standard, ease)",
    },
    ".flux-embed:hover .flux-embed-bar": { opacity: "1" },
    ".flux-embed-bar button": {
      font: "inherit",
      fontSize: "0.78em",
      color: "var(--c-tx-2)",
      background: "var(--c-surface)",
      border: "1px solid var(--c-line-strong)",
      borderRadius: "var(--r-1)",
      padding: "3px 8px",
      cursor: "pointer",
    },
    ".flux-embed-bar button:hover": {
      color: "var(--c-tx-hi)",
      borderColor: "var(--c-accent)",
    },

    /* ---- tables (B3) ----------------------------------------------------- */
    /* Selectable (native selection — the widget opts out of CodeMirror's mouse
       handling, so a rendered cell can be copied) and hover-actionable. The
       shell root is user-select:none, so "text" must be EXPLICIT here — plain
       removal just inherits none. */
    ".flux-tablewrap": {
      position: "relative",
      margin: "0",
      padding: "0.7em 0 1.4em",
      userSelect: "text",
      // width:0 + min-width:100%: the widget contributes ZERO min-content to
      // the editor's flex sizing (a wide table would otherwise push cm-content
      // past the pane and put a horizontal scrollbar on the WHOLE editor),
      // then stretches back to the text measure — overflow happens inside
      // .flux-tablescroll, where it belongs.
      width: "0",
      minWidth: "100%",
      // Reset the editor's line-wrapping context (.cm-lineWrapping inherits
      // overflow-wrap/white-space into widgets): without this, cell numbers
      // break ANYWHERE ("1.11" → "1." / "11") and a wide table crushes into
      // word soup instead of overflowing into its scroll container.
      whiteSpace: "normal",
      overflowWrap: "normal",
      wordBreak: "normal",
    },
    /* Wide tables scroll inside their own container instead of crushing the
       columns into per-word wrap soup. */
    ".flux-tablescroll": { overflowX: "auto" },
    ".flux-table": {
      borderCollapse: "collapse",
      width: "100%",
      fontSize: "0.95em",
      fontVariantNumeric: "tabular-nums",
    },
    /* Spreadsheet cursor: a rendered cell is a TARGET — clicking it puts the
       caret into that cell's source text. */
    ".flux-table th, .flux-table td": {
      border: "1px solid var(--c-line)",
      padding: "6px 13px",
      lineHeight: "1.5",
      minWidth: "3.5ch",
      cursor: "cell",
    },
    ".flux-table th": {
      background: "var(--c-surface)",
      color: "var(--c-tx-hi)",
      fontWeight: "600",
      whiteSpace: "nowrap", // headers set their column's floor; body text wraps
    },
    ".flux-table td": { color: "var(--c-tx-2)" },
    ".flux-table tbody tr:hover td": { background: "var(--c-surface)" },
    /* Inline content inside cells (mdInline resolver output). */
    ".flux-table .mdi-ref": { color: "var(--c-accent-bright)", whiteSpace: "nowrap" },
    ".flux-table .mdi-cite": { color: "var(--c-accent-bright)" },
    ".flux-table code, .flux-table-cap code": {
      fontFamily: "var(--font-mono)",
      fontSize: "0.88em",
      background: "var(--c-surface)",
      padding: "0 4px",
      borderRadius: "var(--r-1)",
    },
    ".mdi-math.pending": { fontFamily: "var(--font-mono)", color: "var(--c-tx-muted)" },
    ".flux-table-cap": {
      margin: "0.6em auto 0",
      maxWidth: "60ch",
      fontSize: "var(--ts-sm)",
      lineHeight: "1.5",
      color: "var(--c-tx-muted)",
      textAlign: "center",
    },
    ".flux-table-cap b": { color: "var(--c-accent-bright)", fontWeight: "700" },
    ".flux-table-cap .mdi-ref, .flux-table-cap .mdi-cite": { color: "var(--c-accent-bright)" },
    /* Hover action bar (the embed-bar pattern). */
    ".flux-table-bar": {
      position: "absolute",
      top: "12px",
      right: "4px",
      display: "flex",
      gap: "4px",
      opacity: "0",
      transition: "opacity var(--dur-quick, 120ms) var(--ease-standard, ease)",
    },
    ".flux-tablewrap:hover .flux-table-bar": { opacity: "1" },
    ".flux-table-bar button": {
      font: "inherit",
      fontSize: "0.78em",
      color: "var(--c-tx-2)",
      background: "var(--c-surface)",
      border: "1px solid var(--c-line-strong)",
      borderRadius: "var(--r-1)",
      padding: "3px 8px",
      cursor: "pointer",
    },
    ".flux-table-bar button:hover": {
      color: "var(--c-tx-hi)",
      borderColor: "var(--c-accent)",
    },

    /* ---- comment highlights (C1) ----------------------------------------- */
    ".cm-comment-hl": {
      backgroundColor: "var(--c-comment-tint)",
      borderRadius: "2px",
      boxShadow: "0 1px 0 var(--c-comment)",
      transition: "background-color var(--dur-quick, 120ms) ease",
    },
    ".cm-comment-hl.active": { backgroundColor: "var(--c-comment-tint-2)" },
  },
  // The paper surface is now always the light Flexoki "paper" theme (Redesign
  // v2); declare light so CM's built-in selection/caret defaults match.
  { dark: false },
);

export const fluxHighlight = HighlightStyle.define([
  {
    tag: t.heading1,
    fontSize: "1.9em",
    fontWeight: "700",
    color: "var(--c-tx-hi)",
    lineHeight: "1.3",
  },
  { tag: t.heading2, fontSize: "1.5em", fontWeight: "700", color: "var(--c-tx-hi)" },
  { tag: t.heading3, fontSize: "1.25em", fontWeight: "600", color: "var(--c-tx-hi)" },
  {
    tag: [t.heading4, t.heading5, t.heading6, t.heading],
    fontWeight: "600",
    color: "var(--c-tx-hi)",
  },
  { tag: t.strong, fontWeight: "700", color: "var(--c-tx-hi)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--c-accent-bright)", textDecoration: "underline" },
  {
    tag: t.monospace,
    fontFamily: "var(--font-mono)",
    fontSize: "0.92em",
    color: "var(--c-tx-2)",
  },
  { tag: t.quote, color: "var(--c-tx-muted)", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.meta], color: "var(--c-tx-faint)" },
  // Note: list *content* is intentionally left at body colour; the bullet glyph
  // gets its accent from the BulletWidget (.cm-flux-bullet), and ordered markers
  // stay quiet. Colouring t.list here would tint the whole list text.
]);

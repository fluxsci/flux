// A CodeMirror 6 theme + markdown highlight style built from Flux tokens, so
// the editor matches the shell (serif body, accent, dark) and re-themes for
// free when tokens change.
//
// Part of the LOCKED editing-feel contract — see ./EDITING-FEEL.md. In
// particular: the .cm-cursor 70ms transition (smooth caret) and the identical
// active/inactive metrics of .cm-flux-embedsrc/.cm-flux-tablesrc are tuned
// feel constants — do not change without an explicit user request.

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
    // Obsidian-signature smooth caret: drawSelection reuses the cursor node
    // across moves, so a short position transition animates it. Kept brief so
    // fast typing doesn't smear.
    ".cm-cursor": {
      transition: "left 70ms ease-out, top 70ms ease-out",
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
    ".cm-line.cm-flux-embedsrc, .cm-line.cm-flux-tablesrc": {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      lineHeight: "1.65",
      color: "var(--c-tx-faint)",
    },
    ".cm-flux-embedsrc *, .cm-flux-tablesrc *": {
      fontFamily: "var(--font-mono) !important",
      fontSize: "12px !important",
      fontWeight: "400 !important",
      fontStyle: "normal !important",
      color: "var(--c-tx-faint) !important",
      letterSpacing: "0 !important",
    },

    /* ---- live-preview decoration classes (livePreview.ts) ---------------- */
    ".cm-flux-link": {
      color: "var(--c-accent-bright)",
      textDecoration: "underline",
      textUnderlineOffset: "2px",
      cursor: "pointer",
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
    ".flux-tablewrap": { margin: "0", padding: "0.7em 0 1.4em", userSelect: "none" },
    ".flux-table": {
      borderCollapse: "collapse",
      width: "100%",
      fontSize: "0.95em",
      fontVariantNumeric: "tabular-nums",
    },
    ".flux-table th, .flux-table td": {
      border: "1px solid var(--c-line)",
      padding: "6px 13px",
      lineHeight: "1.5",
    },
    ".flux-table th": {
      background: "var(--c-surface)",
      color: "var(--c-tx-hi)",
      fontWeight: "600",
    },
    ".flux-table td": { color: "var(--c-tx-2)" },
    ".flux-table tbody tr:hover td": { background: "var(--c-surface)" },
    ".flux-table-cap": {
      margin: "0.6em auto 0",
      maxWidth: "60ch",
      fontSize: "var(--ts-sm)",
      lineHeight: "1.5",
      color: "var(--c-tx-muted)",
      textAlign: "center",
    },
    ".flux-table-cap b": { color: "var(--c-accent-bright)", fontWeight: "700" },

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

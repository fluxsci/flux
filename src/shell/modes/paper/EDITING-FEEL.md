# The Paper editor's editing feel is LOCKED

The cursor movement, typing latency, and overall editing feel of this module
were overhauled and hand-tuned in July 2026 (commits PaperNav 1–2, PaperFig 3,
PaperCite 4–5, PaperKeys 6), and the owner has explicitly signed off on the
result: **"I want the feel of the cursor/typing/editing to remain JUST like
this."** Treat the invariants below as a contract. Do not "improve", refactor
away, or trade off any of them without the user explicitly asking for that
specific change.

## The invariants (and why they exist)

1. **Editor decorations are a pure function of the document — never of the
   selection.** `science/embeds.ts` and `science/tables.ts` rebuild their
   StateFields only on `docChanged` / `refreshChips`. The old code rebuilt on
   selection and swapped a ~500px widget in the same transaction that moved
   the caret — that was THE "arrow up jumps multiple lines" bug. Never add a
   selection-dependent branch to these fields, and never mutate layout
   (heights, display, metrics) in response to caret movement.

2. **No block-level `atomicRanges`, no `Decoration.replace` over lines.**
   Embeds and tables render as a styled *source line* (`cm-flux-embedsrc` /
   `cm-flux-tablesrc`) plus a `Decoration.widget({block: true, side: 1})`
   AFTER the line. Every doc line = exactly one vertical keypress. Inline
   atomics (chips, hidden syntax) are fine; block atomics are not.

3. **Source-line styling must keep identical metrics active vs. inactive**
   (mono 12px both ways — dim via color/opacity only). Any font-size or
   padding change on caret entry reflows the line and breaks goal-column
   navigation.

4. **Block widgets carry an accurate `estimatedHeight`** (computed from the
   SVG's own width/height attrs) and patch themselves in place via
   `updateDOM()` for width-only changes. Removing either brings back scroll
   jumps.

5. **Vim loads FIRST in the extension tree** — the `first` slot in
   `markdown-setup.ts` (`createEditorExtensions`). Vim claims keys at the DOM
   level and its status panel host crashes if anything (e.g. `search()`'s
   panel host) initializes before it. Vim flavors (`off | vim | flux`) live in
   `editing/vim.ts` + `editing/vimStore.ts`; flux-flavor tweaks (jj → Esc, …)
   are applied ONLY in `applyFluxFlavor` so plain vim always has stock
   behavior.

6. **Feel constants — do not tweak without an explicit user request:**
   - `EditorView.scrollMargins` top 84 / bottom 96 (caret never hugs the
     viewport edge) in `markdown-setup.ts`.
   - `.cm-cursor { transition: left var(--flux-caret-ms, 70ms) … }` in
     `flux-theme.ts` (the smooth caret the user loves). The **default is 70ms**
     (the loved feel — keep it as the default); the duration is user-tunable via
     Settings › Paper › caret glide, which sets `--flux-caret-ms` on
     `section.paper` (0ms = instant). Unlocked for configurability July 2026 at
     the owner's request — the *default* stays the invariant, the value is the
     knob.
   - The 150ms `latestIdle` debounce for TOC/stats (typing is never taxed
     per-keystroke).

7. **Focus returns to the editor after every transient UI** (palette, picker,
   margin panes, preview, prompts, modal closes). Keyboard-first is the
   operating assumption; anything that strands focus is a regression.

8. **Citation ordinals publish synchronously** (`citeNumberField` sits before
   the chip plugin in the extension list) so numeric chips never render a
   stale number.

9. **External reloads dispatch a minimal single-span diff** (`minimalDiff` in
   PaperMode), never a whole-doc replace — selection, scroll, and comment
   marks survive agent/disk edits.

## The gate

After ANY change to this module, run the verify suite (dev server on :1420):

```
node scripts/verify-paper-nav.mjs        # 1-keypress-per-line, zero layout shift
node scripts/verify-paper-vim.mjs        # vim + Esc ordering + toggle
node scripts/verify-paper-keyboard.mjs   # focus discipline, folding, preview, status bar
node scripts/verify-fig-width.mjs        # figure sizing (updateDOM identity)
node scripts/verify-citegroup.mjs        # citation group editor
node scripts/verify-paper-extras.mjs     # flux-vim jj, hover card, panel toggles
node scripts/verify-figref.mjs           # @@ picker, panel refs, live renumber/caption sync
npx tsx scripts/verify-figname.ts        # name-derived designations ("Figure 3" → "3") + panel specs
npx tsx scripts/verify-citenum.ts        # citation numbering (pure)
node scripts/verify-w18-paper.mjs        # decoration stability on selection-only txns
node scripts/verify-paper-math.mjs       # math (2.1): nav through $$ blocks, reveal-on-touch, export parity
```

(Or run the whole list at once: `node scripts/run-verifies.mjs --group paper-gate`.)

`verify-paper-nav.mjs` is the canary for the feel itself: it asserts that N
ArrowDowns advance exactly one line each through embeds and tables, that
`.cm-content` scrollHeight does not change across caret moves, and that the
goal column survives crossing a figure. If it fails, the feel regressed —
fix the regression, don't loosen the test.

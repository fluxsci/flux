# Inline slides in Paper documents

Status: approved and implemented; release verification is recorded in `INLINE_SLIDES_TESTING.md`.

Prepared 2026-09-13 from the current Flux checkout. Applies to manuscripts, ordinary documents, and Context documents opened in Paper.

## 1. Recommended feature

Add **Insert slide…** alongside **Insert figure…**. The user chooses a project deck, then one slide. Paper inserts a linked block at the caret. It initially displays the slide's **step 0**, and the user advances through its animation steps by clicking the artwork or the small Next button below it.

The block keeps the deck as its source of truth. It uses Flux's existing slide compiler, renderer, and player. Each occurrence has independent playback state, including two occurrences of the same slide in one document or in separate Paper panes.

Ship the picker, editor playback, document preview, portable HTML playback, and correct static PDF/Word export together. These are successive implementation milestones within one feature.

## 2. User-facing contract

### Insertion

1. Open **Insert slide…** from the command palette or type **/slide**. Put it next to the existing figure insertion action; a new global keyboard chord is unnecessary.
2. Choose a deck from a searchable list, using its title and slide count. Only decks registered in this project appear. Show empty, unavailable, and incompatible decks explicitly.
3. Choose a slide from a searchable thumbnail grid in deck order. Each card shows its name, position in the deck, and number of animation steps. A Back control returns to deck selection.
4. Enter or clicking a card inserts it. Escape cancels and returns focus to the originating editor. Reopening starts a fresh picker, following the figure picker's existing lifecycle.

Use the fully built slide for picker thumbnails, matching the existing slide filmstrip; slides that introduce all their content through animations would otherwise be hard to recognize. State briefly in the picker that insertion starts at step 0. Thumbnails are cached images, with only visible rows rendered; they do not mount active players.

Insertion follows the figure block convention: use an empty line when available, otherwise insert a separated block after the current line. It is one undoable document edit. While assets load, keep the dialog and editor responsive. Recheck the originating project, pane, document, mapped insertion anchor, deck, and slide before committing a delayed selection. A project/document switch cancels the pending insertion.

### Inline presentation

Default width is 100% of the document's text column, preserving the deck's aspect ratio and its authored background. Offer the familiar 50% / 75% / 100% / Auto sizing and resize grip. The document width changes the displayed scale, never the slide's authored dimensions.

Below the artwork, show a compact row:

```text
Deck title · Slide name           ‹  Step 0 / 4  ›   ↺   Open in Slide
```

An optional document-owned caption can appear below it. Deck/slide names are linked metadata; slide speaker notes are not a caption and are not included in the document or exported payload.

| Action | Result |
| --- | --- |
| Initial insertion or fresh document open | Show the completed resting state of beat 0; no animation or auto-advance starts. |
| Click artwork or Next | Animate the next authored step, then stop at its endpoint. |
| Several tracks within one step | Play together with their existing delays, durations, easing, and stagger. |
| Deck step marked `auto` or `with-prev` | In the document, require a separate click for that step. Preserve the deck's authored settings. |
| Click Next during an animation | Finish that animation immediately; do not skip into another step. The next click advances again. |
| Back | Cancel any active animation and show the previous step's endpoint. During a transition from k to k+1, return to k. |
| Reset | Return immediately to step 0. |
| At the final step | Disable Next; clicking the artwork does nothing. Never advance to a different slide. |
| Slide with no animation steps | Show its resting artwork and Open in Slide; omit unnecessary playback controls. |
| Open in Slide | Use the existing editor handoff to open that deck and exact slide. Playback alone never invokes this handoff. |

“One step” means an authored beat, not one track. Breaking simultaneous tracks into separate clicks would change the animation's meaning. Overriding the deck's step-advance settings only within embeds is the recommended reading experience; honoring presentation timing can be a later explicit option.

The player is keyboard accessible when focused: Right/Enter/Space advances, Left goes back, Home resets, and Escape returns focus to the editor. Tab reaches labeled buttons normally. Unfocused embeds must not capture document navigation, typing, selection, scrolling, or Vim commands. Announce settled step changes, not animation frames. A keyboard-operated animation toggle may snap transitions to endpoints while keeping the same steps; ambient UI motion remains governed by existing preferences.

Changing playback state does not dirty the manuscript or deck and does not enter either undo history. Ordinary prose edits, width changes, scrolling away and back, or a preview refresh must preserve an occurrence's current settled step. Closing/reopening the document resets playback to 0. If a playing block leaves view, stop its clock and retain its target endpoint for re-entry.

## 3. Document representation

Use a normal Quarto image with a slide-specific class and attributes, backed by a generated step-0 SVG. For example, from `paper/notes.qmd`:

```markdown
![](../slides/talk/renders/results-step-0.svg){#slide-e7b2 .flux-slide deck="talk" slide="results" width=100%}
```

Proposed fields:

- `deck` and `slide`: stable source IDs. Never resolve by deck title, slide name, or ordinal position.
- `#slide-e7b2`: occurrence identity, distinct from the source slide ID. Used for local playback restoration and ordinary anchor links.
- `.flux-slide`: explicit type marker, keeping this block outside the existing `fig-…` grammar and figure numbering.
- `width`: same unit and preservation rules as figure embeds.
- Alt text: optional document-owned caption/description. Unlike linked figure captions, slide captions must not pass through figure-alt normalization.
- Image destination: document-relative path to a rebuildable SVG poster. Resolve the actual deck file through `project.json.slides[].path`, including customized paths; the derived poster path is not the deck lookup mechanism.

The authoritative fields are source IDs and document text. Posters, thumbnail images, parsed assets, and playback position are derived. New syntax requires no deck or project schema migration. Existing documents remain byte-identical.

Create one shared parser/serializer and code-aware block scanner under `src/lib/slide/`. It must handle attribute ordering, escaped caption text, whitespace, quoted values, and unrelated attributes without discarding them. Exclude front matter, code examples, comments, and math; use the same scanner for editor, renderer, export, and dependency discovery. Do not extend `EMBED_RE` so a slide accidentally enters figure reference reconciliation, numbering, or caption normalization.

Generate new occurrence IDs on insertion. Playback identity must also tolerate pasted duplicate IDs without sharing state or silently rewriting prose: maintain a distinct editor occurrence handle mapped through transactions, and allocate distinct DOM namespaces for every mount. Show duplicate anchors as a document diagnostic; exports give each rendered occurrence a unique DOM identity. Cross-project copying remains unresolved until the corresponding source deck is available; do not silently link to a same-named slide.

Relative poster links must use `relativeDocumentPath` and survive `relocateDocumentLinks`, nested folders, includes, Context documents, legacy manuscript folders, project moves, and Windows separators. Deleting an embed removes only the document block.

## 4. Existing foundations and necessary changes

| Area | Verified current behavior | Implementation consequence |
| --- | --- | --- |
| `paper/scholar/FigurePicker.svelte`, `PaperMode.svelte:insertFigure` | Figure picker inserts a one-line image and returns editor focus. | Follow the interaction/insertion convention; add a dedicated two-stage SlidePicker. |
| `paper/science/embeds.ts`, `changeGate.ts` | Figure block widgets are document-derived, height-estimated, and change-gated. Width-only edits patch their DOM. | Add slide widgets with the same navigation guarantees and explicit playback lifecycle. |
| `slide/ops.ts:addSlide`, `slide/player/player.ts` | Beat 0 is the resting state. The player supports seeking, playing, events, and destruction. Its default navigation schedules auto beats, groups `with-prev`, and crosses slides. | Add an opt-in manual step policy; retain existing Present/editor/export defaults. |
| `slide/player/render.ts`, `transform.ts` | Both still read global `plotDom`; rendering also reads global manifests. SVG prefixes start from authored element IDs. | Add a scoped asset/DOM context and per-mount ID namespace before mounting multiple inline players. |
| `project/slideBridge.ts` | Listing and reading are separate from store loading, but `readDeck` seeds editing baselines and can quarantine; asset resolution populates shared caches. | Extract a read-only inspection/gathering path. Do not call `loadDeckInto` or the cache-populating resolver from embeds. |
| `flux-core/slides.ts:gatherDeckPayload` | Builds complete portable payloads, including assets referenced only by transformations; it also synchronizes sources and can write. | Share dependency/resolution policy with an IO-injected read-only gatherer. Keep accepted source writes in an explicit synchronization stage. |
| `projectWatch.ts` and revision stores | External slide changes bump `deckRevision`; own writes are suppressed by the filesystem watcher. Paper currently subscribes to figures and bibliography. | Publish successful in-app deck saves as well, and subscribe Paper's slide data service to relevant deck and asset changes. |
| `PreviewPane.svelte` | Preview runs in a sandboxed iframe and replaces `srcdoc` when it updates. | Add playback-state restoration across those updates, alongside scroll restoration. |
| `renderManuscript.ts`, `exportQmd.ts`, `flux-core/manuscript.ts` | GUI HTML/PDF use the in-app renderer; Word and CLI compile use Quarto preparation. | Both export paths must recognize the same embed representation. |
| `slide/export/runtime.ts` | Existing portable runtime is a full presentation host with viewport layout, global keyboard behavior, notes, and a timer. | Reuse the player, add a compact embed host; embedding the current full presentation runtime directly is inappropriate. |
| `project/dependencies.ts` | Usage is indexed by figure and asset. Its recursive document walk does not currently scan ordinary `paper/` documents beyond manifest registrations. | Add deck/slide usage and align scanning with canonical document discovery, including open unsaved buffers. |

In this table, `paper/` abbreviates `src/shell/modes/paper/`, `slide/` abbreviates `src/lib/slide/`, and `project/` abbreviates `src/lib/project/`. `projectWatch.ts` is in `src/lib/project/`; `exportQmd.ts` is in `src/lib/`.

### A. Shared source and asset service

Add a small pure contract for `SlideEmbedRef`, reference resolution, dependency collection, validation results, and revision keys. It is used by renderer and Node adapters. Share the existing normalize/forward-version/validation logic; keep baseline adoption, quarantine, toasts, locks, and filesystem writes in their proper adapters.

A requested slide snapshot contains deck identity, title, stage, theme/background, the selected slide, and the assets/manifests required by its elements and every animation target. It excludes other slides, speaker notes, recipes, and authoring-only local filesystem paths from portable payloads. Resolve registered accepted assets before raw source paths, preserving source-sync and physical-size rules.

Cache immutable snapshots by project root, deck ID, slide ID, and relevant content/asset revision. Reuse bytes/prepared pristine plot documents between occurrences within that scope; clone DOM per mount. Handle deck-local asset IDs that collide across decks. A broken slide or asset must not prevent other picker cards or embeds from rendering.

Keep viewing read-only. Successful source synchronization publishes an accepted snapshot; a loader must not alter the active editor's baseline or caches. Extend the existing source-sync service to cover referenced closed decks, since its current live-deck refresh alone cannot keep those current. Use existing conflict, lock, accepted-size, and publish-after-persistence rules. Unreadable/invalid data remains a diagnostic, never an empty replacement.

### B. Reusable compact player

Add a framework-neutral `mountSlideEmbed(host, snapshot, options)` controller over `createPlayer`. Give it one selected slide, the manual-step policy, responsive fit, local controls, state restoration, and `destroy()`.

Thread an explicit asset context through `SlideRenderCtx`, `PlayerOpts`, and transform/morph rendering: prepared plot DOM, manifest, asset URL, and size. Keep an adapter for existing authoring callers. Inline rendering must not seed or clear the Figure/Slide plot caches.

Add shared DOM-ID helpers so every plot placement and transform/crossfade layer is unique to its mount. Logical element/track IDs stay unchanged. Thread the same render prefix through `prefixIds`, part targeting, override application, morph matching, and generated clip/mask/filter/gradient/use references. This prevents duplicate embeds or a hidden kept-alive editor from blanking another plot. Preserve the existing plot stylesheet scoping.

Implement manual navigation in the player/controller contract, not by rewriting deck beats. Suppress initial transitions and auto timers from construction onward. Keep existing Present and full-deck export behavior unchanged. There must be zero animation callbacks while idle.

### C. Paper integration

Add `SlidePicker.svelte`, a per-Paper data adapter, and `science/slideEmbeds.ts`. Wire the action through `commands.ts`, slash completions, and the per-editor `chipContext` handler registry.

The CodeMirror field tracks parsed reference spans and decorations. It performs no filesystem access, asset parsing, or player construction on the keystroke path. Resolve data asynchronously; publish a scoped refresh for affected blocks. Keep the source line navigable and the rendered block below it; no block atomic ranges and no selection-dependent block replacement.

Widgets retain the player when text elsewhere changes. Width/caption/title updates patch DOM and request measurement without restarting playback. Reserve artwork height from stage aspect ratio plus fixed controls and measured caption space, including the loading/error state. Maintain occurrence state in the owning editor with transaction-mapped positions, so viewport virtualization does not reset it.

Mount players only in/near the viewport and bound concurrent preparation. Release player bindings, observers, listeners, timers, and blob URLs on unmount. Preserve a lightweight poster and step record for distant blocks. Picker search and scrolling use windowed rows; do not port the filmstrip's global-store component directly into Paper.

For **Open in Slide**, flush the requesting document through the existing checked handoff and route deck ID plus slide ID. A failed save must leave the user in the intact document with the existing error handling.

### D. Source updates and missing references

Deck reorder or renaming updates labels only; stable source IDs keep the same slide. A relevant saved artwork/timeline/asset change invalidates only dependent snapshots. Retain the selected beat by beat ID when it survives, cancel any in-flight animation, and display that beat's fresh endpoint. If the selected beat was removed, reset to 0. Unrelated slide edits preserve the player unchanged.

Publish save events only after successful persistence, including deck edits performed inside Flux, duplicate/create/remove operations, and accepted source updates. Exclude generated `slides/<deckId>/renders/` files from authored-deck refresh signals to avoid poster-write reload loops. Protect asynchronous work with project/document generation checks.

Missing deck/slide, unreadable assets, forward-version refusal, and unsupported animation diagnostics stay local to the block. Retain the block's dimensions and provide **Choose replacement…** and a useful source label. Never substitute slide 1 or an adjacent slide. A last-good poster may remain visible only when visibly marked unavailable/out of date; it does not prove a successful fresh export.

Extend dependency discovery with `byDeck` and `bySlide`. Include all canonical documents and current unsaved buffers. A requested slide/deck deletion that would break documents must report their names and use a shared blocker/explicit override policy in GUI and CLI. Keep the current distinction between removing a deck from the registry and deleting its files. A removed registry entry is unresolved for linked embeds until explicitly restored; leftover files do not silently keep it linked.

## 5. Preview and export contract

| Surface | Result |
| --- | --- |
| Paper editor | Interactive; begins at 0; local playback state. |
| Continuous and paginated preview | Same compact interactive player, beginning at 0 and preserving state across ordinary preview refreshes. |
| Flux HTML export, GUI and CLI | Self-contained interactive embeds, all initially at 0; works offline without Flux. |
| PDF export, GUI and CLI | A static step-0 image, with caption/width retained and no playback controls. |
| Word export, GUI and CLI | A static step-0 image with a verified raster fallback. |
| A plain external Quarto render | Ordinary static image fallback when generated posters are present. Animation enhancement requires Flux's export path. |

Recommend step 0 for static output in this first release because it is explicit and matches the requested initial display. It can be sparse or blank for slides that build everything in. Choosing a later print frame is a useful follow-up, not an implicit “current playback” dependency. Document this behavior in the export UI/help; do not derive a saved output from whichever step the author happened to click last.

### Posters

Add a shared `renderSlidePosterSvg` endpoint renderer over the existing compiled state, `elementToSvg`/`figureToSvg`, and placed-plot markup machinery. It must include the stage background, camera, group visibility, future entrances, plot-part opacity/visibility, ghost births, count-up baseline, crops, and point-size compensation. Extend shared evaluated state where needed rather than implementing separate animation rules in the poster renderer.

This is the first technical proof to complete: ordinary static slide elements are insufficient for a correct step-0 poster. Compare actual painted SVG posters against the browser player's step-0 frame on representative fixtures, including legacy supported decks. Any semantic gap must be fixed in the shared evaluator/renderer before relying on this path for Word/PDF. Use the same endpoint mechanism for fully built picker thumbnails and test that endpoint too.

Generate posters on insertion and after relevant accepted source changes, and regenerate/check them during export preflight. Store a rebuildable fingerprint covering selected slide, effective stage/theme, all dependencies, and renderer version. Writes are atomic and byte-identical writes are skipped. A missing render blocks a clean-success export rather than leaving a broken image link.

### Interactive documents

Extend `renderManuscript` with explicit project/document context and output purpose (interactive preview, interactive HTML, or static print), instead of treating every output as identical HTML. Emit a static poster for each slide first, then enhance it with the compact host. Keep artwork/control dimensions known before pagination. Both modes must preserve captions and treat the whole block as a pagination unit.

The existing Electron print window runs with JavaScript disabled. PDF content must therefore be fully materialized before it reaches that window; injecting a player bootstrap and waiting for it there cannot work. Await image/font readiness using the applicable export adapter, and verify the resulting page pixels.

Package one compact runtime and the required fonts per exported document, with deduplicated slide/asset payloads and independent occurrence state. Do not embed a full exported presentation per block. Repeated uses of a slide share immutable data, not a Player instance. HTML printing uses the poster via print styles.

The preview's `srcdoc` replacement needs a bounded, validated state message alongside scroll restoration: occurrence identity, source revision, beat ID. Accept messages only from that preview iframe. Restore state only when it matches the current document/ref; fresh documents and newly inserted embeds begin at 0.

Integrate the compact runtime with the existing prebuilt export-asset pipeline. Prebuild before any consumer that embeds its bytes. Add exact generated script hashes to the development and Electron CSP through one build-owned value and extend the CSP drift gate. Keep `sandbox="allow-scripts"`; no `allow-same-origin`, `unsafe-inline`, or `unsafe-eval` expansion. Escape serialized payloads so authored text cannot terminate their data container. Verify both dev and packaged builds; runtime bundling must not require esbuild in the installed app.

### Quarto/CLI path

Extend shared export preparation to collect slide references from the selected document and its include tree. Static formats retain poster images; HTML uses generated compact-player blocks/resources. Use the same payload, scanner, poster, and serialization cores as the GUI; IO is injected. Preserve the existing preparation/restore guarantee on success, cancellation, and failure, without overwriting a concurrently changed source.

CLI `compile` currently targets the manifest's default document. Add an explicit document option so an ordinary nested Paper document receives the same supported export as a main manuscript. Verify requested output presence and slide coverage; a zero Quarto exit code alone is not sufficient.

Use the existing `docxSvgFallback` shared machinery for Word, retaining its renderer-canvas and headless-resvg adapters. Test the actual image parts, raster relationships, caption, and pixels. Do not introduce a new native dependency.

## 6. Agent/API coverage

Expose one registry-backed `insert_slide_embed` / `insert-slide-embed` operation using the shared serializer and ordinary document mutation rules. Inputs: deck ID, slide ID, optional document path, width and caption, and an optional unique text anchor; absent anchor appends a separated block. A missing or ambiguous anchor fails without writing. Validate source IDs and recheck the document baseline under the existing manuscript lock before persistence.

Return the document path, stable occurrence ID, source IDs, and inserted Markdown. Existing deck/slide inspection operations provide selection data; add slide listing metadata only where the current read surface lacks it. GUI insertion uses the same reference validation and insertion planning, applied as one CodeMirror transaction. File writes remain in the respective engines.

Regenerate CLI/MCP goldens and agent reference documentation through the existing registry tooling. Do not hand-edit generated files. Publish structured missing-reference diagnostics to agents as well as displaying them in the app.

## 7. Delivery sequence

1. **Prove rendering isolation and poster fidelity.** Add the asset context/ID namespace, explicit manual navigation, shared embed reference contracts, and scoped payload gatherer. Demonstrate two instances of one animated plot slide plus a second deck with colliding asset IDs. Compare the initial/final poster against real player output. This retires the largest technical risk before substantial picker work.
2. **Deliver the complete insertion-to-playback path.** Build the two-stage picker and document widget; wire commands, width, caption, keyboard access, Back/Reset, and Open in Slide. Gate one-edit Undo and unchanged deck/editor state. Exercise static and animated fixtures in the app.
3. **Finish lifecycle and source updates.** Add targeted revision notifications, closed-deck source refresh, transaction-mapped occurrence state, viewport cleanup, replacement/error states, and dependency-aware deletion. Exercise two Paper panes and kept-alive Figure/Slide modes.
4. **Complete preview and all exports.** Integrate compact runtime packaging/CSP, preview state restoration, SVG poster materialization, PDF/Word fallbacks, Quarto HTML enhancement, and CLI document selection/insertion. Open real artifacts and test HTML with the network disabled.
5. **Run release gates and document the feature.** Update Paper and Slide user guides, agent documentation, verification manifest/path mappings, and the engineering guide. Record visible app/export evidence and performance measurements in a focused testing note.

This is a medium feature spanning Paper, slide runtime, and export plumbing. The picker itself is straightforward; most of the implementation effort is in independent playback, reference lifecycle, and consistent exported output. Do not treat a successful widget demo as the completed feature.

## 8. Verification and release criteria

Add manifest-registered gates with these responsibilities (proposed names):

| Gate | Essential assertions |
| --- | --- |
| `verify-slide-embed-core.ts` | Syntax/roundtrip, code-aware scanning, IDs, relative paths, duplicate occurrences, reference/dependency planning, GUI/Node payload and poster parity, legacy/forward guards. |
| `verify-slide-embed-player.ts` | Starts at 0; manual one-beat advance for click/auto/with-prev; authored concurrent tracks; mid-animation click; Back/Reset/end boundaries; no cross-slide navigation; zero timers at rest/destroy; deterministic seeks and unchanged input snapshot. |
| `verify-paper-slide-embeds.mjs` | Deck then slide selection through real controls, slash/palette focus, mapped insertion, Undo/Redo, widths, captions, actual animation geometry/visibility, duplicate embeds, independent panes, keyboard/Vim, scroll stability, empty/missing states. Register in `paper-gate`. |
| `verify-slide-embed-lifecycle.mjs` | No authoring store/cache contamination; hidden-editor SVG/style collisions; deck-local ID collisions; source-only changes, in-app saves, cold decks, changed beat IDs, stale async loads, offscreen cleanup and re-entry. |
| `verify-slide-embed-export.ts` plus browser checks | GUI/CLI references and selected documents agree; transitive includes; HTML works offline; no notes/unrelated slides/local paths; PDF/Word posters paint correctly; source restoration; missing poster prevents clean success; rebuild after cache removal. |
| `verify-scale-paper-slide-embeds.mjs` | 20k-line document with repeated and distinct embeds; large deck picker; only visible players/thumbnails mounted; no full recompile on prose/caret/width changes; timings and callback counts. |

Use existing fixtures for plot morph chains, reverse seeks, ghost transforms, camera movement, draw-on shapes, cropped/rotated plots, authored opacity, static images, and text. Add a slide that is entirely hidden at step 0 so the tests cannot confuse the filmstrip's final state with the requested initial state. Compare playback with Present using the same source revision.

Performance targets:

- Typing, navigation, picker search/scroll, width drag, and ready-player clicks: **≤100 ms to visible response** at fixture scale.
- Warm opening/selection: **≤1 second**; display longer loading work only when it exceeds that band.
- Preserve existing slide frame budgets, including the unchanged dense-playback target. Measure idle clock and native/headful behavior when compositor timing is suspect.
- Idle embeds: zero animation callbacks. Prose/caret changes: zero slide compilations or asset reparses. Residency scales with visible content, not the number of references in the document.
- Export over one second reports progress; long export is cancelable. Read payloads once per unique source revision.

Before release, run `npm run check`, production builds including runtime/CLI/MCP assets, the pure tier, the full `node scripts/run-verifies.mjs --group paper-gate` against :1420, relevant existing Slide/player/ghost/morph/export/tenancy/source-sync checks, the new scale gate, and bundle/startup/CSP gates. Check whether :1420 already serves before starting a server. Verify the native packaged-style runtime on isolated project fixtures; do not test writes against the user's real projects or library.

Acceptance is the entire workflow: select a deck and slide, see its true step 0 inline, step forward/back through the existing animation, keep writing without playback resetting or moving the caret, reopen with the reference intact, receive saved slide updates, and export both a working offline HTML document and visible static PDF/Word images.

## 9. Deliberate boundaries

This release embeds a single existing project slide. Full-deck embeds, external PowerPoint/Google Slides import, cross-project linking, detached/frozen copies, editing slide objects within Paper, presentation notes/HUDs, autoplay, slide-specific figure numbering/cross-reference syntax, and selecting a separate print step can be added separately. The source model and runtime context should permit future print-step and timing options without rewriting current document references.

## 10. Investigation evidence

Read the engineering-guide body and recent session entries, and inspected the source seams named above. The existing `verify-slide-player.ts` and `verify-slide-timeline.ts` checks passed on Node v22.17.0 on 2026-09-13; the latter reports 54 assertions. These establish a useful baseline for the reused engine, not verification of the proposed feature. No full regression suite or new GUI/export behavior was claimed during this planning session.

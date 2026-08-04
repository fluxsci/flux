<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { EditorView } from "@codemirror/view";
  import { projectModel } from "../../shellStore";
  import { readManuscript, writeManuscript } from "../../../lib/project/load";
  import { frontMatterBounds, frontMatterMeta } from "./frontmatter";
  import { externalManuscriptChange } from "../../../lib/project/projectWatch";
  import { createEditorExtensions } from "./markdown-setup";
  import Editor from "./Editor.svelte";
  import Outline from "./outline/Outline.svelte";
  import DocumentPicker from "./documents/DocumentPicker.svelte";
  import { listDocuments, createDocument, type DocEntry } from "./documents/documents";
  import TitlePill from "./TitlePill.svelte";
  import TitleEditor from "./TitleEditor.svelte";
  import CommandPalette from "../../command/CommandPalette.svelte";
  import type { Command } from "../../command/commands";
  import { paperPaletteRequest, openDocRequest } from "../../command/commandBus";
  import { contextCommands } from "../../command/globalCommands";
  import { paperSelectionWatcher } from "./paperContext";
  import { setPaperContextDoc } from "../../../lib/project/paperSelectionStore";
  import { paperLayout } from "./view-mode/paperLayoutStore";
  import { cursorPos, cursorWatcher } from "./outline/activeHeading";
  import SelectionToolbar from "./toolbar/SelectionToolbar.svelte";
  import EmptyState from "./EmptyState.svelte";
  import { selectionWatcher } from "./toolbar/selectionState";
  import { formattingKeymap, CM_HINTS } from "./editing/keymap";
  import { paletteFromTable, dispatchWindowKey, type PaperCmdCtx } from "./commands";
  import { vimCompartment, vimExtensions } from "./editing/vim";
  import { paperVimFlavor, type VimFlavor } from "./editing/vimStore";
  import { setEmbedWidth, EMBED_RE } from "./science/figureAttrs";
  import { transformQmdForExport } from "../../../lib/exportQmd";
  import { setEmbedWidthPreset } from "./editing/figureSize";
  import { citeNumberField } from "./science/citeNumbers";
  import { citationStyleOf } from "./scholar/citeNumbering";
  import { createPaperNumbering, numberingFacet } from "./scholar/numberingFacet";
  // WS-4.2: THIS pane's numbering instance (facet value + margin-facing stores).
  const numbering = createPaperNumbering();
  import { setFrontMatterKey } from "./scholar/frontMatter";
  import { activeCitationWatcher, resetActiveCitation } from "./scholar/activeCitation";
  import { followAtCaret } from "./editing/caretActions";
  import { foldSection, unfoldSection } from "./editing/folding";
  import { foldAll, syntaxTree, syntaxTreeAvailable, unfoldAll } from "@codemirror/language";
  import { keymap } from "@codemirror/view";
  import StatusBar from "./StatusBar.svelte";
  import { wordCount } from "./margin/views/stats";
  import { pageCompartment, themeFor } from "./view-mode/pageView";
  import { paperViewMode, type PaperViewMode } from "./view-mode/paperViewStore";
  import { getOutline, type OutlineItem } from "./outline/outline";
  import { scienceChips, refreshChips } from "./science/chips";
  import { anyCiteRe, crossrefRe, isCrossrefKey } from "./science/grammar";
  import { scienceEmbeds } from "./science/embeds";
  import { scienceTables } from "./science/tables";
  import { scienceMathBlocks, trackMathView } from "./science/math";
  import {
    setChipHandlers,
    setEmbedHandlers,
    setSlashHandlers,
    type ChipTarget,
  } from "./science/chipContext";
  import FigurePicker from "./scholar/FigurePicker.svelte";
  import FigRefPicker from "./scholar/FigRefPicker.svelte";
  import { figRefTrigger } from "./scholar/figRefTrigger";
  import type { FigureRef } from "./scholar/figures";
  import DynamicMargin from "./margin/DynamicMargin.svelte";
  import type { MarginHost } from "./margin/types";
  import { summonPane, closeActivePane, closeAllPanes } from "./margin/marginPanes";
  import { BG_SOURCES, rerollBgSeed } from "./margin/bgSources";
  import { settings } from "../../../lib/settings";
  import * as terminalSession from "../../terminal/terminalSession";
  import { writeCiteGroup, removeCite as removeCiteOp, citationGroupAt } from "./scholar/citeOps";
  import PreviewPane from "./render/PreviewPane.svelte";
  import { renderManuscript } from "./render/renderManuscript";
  import { fileBridge } from "../../../lib/project/types";
  import { pushToast, errMsg } from "../../../lib/toast";
  import { touchActivityLock } from "../../../lib/bridge/activityLock";
  import { createAutosave, ConflictError } from "../../../lib/autosave";
  import { registerFlushable } from "../../lifecycle";
  import { popIn } from "../../../lib/motion/actions";
  import {
    commentField,
    commentClickHandler,
    commentRanges,
    addCommentMark,
    removeCommentMark,
    setCommentActive,
  } from "./comments/commentField";
  import {
    makeAnchor,
    resolveAnchor,
    readComments,
    writeComments,
    newId,
    type CommentThread,
  } from "./comments/comments";
  import { loadFigures, figureRefs, resolveFigure, materializeRenders, exportCtxFigures } from "./scholar/figures";
  import { bibEntries, type BibEntry } from "./scholar/bib";
  import { loadBib, addDoiToBib, addUrlOrDoiToBib, addUrlOrDoiToLibrary } from "./scholar/bibLoad";
  import { materializeIntoProject, refreshFluxLib } from "../../../lib/references/fluxlibBridge";
  import { fluxLibRevision, fluxLibEntries } from "../../../lib/references/revision";
  import { scholarCompletion } from "./scholar/completions";
  import { doiPaste } from "./science/doiPaste";
  import { figRevision, bibRevision } from "../../scholar/revisions";
  import { revealFigure, revealReader } from "../../scholar/nav";
  import { requestRefReveal } from "./margin/refReveal";
  import HoverCard from "./scholar/HoverCard.svelte";

  // `active` (W16): false when this pane is kept-alive but hidden — the ambient
  // margin background pauses (a hidden canvas still gets rAF ticks otherwise).
  let { focused = false, active = true }: { focused?: boolean; active?: boolean } = $props();

  const SEED = `# Introduction\n\nStart writing…\n`;
  const pm = get(projectModel);
  const title = pm?.manifest.title ?? "Untitled";

  let ready = $state(false);
  let initialDoc = $state("");
  let saved = $state(true);
  let isDemo = $state(false);
  let latest = $state("");
  let view = $state<EditorView | undefined>(undefined);
  let outline = $state<OutlineItem[]>([]);
  // PAP-7: a debounced mirror of `latest` for the whole-document passes that feed only
  // cosmetic/occasional UI — the TOC (a full syntax-tree walk) and the cited-key red-dots
  // (a regex over the whole document). These don't need to run on every keystroke; recompute
  // them ~150ms after typing settles. On load / external reload we refresh synchronously
  // (refreshIdleNow) so those UIs are correct immediately.
  let latestIdle = $state("");
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleIdle(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(refreshIdleNow, 150);
  }
  function refreshIdleNow(): void {
    clearTimeout(idleTimer);
    latestIdle = latest;
    if (view) {
      outline = getOutline(view.state);
      // A huge doc can outrun getOutline's parse budget, and the background
      // parser stops ~100k past the viewport — keep pulling until the tree
      // reaches the end of the document (no-op once fully parsed).
      if (!syntaxTreeAvailable(view.state)) scheduleIdle();
    }
  }
  let paletteOpen = $state(false);
  // F4: the active document (project-relative path) + the project's document list.
  let activeDocPath = $state(pm?.manifest.manuscript.path ?? "manuscript/main.qmd");
  let docs = $state<DocEntry[]>([]);
  let diskDiverged = $state(false); // F1: active doc changed on disk while dirty
  // W7: what we believe is currently on disk (last loaded or successfully written).
  // The autosave conflict guard compares against this to avoid clobbering an
  // agent/CLI write that landed between our load and our save.
  let diskBaseline = "";

  function toggleOutliner() {
    paperLayout.update((s) => ({ ...s, outlinerOpen: !s.outlinerOpen }));
  }

  // ---- title｜authors pill (front-matter, read-only in Phase A) -----------
  const meta = $derived.by(() => parseFrontmatterMeta(latest));
  function unquote(s: string): string {
    return s.trim().replace(/^["']|["']$/g, "");
  }
  function parseFrontmatterMeta(src: string): { title: string; authors: string[] } {
    // WS-4.1: extraction lives in frontmatter.ts; this wrapper only supplies
    // the project-manifest fallbacks (front-matter values win when non-empty).
    const m = frontMatterMeta(src);
    const t = m.title ?? (pm?.manifest.title ?? "Untitled");
    const manifestAuthors: string[] = ((pm?.manifest.authors ?? []) as Array<{ name?: string }>)
      .map((a) => a?.name ?? "")
      .filter(Boolean);
    return { title: t, authors: m.authors.length ? m.authors : manifestAuthors };
  }

  // ---- reader-adjustable editor margins ----------------------------------
  let colEl = $state<HTMLDivElement | undefined>(undefined);
  let dragSide = $state<null | "l" | "r">(null);
  const gutterStyle = $derived(
    ($paperLayout.gutterL != null ? `--gutter-l:${($paperLayout.gutterL * 100).toFixed(3)}%;` : "") +
      ($paperLayout.gutterR != null ? `--gutter-r:${($paperLayout.gutterR * 100).toFixed(3)}%;` : ""),
  );
  function seedGutters(r: DOMRect) {
    if (!colEl) return;
    const content = colEl.querySelector(".cm-content") as HTMLElement | null;
    if (!content) return;
    const cs = getComputedStyle(content);
    const l = parseFloat(cs.marginLeft) / r.width;
    const rr = parseFloat(cs.marginRight) / r.width;
    paperLayout.update((s) => ({
      ...s,
      gutterL: s.gutterL ?? (Number.isFinite(l) ? l : 0.1),
      gutterR: s.gutterR ?? (Number.isFinite(rr) ? rr : 0.1),
    }));
  }
  function startMargin(side: "l" | "r", e: PointerEvent) {
    if (!colEl) return;
    e.preventDefault();
    seedGutters(colEl.getBoundingClientRect());
    dragSide = side;
    window.addEventListener("pointermove", moveMargin);
    window.addEventListener("pointerup", endMargin);
  }
  function moveMargin(e: PointerEvent) {
    if (!dragSide || !colEl) return;
    const r = colEl.getBoundingClientRect();
    let f = dragSide === "l" ? (e.clientX - r.left) / r.width : (r.right - e.clientX) / r.width;
    const cur = get(paperLayout);
    const other = (dragSide === "l" ? cur.gutterR : cur.gutterL) ?? 0;
    const maxF = 1 - Math.min(0.6, 360 / r.width) - other;
    f = Math.max(0.02, Math.min(0.45, Math.min(f, maxF)));
    paperLayout.update((s) => (dragSide === "l" ? { ...s, gutterL: f } : { ...s, gutterR: f }));
    view?.requestMeasure();
  }
  function endMargin() {
    dragSide = null;
    window.removeEventListener("pointermove", moveMargin);
    window.removeEventListener("pointerup", endMargin);
  }

  // ---- outliner: active-heading tracking + collapse state ----------------
  const activeFrom = $derived.by(() => {
    const pos = $cursorPos;
    let lo = 0;
    let hi = outline.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (outline[mid].from <= pos) {
        ans = outline[mid].from;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  });
  const collapsedSet = $derived(new Set($paperLayout.collapsed));
  function toggleCollapse(path: string) {
    paperLayout.update((s) => ({
      ...s,
      collapsed: s.collapsed.includes(path)
        ? s.collapsed.filter((p) => p !== path)
        : [...s.collapsed, path],
    }));
  }

  // ---- title｜authors editing (writes YAML front-matter) -----------------
  let titleEditOpen = $state(false);
  async function saveTitleAuthors(newTitle: string, authorsCsv: string) {
    titleEditOpen = false;
    if (!view) return;
    const yaml = await import("js-yaml");
    const src = view.state.doc.toString();
    let metaObj: Record<string, unknown> = {};
    // WS-4.1: single-source bounds; closeEnd = end of the closing --- line
    // (the replace below keeps the newline after it as the body separator,
    // exactly like the old fmEnd+4 arithmetic).
    const fmb = frontMatterBounds(src);
    const hadFm = fmb.has;
    if (hadFm) {
      try {
        metaObj = (yaml.load(fmb.fmText) as Record<string, unknown>) ?? {};
      } catch {
        metaObj = {};
      }
    }
    metaObj.title = newTitle;
    const entries = authorsCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
    if ("authors" in metaObj && !("author" in metaObj)) metaObj.authors = entries;
    else metaObj.author = entries;
    const dumped = yaml.dump(metaObj, { lineWidth: -1 });
    if (hadFm) {
      view.dispatch({ changes: { from: 0, to: fmb.closeEnd, insert: `---\n${dumped}---` } });
    } else {
      view.dispatch({ changes: { from: 0, insert: `---\n${dumped}---\n\n` } });
    }
    view.focus();
  }
  let viewMode = $state<PaperViewMode>(get(paperViewMode));
  let dismissedEmpty = $state(false);
  // W4: the shared autosave controller (stay-dirty + silent retry + sticky error
  // toast) replaces the hand-rolled 600ms saveTimer. `saved` flips true only on
  // a successful write (the old path set it optimistically).
  const autosave = createAutosave({
    name: "manuscript",
    delay: 600,
    isDirty: () => !!pm && !saved,
    save: async () => {
      if (!pm) return;
      const snapshot = latest;
      // W7 conflict guard: if the file changed on disk since we last loaded/saved
      // (an agent/CLI wrote it) AND that change isn't what we're about to write,
      // don't clobber it — surface the diverged banner and stay dirty (the shared
      // controller treats ConflictError as no-retry/no-toast).
      const onDisk = (await readManuscript(pm, activeDocPath)) ?? "";
      if (onDisk !== diskBaseline && onDisk !== snapshot) {
        diskDiverged = true;
        throw new ConflictError("manuscript changed on disk");
      }
      await writeManuscript(pm, snapshot, activeDocPath);
      diskBaseline = snapshot;
      // Only mark clean if nothing was typed during the write — otherwise the
      // controller's trailing save persists the newer text (W4).
      if (latest === snapshot) saved = true;
    },
  });
  const autosaveStatus = autosave.status;
  let hover = $state<{ target: ChipTarget; anchor: HTMLElement } | null>(null);
  let hoverHideTimer: ReturnType<typeof setTimeout> | undefined;
  let doiStatus = $state<"" | "fetching" | "error" | "added">("");
  let pickerOpen = $state(false);
  let pickerOpenN = $state(0);
  let figRefPickerOpen = $state(false);
  let figRefOpenN = $state(0);
  // Bumped when figure data (re)loads so the preview re-renders on a pure
  // renumber/rename (no doc edit to trigger it otherwise).
  let figRefsRev = $state(0);
  // Reopening a picker while the previous instance is still animating OUT
  // would otherwise REVIVE that instance (Svelte keeps an outroing {#if} block
  // alive): stale query/stage and no onMount refocus, so keystrokes fall into
  // the document. The open counters key the blocks — every open is a fresh
  // instance.
  function openFigurePicker() {
    pickerOpenN += 1;
    pickerOpen = true;
  }
  function openFigRefPicker() {
    figRefOpenN += 1;
    figRefPickerOpen = true;
  }
  const subs: Array<() => void> = [];

  // Citekeys actually referenced in the manuscript (the red-dot "cited" state).
  const citedKeys = $derived.by(() => {
    const set = new Set<string>();
    const re = anyCiteRe(); // PAP-19: shared grammar (science/grammar)
    let m: RegExpExecArray | null;
    while ((m = re.exec(latestIdle))) {
      if (!isCrossrefKey(m[1])) set.add(m[1]);
    }
    return set;
  });
  const figures = $derived($figureRefs);
  const references = $derived($bibEntries);

  // The reference SEARCH pane searches the whole machine-global FluxLib (you search
  // to find any paper to cite); the bibliography (`references`) stays the project's
  // cited subset. Union so project-local-only entries (orphans) still surface.
  const libraryReferences = $derived.by(() => {
    if (!$fluxLibEntries.length) return references;
    const byKey = new Map<string, BibEntry>();
    for (const e of $fluxLibEntries) byKey.set(e.key, e);
    for (const e of references) if (!byKey.has(e.key)) byKey.set(e.key, e);
    return [...byKey.values()];
  });

  // Citing a FluxLib entry not yet in this project: pull it into the project's
  // library.bib so the [@key] resolves in the preview, bibliography, and export.
  async function materializeCites(keys: string[]) {
    const root = pm?.root;
    if (!root || !keys.length) return;
    const have = new Set(references.map((e) => e.key));
    const missing = keys.filter((k) => k && !have.has(k));
    if (!missing.length) return;
    const { added } = await materializeIntoProject(root, missing);
    if (added.length) await loadBib(root);
  }

  // One materialization path for ALL citing routes (reference-search pane,
  // @-autocomplete, hand-typed [@key]): any cited key that lives in FluxLib but not
  // yet in this project's subset gets materialized. Converges — once materialized the
  // key joins `references`, so the next run finds nothing to do.
  $effect(() => {
    if (!pm?.root || !citedKeys.size) return;
    const have = new Set(references.map((e) => e.key));
    const libKeys = new Set($fluxLibEntries.map((e) => e.key));
    const missing = [...citedKeys].filter((k) => !have.has(k) && libKeys.has(k));
    if (missing.length) void materializeCites(missing);
  });

  async function addDoiFromPanel(d: string): Promise<string | null> {
    const r = await addUrlOrDoiToBib(d, pm?.root ?? null);
    return "error" in r ? null : r.key;
  }

  // ---- Cmd-K "Add DOI to FluxLib" (in-app input; window.prompt is disabled in
  // Electron). "library" mode adds to FluxLib only; "cite" also inserts [@key]. ----
  let doiPromptOpen = $state(false);
  let doiPromptMode = $state<"library" | "cite">("library");
  let doiPromptValue = $state("");
  let doiPromptError = $state("");
  // PAP-3: "+ New document" — an in-app modal. window.prompt is disabled in Electron
  // (returns null silently), so the shipped multi-document feature couldn't create anything.
  let newDocOpen = $state(false);
  let newDocValue = $state("");
  function openDoiPrompt(mode: "library" | "cite") {
    doiPromptMode = mode;
    doiPromptValue = "";
    doiPromptError = "";
    doiPromptOpen = true;
  }
  function focusSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
  }
  async function submitDoiPrompt() {
    const doi = doiPromptValue.trim();
    if (!doi || doiStatus === "fetching") return;
    doiPromptError = "";
    doiStatus = "fetching";
    if (doiPromptMode === "cite") {
      const r = await addUrlOrDoiToBib(doi, pm?.root ?? null);
      if ("error" in r) {
        doiStatus = "";
        doiPromptError = r.error;
        return;
      }
      doiStatus = "";
      doiPromptOpen = false;
      if (view) writeCiteGroup(view, [r.key]);
    } else {
      const r = await addUrlOrDoiToLibrary(doi);
      if ("error" in r) {
        doiStatus = "";
        doiPromptError = r.error;
        return;
      }
      doiStatus = "added";
      doiPromptOpen = false;
      setTimeout(() => {
        if (doiStatus === "added") doiStatus = "";
      }, 2400);
    }
  }

  // ---- comments ----------------------------------------------------------
  type DraftThread = CommentThread & { draft?: boolean };
  let threads = $state<DraftThread[]>([]);
  let activeComment = $state<string | null>(null);
  let cRanges = $state<Map<string, { from: number; to: number }>>(new Map());
  let commentSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const commentAuthor = pm?.manifest.authors?.[0]?.name || "You";
  const commentCount = $derived(threads.filter((t) => !t.draft && !t.resolved).length);

  function syncRanges() {
    if (view) cRanges = commentRanges(view);
  }

  function scheduleCommentSave() {
    if (!pm) return;
    clearTimeout(commentSaveTimer);
    commentSaveTimer = setTimeout(() => {
      commentSaveTimer = undefined;
      void persistThreadsTo(activeDocPath);
    }, 600);
  }

  /** W5: flush a pending comment save now (registry/exit path). */
  async function flushComments() {
    if (!pm || commentSaveTimer === undefined) return;
    clearTimeout(commentSaveTimer);
    commentSaveTimer = undefined;
    await persistThreadsTo(activeDocPath);
  }

  function startComment() {
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    summonPane("comments");
    const id = newId();
    const doc = view.state.doc.toString();
    const anchor = makeAnchor(doc, sel.from, sel.to);
    threads = [...threads, { id, anchor, resolved: false, messages: [], draft: true }];
    view.dispatch({ effects: [addCommentMark.of({ id, from: sel.from, to: sel.to }), setCommentActive.of(id)] });
    activeComment = id;
    syncRanges();
  }

  function submitNew(id: string, body: string) {
    threads = threads.map((t) =>
      t.id === id
        ? { ...t, draft: false, messages: [{ author: commentAuthor, body, createdAt: new Date().toISOString() }] }
        : t,
    );
    scheduleCommentSave();
  }
  function cancelNew(id: string) {
    threads = threads.filter((t) => t.id !== id);
    view?.dispatch({ effects: removeCommentMark.of(id) });
    if (activeComment === id) activeComment = null;
    syncRanges();
  }
  function replyComment(id: string, body: string) {
    threads = threads.map((t) =>
      t.id === id
        ? { ...t, messages: [...t.messages, { author: commentAuthor, body, createdAt: new Date().toISOString() }] }
        : t,
    );
    scheduleCommentSave();
  }
  function resolveComment(id: string) {
    // PAP-9: snapshot the mark's LIVE range into the anchor before removing it. The debounced
    // save reads live ranges to persist anchors; once the mark is gone it can't, so it would
    // persist the stale creation-anchor and reopen would mis-anchor. Re-derive from cRanges now.
    const live = cRanges.get(id);
    const doc = view?.state.doc.toString() ?? "";
    threads = threads.map((t) =>
      t.id === id
        ? { ...t, resolved: true, anchor: live ? makeAnchor(doc, live.from, live.to) : t.anchor }
        : t,
    );
    view?.dispatch({ effects: removeCommentMark.of(id) });
    syncRanges();
    scheduleCommentSave();
  }
  function reopenComment(id: string) {
    threads = threads.map((t) => (t.id === id ? { ...t, resolved: false } : t));
    const t = threads.find((x) => x.id === id);
    const doc = view?.state.doc.toString() ?? "";
    if (t && view) {
      const r = resolveAnchor(doc, t.anchor);
      if (r) view.dispatch({ effects: addCommentMark.of({ id, from: r.from, to: r.to }) });
    }
    syncRanges();
    scheduleCommentSave();
  }
  function deleteComment(id: string) {
    threads = threads.filter((t) => t.id !== id);
    view?.dispatch({ effects: removeCommentMark.of(id) });
    if (activeComment === id) activeComment = null;
    syncRanges();
    scheduleCommentSave();
  }
  function focusComment(id: string) {
    activeComment = id;
    view?.dispatch({ effects: setCommentActive.of(id) });
    const r = cRanges.get(id);
    if (r && view) view.dispatch({ effects: EditorView.scrollIntoView(r.from, { y: "center" }) });
  }

  // ---- preview + export --------------------------------------------------
  let previewActive = $state(false);
  let exportOpen = $state(false);
  let exportBusy = $state(false);
  let exportDone = $state(false);
  let quartoAvail = $state(false);

  // Bare-quarto parity for the in-app Word export (same transform flux-core's
  // compile applies): composed model captions into EMPTY embed alts (Quarto
  // reads the alt as the figcaption — canonical embeds carry none) + panel
  // refs `@fig-x-a` → literal "Figure 3a". Applied IN PLACE to the doc + its
  // include tree via the file bridge; the returned closure restores originals.
  async function transformDocsForQuarto(fb: NonNullable<ReturnType<typeof fileBridge>>): Promise<() => Promise<void>> {
    if (!pm) return async () => {};
    const INCLUDE_RE = /\{\{<\s*include\s+([^\s>]+)\s*>\}\}/g;
    const texts = new Map<string, string>();
    const readTree = async (abs: string): Promise<string> => {
      if (texts.has(abs)) return "";
      let t = "";
      try {
        t = await fb.readText(abs);
      } catch {
        return "";
      }
      texts.set(abs, t);
      let expanded = "";
      let last = 0;
      for (const m of t.matchAll(INCLUDE_RE)) {
        expanded += t.slice(last, m.index);
        expanded += await readTree(`${abs.slice(0, abs.lastIndexOf("/"))}/${m[1]}`);
        last = (m.index ?? 0) + m[0].length;
      }
      return expanded + t.slice(last);
    };
    await readTree(`${pm.root}/${activeDocPath}`); // populates `texts` (includes)
    const refs = get(figureRefs);
    const ctx = {
      captions: new Map(refs.filter((r) => r.caption?.trim()).map((r) => [r.label, r.caption])),
      // THE editor's family numbering (figfamily.ts) — never embed-order.
      figures: exportCtxFigures(),
    };
    const originals = new Map<string, string>();
    for (const [f, t] of texts) {
      const nt = transformQmdForExport(t, ctx);
      if (nt !== t) {
        originals.set(f, t);
        await fb.writeText(f, nt);
      }
    }
    return async () => {
      for (const [f, t] of originals) await fb.writeText(f, t).catch(() => {});
    };
  }

  async function doExport(kind: "pdf" | "html" | "docx") {
    if (exportBusy) return; // one export at a time (a second Quarto render would race)
    exportOpen = false;
    const fb = fileBridge();
    if (!fb) {
      pushToast("error", "Export needs the desktop app");
      return;
    }
    exportBusy = true;
    try {
      if (kind === "docx") {
        if (!pm || !fb.quartoRender) {
          exportBusy = false;
          return;
        }
        // Quarto reads DISK — flush the debounced autosave first or it renders stale text.
        try {
          await autosave.flush();
        } catch (e) {
          if (e instanceof ConflictError) {
            exportBusy = false;
            pushToast("error", "Word export blocked", {
              detail: "the document changed on disk — resolve the Reload / Keep-mine banner first",
            });
            return;
          }
          throw e;
        }
        const renders = await materializeRenders(pm.root, latest);
        // Quarto reads DISK: transform in place (captions into alts, panel
        // refs literalized), render, restore — sources stay byte-identical.
        const restoreDocs = await transformDocsForQuarto(fb);
        let r;
        try {
          r = await fb.quartoRender(pm.root, "docx", activeDocPath);
        } finally {
          await restoreDocs();
        }
        exportBusy = false;
        if (!r?.ok) {
          pushToast("error", "Word export failed", {
            detail: (r?.log || "quarto did not run").trimEnd().split("\n").slice(-14).join("\n"),
          });
          return;
        }
        if (renders.failed.length) {
          pushToast("info", `${renders.failed.length} figure render(s) missing from the export`, {
            detail: renders.failed.join(", "),
          });
        }
        exportDone = true;
        setTimeout(() => (exportDone = false), 2600);
        const out = r.outPath;
        pushToast(
          "success",
          `Exported ${activeDocPath.replace(/\.qmd$/i, ".docx")}`,
          out && fb.revealPath ? { action: { label: "Reveal", run: () => void fb.revealPath!(out) } } : {},
        );
        return;
      }
      const { full, title } = await renderManuscript(latest, {
        paginated: viewMode === "paginated",
      });
      const safe = (title || "manuscript").replace(/[^\w-]+/g, "-").toLowerCase() || "manuscript";
      const ext = kind === "pdf" ? "pdf" : "html";
      const defPath = pm ? `${pm.root}/exports/${safe}.${ext}` : `${safe}.${ext}`;
      const out = await fb.save(defPath, [{ name: ext.toUpperCase(), extensions: [ext] }]);
      if (!out) {
        exportBusy = false;
        return;
      }
      if (kind === "pdf") {
        if (!fb.printPdf) {
          pushToast("error", "PDF export needs the desktop app");
          exportBusy = false;
          return;
        }
        // printPdf resolves false when the render/write didn't happen — don't claim success.
        const okPdf = await fb.printPdf(full, out, {});
        if (!okPdf) {
          pushToast("error", "PDF export failed", { detail: "the PDF could not be written" });
          exportBusy = false;
          return;
        }
      } else await fb.writeText(out, full);
      exportBusy = false;
      exportDone = true;
      setTimeout(() => (exportDone = false), 2600);
    } catch (e) {
      console.error("[flux] export failed", e);
      pushToast("error", "Export failed", { detail: errMsg(e) });
      exportBusy = false;
    }
  }

  function insertFigure(ref: FigureRef) {
    pickerOpen = false;
    if (!view) return;
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    // Canonical embed: EMPTY alt — the figure's name/id is all an embed needs.
    // The caption under the figure comes live from the model, and Quarto
    // exports inject it at render time (exportQmd.ts).
    const embed = `![](../fig/renders/${ref.id}.svg){#${ref.label}}`;
    let from: number, to: number, insert: string, anchor: number;
    if (line.text.trim() === "") {
      from = line.from;
      to = line.to;
      insert = embed;
      anchor = line.from + embed.length;
    } else {
      from = to = line.to;
      insert = "\n\n" + embed;
      anchor = line.to + insert.length;
    }
    view.dispatch({ changes: { from, to, insert }, selection: { anchor }, userEvent: "input" });
    view.focus();
  }

  // FigRefPicker (`@@` / palette / "/cross-reference") hands back the full
  // reference text ("@fig-x", "@fig-x-a,c"); it goes in at the caret.
  function insertFigRef(text: string) {
    figRefPickerOpen = false;
    if (!view) return;
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, to: pos, insert: text },
      selection: { anchor: pos + text.length },
      userEvent: "input",
    });
    view.focus();
  }

  // Flux-figure is the source of truth for figure captions, and embed lines
  // canonically carry an EMPTY alt (the widget + Preview read the model; Quarto
  // exports get the caption injected at render time). This pass CLEARS the alt
  // of every resolved embed — it replaced the old clobber-alt-with-caption sync,
  // so it is strictly less destructive, and it self-heals legacy docs whose
  // 1500-char alt captions wrapped to walls of raw text (the moma manuscript).
  // Lines the selection touches are skipped — never fight the caret — and catch
  // up on the next figures change. Unresolved embeds keep their alt: it is the
  // only caption fallback they have.
  function normalizeEmbedAlts() {
    if (!view) return;
    const state = view.state;
    const changes: { from: number; to: number; insert: string }[] = [];
    for (let i = 1; i <= state.doc.lines; i++) {
      const line = state.doc.line(i);
      if (line.text.indexOf("![") < 0) continue;
      const m = EMBED_RE.exec(line.text);
      if (!m || m[1].length === 0) continue;
      if (!resolveFigure(m[3], numbering.instance)) continue;
      const lead = /^\s*/.exec(line.text)![0].length;
      const from = line.from + lead + 2; // just past "!["
      const to = from + m[1].length;
      if (state.selection.ranges.some((sr) => sr.from <= to && sr.to >= from)) continue;
      changes.push({ from, to, insert: "" });
    }
    if (changes.length) view.dispatch({ changes, userEvent: "input.figsync" });
  }

  async function handleDoi(doi: string, v: EditorView, from: number, to: number) {
    doiStatus = "fetching";
    const r = await addDoiToBib(doi, pm?.root ?? null);
    if ("error" in r) {
      doiStatus = "error";
      setTimeout(() => (doiStatus = ""), 2600);
      v.dispatch({ changes: { from, to, insert: doi }, selection: { anchor: from + doi.length } });
    } else {
      doiStatus = "";
      const ins = `[@${r.key}]`;
      v.dispatch({ changes: { from, to, insert: ins }, selection: { anchor: from + ins.length } });
    }
    v.focus();
  }

  function showHover(target: ChipTarget, anchor: HTMLElement) {
    clearTimeout(hoverHideTimer);
    hover = { target, anchor };
  }
  function hideHoverSoon() {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(() => (hover = null), 160);
  }
  // Hover-card pills: jump to the reference in the margin (scrolled +
  // untwirled), or open its full-text PDF in FluxReader (split pane).
  function openRefFromHover(key: string) {
    hover = null;
    summonPane("bibliography");
    requestRefReveal(key);
    view?.focus();
  }
  function openPdfFromHover(key: string) {
    hover = null;
    revealReader(key);
  }
  function activateChip(target: ChipTarget, el?: HTMLElement) {
    if (target.kind === "figref") {
      const r = resolveFigure(target.label, numbering.instance);
      if (r) revealFigure(r.ref.id);
    } else if (target.kind === "cite") {
      // Land the caret at the chip (its edge satisfies citationGroupAt's
      // inclusive bounds) so the group editor tracks THIS group, then open it.
      // isConnected guard: the first click of a double-click may have revealed
      // the raw text and unmounted the chip — the caret is already there then.
      if (view && el?.isConnected) {
        const pos = view.posAtDOM(el);
        view.dispatch({ selection: { anchor: pos } });
      }
      summonPane("citation-group");
    }
  }

  function editCitationAtCursor() {
    if (!view) return;
    const g = citationGroupAt(view.state, view.state.selection.main.head);
    summonPane(g ? "citation-group" : "reference-search");
  }

  // Double-click anywhere on a citation (chip OR revealed raw text) opens the
  // group editor; on a cross-ref, jumps to the figure. Editor-level because
  // the FIRST click of a double-click moves the caret onto the chip, which
  // reveals its raw text and unmounts the widget — a widget-level dblclick
  // listener dies with the element and never fires.
  const chipDblClick = EditorView.domEventHandlers({
    dblclick: (e, v) => {
      // The click's coords can be stale by dblclick time: the first click put
      // the caret on the chip, which revealed its raw text and RESIZED the
      // line. So resolve at the coords AND at the selection head (where the
      // first click reliably landed).
      const coordPos = v.posAtCoords({ x: e.clientX, y: e.clientY });
      const candidates = [coordPos, v.state.selection.main.head].filter(
        (p): p is number => p != null,
      );
      for (const pos of candidates) {
        const g = citationGroupAt(v.state, pos);
        if (g) {
          v.dispatch({ selection: { anchor: g.from } });
          summonPane("citation-group");
          return true;
        }
      }
      for (const pos of candidates) {
        const line = v.state.doc.lineAt(pos);
        const re = crossrefRe();
        let m: RegExpExecArray | null;
        while ((m = re.exec(line.text))) {
          const from = line.from + m.index;
          const to = from + m[0].length;
          if (pos >= from && pos <= to) {
            const r = resolveFigure(m[0].slice(1), numbering.instance);
            if (r) {
              revealFigure(r.ref.id);
              return true;
            }
          }
        }
      }
      return false; // plain prose — keep CodeMirror's word selection
    },
  });

  const status = $derived<"demo" | "saved" | "saving" | "error">(
    isDemo ? "demo" : $autosaveStatus === "error" ? "error" : saved ? "saved" : "saving",
  );

  // StatusBar word count — from the 150ms-debounced mirror, never per keystroke.
  const statusWords = $derived(wordCount(latestIdle));

  // Front matter picks the citation style (citation-style: numeric | author-year).
  // The scan is O(front matter) per keystroke; the effect fires only when the
  // STYLE actually flips — every visible chip then relabels via refreshChips.
  const citeStyle = $derived(citationStyleOf(latest));
  $effect(() => {
    numbering.setStyle(citeStyle); // WS-4.2: per-editor instance, not a module store
    view?.dispatch({ effects: refreshChips.of(null) });
  });
  // PAP-7: is there any non-whitespace after the front matter? Scanned in place (no slice +
  // trim of the whole document per keystroke), and left on `latest` — NOT the debounced
  // mirror — so the empty-doc hint stays instant. A non-empty doc bails at its first content
  // character, so this is O(leading whitespace), not O(document).
  const bodyEmpty = $derived.by(() => {
    const s = latest;
    let i = 0;
    // WS-4.1: single-source boundary (frontmatter.ts).
    i = frontMatterBounds(s).bodyStart;
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return false;
    }
    return true;
  });

  onMount(async () => {
    // PAP-17: the integrated terminal is an app-lifetime singleton with a fixed cwd. Retire any
    // shell left over from a different project so it can't run commands in the wrong directory.
    void terminalSession.syncRoot(pm?.root ?? null);
    if (pm) {
      docs = await listDocuments(pm);
      // Restore the last active document if it still exists, else the main one.
      const want = get(paperLayout).activeDocPath;
      activeDocPath =
        want && docs.some((d) => d.path === want) ? want : pm.manifest.manuscript.path;
      initialDoc = (await readManuscript(pm, activeDocPath)) || SEED;
    } else {
      initialDoc = SEED;
      isDemo = true;
    }
    latest = initialDoc;
    latestIdle = initialDoc; // PAP-7: seed the debounced mirror so cited-keys are correct pre-mount
    diskBaseline = initialDoc; // W7: seed the conflict-guard baseline
    ready = true;

    setChipHandlers({
      onActivate: activateChip,
      onHover: showHover,
      onLeave: hideHoverSoon,
    });
    setEmbedHandlers({
      onOpenFigure: (id) => revealFigure(id),
      // The widget hands over its DOM element; resolve the position fresh
      // (widget instances persist across rebuilds — offsets would go stale).
      onSetWidth: (el, width) => {
        if (!view) return;
        setEmbedWidth(view, view.posAtDOM(el), width);
      },
    });
    setSlashHandlers({
      onInsertFigure: openFigurePicker,
      onInsertFigRef: openFigRefPicker,
    });
    await Promise.all([loadFigures(pm?.root ?? null), loadBib(pm?.root ?? null)]);
    const refresh = () => view?.dispatch({ effects: refreshChips.of(null) });
    subs.push(figRevision.subscribe(() => void loadFigures(pm?.root ?? null)));
    subs.push(bibRevision.subscribe(() => void loadBib(pm?.root ?? null)));
    // Keep the shared FluxLib store current for the reference search + @-autocomplete
    // (fires immediately, then on any FluxLib change — add here, Library mode, capture).
    subs.push(fluxLibRevision.subscribe(() => void refreshFluxLib()));
    // PAP-20: externalManuscriptChange is a module-global store; subscribing replays its
    // CURRENT value immediately, so a fresh mount (project switch, keep-alive re-entry) would
    // re-process the last external edit as if it just happened. Gate on the monotonic `n`
    // captured at mount — only strictly-newer changes are real.
    let lastSeenChangeN = get(externalManuscriptChange)?.n ?? 0;
    subs.push(
      externalManuscriptChange.subscribe((chg) => {
        if (!chg || chg.n <= lastSeenChangeN) return;
        lastSeenChangeN = chg.n;
        void onExternalManuscript(chg);
      }),
    );
    subs.push(
      figureRefs.subscribe(() => {
        refresh();
        normalizeEmbedAlts(); // embed alts stay empty; the model owns captions
        figRefsRev += 1; // preview re-renders on a pure renumber too
      }),
    );
    subs.push(bibEntries.subscribe(refresh));

    const fb = fileBridge();
    if (fb?.quartoAvailable) {
      try {
        quartoAvail = (await fb.quartoAvailable()).installed;
      } catch {
        quartoAvail = false;
      }
    }
  });

  function buildExtensions() {
    return createEditorExtensions({
      // Vim must precede the WHOLE tree (keys claimed at the DOM level; its
      // plugin must init before the panel host) — see markdown-setup `first`.
      first: [vimCompartment.of(vimExtensions(get(paperVimFlavor)))],
      extra: [
        pageCompartment.of(themeFor(viewMode)),
        // The outline walks the syntax tree, which the background parser fills
        // in AFTER mount via non-doc-change transactions (init parses ~3k
        // chars). Without this, headings past the parsed prefix stay missing
        // from the TOC until the next keystroke.
        EditorView.updateListener.of((u) => {
          if (!u.docChanged && syntaxTree(u.state) !== syntaxTree(u.startState)) scheduleIdle();
        }),
        selectionWatcher,
        paperSelectionWatcher, // feedback stamp: live doc selection → shell store
        cursorWatcher,
        activeCitationWatcher,
        chipDblClick,
        // Mod-Enter follows whatever is under the caret (embed/chip → figure,
        // citation → group editor); falls through on plain prose.
        keymap.of([
          {
            key: "Mod-Enter",
            run: followAtCaret({
              openFigure: (id) => revealFigure(id),
              editCitation: () => editCitationAtCursor(),
            }),
          },
          {
            // Keyboard path to commenting (the floating bubble is mouse-only).
            key: "Mod-Alt-m",
            run: (v) => {
              if (v.state.selection.main.empty) return false;
              startComment();
              return true;
            },
          },
        ]),
        formattingKeymap,
        // `@@` → figure-reference picker (the second @ never lands in the doc).
        figRefTrigger(openFigRefPicker),
        // WS-4.2: THIS editor's numbering instance — provided before
        // citeNumberField so writers/readers share it in the same update.
        numberingFacet.of(numbering.instance),
        citeNumberField, // before the chip plugin: ordinals publish first
        scienceChips,
        scienceEmbeds,
        scienceTables,
        scienceMathBlocks, // 2.1: $$ display math (block widget AFTER source lines)
        scholarCompletion,
        doiPaste(handleDoi),
        commentField,
        commentClickHandler(focusComment),
      ],
    });
  }

  function onReady(v: EditorView) {
    view = v;
    setPaperContextDoc(activeDocPath); // feedback stamp: initial doc
    untrackMath?.();
    untrackMath = trackMathView(v); // 2.1: KaTeX-loaded → refresh math decorations
    refreshIdleNow(); // seed latestIdle + the TOC synchronously on mount
    void loadComments(v);
    normalizeEmbedAlts(); // figures may have loaded before the editor mounted
  }
  let untrackMath: (() => void) | null = null;

  async function loadComments(v: EditorView) {
    if (!pm) return;
    const loaded = await readComments(pm, activeDocPath);
    if (!loaded.length) return;
    const doc = v.state.doc.toString();
    const effects = [];
    for (const t of loaded) {
      const r = t.resolved ? null : resolveAnchor(doc, t.anchor);
      if (r) effects.push(addCommentMark.of({ id: t.id, from: r.from, to: r.to }));
    }
    threads = loaded;
    if (effects.length) v.dispatch({ effects });
    syncRanges();
  }

  // PAP-4: after a whole-document swap (external/agent reload of the .qmd), CodeMirror
  // collapses the existing comment marks and commentField drops them — every thread would
  // read "Detached" in exactly the agent-edits→human-reviews flow. Re-resolve each live
  // thread's W3C text-quote anchor against the NEW text and re-add its mark (the threads
  // themselves are in-memory + unchanged; only their editor marks were lost).
  function reanchorComments() {
    if (!view) return;
    const doc = view.state.doc.toString();
    const effects = [];
    for (const t of threads) {
      if (t.resolved) continue;
      const r = resolveAnchor(doc, t.anchor);
      if (r) effects.push(addCommentMark.of({ id: t.id, from: r.from, to: r.to }));
    }
    if (effects.length) view.dispatch({ effects });
    syncRanges();
  }

  function onChange(s: string) {
    latest = s;
    scheduleIdle(); // PAP-7: TOC + cited-key recompute settle ~150ms after typing stops
    syncRanges();
    if (threads.some((t) => !t.draft)) scheduleCommentSave();
    if (!pm) return;
    touchActivityLock("manuscript"); // W3: defer concurrent agent writes while mid-edit
    saved = false;
    autosave.schedule();
  }

  function setView(m: PaperViewMode) {
    viewMode = m;
    paperViewMode.set(m);
    view?.dispatch({ effects: pageCompartment.reconfigure(themeFor(m)) });
    view?.focus();
  }

  function setVimFlavor(f: VimFlavor) {
    paperVimFlavor.set(f);
    view?.dispatch({ effects: vimCompartment.reconfigure(vimExtensions(f)) });
    view?.focus();
  }

  function jump(from: number) {
    if (!view) return;
    view.dispatch({
      selection: { anchor: from },
      effects: EditorView.scrollIntoView(from, { y: "start" }),
    });
    view.focus();
  }

  function startFrom(seed: string) {
    dismissedEmpty = true;
    if (view && seed)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: seed } });
    view?.focus();
  }

  async function flush() {
    await autosave.flush();
  }

  // ---- F4: document switching --------------------------------------------
  function persistThreadsTo(docPath: string): Promise<void> {
    if (!pm) return Promise.resolve();
    // Refresh each anchor from its live range before persisting.
    const doc = view?.state.doc.toString() ?? latest;
    const persist: CommentThread[] = threads
      .filter((t) => !t.draft)
      .map((t) => {
        const r = cRanges.get(t.id);
        const anchor = r ? makeAnchor(doc, r.from, r.to) : t.anchor;
        return { id: t.id, anchor, resolved: t.resolved, messages: t.messages };
      });
    return writeComments(pm, persist, docPath);
  }

  async function loadDocument(path: string) {
    if (!pm || !view || path === activeDocPath) return;
    // Persist the current document (text + comments) before switching away.
    clearTimeout(commentSaveTimer);
    commentSaveTimer = undefined;
    await autosave.flush();
    await persistThreadsTo(activeDocPath);

    const text = (await readManuscript(pm, path)) || "";
    threads = [];
    activeComment = null;
    cRanges = new Map();
    activeDocPath = path;
    setPaperContextDoc(path); // feedback stamp follows the active doc
    paperLayout.update((s) => ({ ...s, activeDocPath: path }));
    // Swap the editor content in place (preserve the extension set).
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 },
    });
    latest = text;
    diskBaseline = text; // W7: the newly-loaded document is our baseline
    saved = true; // the swap's own change event scheduled a save; isDirty=false makes it a no-op
    refreshIdleNow(); // load is immediate, not debounced
    syncRanges();
    await loadComments(view);
    view.focus();
  }

  function newDocument() {
    if (!pm) return;
    newDocValue = "";
    newDocOpen = true;
  }
  async function submitNewDoc() {
    if (!pm) return;
    const name = newDocValue.trim() || "Untitled";
    newDocOpen = false;
    try {
      const rel = await createDocument(pm, name);
      docs = await listDocuments(pm);
      await loadDocument(rel);
    } catch (e) {
      pushToast("error", "Couldn’t create the document", { detail: errMsg(e) });
    }
  }

  // F1 live reload: an external (agent/script) edit to the *active* document.
  // Reload silently if the editor is clean; if dirty, never clobber unsaved work —
  // surface a "reloaded from disk / keep mine" choice instead.
  // Minimal single-span diff between the buffer and disk text, so an external
  // reload dispatches a LOCAL change: CodeMirror then maps the selection,
  // scroll anchor and comment marks through it instead of clobbering them
  // (the old whole-doc replace collapsed all three and bloated undo).
  function minimalDiff(a: string, b: string) {
    let from = 0;
    const maxF = Math.min(a.length, b.length);
    while (from < maxF && a.charCodeAt(from) === b.charCodeAt(from)) from++;
    let aTo = a.length;
    let bTo = b.length;
    while (aTo > from && bTo > from && a.charCodeAt(aTo - 1) === b.charCodeAt(bTo - 1)) {
      aTo--;
      bTo--;
    }
    return { from, to: aTo, insert: b.slice(from, bTo) };
  }

  function applyDiskText(text: string) {
    if (!view) return;
    view.dispatch({ changes: minimalDiff(view.state.doc.toString(), text) });
    latest = text;
    diskBaseline = text; // W7: disk is now our baseline
    saved = true;
    diskDiverged = false;
    refreshIdleNow(); // external reload is immediate, not debounced
    reanchorComments(); // PAP-4: re-attach comment marks to the new text (calls syncRanges)
  }
  // The active document's comments sidecar (mirrors flux-core commentsRel /
  // comments.ts commentsPath): main doc → comments.json, others → <base>.comments.json.
  function commentsSidecarRel(): string {
    const mainPath = pm?.manifest.manuscript.path ?? "";
    const mp = activeDocPath;
    const dir = mp.includes("/") ? mp.slice(0, mp.lastIndexOf("/")) : "";
    const isMain = mp === mainPath;
    const base = mp.slice(mp.lastIndexOf("/") + 1).replace(/\.(qmd|md)$/, "");
    const name = isMain ? "comments.json" : `${base}.comments.json`;
    return dir ? `${dir}/${name}` : name;
  }

  // F1 live reload for review comments: an external resolve/edit to the active
  // doc's comments.json refreshes the margin in place. Non-destructive — skipped
  // while the human is composing a draft, so in-progress work is never clobbered.
  async function reloadCommentsFromDisk() {
    if (!pm || !view) return;
    if (threads.some((t) => t.draft)) return;
    const loaded = await readComments(pm, activeDocPath);
    const doc = view.state.doc.toString();
    const effects = [];
    for (const t of threads) effects.push(removeCommentMark.of(t.id));
    for (const t of loaded) {
      const r = t.resolved ? null : resolveAnchor(doc, t.anchor);
      if (r) effects.push(addCommentMark.of({ id: t.id, from: r.from, to: r.to }));
    }
    threads = loaded;
    if (activeComment && !loaded.some((t) => t.id === activeComment && !t.resolved)) activeComment = null;
    if (effects.length) view.dispatch({ effects });
    syncRanges();
  }

  async function onExternalManuscript(chg: { path: string; n: number } | null) {
    if (!chg || !pm || !view) return;
    if (chg.path.endsWith(commentsSidecarRel())) {
      await reloadCommentsFromDisk(); // comments sidecar changed → refresh margin in place
      return;
    }
    if (!chg.path.endsWith(activeDocPath)) return; // only the active document
    const text = (await readManuscript(pm, activeDocPath)) || "";
    if (text === latest) return; // nothing new (e.g. our own echoed write)
    if (!saved) {
      diskDiverged = true; // dirty → keep the user's unsaved work, offer a choice
      return;
    }
    applyDiskText(text);
  }
  async function forceReloadFromDisk() {
    if (!pm) return;
    try {
      applyDiskText((await readManuscript(pm, activeDocPath)) || "");
    } catch (e) {
      // Leave the banner up so the choice is still available.
      pushToast("error", "Couldn't reload from disk", { detail: errMsg(e) });
    }
  }
  // W7: resolve a divergence by making the editor's version win — write it over
  // disk and adopt it as the new baseline so the guard stops firing.
  async function overwriteDisk() {
    if (!pm) return;
    const snapshot = latest;
    try {
      await writeManuscript(pm, snapshot, activeDocPath);
      diskBaseline = snapshot;
      if (latest === snapshot) saved = true;
      diskDiverged = false;
    } catch (e) {
      pushToast("error", "Couldn't overwrite the file on disk", { detail: errMsg(e) });
    }
  }
  // W5: register with the shell's dirty registry so goHome/quit/reload flush us.
  const unregFlush = registerFlushable({
    id: "paper",
    isDirty: () => !!pm && !saved,
    flush: () => autosave.flush(),
  });
  const unregComments = registerFlushable({
    id: "paper-comments",
    isDirty: () => commentSaveTimer !== undefined,
    flush: () => flushComments(),
  });

  onDestroy(() => {
    void flush();
    void flushComments();
    autosave.dispose();
    untrackMath?.();
    unregFlush();
    unregComments();
    subs.forEach((u) => u());
    clearTimeout(hoverHideTimer);
    clearTimeout(idleTimer);
    resetActiveCitation();
  });

  // ---- dynamic margin -----------------------------------------------------
  // Pane summoning lives in margin/marginPanes.ts (summonPane opens the margin
  // itself when needed); PaperMode only owns the show/hide toggle + resize.
  let workEl = $state<HTMLDivElement | undefined>(undefined);
  let dmDragging = $state(false);

  // Alt+D round-trip: hide returns focus to the editor only when focus was
  // inside the margin; show never steals focus from where you're typing.
  function toggleMargin() {
    if (get(paperLayout).dynMarginOpen) {
      const inside = !!document.activeElement?.closest(".dynmargin");
      paperLayout.update((s) => ({ ...s, dynMarginOpen: false }));
      if (inside) view?.focus();
    } else {
      paperLayout.update((s) => ({ ...s, dynMarginOpen: true }));
    }
  }
  function startDmDrag(e: PointerEvent) {
    dmDragging = true;
    e.preventDefault();
    window.addEventListener("pointermove", dmMove);
    window.addEventListener("pointerup", dmEnd);
  }
  // Outliner (left rail) drag — the dm-grip trio, mirrored to the left edge.
  let lrDragging = $state(false);
  function startLrDrag(e: PointerEvent) {
    void e; // no preventDefault — it would suppress the dblclick reset
    lrDragging = true;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", lrMove);
    window.addEventListener("pointerup", lrEnd);
  }
  function lrMove(e: PointerEvent) {
    if (!lrDragging || !workEl) return;
    const r = workEl.getBoundingClientRect();
    const w = Math.max(180, Math.min(420, e.clientX - r.left));
    paperLayout.update((s) => ({ ...s, outlinerW: Math.round(w) }));
  }
  function lrEnd() {
    lrDragging = false;
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", lrMove);
    window.removeEventListener("pointerup", lrEnd);
  }
  const resetLrW = () => paperLayout.update((s) => ({ ...s, outlinerW: 224 }));
  // The margin can grow until the editor column is down to ~420px — workspace-
  // relative, not a fixed cap (620 stays the ceiling only on small windows).
  function dmMaxW(): number {
    const w = workEl?.getBoundingClientRect().width ?? 0;
    return Math.max(620, w - 420);
  }
  function dmMove(e: PointerEvent) {
    if (!dmDragging || !workEl) return;
    const r = workEl.getBoundingClientRect();
    const w = Math.max(260, Math.min(dmMaxW(), r.right - e.clientX));
    paperLayout.update((s) => ({ ...s, dynMarginW: w }));
  }
  function dmEnd() {
    dmDragging = false;
    window.removeEventListener("pointermove", dmMove);
    window.removeEventListener("pointerup", dmEnd);
  }

  // A stable, getter-backed bundle: identity never changes, but each field read
  // is fine-grained reactive (so views only re-run when their data changes).
  const marginHost: MarginHost = {
    get view() {
      return view;
    },
    get latest() {
      return latest;
    },
    get latestIdle() {
      return latestIdle;
    },
    setCitationStyle(style) {
      if (view) setFrontMatterKey(view, "citation-style", style);
      view?.focus();
    },
    // WS-4.2: the per-editor numbering faces margin views subscribe to
    // (replaces their module-store imports).
    numbering: { ordinals: numbering.ordinalsStore, style: numbering.styleStore },
    get citedKeys() {
      return citedKeys;
    },
    get figures() {
      return figures;
    },
    get references() {
      return references;
    },
    get libraryReferences() {
      return libraryReferences;
    },
    get comments() {
      return {
        threads,
        ranges: cRanges,
        activeId: activeComment,
        author: commentAuthor,
        count: commentCount,
        onSubmitNew: submitNew,
        onCancelNew: cancelNew,
        onReply: replyComment,
        onResolve: resolveComment,
        onReopen: reopenComment,
        onDelete: deleteComment,
        onFocus: focusComment,
        onStart: startComment,
      };
    },
    writeCites: (keys, target) => {
      if (view) writeCiteGroup(view, keys, target);
    },
    removeCite: (key) => {
      if (view) removeCiteOp(view, key);
    },
    citationAtCaret: () =>
      view ? citationGroupAt(view.state, view.state.selection.main.head) : null,
    insertFigure,
    addDoi: addDoiFromPanel,
    focusEditor: () => view?.focus(),
    openFigure: (id) => revealFigure(id),
  };

  // ---- command palette (⌘K) + keyboard shortcuts -------------------------
  // WS-4.3: ONE shortcut table (commands.ts) generates BOTH the palette list
  // and the window dispatcher. Dynamic groups (figure-width presets, ambient
  // scenes, quarto-gated export) are palette-only and appended here.
  const cmdCtx: PaperCmdCtx = {
    previewActive: () => previewActive,
    togglePreview: () => {
      previewActive = !previewActive;
      if (!previewActive) view?.focus();
    },
    setView,
    setCitationStyle: (style) => marginHost.setCitationStyle(style),
    vimFlavor: () => $paperVimFlavor,
    setVimFlavor,
    openFigurePicker,
    openFigRefPicker,
    outlinerOpen: () => $paperLayout.outlinerOpen,
    toggleOutliner,
    marginOpen: () => $paperLayout.dynMarginOpen,
    toggleMargin,
    summonPane: (kind) => summonPane(kind as Parameters<typeof summonPane>[0]),
    editCitationAtCursor,
    openDoiPrompt,
    startComment,
    closeActivePane: () => {
      if (closeActivePane()) view?.focus();
    },
    closeAllPanes: () => {
      if (closeAllPanes()) view?.focus();
    },
    widerMargin: () =>
      paperLayout.update((s) => ({ ...s, dynMarginOpen: true, dynMarginW: Math.min(dmMaxW(), s.dynMarginW + 40) })),
    narrowerMargin: () => paperLayout.update((s) => ({ ...s, dynMarginW: Math.max(260, s.dynMarginW - 40) })),
    rerollBgSeed,
    foldSection: () => {
      if (view) {
        foldSection(view);
        view.focus();
      }
    },
    unfoldSection: () => {
      if (view) {
        unfoldSection(view);
        view.focus();
      }
    },
    foldAll: () => {
      if (view) {
        foldAll(view);
        view.focus();
      }
    },
    unfoldAll: () => {
      if (view) {
        unfoldAll(view);
        view.focus();
      }
    },
    doExport: (kind) => doExport(kind),
    togglePalette: () => {
      paletteOpen = !paletteOpen;
    },
  };
  const commands = $derived<Command[]>([
    ...paletteFromTable(cmdCtx),
    // Context/agent commands (principal-agent scheme) — same set as the shell
    // GlobalPalette, but opening docs stays in-pane via loadDocument.
    ...contextCommands({ inPaper: true, openDoc: (rel) => void loadDocument(rel) }),
    ...[25, 50, 75, 100, null].map((pct) => ({
      id: `fig-width-${pct ?? "auto"}`,
      title: pct ? `Figure width ${pct}%` : "Figure width auto",
      hint: pct ? CM_HINTS.figWidth : "Figure", // real binding: editing keymap layer
      keywords: "figure resize size width embed scale zoom",
      run: () => {
        if (!view || !setEmbedWidthPreset(view, pct))
          pushToast("info", "Place the cursor on a figure embed line first.");
      },
    })),
    ...BG_SOURCES.map((s) => ({
      id: `margin-bg-${s.id}`,
      title: `Background: ${s.label}`,
      hint: "Margin",
      keywords: "dynamic background ambient art scene switch",
      run: () => settings.update((v) => ({ ...v, paperMarginScene: s.id as never })),
    })),
    ...(quartoAvail
      ? [{ id: "export-docx", title: "Export Word", hint: "Export", keywords: "docx quarto", run: () => doExport("docx") }]
      : []),
  ]);

  // Shell-routed requests (commandBus): the shell owns Ctrl+K and forwards it
  // here while Paper is focused; palette "Open mission/notebook/rules" from any
  // mode lands as an openDocRequest.
  let seenPalReq = get(paperPaletteRequest);
  let seenDocReq = get(openDocRequest)?.n ?? 0;
  $effect(() => {
    const n = $paperPaletteRequest;
    if (n !== seenPalReq) {
      seenPalReq = n;
      paletteOpen = !paletteOpen;
    }
  });
  $effect(() => {
    const req = $openDocRequest;
    if (req && req.n !== seenDocReq) {
      seenDocReq = req.n;
      void loadDocument(req.path);
    }
  });

  $effect(() => {
    if (!focused) return;
    const h = (e: KeyboardEvent) => {
      // Table-driven chords first (view toggle, margin panes, …).
      if (dispatchWindowKey(e, cmdCtx)) return;
      // Esc layering guards — MODAL, kept verbatim (not commands).
      if (e.key === "Escape" && exportOpen) {
        // The export menu is not mouse-only — Esc closes it and returns to the editor.
        e.preventDefault();
        exportOpen = false;
        view?.focus();
      } else if (
        e.key === "Escape" &&
        previewActive &&
        !e.defaultPrevented &&
        !paletteOpen &&
        !pickerOpen &&
        !figRefPickerOpen &&
        !doiPromptOpen &&
        !newDocOpen &&
        !titleEditOpen &&
        !exportOpen
      ) {
        // Preview must not be a keyboard trap — but one Esc must peel only ONE layer,
        // so bail if any overlay is open or already consumed this key.
        e.preventDefault();
        previewActive = false;
        view?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });
</script>

<section class="paper">
  <div class="work" bind:this={workEl}>
    {#if $paperLayout.outlinerOpen}
      <div class="leftrail" style={`flex-basis:${$paperLayout.outlinerW}px`}>
        <Outline
          items={outline}
          title={meta.title}
          {activeFrom}
          collapsed={collapsedSet}
          onJump={jump}
          onToggleCollapse={toggleCollapse} />
        {#if !isDemo}
          <DocumentPicker {docs} activePath={activeDocPath} onSelect={loadDocument} onNew={newDocument} />
        {/if}
      </div>
      <div
        class="lr-grip"
        class:active={lrDragging}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize outliner (double-click resets)"
        onpointerdown={startLrDrag}
        ondblclick={resetLrW}>
      </div>
    {/if}
    <div class="editor-col" bind:this={colEl} style={gutterStyle}>
      {#if ready}
        <div class="titlepill-wrap">
          <TitlePill
            title={meta.title}
            authors={meta.authors}
            {status}
            onEdit={() => (titleEditOpen = true)} />
        </div>
        <Editor doc={initialDoc} extensions={buildExtensions()} {onReady} {onChange} />
        {#if viewMode !== "paginated" && !previewActive}
          <div
            class="mhandle left"
            class:active={dragSide === "l"}
            role="separator"
            aria-orientation="vertical"
            aria-label="Adjust left margin"
            onpointerdown={(e) => startMargin("l", e)}>
            <span class="grip"></span>
          </div>
          <div
            class="mhandle right"
            class:active={dragSide === "r"}
            role="separator"
            aria-orientation="vertical"
            aria-label="Adjust right margin"
            onpointerdown={(e) => startMargin("r", e)}>
            <span class="grip"></span>
          </div>
        {/if}
        {#if bodyEmpty && !dismissedEmpty}
          <EmptyState {title} onStart={startFrom} />
        {/if}
        {#if previewActive}
          <PreviewPane src={latest} paginated={viewMode === "paginated"} rev={figRefsRev} />
        {:else if !(bodyEmpty && !dismissedEmpty)}
          <StatusBar
            words={statusWords}
            {status}
            exporting={exportBusy}
            onStats={() => summonPane("stats")}
            onExport={() => (exportOpen = true)} />
        {/if}
      {/if}
    </div>
    {#if $paperLayout.dynMarginOpen}
      <div class="dm-wrap" style="flex:0 0 {$paperLayout.dynMarginW}px">
        <div
          class="dm-grip"
          class:active={dmDragging}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize margin"
          onpointerdown={startDmDrag}>
          <span class="bar"></span>
        </div>
        <DynamicMargin host={marginHost} paused={!active} />
      </div>
    {/if}
  </div>

  <SelectionToolbar {view} onComment={startComment} />

  {#if paletteOpen}
    <CommandPalette {commands} onClose={() => { paletteOpen = false; view?.focus(); }} />
  {/if}

  {#if doiPromptOpen}
    <div class="doi-prompt-backdrop">
      <div class="doi-prompt" role="dialog" aria-label="Add a DOI or URL">
        <label for="doi-prompt-input">
          {doiPromptMode === "cite"
            ? "Add a DOI or URL and cite it here"
            : "Add a DOI or URL to your FluxLib"}
        </label>
        <input
          id="doi-prompt-input"
          type="text"
          placeholder="10.1038/…  ·  https://doi.org/…  ·  or a paper URL"
          bind:value={doiPromptValue}
          use:focusSelect
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitDoiPrompt();
            } else if (e.key === "Escape") {
              e.preventDefault();
              doiPromptOpen = false;
              view?.focus();
            }
          }} />
        {#if doiPromptError}<div class="doi-prompt-err">{doiPromptError}</div>{/if}
        <div class="doi-prompt-actions">
          <button class="ghost" onclick={() => { doiPromptOpen = false; view?.focus(); }}>Cancel</button>
          <button
            onclick={submitDoiPrompt}
            disabled={doiStatus === "fetching" || !doiPromptValue.trim()}>
            {doiStatus === "fetching"
              ? "Fetching…"
              : doiPromptMode === "cite"
                ? "Add & cite"
                : "Add to FluxLib"}
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if newDocOpen}
    <div class="doi-prompt-backdrop">
      <div class="doi-prompt" role="dialog" aria-label="New document">
        <label for="new-doc-input">Name the new document</label>
        <input
          id="new-doc-input"
          type="text"
          placeholder="Untitled"
          bind:value={newDocValue}
          use:focusSelect
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitNewDoc();
            } else if (e.key === "Escape") {
              e.preventDefault();
              newDocOpen = false;
              view?.focus(); // return focus to the editor (feel invariant #7)
            }
          }} />
        <div class="doi-prompt-actions">
          <button class="ghost" onclick={() => { newDocOpen = false; view?.focus(); }}>Cancel</button>
          <button onclick={submitNewDoc}>Create</button>
        </div>
      </div>
    </div>
  {/if}

  {#if titleEditOpen}
    <TitleEditor
      title={meta.title}
      authors={meta.authors}
      onSave={saveTitleAuthors}
      onClose={() => { titleEditOpen = false; view?.focus(); }} />
  {/if}

  {#if hover}
    <HoverCard
      target={hover.target}
      anchor={hover.anchor}
      nums={numbering.instance}
      onenter={() => clearTimeout(hoverHideTimer)}
      onleave={hideHoverSoon}
      onOpenRef={openRefFromHover}
      onOpenPdf={openPdfFromHover} />
  {/if}

  {#if doiStatus}
    <div class="doi-toast" class:err={doiStatus === "error"} class:done={doiStatus === "added"}>
      {doiStatus === "fetching"
        ? "Fetching reference…"
        : doiStatus === "added"
          ? "Added to FluxLib ✓"
          : "Couldn't resolve that DOI"}
    </div>
  {/if}

  {#if diskDiverged}
    <div class="disk-toast">
      <span>This document changed on disk (an agent or another tool edited it).</span>
      <button onclick={forceReloadFromDisk}>Reload theirs</button>
      <button class="ghost" onclick={overwriteDisk}>Overwrite with mine</button>
    </div>
  {/if}

  {#if pickerOpen}
    {#key pickerOpenN}
      <FigurePicker
        figures={$figureRefs}
        onSelect={insertFigure}
        onClose={() => { pickerOpen = false; view?.focus(); }} />
    {/key}
  {/if}

  {#if figRefPickerOpen}
    {#key figRefOpenN}
      <FigRefPicker
        figures={$figureRefs}
        nums={numbering.instance}
        onInsert={insertFigRef}
        onClose={() => { figRefPickerOpen = false; view?.focus(); }} />
    {/key}
  {/if}

  {#if exportOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="menu-scrim" onclick={() => { exportOpen = false; view?.focus(); }}></div>
    <div class="export-menu" transition:popIn>
      <button onclick={() => doExport("pdf")}>PDF</button>
      <button onclick={() => doExport("html")}>HTML</button>
      <button
        onclick={() => doExport("docx")}
        disabled={!quartoAvail}
        title={quartoAvail ? "Word via Quarto" : "Install Quarto for Word export"}>
        Word {quartoAvail ? "" : "· needs Quarto"}
      </button>
    </div>
  {/if}

  {#if exportBusy}
    <div class="doi-toast">Exporting…</div>
  {:else if exportDone}
    <div class="doi-toast done">Exported ✓</div>
  {/if}
</section>

<style>
  .paper {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background: var(--c-bg);
    color: var(--c-tx);
  }
  /* The three panels read as distinct paper cards on a cream desk. */
  .work {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    gap: 14px;
    padding: 20px 16px 16px;
    background: var(--c-bg);
  }
  /* F4: left rail = Outline (fills) + the document picker beneath it. */
  .leftrail {
    flex: 0 0 224px; /* overridden inline by $paperLayout.outlinerW */
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  /* Outliner drag seam — a slim flex sibling overlaying the rail/editor gap. */
  .lr-grip {
    flex: 0 0 8px;
    margin: 0 -4px 0 -4px;
    cursor: col-resize;
    z-index: 4;
    background: transparent;
  }
  .lr-grip:hover,
  .lr-grip.active {
    background: color-mix(in srgb, var(--c-accent, #4385be) 30%, transparent);
  }
  .leftrail :global(.outline) {
    flex: 1 1 auto;
    width: auto;
    min-height: 0;
  }
  .editor-col {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
    --cm-pad-top: 72px;
    border: 1.5px solid var(--c-edge);
    border-radius: var(--r-3);
    background: var(--flx-paper);
  }
  /* The title｜authors banner straddles the editor card's top edge. */
  .titlepill-wrap {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    transform: translateY(-50%);
    z-index: 6;
    display: flex;
    justify-content: center;
    pointer-events: none;
  }
  .titlepill-wrap :global(.pill) {
    pointer-events: auto;
  }
  /* Reader-adjustable margins: a thin guide that lights up on hover/drag, sitting
     just inside the gutter so the text column stays fully clickable. */
  .mhandle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 12px;
    z-index: 4;
    cursor: col-resize;
    display: flex;
    justify-content: center;
  }
  .mhandle.left {
    left: calc(var(--gutter-l, max(24px, (100% - 72ch) / 2)) - 12px);
  }
  .mhandle.right {
    right: calc(var(--gutter-r, max(24px, (100% - 72ch) / 2)) - 12px);
  }
  .mhandle .grip {
    width: 2px;
    height: 100%;
    background: var(--c-accent);
    opacity: 0;
    transition: opacity var(--dur-quick) var(--ease-standard);
  }
  .mhandle:hover .grip,
  .mhandle.active .grip {
    opacity: 0.55;
    box-shadow: 0 0 8px var(--c-accent-glow);
  }
  .dm-wrap {
    position: relative;
    height: 100%;
    min-width: 0;
  }
  /* Resize grip living in the desk gap on the margin card's left edge. */
  .dm-grip {
    position: absolute;
    left: -14px;
    top: 0;
    bottom: 0;
    width: 14px;
    z-index: 4;
    display: grid;
    place-items: center;
    cursor: col-resize;
  }
  .dm-grip .bar {
    width: 2px;
    height: 36px;
    border-radius: 1px;
    background: var(--c-edge);
    opacity: 0.45;
    transition:
      opacity var(--dur-quick) var(--ease-standard),
      background var(--dur-quick) var(--ease-standard);
  }
  .dm-grip:hover .bar,
  .dm-grip.active .bar {
    background: var(--c-accent);
    opacity: 1;
    height: 100%;
    box-shadow: 0 0 8px var(--c-accent-glow);
  }
  .doi-toast {
    position: absolute;
    bottom: var(--sp-5);
    left: 50%;
    transform: translateX(-50%);
    padding: var(--sp-2) var(--sp-4);
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-pill);
    box-shadow: var(--elev-2);
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
    z-index: 60;
  }
  .doi-toast.err {
    color: var(--c-danger, #d14d41);
  }
  .doi-toast.done {
    color: var(--c-accent-bright);
  }
  .doi-prompt-backdrop {
    position: absolute;
    inset: 0;
    z-index: 70;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 16vh;
    background: rgba(0, 0, 0, 0.18);
  }
  .doi-prompt {
    width: min(440px, 90%);
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-4);
    background: var(--c-surface, #fff);
    border: 1px solid var(--c-line-strong, #ccc);
    border-radius: 10px;
    box-shadow: var(--elev-2);
  }
  .doi-prompt label {
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
  }
  .doi-prompt input {
    width: 100%;
    box-sizing: border-box;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--c-line-strong, #ccc);
    border-radius: 6px;
    background: var(--c-surface, #fff);
    color: inherit;
    font-size: var(--ts-base, 0.95rem);
  }
  .doi-prompt-err {
    font-size: var(--ts-sm);
    color: var(--c-danger, #d14d41);
  }
  .doi-prompt-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
  }
  .disk-toast {
    position: absolute;
    bottom: var(--sp-5);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: var(--sp-2) var(--sp-3);
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-pill);
    box-shadow: var(--elev-2);
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
    z-index: 60;
  }
  .disk-toast button {
    background: var(--c-accent);
    color: #fff;
    border: none;
    border-radius: var(--r-1);
    padding: 4px 10px;
    font: inherit;
    font-size: var(--ts-sm);
    cursor: pointer;
  }
  .disk-toast button.ghost {
    background: none;
    color: var(--c-tx-faint);
    border: 1px solid var(--c-line-strong);
  }
  .menu-scrim {
    position: absolute;
    inset: 0;
    z-index: 65;
  }
  .export-menu {
    /* Pops from its trigger — the StatusBar's Export segment, bottom-right. */
    position: absolute;
    bottom: 44px;
    right: 12px;
    z-index: 66;
    min-width: 150px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2);
    box-shadow: var(--elev-2);
  }
  .export-menu button {
    text-align: left;
    background: none;
    border: none;
    padding: 7px 10px;
    border-radius: var(--r-1);
    color: var(--c-tx-2);
    font: inherit;
    font-size: var(--ts-sm);
    cursor: pointer;
  }
  .export-menu button:hover:not(:disabled) {
    background: var(--c-ui-hover);
    color: var(--c-tx-hi);
  }
  .export-menu button:disabled {
    color: var(--c-tx-faint);
    cursor: default;
  }
</style>

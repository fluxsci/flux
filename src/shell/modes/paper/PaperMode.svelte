<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { EditorView } from "@codemirror/view";
  import { projectModel } from "../../shellStore";
  import { readManuscript, writeManuscript } from "../../../lib/project/load";
  import { externalManuscriptChange } from "../../../lib/project/projectWatch";
  import { createEditorExtensions } from "./markdown-setup";
  import Editor from "./Editor.svelte";
  import Outline from "./outline/Outline.svelte";
  import DocumentPicker from "./documents/DocumentPicker.svelte";
  import { listDocuments, createDocument, type DocEntry } from "./documents/documents";
  import TitlePill from "./TitlePill.svelte";
  import TitleEditor from "./TitleEditor.svelte";
  import CommandPalette from "./command/CommandPalette.svelte";
  import type { Command } from "./command/commands";
  import { paperLayout } from "./view-mode/paperLayoutStore";
  import { cursorPos, cursorWatcher } from "./outline/activeHeading";
  import SelectionToolbar from "./toolbar/SelectionToolbar.svelte";
  import EmptyState from "./EmptyState.svelte";
  import { selectionWatcher } from "./toolbar/selectionState";
  import { formattingKeymap } from "./editing/keymap";
  import { pageCompartment, themeFor } from "./view-mode/pageView";
  import { paperViewMode, type PaperViewMode } from "./view-mode/paperViewStore";
  import { getOutline, type OutlineItem } from "./outline/outline";
  import { scienceChips, refreshChips } from "./science/chips";
  import { scienceEmbeds } from "./science/embeds";
  import { scienceTables } from "./science/tables";
  import {
    setChipHandlers,
    setEmbedHandlers,
    setSlashHandlers,
    type ChipTarget,
  } from "./science/chipContext";
  import FigurePicker from "./scholar/FigurePicker.svelte";
  import type { FigureRef } from "./scholar/figures";
  import DynamicMargin from "./margin/DynamicMargin.svelte";
  import type { MarginHost } from "./margin/types";
  import { writeCiteGroup, removeCite as removeCiteOp, citationGroupAt } from "./scholar/citeOps";
  import PreviewPane from "./render/PreviewPane.svelte";
  import { renderManuscript } from "./render/renderManuscript";
  import { fileBridge } from "../../../lib/project/types";
  import { pushToast, errMsg } from "../../../lib/toast";
  import { touchActivityLock } from "../../../lib/bridge/activityLock";
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
  import { loadFigures, figureRefs, resolveFigure } from "./scholar/figures";
  import { bibEntries, type BibEntry } from "./scholar/bib";
  import { loadBib, addDoiToBib, addUrlOrDoiToBib, addUrlOrDoiToLibrary } from "./scholar/bibLoad";
  import { materializeIntoProject, refreshFluxLib } from "../../../lib/references/fluxlibBridge";
  import { fluxLibRevision, fluxLibEntries } from "../../../lib/references/revision";
  import { scholarCompletion } from "./scholar/completions";
  import { doiPaste } from "./science/doiPaste";
  import { figRevision, bibRevision } from "../../scholar/revisions";
  import { revealFigure } from "../../scholar/nav";
  import HoverCard from "./scholar/HoverCard.svelte";

  let { focused = false }: { focused?: boolean } = $props();

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
  let paletteOpen = $state(false);
  // F4: the active document (project-relative path) + the project's document list.
  let activeDocPath = $state(pm?.manifest.manuscript.path ?? "manuscript/main.qmd");
  let docs = $state<DocEntry[]>([]);
  let diskDiverged = $state(false); // F1: active doc changed on disk while dirty

  function toggleOutliner() {
    paperLayout.update((s) => ({ ...s, outlinerOpen: !s.outlinerOpen }));
  }

  // ---- title｜authors pill (front-matter, read-only in Phase A) -----------
  const meta = $derived.by(() => parseFrontmatterMeta(latest));
  function unquote(s: string): string {
    return s.trim().replace(/^["']|["']$/g, "");
  }
  function parseFrontmatterMeta(src: string): { title: string; authors: string[] } {
    let t = pm?.manifest.title ?? "Untitled";
    let authors: string[] = ((pm?.manifest.authors ?? []) as Array<{ name?: string }>)
      .map((a) => a?.name ?? "")
      .filter(Boolean);
    if (src.startsWith("---")) {
      const end = src.indexOf("\n---", 3);
      if (end >= 0) {
        const fm = src.slice(3, end);
        const tm = /^title:[ \t]*(.+?)[ \t]*$/m.exec(fm);
        if (tm) t = unquote(tm[1]);
        const am = /^authors?:[ \t]*(.*)$/m.exec(fm);
        if (am) {
          const inline = am[1].trim();
          if (inline.startsWith("[")) {
            authors = inline.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
          } else if (inline) {
            authors = [unquote(inline)];
          } else {
            // block list following the key, e.g. "- name: A"
            const acc: string[] = [];
            for (const ln of fm.slice(am.index + am[0].length).split("\n").slice(1)) {
              if (/^[ \t]*-[ \t]*/.test(ln)) acc.push(unquote(ln.replace(/^[ \t]*-[ \t]*(?:name:[ \t]*)?/, "")));
              else if (/^[ \t]+name:[ \t]*/.test(ln)) acc.push(unquote(ln.replace(/^[ \t]+name:[ \t]*/, "")));
              else if (/^\S/.test(ln)) break; // next top-level key
            }
            if (acc.length) authors = acc.filter(Boolean);
          }
        }
      }
    }
    return { title: t, authors };
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
    const fmEnd = src.startsWith("---") ? src.indexOf("\n---", 3) : -1;
    const hadFm = fmEnd >= 0;
    if (hadFm) {
      try {
        metaObj = (yaml.load(src.slice(3, fmEnd)) as Record<string, unknown>) ?? {};
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
      view.dispatch({ changes: { from: 0, to: fmEnd + 4, insert: `---\n${dumped}---` } });
    } else {
      view.dispatch({ changes: { from: 0, insert: `---\n${dumped}---\n\n` } });
    }
    view.focus();
  }
  let viewMode = $state<PaperViewMode>(get(paperViewMode));
  let dismissedEmpty = $state(false);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let hover = $state<{ target: ChipTarget; anchor: HTMLElement } | null>(null);
  let hoverHideTimer: ReturnType<typeof setTimeout> | undefined;
  let doiStatus = $state<"" | "fetching" | "error" | "added">("");
  let pickerOpen = $state(false);
  const subs: Array<() => void> = [];

  // Citekeys actually referenced in the manuscript (the red-dot "cited" state).
  const citedKeys = $derived.by(() => {
    const set = new Set<string>();
    const re = /(?:\[@|(?:^|[\s([])@)([A-Za-z][\w:.-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(latest))) {
      if (!/^(?:fig|tbl|sec|eq)-/.test(m[1])) set.add(m[1]);
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

  // One materialization path for ALL citing routes (margin search, omnibox,
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
      // Refresh each anchor from its live range before persisting.
      const doc = view?.state.doc.toString() ?? latest;
      const persist: CommentThread[] = threads
        .filter((t) => !t.draft)
        .map((t) => {
          const r = cRanges.get(t.id);
          const anchor = r ? makeAnchor(doc, r.from, r.to) : t.anchor;
          return { id: t.id, anchor, resolved: t.resolved, messages: t.messages };
        });
      void writeComments(pm, persist, activeDocPath);
    }, 600);
  }

  function startComment() {
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    openMarginView("comments");
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
    threads = threads.map((t) => (t.id === id ? { ...t, resolved: true } : t));
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

  async function doExport(kind: "pdf" | "html" | "docx") {
    exportOpen = false;
    const fb = fileBridge();
    if (!fb) return;
    exportBusy = true;
    try {
      if (kind === "docx") {
        if (pm && fb.quartoRender) await fb.quartoRender(pm.root, "docx");
        exportBusy = false;
        exportDone = true;
        setTimeout(() => (exportDone = false), 2600);
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
      if (kind === "pdf") await fb.printPdf?.(full, out, {});
      else await fb.writeText(out, full);
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
    const cap = ref.caption || ref.name || "";
    const embed = `![${cap}](../fig/renders/${ref.id}.svg){#${ref.label}}`;
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
  function activateChip(target: ChipTarget) {
    if (target.kind === "figref") {
      const r = resolveFigure(target.label);
      if (r) revealFigure(r.ref.id);
    }
  }

  const status = $derived<"demo" | "saved" | "saving">(
    isDemo ? "demo" : saved ? "saved" : "saving",
  );
  const bodyEmpty = $derived(stripFrontmatter(latest).trim().length === 0);

  function stripFrontmatter(s: string): string {
    if (s.startsWith("---")) {
      const end = s.indexOf("\n---", 3);
      if (end >= 0) return s.slice(end + 4);
    }
    return s;
  }

  onMount(async () => {
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
    ready = true;

    setChipHandlers({
      onActivate: activateChip,
      onHover: showHover,
      onLeave: hideHoverSoon,
    });
    setEmbedHandlers({ onOpenFigure: (id) => revealFigure(id) });
    setSlashHandlers({ onInsertFigure: () => (pickerOpen = true) });
    await Promise.all([loadFigures(pm?.root ?? null), loadBib(pm?.root ?? null)]);
    const refresh = () => view?.dispatch({ effects: refreshChips.of(null) });
    subs.push(figRevision.subscribe(() => void loadFigures(pm?.root ?? null)));
    subs.push(bibRevision.subscribe(() => void loadBib(pm?.root ?? null)));
    // Keep the shared FluxLib store current for the reference search + @-autocomplete
    // (fires immediately, then on any FluxLib change — add here, Library mode, capture).
    subs.push(fluxLibRevision.subscribe(() => void refreshFluxLib()));
    subs.push(externalManuscriptChange.subscribe((chg) => void onExternalManuscript(chg)));
    subs.push(figureRefs.subscribe(refresh));
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
      extra: [
        pageCompartment.of(themeFor(viewMode)),
        selectionWatcher,
        cursorWatcher,
        formattingKeymap,
        scienceChips,
        scienceEmbeds,
        scienceTables,
        scholarCompletion,
        doiPaste(handleDoi),
        commentField,
        commentClickHandler(focusComment),
      ],
    });
  }

  function onReady(v: EditorView) {
    view = v;
    outline = getOutline(v.state);
    void loadComments(v);
  }

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

  function onChange(s: string) {
    latest = s;
    if (view) outline = getOutline(view.state);
    syncRanges();
    if (threads.some((t) => !t.draft)) scheduleCommentSave();
    if (!pm) return;
    touchActivityLock("manuscript"); // W3: defer concurrent agent writes while mid-edit
    saved = false;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await writeManuscript(pm, latest, activeDocPath);
      saved = true;
    }, 600);
  }

  function setView(m: PaperViewMode) {
    viewMode = m;
    paperViewMode.set(m);
    view?.dispatch({ effects: pageCompartment.reconfigure(themeFor(m)) });
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
    clearTimeout(saveTimer);
    if (pm && !saved) {
      await writeManuscript(pm, latest, activeDocPath);
      saved = true;
    }
  }

  // ---- F4: document switching --------------------------------------------
  function persistThreadsTo(docPath: string) {
    if (!pm) return;
    const doc = view?.state.doc.toString() ?? latest;
    const persist: CommentThread[] = threads
      .filter((t) => !t.draft)
      .map((t) => {
        const r = cRanges.get(t.id);
        const anchor = r ? makeAnchor(doc, r.from, r.to) : t.anchor;
        return { id: t.id, anchor, resolved: t.resolved, messages: t.messages };
      });
    void writeComments(pm, persist, docPath);
  }

  async function loadDocument(path: string) {
    if (!pm || !view || path === activeDocPath) return;
    // Persist the current document (text + comments) before switching away.
    clearTimeout(saveTimer);
    clearTimeout(commentSaveTimer);
    if (!saved) await writeManuscript(pm, latest, activeDocPath);
    persistThreadsTo(activeDocPath);

    const text = (await readManuscript(pm, path)) || "";
    threads = [];
    activeComment = null;
    cRanges = new Map();
    activeDocPath = path;
    paperLayout.update((s) => ({ ...s, activeDocPath: path }));
    // Swap the editor content in place (preserve the extension set).
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 },
    });
    latest = text;
    saved = true;
    clearTimeout(saveTimer); // ignore the swap's own change event
    outline = getOutline(view.state);
    syncRanges();
    await loadComments(view);
    view.focus();
  }

  async function newDocument() {
    if (!pm) return;
    const name = window.prompt("New document name", "Untitled");
    if (name == null) return;
    const rel = await createDocument(pm, name.trim() || "Untitled");
    docs = await listDocuments(pm);
    await loadDocument(rel);
  }

  // F1 live reload: an external (agent/script) edit to the *active* document.
  // Reload silently if the editor is clean; if dirty, never clobber unsaved work —
  // surface a "reloaded from disk / keep mine" choice instead.
  function applyDiskText(text: string) {
    if (!view) return;
    const head = Math.min(view.state.selection.main.head, text.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: head },
    });
    latest = text;
    saved = true;
    diskDiverged = false;
    outline = getOutline(view.state);
    syncRanges();
  }
  // The active document's comments sidecar (mirrors flux-core commentsRel /
  // comments.ts commentsPath): main doc → comments.json, others → <base>.comments.json.
  function commentsSidecarRel(): string {
    const mainPath = pm?.manifest.manuscript.path ?? "";
    const mp = activeDocPath;
    const dir = mp.includes("/") ? mp.slice(0, mp.lastIndexOf("/")) : "";
    const isMain = mp === mainPath;
    const base = mp.slice(mp.lastIndexOf("/") + 1).replace(/\.qmd$/, "");
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
    applyDiskText((await readManuscript(pm, activeDocPath)) || "");
  }
  onDestroy(() => {
    void flush();
    subs.forEach((u) => u());
    clearTimeout(hoverHideTimer);
    clearTimeout(commentSaveTimer);
  });

  // ---- dynamic margin -----------------------------------------------------
  let omniFocusN = $state(0);
  let viewReq = $state<{ id: string; n: number }>({ id: "figure", n: 0 });
  let workEl = $state<HTMLDivElement | undefined>(undefined);
  let dmDragging = $state(false);

  function openMarginView(id: string) {
    paperLayout.update((s) => ({ ...s, dynMarginOpen: true }));
    viewReq = { id, n: viewReq.n + 1 };
  }
  function focusMarginSearch() {
    paperLayout.update((s) => ({ ...s, dynMarginOpen: true }));
    omniFocusN += 1;
  }
  function toggleMargin() {
    paperLayout.update((s) => ({ ...s, dynMarginOpen: !s.dynMarginOpen }));
  }
  function startDmDrag(e: PointerEvent) {
    dmDragging = true;
    e.preventDefault();
    window.addEventListener("pointermove", dmMove);
    window.addEventListener("pointerup", dmEnd);
  }
  function dmMove(e: PointerEvent) {
    if (!dmDragging || !workEl) return;
    const r = workEl.getBoundingClientRect();
    const w = Math.max(260, Math.min(620, r.right - e.clientX));
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
  const commands = $derived<Command[]>([
    {
      id: "view-toggle",
      title: previewActive ? "Switch to Edit" : "Switch to Preview",
      hint: "View",
      keywords: "preview edit render",
      run: () => (previewActive = !previewActive),
    },
    { id: "view-continuous", title: "Continuous view", hint: "View", keywords: "scroll column", run: () => setView("continuous") },
    { id: "view-paginated", title: "Paginated view", hint: "View", keywords: "page sheets print", run: () => setView("paginated") },
    { id: "insert-figure", title: "Insert figure…", hint: "Insert", keywords: "image panel embed", run: () => (pickerOpen = true) },
    {
      id: "toggle-outliner",
      title: $paperLayout.outlinerOpen ? "Hide outliner" : "Show outliner",
      hint: "Alt+O",
      keywords: "outline toc headings sections",
      run: toggleOutliner,
    },
    { id: "toggle-margin", title: $paperLayout.dynMarginOpen ? "Hide dynamic margin" : "Show dynamic margin", hint: "Alt+F", keywords: "panel margin sidebar", run: toggleMargin },
    { id: "margin-search", title: "Search references…", hint: "Margin", keywords: "find cite reference bibliography", run: focusMarginSearch },
    { id: "margin-references", title: "References", hint: "Margin", keywords: "bibliography citations library", run: () => openMarginView("bibliography") },
    { id: "add-doi-library", title: "Add DOI to FluxLib", hint: "Reference", keywords: "doi reference library fluxlib add paper crossref import", run: () => openDoiPrompt("library") },
    { id: "add-doi-cite", title: "Add DOI & cite here", hint: "Reference", keywords: "doi cite citation reference insert crossref", run: () => openDoiPrompt("cite") },
    { id: "margin-figures", title: "Figures", hint: "Margin", keywords: "image plot zoom panel", run: () => openMarginView("figure") },
    { id: "margin-comments", title: "Comments", hint: "Margin", keywords: "notes annotations review", run: () => openMarginView("comments") },
    { id: "margin-stats", title: "Statistics", hint: "Margin", keywords: "word count length", run: () => openMarginView("stats") },
    { id: "margin-terminal", title: "Terminal", hint: "Ctrl+`", keywords: "shell console command cli bash zsh run", run: () => openMarginView("terminal") },
    { id: "export-pdf", title: "Export PDF", hint: "Export", keywords: "download print", run: () => doExport("pdf") },
    { id: "export-html", title: "Export HTML", hint: "Export", keywords: "download web", run: () => doExport("html") },
    ...(quartoAvail
      ? [{ id: "export-docx", title: "Export Word", hint: "Export", keywords: "docx quarto", run: () => doExport("docx") }]
      : []),
  ]);

  $effect(() => {
    if (!focused) return;
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.code === "KeyK") {
        e.preventDefault();
        paletteOpen = !paletteOpen;
      } else if (e.altKey && !mod && !e.shiftKey && e.code === "KeyO") {
        e.preventDefault();
        toggleOutliner();
      } else if (e.altKey && !mod && !e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        focusMarginSearch();
      } else if (mod && !e.shiftKey && !e.altKey && e.code === "Backquote") {
        e.preventDefault();
        openMarginView("terminal");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });
</script>

<section class="paper">
  <div class="work" bind:this={workEl}>
    {#if $paperLayout.outlinerOpen}
      <div class="leftrail">
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
          <PreviewPane src={latest} paginated={viewMode === "paginated"} />
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
        <DynamicMargin
          host={marginHost}
          focusReq={omniFocusN}
          {viewReq}
          onClose={() => paperLayout.update((s) => ({ ...s, dynMarginOpen: false }))} />
      </div>
    {/if}
  </div>

  <SelectionToolbar {view} onComment={startComment} />

  {#if paletteOpen}
    <CommandPalette {commands} onClose={() => (paletteOpen = false)} />
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
            }
          }} />
        {#if doiPromptError}<div class="doi-prompt-err">{doiPromptError}</div>{/if}
        <div class="doi-prompt-actions">
          <button class="ghost" onclick={() => (doiPromptOpen = false)}>Cancel</button>
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

  {#if titleEditOpen}
    <TitleEditor
      title={meta.title}
      authors={meta.authors}
      onSave={saveTitleAuthors}
      onClose={() => (titleEditOpen = false)} />
  {/if}

  {#if hover}
    <HoverCard
      target={hover.target}
      anchor={hover.anchor}
      onenter={() => clearTimeout(hoverHideTimer)}
      onleave={hideHoverSoon} />
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
      <span>This document changed on disk.</span>
      <button onclick={forceReloadFromDisk}>Reload</button>
      <button class="ghost" onclick={() => (diskDiverged = false)}>Keep mine</button>
    </div>
  {/if}

  {#if pickerOpen}
    <FigurePicker
      figures={$figureRefs}
      onSelect={insertFigure}
      onClose={() => (pickerOpen = false)} />
  {/if}

  {#if exportOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="menu-scrim" onclick={() => (exportOpen = false)}></div>
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
    flex: 0 0 224px;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 14px;
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
    position: absolute;
    top: 78px;
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

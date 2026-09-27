<script lang="ts">
  import { fullscreenPortal } from "../../lib/ui/portal";
  import { onDestroy, tick, untrack } from "svelte";
  import { get } from "svelte/store";
  import { annotationOpen, annotationRequest, closeAnnotation, bufferAnnotationInput, focusAnnotationInput, type AnnotationRequest } from "./annotateChord";
  import { initAnnotationStore, sessions, annotationRoute, rememberRoute, projectGeneration, editAnnotationRequest,
    addAnnotation, annotationImage } from "./annotationStore";
  import { requestInbox } from "../inbox/inboxState";
  import { currentProject } from "../shellStore";
  import { settings } from "../../lib/settings";
  import { modalFocus } from "../../lib/ui/modalFocus";
  import { describeStamp, describeRoute, parseTags, parseRoute, type ContextStamp, type Route } from "../../lib/project/annotations";
  import type { InboxItem } from "../../lib/project/inbox";
  import { describeTarget, formatTarget, resolvedTargetKey, widenTarget, uniqueTargets, type TargetRef } from "../../lib/project/targets";
  import { resolveAt, resolveWithin, elementUnder, type TargetHit } from "../../lib/bridge/targetResolvers";
  import { anchorPathOf, arrowHead, markBadgePoint, markTargetPoint, snapshotCrop, type FeedbackMark, type MarkKind } from "../../lib/project/annotationCapture";

  import RecipientList from "./RecipientList.svelte";
  import { recipientOptions } from "../../lib/project/agentRouting";
  import { backgroundAvailable } from "./backgroundAvailability";

  initAnnotationStore();
  const INK = "#ff2bd6";
  let text = $state("");
  let stamp = $state<ContextStamp | null>(null);
  let marks = $state<FeedbackMark[]>([]);
  let drawing = $state<FeedbackMark | null>(null);
  let tool = $state<MarkKind>("arrow");
  let frozen = $state<string | null>(null);
  let frozenImg: HTMLImageElement | null = null;
  let win = $state({ w: 1, h: 1, dpr: 1 });
  let sourceDocument: Document = document;
  let viewIdentity: unknown[] = [];
  let staleView = $state(false);
  let ready = $state(false), busy = $state(false), error = $state("");
  let input = $state<HTMLTextAreaElement>();
  let host = $state<HTMLDivElement>();
  let svg = $state<SVGSVGElement>();
  let editing = $state<InboxItem | null>(null);
  let routeOpen = $state(false);
  let hover = $state<TargetHit[]>([]), specificity = $state(0);
  let pointer = $state({ x: 0, y: 0 });
  let selected = $state<{ ref: TargetRef; history: TargetRef[]; n?: number }[]>([]);
  let generation = 0;
  let seenProject = -1;
  const routeOptions = $derived(recipientOptions($sessions, $backgroundAvailable).map(o => o.route));
  const parsed = $derived(parseRoute(text, $sessions.map(({ id, name, client }) => ({ id, name, client }))));
  const route = $derived(parsed.route ?? $annotationRoute);
  const tags = $derived(parseTags(text));
  const background = $derived(typeof route === "object" && "background" in route);
  const hit = $derived(hover[specificity]);
  const hasMarks = $derived(marks.length > 0 || !!editing?.context?.snapshot?.marks.length);
  const attach = $derived($settings["annotate.attachView"] || hasMarks);
  const canAdd = $derived(ready && !busy && !!$currentProject?.path && !!parsed.text && !background);

  function clearPicture() { if (frozen) URL.revokeObjectURL(frozen); frozen = null; frozenImg = null; }
  function resetDraft() {
    text = ""; stamp = null; marks = []; selected = []; editing = null; error = ""; drawing = null; clearPicture();
  }
  $effect(() => {
    const g = $projectGeneration;
    untrack(() => { if (g !== seenProject) { seenProject = g; generation++; resetDraft(); ready = false; busy = false; } });
  });
  $effect(() => {
    const open = $annotationOpen, req = $annotationRequest;
    untrack(() => {
      if (open && req) void openSurface(req);
      else { generation++; ready = false; drawing = null; hover = []; routeOpen = false; }
    });
  });
  onDestroy(() => { generation++; clearPicture(); });

  async function openSurface(req: AnnotationRequest, refresh = false) {
    const owner = ++generation;
    bufferAnnotationInput();
    ready = false; busy = false; error = "";
    const editRequest = get(editAnnotationRequest);
    if (editRequest) {
      editAnnotationRequest.set(null);
      win = editRequest.context?.snapshot?.window ?? req.size;
      sourceDocument = req.document; viewIdentity = req.identity; staleView = false;
      await edit(editRequest, owner);
      if (owner !== generation) return;
      ready = true;
      await tick(); if (input) focusAnnotationInput(input);
      return;
    }
    // A cancelled marked draft retains its picture AND target context together.
    if (!refresh && stamp) staleView = req.document !== sourceDocument || req.identity.length !== viewIdentity.length || req.identity.some((v,i) => v !== viewIdentity[i]);
    if (refresh || !stamp || (!text.trim() && !marks.length && !editing)) {
      if (refresh) { marks = []; editing = null; }
      viewIdentity = req.identity; staleView = false;
      tool = "arrow"; hover = []; specificity = 0;
      clearPicture(); stamp = req.stamp; win = req.size; sourceDocument = req.document;
      selected = (req.stamp.targets ?? []).map(ref => ({ ref, history: [] }));
      const shot = await req.shot;
      if (owner !== generation) return;
      if (shot) {
        const url = URL.createObjectURL(new Blob([new Uint8Array(shot.png)], { type: "image/png" }));
        const img = new Image(); img.src = url;
        try { await img.decode(); } catch { URL.revokeObjectURL(url); }
        if (owner !== generation) { URL.revokeObjectURL(url); return; }
        if (img.naturalWidth) { frozen = url; frozenImg = img; }
      }
    }
    if (owner !== generation) return;
    ready = true;
    if (req.stamp.window?.kind === "utility") window.focus();
    await tick();
    if (owner !== generation || !input) return;
    const buffered = focusAnnotationInput(input);
    text += buffered.text;
    await tick();
    input.setSelectionRange(input.value.length, input.value.length);
    if (buffered.submit) void add();
  }
  function point(e: PointerEvent): [number, number] {
    const ctm = svg?.getScreenCTM();
    if (!ctm) return [e.clientX, e.clientY];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return [Math.max(0, Math.min(win.w, p.x)), Math.max(0, Math.min(win.h, p.y))];
  }
  function inspectPoint(p: [number, number]) {
    const next = resolveAt(p[0], p[1], { ignore: host, document: sourceDocument });
    if (next[0] && hover[0] && resolvedTargetKey(next[0].ref) === resolvedTargetKey(hover[0].ref)) specificity = Math.min(specificity, next.length - 1);
    else specificity = 0;
    hover = next;
  }
  function onDown(e: PointerEvent) {
    if (e.button !== 0 || busy || editing || staleView) return;
    e.preventDefault();
    svg?.setPointerCapture(e.pointerId);
    const p = point(e);
    inspectPoint(p);
    drawing = { kind: tool, n: (marks.at(-1)?.n ?? 0) + 1, points: tool === "pen" ? [p] : [p, p] };
  }
  function onMove(e: PointerEvent) {
    if (editing || staleView) return;
    const p = point(e); pointer = { x: e.clientX, y: e.clientY };
    if (drawing) {
      if (drawing.kind === "pen") {
        const last = drawing.points.at(-1)!;
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 2) drawing.points.push(p);
      } else drawing.points = [drawing.points[0], p];
    }
    inspectPoint(p);
  }
  function onUp() {
    if (!drawing) return;
    const m = $state.snapshot(drawing); drawing = null;
    const a = m.points[0], b = m.points.at(-1)!;
    if (m.kind !== "pen" && Math.hypot(b[0] - a[0], b[1] - a[1]) < 4) {
      if (m.kind === "box") return;
      m.points = [[a[0] - 40, a[1] + 40], a];
    }
    const [x, y] = markTargetPoint(m);
    m.anchor = anchorPathOf(elementUnder(x, y, { ignore: host, document: sourceDocument }));
    const found = m.kind === "box" ? resolveWithin(box(m), { ignore: host, document: sourceDocument }) : resolveAt(x, y, { ignore: host, document: sourceDocument });
    m.targets = m.kind === "box" ? found.map(h => h.ref) : found.length ? [found[Math.min(specificity, found.length - 1)].ref] : [];
    if (!m.targets.length) m.targets = [{ kind: "region", surface: stamp?.surface ?? "unknown", rect: m.kind === "box" ? box(m) : { x, y, w: 1, h: 1 } }];
    marks = [...marks, m];
    selected = [...selected, ...m.targets.map(ref => ({ ref, history: [], n: m.n }))];
    input?.focus({ preventScroll: true });
  }
  function undo() {
    const n = marks.at(-1)?.n; marks = marks.slice(0, -1); selected = selected.filter(s => s.n !== n);
  }
  function widen(index: number, narrow = false) {
    const item = selected[index];
    if (narrow) { const ref = item.history.at(-1); if (ref) selected[index] = { ...item, ref, history: item.history.slice(0, -1) }; }
    else { const ref = widenTarget(item.ref); if (ref) selected[index] = { ...item, ref, history: [...item.history, item.ref] }; }
  }
  function cycleRoute(direction = 1) {
    const i = routeOptions.findIndex(r => JSON.stringify(r) === JSON.stringify(route));
    rememberRoute(routeOptions[(i + direction + routeOptions.length) % routeOptions.length]);
    // A deliberate pill choice supersedes mentions already parsed in the text.
    if (parsed.route) text = parsed.text;
  }
  function chooseRoute(r: Route) { rememberRoute(r); if (parsed.route) text = parsed.text; routeOpen = false; input?.focus(); }
  function onKey(e: KeyboardEvent) {
    if (!get(annotationOpen) || !ready) return;
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeAnnotation(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const tools: Record<string, MarkKind> = { KeyA: "arrow", KeyB: "box", KeyP: "pen" };
      if (tools[e.code] || e.code === "KeyZ" || e.code === "ArrowUp" || e.code === "ArrowDown") {
        e.preventDefault(); e.stopImmediatePropagation();
        if (tools[e.code]) tool = tools[e.code];
        else if (e.code === "KeyZ") undo();
        else specificity = Math.max(0, Math.min(hover.length - 1, specificity + (e.code === "ArrowUp" ? 1 : -1)));
      }
      return;
    }
    if (e.target === input && e.key === "Tab" && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); cycleRoute(); return; }
    if (e.target === input && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); void add(); }
    if (e.target === input && e.key === "Backspace" && !text && marks.length) { e.preventDefault(); undo(); }
  }
  function wheel(e: WheelEvent) { e.preventDefault(); specificity = Math.max(0, Math.min(hover.length - 1, specificity + (e.deltaY < 0 ? 1 : -1))); }
  async function edit(item: InboxItem, owner: number) {
    if (busy) return;
    busy = true;
    try {
      const url = await annotationImage(item);
      if (owner !== generation) { if (url) URL.revokeObjectURL(url); return; }
      clearPicture(); editing = item; text = item.text; stamp = item.context; marks = [];
      const original = item.context?.snapshot?.marks ?? [];
      selected = [
        ...item.targets.filter(ref => !original.some(m => m.targets?.some(t => resolvedTargetKey(t) === resolvedTargetKey(ref)))).map(ref => ({ ref, history: [] })),
        ...original.flatMap(m => (m.targets ?? []).map(ref => ({ ref, history: [], n: m.n }))),
      ]; hover = []; rememberRoute(item.route);
      if (url) { frozen = url; }
      input?.focus();
    } catch (e) { error = String(e); }
    finally { if (owner === generation) busy = false; }
  }
  async function add() {
    if (!canAdd || !stamp) return;
    const owner = generation; busy = true; error = "";
    try {
      const savedMarks = $state.snapshot(editing?.context?.snapshot?.marks ?? marks).map(m => ({ ...m, targets: uniqueTargets(selected.filter(s => s.n === m.n).map(s => $state.snapshot(s.ref))) }));
      const context = { ...$state.snapshot(stamp), targets: uniqueTargets(selected.map(s => $state.snapshot(s.ref))) };
      let png: Uint8Array | null = null;
      if (!attach) context.snapshot = null;
      else if (editing && context.snapshot) context.snapshot = { ...context.snapshot, marks: savedMarks };
      else if (!editing) {
        const crop = snapshotCrop(savedMarks, win);
        context.snapshot = { image: null, rect: crop, window: { ...win }, marks: savedMarks };
        if (frozenImg) {
          const sourceScale = frozenImg.naturalWidth / win.w;
          const scale = savedMarks.length ? sourceScale : Math.min(sourceScale, 1600 / Math.max(crop.w, crop.h));
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(crop.w * scale)); c.height = Math.max(1, Math.round(crop.h * scale));
          const ctx = c.getContext("2d");
          if (!ctx) throw new Error("Could not compose the annotation picture");
          ctx.drawImage(frozenImg, crop.x * sourceScale, crop.y * sourceScale, crop.w * sourceScale, crop.h * sourceScale, 0, 0, c.width, c.height);
          ctx.scale(scale, scale); ctx.translate(-crop.x, -crop.y); paintMarks(ctx, savedMarks);
          const blob = await new Promise<Blob | null>(r => c.toBlob(r, "image/png"));
          if (!blob) throw new Error("Could not encode the annotation picture");
          png = new Uint8Array(await blob.arrayBuffer());
        }
      }
      if (owner !== generation) return;
      await addAnnotation(parsed.text, context, route, { replaces: editing?.id, png });
      if (owner !== generation) return;
      rememberRoute(route); resetDraft(); closeAnnotation();
    } catch (e) { if (owner === generation) error = String(e); }
    finally { if (owner === generation) busy = false; }
  }
  function paintMarks(ctx: CanvasRenderingContext2D, list: FeedbackMark[]) {
    for (const m of list) {
      const a = m.points[0], b = m.points[m.points.length - 1];
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass ? INK : "rgba(255,255,255,0.92)";
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = pass ? 3 : 6;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        if (m.kind === "box") {
          ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        } else {
          ctx.beginPath();
          m.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.stroke();
        }
        if (m.kind === "arrow") {
          ctx.beginPath();
          arrowHead(a, b).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.closePath();
          ctx.fill();
          if (!pass) ctx.stroke();
        }
      }
      const [bx, by] = markBadgePoint(m);
      ctx.beginPath();
      ctx.arc(bx, by, 11, 0, Math.PI * 2);
      ctx.fillStyle = INK;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "700 12px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(m.n), bx, by + 0.5);
    }
  }
  const pts = (m: FeedbackMark) => m.points.map((p) => p.join(",")).join(" ");
  const box = (m: FeedbackMark) => {
    const a = m.points[0], b = m.points[m.points.length - 1];
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
  };
</script>

<!-- Owns the modal keymap; the bootstrap listener handles the toggle first. -->
<svelte:window onkeydowncapture={onKey} />

{#if $annotationOpen && ready}
  <div class="annotation-surface" data-annotation-surface bind:this={host} use:fullscreenPortal use:modalFocus role="dialog" aria-modal="true" aria-label="Annotate" tabindex="-1"
    onkeydown={e => e.stopPropagation()} onclick={e => e.stopPropagation()}
    onpointerdown={e => e.stopPropagation()} onpointermove={e => e.stopPropagation()} onpointerup={e => e.stopPropagation()}
    onmousedown={e => e.stopPropagation()} onmousemove={e => e.stopPropagation()} onmouseup={e => e.stopPropagation()}>
    {#if frozen}<img class="annotation-shot" src={frozen} alt="Frozen view" draggable="false" />{/if}
    <svg class="annotation-marks" bind:this={svg} role="application" aria-label="Drag to point at something" viewBox={`0 0 ${win.w} ${win.h}`}
      onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointercancel={() => drawing = null} onwheel={wheel}>
      {#if hit}<rect class="target-outline" x={hit.bounds.x} y={hit.bounds.y} width={hit.bounds.w} height={hit.bounds.h} />{/if}
      {#each [...marks, ...(drawing ? [drawing] : [])] as m (m.n)}
        {@const badge = markBadgePoint(m)}
        <g class="mark" data-kind={m.kind} data-n={m.n}>
          {#if m.kind === "box"}{@const r = box(m)}
            <rect class="halo" x={r.x} y={r.y} width={r.w} height={r.h} /><rect class="ink" x={r.x} y={r.y} width={r.w} height={r.h} />
          {:else}<polyline class="halo" points={pts(m)} /><polyline class="ink" points={pts(m)} />{/if}
          {#if m.kind === "arrow"}<polygon class="head" points={arrowHead(m.points[0], m.points.at(-1)!).map(p => p.join(",")).join(" ")} />{/if}
          <circle class="badge" cx={badge[0]} cy={badge[1]} r="11" /><text class="badge-n" x={badge[0]} y={badge[1]}>{m.n}</text>
        </g>
      {/each}
    </svg>
    {#if hit}<div class="target-label" style:left={`${Math.max(8, Math.min(pointer.x + 14, window.innerWidth - 350))}px`} style:top={`${Math.max(8, pointer.y - 36)}px`}>{hit.label}<small>Alt ↑↓ · widen / narrow</small></div>{/if}
    <div class="annotation-tools" role="toolbar" aria-label="Annotation tools">
      <span class="eyebrow">ANNOTATE</span>
      {#each [{ id: "arrow", key: "A" }, { id: "box", key: "B" }, { id: "pen", key: "P" }] as t}
        <button class:chosen={tool === t.id} aria-pressed={tool === t.id} disabled={!!editing || staleView} onclick={() => tool = t.id as MarkKind}><kbd>Alt {t.key}</kbd>{t.id}</button>
      {/each}
      <button disabled={!marks.length} onclick={undo}><kbd>Alt Z</kbd>Undo mark</button>
    </div>
    <div class="annotation-composer">
      <div class="heading"><strong>{editing ? "Edit annotation" : "Annotate"}</strong><button aria-label="Cancel annotation" onclick={closeAnnotation}>×</button></div>
      <div class="context" title={describeStamp(stamp)}>{describeStamp(stamp)}</div>
      {#if selected.length}<div class="target-chips" aria-label="Annotation targets">
        {#each selected as s, i}
          <span class="target-chip" data-target={formatTarget(s.ref)}>{#if s.n}<b>{s.n}</b>{/if}<span title={describeTarget(s.ref)}>{describeTarget(s.ref)}</span>
            <button aria-label="Widen target" disabled={!widenTarget(s.ref)} onclick={() => widen(i)}>▾</button>
            {#if s.history.length}<button aria-label="Narrow target" onclick={() => widen(i, true)}>▴</button>{/if}
            <button aria-label="Remove target" onclick={() => selected = selected.filter((_, j) => j !== i)}>×</button>
          </span>
        {/each}
      </div>{/if}
      <textarea bind:this={input} bind:value={text} aria-label="Annotation note" rows="3" placeholder="What should change? #tags · @agent" spellcheck="true"></textarea>
      {#if tags.length}<div class="tags">{#each tags as tag}<span>#{tag}</span>{/each}</div>{/if}
      <div class="routing">
        <button class="to-pill" aria-expanded={routeOpen} onclick={() => routeOpen = !routeOpen} title="Tab in the note cycles recipients">To: <b>{describeRoute(route)}</b> ▾</button>
        {#if typeof route === "object" && "session" in route && !$sessions.some(s => s.id === route.session.id && s.watching)}<small class="muted">queued until it watches</small>{/if}
        {#if routeOpen}<RecipientList choose={chooseRoute} />{/if}
      </div>
      {#if staleView && !editing}<p class="hint">Your draft keeps its earlier view. To draw on the current view, <button onclick={() => { if ($annotationRequest) void openSurface($annotationRequest, true); }}>Refresh view (clears marks)</button>.</p>{/if}
      {#if editing}<p class="hint">Editing the saved annotation; its original picture is preserved.</p>{/if}
      {#if background}<p class="hint">Background agents are not available yet. Choose Inbox or a connected agent.</p>{/if}
      {#if error}<p role="alert">{error} Your draft is retained.</p>{/if}
      {#if !$currentProject?.path}<p class="hint">Demo project — annotations are not saved</p>{/if}
      {#if !frozen && attach}<p class="hint">Screenshot unavailable — your targets and marks will still be saved.</p>{/if}
      <div class="actions">
        <label><input type="checkbox" checked={attach} disabled={hasMarks} onchange={e => settings.update(s => ({ ...s, "annotate.attachView": e.currentTarget.checked }))} />Attach view</label>
        <span></span><button onclick={closeAnnotation}>Cancel <kbd>Esc</kbd></button><button class="primary" disabled={!canAdd} onclick={() => void add()}>{busy ? "Saving…" : "Add"} <kbd>Enter</kbd></button>
      </div>
      <div class="inbox-link"><button onclick={() => { closeAnnotation(); requestInbox(); }}>Open inbox ↗</button></div>
      <small class="hint">Drag to point · Shift Enter for a new line · Tab changes To:</small>
    </div>
  </div>
{/if}

<style>
  .annotation-surface { position: fixed; inset: 0; z-index: 2000; user-select: none; cursor: var(--cursor-cross); }
  .annotation-shot, .annotation-marks { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .annotation-shot { pointer-events: none; background: var(--c-bg); }
  .annotation-marks { touch-action: none; }
  .target-outline { fill: color-mix(in srgb, var(--c-accent) 8%, transparent); stroke: var(--c-accent); stroke-width: 2; vector-effect: non-scaling-stroke; pointer-events: none; }
  .mark { pointer-events: none; }
  .halo, .ink { fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .halo { stroke: #fff; stroke-width: 6; }
  .ink { stroke: #ff2bd6; stroke-width: 3; }
  .head, .badge { fill: #ff2bd6; stroke: #fff; stroke-width: 2; }
  .badge-n { fill: #fff; font: 700 12px var(--font-ui); text-anchor: middle; dominant-baseline: central; }
  .annotation-tools, .annotation-composer, .target-label { background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-panel); box-shadow: var(--elev-3); color: var(--c-tx); }
  .annotation-tools { position: absolute; top: 12px; left: 12px; display: flex; gap: 6px; align-items: center; padding: 6px 8px; }
  .eyebrow { font: 600 10px var(--font-mono); letter-spacing: .08em; color: var(--c-tx-muted); margin-right: 8px; }
  .annotation-composer { position: absolute; bottom: 16px; right: 16px; width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 82px); overflow: auto; display: flex; flex-direction: column; gap: 9px; padding: 12px; box-sizing: border-box; user-select: text; }
  .heading, .actions, .routing { display: flex; align-items: center; gap: 8px; }
  .heading strong { flex: 1; font: 18px var(--font-serif); }
  .context { color: var(--c-tx-muted); font: 10px/1.5 var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  textarea { box-sizing: border-box; width: 100%; min-height: 84px; resize: vertical; padding: 8px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: var(--c-bg); color: var(--c-tx); font: 14px/1.5 var(--font-ui); outline: none; }
  textarea:focus { border-color: var(--c-accent); }
  button { font: 12px var(--font-ui); color: var(--c-tx); background: transparent; border: 1px solid transparent; border-radius: var(--r-ui); padding: 4px 7px; cursor: var(--cursor-cross-hover); }
  button:hover:not(:disabled), button:focus-visible { border-color: var(--c-accent); outline: none; }
  button:disabled { opacity: .4; cursor: var(--cursor-cross); }
  button.chosen, .chosen { background: var(--c-accent-tint); box-shadow: inset 2px 0 var(--c-accent); }
  kbd { font: 10px var(--font-mono); color: var(--c-tx-muted); margin: 0 5px; }
  .actions > span { flex: 1; }
  .actions label { font: 12px var(--font-ui); display: flex; align-items: center; gap: 5px; }
  .primary { border-color: var(--c-accent); color: var(--c-accent); background: var(--c-accent-tint); }
  .hint, .muted { font: 11px/1.5 var(--font-ui); color: var(--c-tx-muted); margin: 0; }
  p[role="alert"] { font: 12px var(--font-ui); color: var(--c-danger); margin: 0; }
  .target-label { position: fixed; max-width: 330px; padding: 6px 9px; font: 12px var(--font-ui); pointer-events: none; }
  .target-label small { display: block; font: 10px var(--font-mono); color: var(--c-tx-muted); margin-top: 3px; }
  .target-chips, .tags { display: flex; flex-wrap: wrap; gap: 4px; max-height: 110px; overflow: auto; }
  .target-chip { display: inline-flex; align-items: center; max-width: 100%; background: var(--c-accent-tint); border: 1px solid var(--c-line); border-radius: var(--r-ui); font: 11px var(--font-ui); }
  .target-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 6px; }
  .target-chip b { background: #ff2bd6; color: #fff; padding: 3px 5px; }
  .target-chip button { padding: 2px 4px; }
  .tags span { color: var(--c-accent); background: var(--c-accent-tint); font: 10px var(--font-mono); padding: 3px 5px; border-radius: var(--r-ui); }
  .routing { flex-wrap: wrap; }
  .to-pill { border-color: var(--c-line-strong); }
  .inbox-link { border-top: 1px solid var(--c-line); padding-top: 5px; }

  @media (max-width: 650px) { .annotation-tools { gap: 0; } .eyebrow { display: none; } .annotation-tools kbd { display: none; } }
</style>

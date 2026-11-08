<script lang="ts">
  // Annotate — point at anything on a frozen view, say what should change, send it
  // to the Inbox or an agent. The surface is a still of the window (the frame and
  // the "frozen view" capsule say so), with a drawing layer whose hover names the
  // thing under the pointer; the composer at the bottom-right is one framed
  // composer with the recipient, the attached-view toggle and Add in its bar.
  // Chips name targets in words (ids in their tooltips); hovering a numbered chip
  // lights up its mark on the still. The drawing geometry is untouched: the
  // screenshot and the SVG map pointer coordinates through the SVG's CTM.
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
  import { describeTarget, formatTarget, shortTarget, targetPrompt, resolvedTargetKey, widenTarget, uniqueTargets, type TargetRef } from "../../lib/project/targets";
  import { resolveAt, resolveWithin, elementUnder, type TargetHit } from "../../lib/bridge/targetResolvers";
  import { anchorPathOf, arrowHead, markBadgePoint, markTargetPoint, snapshotCrop, type FeedbackMark, type MarkKind } from "../../lib/project/annotationCapture";
  import { pushToast } from "../../lib/toast";

  import RecipientList from "./RecipientList.svelte";
  import AgentMark from "./AgentMark.svelte";
  import { recipientOptions } from "../../lib/project/agentRouting";
  import { backgroundAvailable } from "./backgroundAvailability";

  initAnnotationStore();
  const INK_FALLBACK = "#ff2bd6";
  const ink = () => (typeof getComputedStyle === "function" && getComputedStyle(document.documentElement).getPropertyValue("--c-ink-mark").trim()) || INK_FALLBACK;
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
  let litMark = $state<number | null>(null);
  let hoverHints = $state(0);
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
  const canAdd = $derived(ready && !busy && !!$currentProject?.path && !!parsed.text && (!background || $backgroundAvailable));
  const routeSession = $derived(typeof route === "object" && "session" in route ? $sessions.find(s => s.id === route.session.id) : null);
  const placeholder = $derived(targetPrompt(stamp?.targets, "What should change about").replace(/…$/, "?") + " #tags · @agent");
  const routeName = $derived(describeRoute(route));
  const whereHuman = $derived(stamp?.targets?.[0] ? `${stamp.surface} · ${shortTarget(stamp.targets[0])}${(stamp.targets.length ?? 0) > 1 ? ` +${stamp.targets.length - 1}` : ""}` : stamp?.activeFigureName ? `${stamp.surface} · figure “${stamp.activeFigureName}”` : stamp?.doc?.path ? `${stamp.surface} · ${stamp.doc.path.split("/").pop()}` : stamp ? `${stamp.surface} view` : "");

  function clearPicture() { if (frozen) URL.revokeObjectURL(frozen); frozen = null; frozenImg = null; }
  function resetDraft() {
    text = ""; stamp = null; marks = []; selected = []; editing = null; error = ""; drawing = null; litMark = null; clearPicture();
  }
  $effect(() => {
    const g = $projectGeneration;
    untrack(() => { if (g !== seenProject) { seenProject = g; generation++; resetDraft(); ready = false; busy = false; } });
  });
  $effect(() => {
    const open = $annotationOpen, req = $annotationRequest;
    untrack(() => {
      if (open && req) void openSurface(req);
      else { generation++; ready = false; drawing = null; hover = []; routeOpen = false; litMark = null; }
    });
  });
  onDestroy(() => { generation++; clearPicture(); });

  async function openSurface(req: AnnotationRequest, refresh = false) {
    const owner = ++generation;
    // "To: New background agent" / @new need the installed CLIs; the probe is cached and async.
    void import("../inbox/backgroundStore").then(m => m.refreshBackgroundCapabilities());
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
    else { specificity = 0; if (next[0] && !hover[0]) hoverHints++; }
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
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); if (routeOpen) { routeOpen = false; input?.focus(); return; } closeAnnotation(); return; }
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
      const destination = describeRoute(route), wasEdit = !!editing;
      await addAnnotation(parsed.text, context, route, { replaces: editing?.id, png });
      if (owner !== generation) return;
      rememberRoute(route); resetDraft(); closeAnnotation();
      if (get(currentProject)?.path) pushToast("success", wasEdit ? "Annotation updated" : background ? `${destination.replace(/^New /, "")} is starting on it` : destination === "Inbox" ? "Added to Inbox" : `Sent to ${destination}`, { action: { label: "Open", run: () => requestInbox() } });
    } catch (e) { if (owner === generation) error = String(e); }
    finally { if (owner === generation) busy = false; }
  }
  function paintMarks(ctx: CanvasRenderingContext2D, list: FeedbackMark[]) {
    const INK = ink();
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
  const kindGlyph = (k: TargetRef["kind"]) => k === "passage" || k === "doc" ? "❝" : k === "slide" || k === "beat" || k === "track" ? "▭" : k === "region" ? "⌗" : "◫";
</script>

<!-- Owns the modal keymap; the bootstrap listener handles the toggle first. -->
<svelte:window onkeydowncapture={onKey} />

{#if $annotationOpen && ready}
  <div class="annotation-surface agent-surface" data-annotation-surface bind:this={host} use:fullscreenPortal use:modalFocus role="dialog" aria-modal="true" aria-label="Annotate" tabindex="-1"
    onkeydown={e => e.stopPropagation()} onclick={e => e.stopPropagation()}
    onpointerdown={e => e.stopPropagation()} onpointermove={e => e.stopPropagation()} onpointerup={e => e.stopPropagation()}
    onmousedown={e => e.stopPropagation()} onmousemove={e => e.stopPropagation()} onmouseup={e => e.stopPropagation()}>
    {#if frozen}<img class="annotation-shot" src={frozen} alt="Frozen view" draggable="false" />{/if}
    <div class="annotation-frame" aria-hidden="true"></div>
    <svg class="annotation-marks" class:lit={litMark !== null} bind:this={svg} role="application" aria-label="Drag to point at something" viewBox={`0 0 ${win.w} ${win.h}`}
      onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointercancel={() => drawing = null} onwheel={wheel}>
      {#if hit}<rect class="target-outline" x={hit.bounds.x} y={hit.bounds.y} width={hit.bounds.w} height={hit.bounds.h} />{/if}
      {#each [...marks, ...(drawing ? [drawing] : [])] as m (m.n)}
        {@const badge = markBadgePoint(m)}
        <g class="mark" class:dim={litMark !== null && litMark !== m.n} class:lift={litMark === m.n} data-kind={m.kind} data-n={m.n}>
          {#if m.kind === "box"}{@const r = box(m)}
            <rect class="halo" x={r.x} y={r.y} width={r.w} height={r.h} /><rect class="ink" x={r.x} y={r.y} width={r.w} height={r.h} />
          {:else}<polyline class="halo" points={pts(m)} /><polyline class="ink" points={pts(m)} />{/if}
          {#if m.kind === "arrow"}<polygon class="head" points={arrowHead(m.points[0], m.points.at(-1)!).map(p => p.join(",")).join(" ")} />{/if}
          <g class="badge-g" style={`transform-origin:${badge[0]}px ${badge[1]}px`}><circle class="badge" cx={badge[0]} cy={badge[1]} r="11" /><text class="badge-n" x={badge[0]} y={badge[1]}>{m.n}</text></g>
        </g>
      {/each}
    </svg>
    {#if hit}<div class="target-label" style:transform={`translate(${Math.max(8, Math.min(pointer.x + 14, window.innerWidth - 350))}px, ${Math.max(8, pointer.y - 36)}px)`}><span class="glyph" aria-hidden="true">{kindGlyph(hit.ref.kind)}</span>{hit.label}{#if hoverHints <= 3}<small>Alt ↑↓ · widen / narrow</small>{/if}</div>{/if}
    <div class="annotation-tools" role="toolbar" aria-label="Annotation tools">
      <span class="eyebrow">ANNOTATE</span>
      <span class="seg">
        {#each [{ id: "arrow", key: "A", glyph: "↗" }, { id: "box", key: "B", glyph: "▢" }, { id: "pen", key: "P", glyph: "✎" }] as t}
          <button class:chosen={tool === t.id} aria-pressed={tool === t.id} disabled={!!editing || staleView} title={`Alt ${t.key}`} onclick={() => tool = t.id as MarkKind}><span class="glyph" aria-hidden="true">{t.glyph}</span>{t.id}<kbd>{t.key}</kbd></button>
        {/each}
      </span>
      <span class="vsep"></span>
      <button class="undo" disabled={!marks.length} title="Alt Z" onclick={undo}>Undo mark<kbd>Z</kbd></button>
      <span class="vsep"></span>
      <span class="frozen-note">{staleView ? "earlier view" : "view frozen"}{#if editing} · editing{/if}</span>
    </div>
    <div class="annotation-composer">
      <div class="heading surface-head">
        <strong class="ttl">{editing ? "Edit annotation" : "Annotate"}</strong>
        <span class="vsep"></span>
        <span class="ctx" title={describeStamp(stamp)}>{whereHuman}</span>
        <span class="context sr" aria-hidden="true">{describeStamp(stamp)}</span>
        <button class="xbtn" aria-label="Cancel annotation" title="Cancel · Esc" onclick={closeAnnotation}></button>
      </div>
      <div class="body">
        {#if selected.length}<div class="target-chips" aria-label="Annotation targets">
          {#each selected as s, i}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span class="target-chip" class:numbered={!!s.n} data-target={formatTarget(s.ref)} data-kind={s.ref.kind} title={describeTarget(s.ref)}
              onmouseenter={() => { if (s.n) litMark = s.n; }} onmouseleave={() => { if (litMark === s.n) litMark = null; }}>
              {#if s.n}<b>{s.n}</b>{:else}<span class="glyph" aria-hidden="true">{kindGlyph(s.ref.kind)}</span>{/if}<span class="label">{shortTarget(s.ref)}</span>
              <span class="chip-acts">
                <button aria-label="Widen target" title="Widen (Alt ↑)" disabled={!widenTarget(s.ref)} onclick={() => widen(i)}>▾</button>
                {#if s.history.length}<button aria-label="Narrow target" title="Narrow" onclick={() => widen(i, true)}>▴</button>{/if}
                <button aria-label="Remove target" title="Remove" onclick={() => selected = selected.filter((_, j) => j !== i)}>×</button>
              </span>
            </span>
          {/each}
        </div>{/if}
        <div class="flux-composer">
          <textarea bind:this={input} bind:value={text} aria-label="Annotation note" rows="3" {placeholder} spellcheck="true"></textarea>
          {#if tags.length}<div class="tags">{#each tags as tag}<span>#{tag}</span>{/each}</div>{/if}
          <div class="composer-bar actions">
            <span class="routing">
              <button class="to-pill" aria-expanded={routeOpen} onclick={() => routeOpen = !routeOpen} title="Tab in the note cycles recipients">{#if routeSession}<AgentMark size={11} seed={routeSession.name} state={routeSession.watching ? "working" : "idle"} />{/if}To: <b>{routeName}</b> ▾</button>
              {#if routeSession && !routeSession.watching}<span class="muted">queued until it watches</span>{:else if routeSession?.watching}<span class="muted live">watching</span>{/if}
            </span>
            <span class="grow"></span>
            <label class="attach" title={hasMarks ? "Marks always carry the view" : "Send the frozen view with the note"}><input type="checkbox" checked={attach} disabled={hasMarks} onchange={e => settings.update(s => ({ ...s, "annotate.attachView": e.currentTarget.checked }))} /><span class="switch" aria-hidden="true"></span>Attach view</label>
            <button class="primary" disabled={!canAdd} onclick={() => void add()}>{busy ? "Saving…" : "Add"} <kbd>Enter</kbd></button>
          </div>
        </div>
        {#if routeOpen}<div class="routes-pop arrive"><RecipientList choose={chooseRoute} /></div>{/if}
        {#if staleView && !editing}<p class="hint">Your draft keeps its earlier view. To draw on the current view, <button onclick={() => { if ($annotationRequest) void openSurface($annotationRequest, true); }}>Refresh view (clears marks)</button>.</p>{/if}
        {#if editing}<p class="hint">Editing the saved annotation; its original picture is preserved.</p>{/if}
        {#if background && !$backgroundAvailable}<p class="hint">No background agent is available: install and sign in to Claude Code or Codex (AI status). Choose Inbox or a connected agent.</p>{/if}
        {#if error}<p role="alert">{error} Your draft is retained.</p>{/if}
        {#if !$currentProject?.path}<p class="hint">Demo project — annotations are not saved</p>{/if}
        {#if !frozen && attach}<p class="hint">Screenshot unavailable — your targets and marks will still be saved.</p>{/if}
        <div class="foot"><small class="hint">Drag to point · <kbd>Shift</kbd><kbd>Enter</kbd> new line · <kbd>Tab</kbd> To: · <kbd>Esc</kbd> keeps draft</small><span class="inbox-link"><button onclick={() => { closeAnnotation(); requestInbox(); }}>Open inbox ↗</button></span></div>
      </div>
    </div>
  </div>
{/if}

<style>
  .annotation-surface { position: fixed; inset: 0; z-index: 2000; user-select: none; cursor: var(--cursor-cross); animation: flux-arrive var(--dur-fade) both; }
  .annotation-shot, .annotation-marks { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .annotation-shot { pointer-events: none; background: var(--c-bg); }
  .annotation-marks { touch-action: none; }
  /* The "frozen view" signal: one inner hairline and a soft vignette, painted once, never animated. */
  .annotation-frame { position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 1.5px var(--c-accent), inset 0 0 90px rgba(0, 0, 0, 0.22); }
  .target-outline { fill: color-mix(in srgb, var(--c-accent) 8%, transparent); stroke: var(--c-accent); stroke-width: 2; vector-effect: non-scaling-stroke; pointer-events: none; }
  .mark { pointer-events: none; transition: opacity var(--dur-fade); }
  .mark.dim { opacity: .3; }
  .badge-g { transform-box: view-box; transition: transform var(--dur-instant) var(--ease-enter); }
  .mark.lift .badge-g { transform: scale(1.18); }
  .halo, .ink { fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .halo { stroke: var(--c-ink-halo); stroke-width: 6; }
  .ink { stroke: var(--c-ink-mark); stroke-width: 3; }
  .head, .badge { fill: var(--c-ink-mark); stroke: #fff; stroke-width: 2; }
  .badge-n { fill: #fff; font: 700 12px var(--font-ui); text-anchor: middle; dominant-baseline: central; }
  .annotation-tools, .annotation-composer, .target-label { background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-1); box-shadow: var(--elev-3); color: var(--c-tx); }
  .annotation-tools { position: absolute; top: 12px; left: 50%; translate: -50% 0; display: flex; gap: 8px; align-items: center; height: 34px; padding: 0 10px 0 12px; border-radius: var(--r-pill); font: var(--ts-xs) var(--font-ui); }
  .eyebrow { font: 600 10px var(--font-mono); letter-spacing: .1em; color: var(--c-tx-muted); }
  .vsep { width: 1px; height: 14px; background: var(--c-line-strong); flex-shrink: 0; }
  .seg { display: inline-flex; gap: 2px; padding: 2px; background: var(--c-bg); border-radius: var(--r-pill); }
  .seg button { height: 22px; padding: 0 9px 0 7px; border-radius: var(--r-pill); display: inline-flex; align-items: center; gap: 5px; }
  .seg .glyph { font-size: 11px; opacity: .8; }
  .annotation-tools button { font: var(--ts-xs) var(--font-ui); color: var(--c-tx-2); background: transparent; border: 1px solid transparent; border-radius: var(--r-ui); padding: 3px 7px; cursor: var(--cursor-cross-hover); }
  .annotation-tools button:hover:not(:disabled) { color: var(--c-tx); background: var(--c-ui-hover); }
  .annotation-tools button:disabled { opacity: .4; cursor: var(--cursor-cross); }
  .annotation-tools button.chosen { background: var(--c-accent); color: var(--c-on-accent); }
  .annotation-tools button.chosen kbd { color: var(--c-on-accent); border-color: color-mix(in srgb, var(--c-on-accent) 45%, transparent); opacity: .85; }
  .annotation-tools kbd { margin-left: 2px; }
  .frozen-note { color: var(--c-tx-muted); font: var(--ts-xs) var(--font-ui); white-space: nowrap; }
  .annotation-composer { position: absolute; bottom: 16px; right: 16px; width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 82px); display: flex; flex-direction: column; box-sizing: border-box; user-select: text; overflow: hidden; animation: composer-enter var(--dur-instant) var(--ease-enter) both; transform-origin: right bottom; }
  @keyframes composer-enter { from { opacity: 0; transform: scale(.985); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .annotation-composer { animation-name: flux-arrive; } }
  .heading .ctx { font: var(--ts-xs) var(--font-ui); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .body { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 10px; overflow: auto; min-height: 0; }
  .flux-composer textarea { min-height: calc(3 * 1.5em + 15px); }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 11px 2px; }
  .tags span { color: var(--c-accent); background: var(--c-accent-tint); font: 10px var(--font-mono); padding: 2px 5px; border-radius: var(--r-ui); }
  .actions { flex-wrap: wrap; row-gap: 4px; }
  .routing { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .to-pill { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border: 1px solid var(--c-line-strong) !important; border-radius: var(--r-pill) !important; color: var(--c-tx-2); font: var(--ts-xs) var(--font-ui); background: transparent; cursor: var(--cursor-cross-hover); }
  .to-pill b { color: var(--c-tx); font-weight: 600; }
  .muted { font: 10.5px var(--font-ui); color: var(--c-tx-muted); white-space: nowrap; }
  .muted.live { color: var(--c-accent); }
  .grow { flex: 1; }
  .attach { position: relative; display: inline-flex; align-items: center; gap: 6px; font: var(--ts-xs) var(--font-ui); color: var(--c-tx-2); cursor: var(--cursor-cross-hover); white-space: nowrap; }
  /* The real checkbox sits invisibly over the switch so clicks, keys and gates hit it. */
  .attach input { position: absolute; left: 0; top: 50%; translate: 0 -50%; width: 26px; height: 15px; margin: 0; opacity: 0; cursor: inherit; }
  .switch { width: 26px; height: 15px; border-radius: var(--r-pill); background: var(--c-ui-active); position: relative; transition: background var(--dur-fade); flex-shrink: 0; }
  .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: var(--c-tx-hi); transition: translate var(--dur-instant) var(--ease-standard); }
  .attach input:checked + .switch { background: var(--c-accent); }
  .attach input:checked + .switch::after { translate: 11px 0; }
  .attach input:disabled + .switch { opacity: .55; }
  .attach input:focus-visible + .switch { outline: 2px solid var(--c-accent); outline-offset: 2px; }
  .primary { color: var(--c-on-accent) !important; background: var(--c-accent) !important; border-color: var(--c-accent) !important; }
  .primary kbd { color: var(--c-on-accent); border-color: color-mix(in srgb, var(--c-on-accent) 45%, transparent); }
  .routes-pop { border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); overflow: hidden; }
  .routes-pop :global(.routes) { border: 0; }
  .hint, .muted { font: 11px/1.5 var(--font-ui); color: var(--c-tx-muted); margin: 0; }
  .hint button { background: none; border: 0; padding: 0; color: var(--c-accent); font: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: var(--cursor-cross-hover); }
  p[role="alert"] { font: 12px var(--font-ui); color: var(--c-danger); margin: 0; }
  .target-label { position: fixed; left: 0; top: 0; max-width: 330px; padding: 6px 9px; font: 12px var(--font-ui); pointer-events: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; will-change: transform; }
  .target-label .glyph { color: var(--c-tx-muted); font-size: 11px; }
  .target-label small { flex-basis: 100%; font: 10px var(--font-mono); color: var(--c-tx-muted); margin-top: 1px; }
  .target-chips { display: flex; flex-wrap: wrap; gap: 4px; max-height: 110px; overflow: auto; }
  .target-chip { display: inline-flex; align-items: center; gap: 0; max-width: 100%; height: 24px; background: var(--c-surface-2); border: 1px solid var(--c-line); border-radius: var(--r-pill); font: var(--ts-xs) var(--font-ui); color: var(--c-tx-2); padding-right: 4px; transition: border-color var(--dur-fade), background var(--dur-fade); }
  .target-chip:hover { border-color: var(--c-line-strong); color: var(--c-tx); }
  .target-chip.numbered:hover { border-color: var(--c-ink-mark); }
  .target-chip .glyph { padding: 0 2px 0 8px; color: var(--c-tx-muted); font-size: 11px; }
  .target-chip .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px 0 6px; }
  .target-chip b { display: inline-grid; place-items: center; width: 16px; height: 16px; margin-left: 3px; border-radius: 50%; background: var(--c-ink-mark); color: #fff; font: 700 10px var(--font-ui); flex-shrink: 0; }
  .chip-acts { display: inline-flex; opacity: 0; transition: opacity var(--dur-fade); }
  .target-chip:hover .chip-acts, .target-chip:focus-within .chip-acts { opacity: 1; }
  .chip-acts button { width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--c-tx-muted); font: 11px var(--font-ui); cursor: var(--cursor-cross-hover); }
  .chip-acts button:hover:not(:disabled) { background: var(--c-ui-hover); color: var(--c-tx); }
  .chip-acts button:disabled { opacity: .3; }
  .foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--c-line); padding-top: 7px; }
  .foot .hint { font-size: 10.5px; }
  .foot kbd { margin: 0 1px; }
  .inbox-link button { background: none; border: 0; padding: 0; color: var(--c-tx-muted); font: var(--ts-xs) var(--font-ui); cursor: var(--cursor-cross-hover); white-space: nowrap; }
  .inbox-link button:hover { color: var(--c-tx); }

  @media (max-width: 650px) { .eyebrow, .frozen-note { display: none; } .annotation-tools kbd { display: none; } }
</style>

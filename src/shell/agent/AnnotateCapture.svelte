<script lang="ts">
  // "Snapshot & annotate" (Ctrl+Shift+S, the palette, or the button in Note to
  // agent): freeze the window, draw numbered arrows / boxes / pen strokes on it,
  // Enter → the note popover with the crop attached. The crop is composed from
  // the FROZEN capture, never from the live DOM, so the tool strip is never in
  // the picture; each mark remembers the element under its tip
  // (feedbackCapture.anchorPathOf) so the agent reads `1 → button.tool "Gallery"`
  // beside the image. A browser build has no window capture: marks and anchors
  // are still recorded and the note says so (image stays null).
  import { annotateCaptureOpen, feedbackCaptureOpen } from "../command/commandBus";
  import { setPendingSnapshot } from "./feedbackStore";
  import { fileBridge } from "../../lib/project/types";
  import {
    anchorPathOf,
    arrowHead,
    markBadgePoint,
    markTargetPoint,
    snapshotCrop,
    type FeedbackMark,
    type MarkKind,
  } from "../../lib/project/feedbackCapture";

  const INK = "#ff2bd6";
  let tool = $state<MarkKind>("arrow");
  let marks = $state<FeedbackMark[]>([]);
  let draft = $state<FeedbackMark | null>(null);
  let frozen = $state<string | null>(null); // object URL of the window capture
  let frozenImg: HTMLImageElement | null = null;
  let scale = 1; // device px per CSS px in the capture
  let ready = $state(false);
  let busy = $state(false);
  let host = $state<HTMLDivElement | undefined>(undefined);
  let win = $state({ w: 0, h: 0, dpr: 1 });

  $effect(() => {
    if ($annotateCaptureOpen) void open();
    else reset();
  });

  async function open() {
    win = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
    marks = [];
    draft = null;
    tool = "arrow";
    const fb = fileBridge();
    if (fb?.captureWindow) {
      try {
        const shot = await fb.captureWindow();
        const bytes = new Uint8Array(shot.png.byteLength); // a plain ArrayBuffer-backed copy for Blob
        bytes.set(shot.png);
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        const img = new Image();
        img.src = url;
        await img.decode();
        frozenImg = img;
        frozen = url;
        scale = img.naturalWidth / Math.max(1, win.w);
      } catch {
        frozen = null;
        frozenImg = null;
      }
    }
    ready = true;
  }
  function reset() {
    ready = false;
    marks = [];
    draft = null;
    busy = false;
    if (frozen) URL.revokeObjectURL(frozen);
    frozen = null;
    frozenImg = null;
  }
  function cancel() {
    annotateCaptureOpen.set(false);
  }

  // --- drawing -------------------------------------------------------------------
  const pt = (e: PointerEvent): [number, number] => [Math.round(e.clientX), Math.round(e.clientY)];
  function onDown(e: PointerEvent) {
    if (e.button !== 0 || busy) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = pt(e);
    draft = { kind: tool, n: marks.length + 1, points: tool === "pen" ? [p] : [p, p] };
  }
  function onMove(e: PointerEvent) {
    if (!draft) return;
    const p = pt(e);
    draft.points = draft.kind === "pen" ? [...draft.points, p] : [draft.points[0], p];
  }
  function onUp() {
    if (!draft) return;
    const m = draft;
    draft = null;
    const [x0, y0] = m.points[0];
    const [x1, y1] = m.points[m.points.length - 1];
    if (m.kind !== "pen" && Math.hypot(x1 - x0, y1 - y0) < 4) {
      if (m.kind === "box") return; // a click draws no box
      m.points = [[x0 - 40, y0 + 40], [x0, y0]]; // a click = a short arrow AT the click
    }
    const [tx, ty] = markTargetPoint(m);
    m.anchor = anchorPathOf(elementUnder(tx, ty));
    marks = [...marks, m];
  }
  function elementUnder(x: number, y: number): Element | null {
    return document.elementsFromPoint(x, y).find((el) => !(host && host.contains(el))) ?? null;
  }
  function undo() {
    marks = marks.slice(0, -1);
  }

  function onKey(e: KeyboardEvent) {
    if (!$annotateCaptureOpen) return;
    const k = e.key;
    if (k === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); cancel(); return; }
    if (k === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); void finish(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return; // chords (Ctrl+Shift+S toggles) stay with the workspace
    if (k === "Backspace" || k === "Delete") { e.preventDefault(); e.stopImmediatePropagation(); undo(); return; }
    const lk = k.toLowerCase();
    if (lk === "a" || lk === "b" || lk === "p") {
      e.preventDefault();
      e.stopImmediatePropagation();
      tool = lk === "a" ? "arrow" : lk === "b" ? "box" : "pen";
    }
  }

  // --- finish: compose the crop, hand it to the note popover -------------------------
  async function finish() {
    if (busy) return;
    busy = true;
    try {
      const crop = snapshotCrop(marks, win);
      let png: Uint8Array | null = null;
      let preview: string | null = null;
      if (frozenImg) {
        const s = scale;
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(crop.w * s));
        c.height = Math.max(1, Math.round(crop.h * s));
        const ctx = c.getContext("2d");
        if (ctx) {
          ctx.drawImage(frozenImg, crop.x * s, crop.y * s, crop.w * s, crop.h * s, 0, 0, c.width, c.height);
          ctx.save();
          ctx.scale(s, s);
          ctx.translate(-crop.x, -crop.y);
          paintMarks(ctx, marks);
          ctx.restore();
          const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
          if (blob) png = new Uint8Array(await blob.arrayBuffer());
          preview = thumbnail(c);
        }
      }
      setPendingSnapshot({
        info: {
          image: null,
          rect: crop,
          window: { ...win },
          marks: marks.map((m) => ({ ...m, points: m.points.map((p) => [p[0], p[1]] as [number, number]) })),
        },
        png,
        preview,
      });
      annotateCaptureOpen.set(false);
      feedbackCaptureOpen.set(true);
    } finally {
      busy = false;
    }
  }
  /** The popover preview: the composed crop itself, capped at 1600 px wide so a
   *  full-window snapshot on a 2× screen stays a few hundred KB in memory. */
  function thumbnail(c: HTMLCanvasElement): string {
    const cap = 1600;
    if (c.width <= cap) return c.toDataURL("image/png");
    const tw = cap;
    const th = Math.max(1, Math.round((c.height / c.width) * tw));
    const t = document.createElement("canvas");
    t.width = tw;
    t.height = th;
    t.getContext("2d")?.drawImage(c, 0, 0, tw, th);
    return t.toDataURL("image/png");
  }
  /** The same marks the SVG shows, painted into the PNG (halo pass, then ink). */
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

<svelte:window onkeydowncapture={onKey} />

{#if $annotateCaptureOpen && ready}
  <div class="annot" class:frozen={!!frozen} bind:this={host} role="dialog" aria-label="Snapshot & annotate">
    {#if frozen}<img class="annot-shot" src={frozen} alt="" draggable="false" />{/if}
    <svg
      class="annot-marks"
      role="application"
      aria-label="Drawing surface: drag to draw the current tool"
      width={win.w}
      height={win.h}
      viewBox={`0 0 ${win.w} ${win.h}`}
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerup={onUp}
      onpointercancel={onUp}
    >
      {#each [...marks, ...(draft ? [draft] : [])] as m (m.n)}
        {@const badge = markBadgePoint(m)}
        <g class="mark" data-kind={m.kind} data-n={m.n}>
          {#if m.kind === "box"}
            {@const r = box(m)}
            <rect class="halo" x={r.x} y={r.y} width={r.w} height={r.h} />
            <rect class="ink" x={r.x} y={r.y} width={r.w} height={r.h} />
          {:else}
            <polyline class="halo" points={pts(m)} />
            <polyline class="ink" points={pts(m)} />
          {/if}
          {#if m.kind === "arrow"}
            <polygon class="head" points={arrowHead(m.points[0], m.points[m.points.length - 1]).map((p) => p.join(",")).join(" ")} />
          {/if}
          <circle class="badge" cx={badge[0]} cy={badge[1]} r="11" />
          <text class="badge-n" x={badge[0]} y={badge[1]}>{m.n}</text>
        </g>
      {/each}
    </svg>
    <div class="annot-tools" role="toolbar" aria-label="Annotation tools">
      <span class="ttl">ANNOTATE</span>
      <button class:on={tool === "arrow"} onclick={() => (tool = "arrow")}><kbd>a</kbd>arrow</button>
      <button class:on={tool === "box"} onclick={() => (tool = "box")}><kbd>b</kbd>box</button>
      <button class:on={tool === "pen"} onclick={() => (tool = "pen")}><kbd>p</kbd>pen</button>
      <span class="sep"></span>
      <button disabled={!marks.length} onclick={undo}><kbd>⌫</kbd>undo</button>
      <span class="hint">{frozen ? "window frozen" : "no screenshot in the browser build"} · drag to draw · the numbers go in your note</span>
      <button onclick={cancel}><kbd>esc</kbd>cancel</button>
      <button class="primary" disabled={busy} onclick={() => void finish()}>
        <kbd>⏎</kbd>{marks.length ? `note with ${marks.length} mark${marks.length === 1 ? "" : "s"}` : "note with snapshot"}
      </button>
    </div>
  </div>
{/if}

<style>
  .annot {
    position: fixed;
    inset: 0;
    z-index: 150;
    cursor: crosshair;
    user-select: none;
  }
  .annot-shot {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .annot-marks {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    touch-action: none;
  }
  .mark .halo {
    fill: none;
    stroke: rgba(255, 255, 255, 0.92);
    stroke-width: 6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .mark .ink {
    fill: none;
    stroke: #ff2bd6;
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .mark .head {
    fill: #ff2bd6;
    stroke: #fff;
    stroke-width: 1.5;
    stroke-linejoin: round;
  }
  .mark .badge {
    fill: #ff2bd6;
    stroke: #fff;
    stroke-width: 2;
  }
  .mark .badge-n {
    fill: #fff;
    font: 700 12px var(--font-ui);
    text-anchor: middle;
    dominant-baseline: central;
    pointer-events: none;
  }
  .annot-tools {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 8px;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-panel);
    box-shadow: var(--elev-3);
    cursor: var(--cursor-cross);
    white-space: nowrap;
  }
  .ttl {
    font: 600 10.5px var(--font-mono);
    letter-spacing: 0.08em;
    color: var(--c-tx-muted);
    margin-right: 4px;
  }
  .annot-tools button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: var(--r-ui);
    background: transparent;
    color: var(--c-tx);
    font: 12px var(--font-ui);
    cursor: var(--cursor-cross-hover);
  }
  .annot-tools button:hover:not(:disabled) {
    border-color: var(--c-line-strong);
    color: var(--c-tx-hi);
  }
  .annot-tools button.on {
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .annot-tools button.primary {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .annot-tools button:disabled {
    opacity: 0.4;
    cursor: var(--cursor-cross);
  }
  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 3px;
    border-radius: var(--r-ui);
    background: var(--c-accent-tint);
    color: var(--c-accent);
    font: 600 10px var(--font-mono);
  }
  .sep {
    width: 1px;
    height: 16px;
    background: var(--c-line);
  }
  .hint {
    font: 10.5px var(--font-mono);
    color: var(--c-tx-muted);
    padding: 0 6px;
  }
</style>

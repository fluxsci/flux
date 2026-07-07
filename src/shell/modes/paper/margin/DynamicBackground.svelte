<script lang="ts">
  // The dynamic background — one compositor for all five BgSources (ambient
  // scenes + living vines). Same lifecycle machinery as the testbed wrappers
  // (Poisson spawns → per-sprite offscreen layer → reveal ops by time →
  // multiply-composite with a hold/fade envelope), with the two behaviors the
  // margin needs that the testbed never did:
  //
  //  · Container-driven size. No width/height props — a ResizeObserver on the
  //    wrapper reallocates the backing store and recomposites synchronously in
  //    the same callback (post-layout, pre-paint), so a grip-drag never shows
  //    a blank or stale frame.
  //  · Resize never resets the field. Sprites keep their spawn-time layers
  //    (anchored top-left, cropped/underhanging as the box changes) and age
  //    out naturally; new sprites spawn at the new dimensions. Only a
  //    source/seed change restarts the field — under a short crossfade from a
  //    snapshot of the last frame, never a hard cut.
  import { onMount } from "svelte";
  import { fx } from "../../../../lib/ambient/core/palette";
  import { makeRng, type Rng } from "../../../../lib/ambient/core/prng";
  import { bgSourceById, type BgField, type BgRect } from "./bgSources";

  // `paused` = the whole PANE is hidden (keep-alive keeps hidden modes mounted, and the
  // loop would otherwise keep ticking) — nobody can stare into a hidden margin, so the
  // loop stops cold and resumes with a fresh timestamp (no dt jump / fast-forward).
  // This is UNRELATED to reduce-motion, which deliberately never stills this canvas
  // (see the loop comment below).
  let { sourceId, seed, paused = false }: { sourceId: string; seed: string; paused?: boolean } = $props();

  interface Sprite {
    off: HTMLCanvasElement;
    octx: CanvasRenderingContext2D;
    ops: Array<{ t: number; draw(ctx: CanvasRenderingContext2D): void }>;
    duration: number;
    /** Spawn-time bounds — never restated on resize (that's the seamlessness). */
    bx: number;
    by: number;
    bw: number;
    bh: number;
    clock: number;
    opIdx: number;
    grow: number;
    hold: number;
    fade: number;
  }

  const GHOST_FADE = 0.3; // seconds of crossfade when the source/seed changes

  let wrap: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let ctx: CanvasRenderingContext2D | null = null;
  let dpr = 1;
  let width = 0; // CSS px, measured from the container
  let height = 0;
  let ready = false;

  let field: BgField | null = null;
  let active: Sprite[] = [];
  let spriteIndex = 0;
  let worldClock = 0;
  let nextSpawn = 0;
  let retryAt = 0;
  let schedRng: Rng = makeRng("init");
  let ghost: { off: HTMLCanvasElement; w: number; h: number; age: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | 0 = 0; // the ambient loop's setTimeout handle
  let startLoop = () => {};
  let stopLoop = () => {};
  $effect(() => {
    if (paused) stopLoop();
    else startLoop();
  });

  // Dev-only perf rings, read by scripts/verify-margin-bg.mjs.
  const frames: number[] = []; // tick-to-tick deltas (ms)
  const spawns: number[] = []; // trySpawn durations (ms)

  function resetField(): void {
    const src = bgSourceById(sourceId);
    field = src.make(seed);
    active = [];
    spriteIndex = 0;
    worldClock = 0;
    nextSpawn = 0;
    retryAt = 0;
    schedRng = makeRng(`${seed}|${src.id}|schedule`);
  }

  function trySpawn(): void {
    if (!field || width < 2 || height < 2) return;
    const t0 = performance.now();
    const occupied: BgRect[] = active.map((s) => ({ x: s.bx, y: s.by, w: s.bw, h: s.bh }));
    let spec: ReturnType<BgField["spawn"]>;
    try {
      spec = field.spawn(spriteIndex++, width, height, occupied);
    } catch (err) {
      console.error(`[dynmargin] background "${sourceId}" spawn failed:`, err);
      return;
    }
    if (!spec || !spec.ops.length) return;
    const b = spec.bounds ?? { x: 0, y: 0, w: width, h: height };
    const bx = Math.max(0, Math.floor(b.x));
    const by = Math.max(0, Math.floor(b.y));
    const bw = Math.min(width - bx, Math.ceil(b.w + (b.x - bx)));
    const bh = Math.min(height - by, Math.ceil(b.h + (b.y - by)));
    if (bw < 2 || bh < 2) return;
    const off = document.createElement("canvas");
    off.width = Math.ceil(bw * dpr);
    off.height = Math.ceil(bh * dpr);
    const octx = off.getContext("2d");
    if (!octx) return;
    octx.setTransform(dpr, 0, 0, dpr, -bx * dpr, -by * dpr);
    octx.globalCompositeOperation = "multiply";
    const life = field.life;
    const vary = (v: number) => v * schedRng.range(0.75, 1.3);
    active.push({
      off,
      octx,
      ops: spec.ops,
      duration: Math.max(1, spec.duration),
      bx,
      by,
      bw,
      bh,
      clock: 0,
      opIdx: 0,
      grow: Math.max(0.5, vary(life.grow)),
      hold: Math.max(0, vary(life.hold)),
      fade: Math.max(0.5, vary(life.fade)),
    });
    if (import.meta.env.DEV) {
      spawns.push(performance.now() - t0);
      if (spawns.length > 50) spawns.shift();
    }
  }

  function advance(dt: number): void {
    if (!field) return;
    const d = dt * field.speed;
    worldClock += d;
    // Spawn when due — or immediately if the pane has gone empty, so the
    // margin never sits on blank paper between arrivals.
    if ((worldClock >= nextSpawn || active.length === 0) && worldClock >= retryAt) {
      if (active.length < field.life.maxConcurrent) {
        trySpawn();
        const mean = 60 / Math.max(0.1, field.life.rate);
        const gap = -Math.log(1 - schedRng.next()) * mean;
        nextSpawn = worldClock + Math.min(mean * 2.2, Math.max(field.minGap, gap));
      } else {
        nextSpawn = worldClock + 0.7;
      }
      retryAt = worldClock + 0.5;
    }
    for (const s of active) {
      s.clock += d;
      const opClock = s.clock >= s.grow ? s.duration + 1 : (s.clock / s.grow) * s.duration;
      try {
        while (s.opIdx < s.ops.length && s.ops[s.opIdx].t <= opClock) {
          s.ops[s.opIdx++].draw(s.octx);
        }
      } catch (err) {
        console.error(`[dynmargin] background "${sourceId}" draw failed:`, err);
        s.opIdx = s.ops.length;
      }
    }
    active = active.filter((s) => s.clock < s.grow + s.hold + s.fade);
  }

  function composite(): void {
    if (!ctx || !field) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = fx("paper");
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "multiply";
    for (const s of active) {
      const past = s.clock - s.grow - s.hold;
      let env = 1;
      if (past > 0) {
        const u = Math.min(1, past / s.fade);
        env = 1 - u * u * (3 - 2 * u);
      }
      ctx.globalAlpha = Math.min(1, env * field.opacity);
      // Spawn-time size and position, always — never stretched to the current
      // box, so old art survives a resize unwarped.
      ctx.drawImage(s.off, s.bx, s.by, s.bw, s.bh);
    }
    ctx.globalCompositeOperation = "source-over";
    if (ghost) {
      const u = Math.min(1, ghost.age / GHOST_FADE);
      ctx.globalAlpha = 1 - u * u * (3 - 2 * u);
      ctx.drawImage(ghost.off, 0, 0, ghost.w, ghost.h);
      if (u >= 1) ghost = null;
    }
    ctx.globalAlpha = 1;
  }

  /** Snapshot the current frame so a field switch crossfades instead of cutting. */
  function snapshotGhost(): void {
    if (!canvas || canvas.width < 2 || canvas.height < 2) return;
    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    off.getContext("2d")?.drawImage(canvas, 0, 0);
    ghost = { off, w: width, h: height, age: 0 };
  }

  function resize(cssW: number, cssH: number): void {
    if (!canvas || cssW < 2 || cssH < 2) return;
    width = cssW;
    height = cssH;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(2, Math.round(cssW * dpr));
    canvas.height = Math.max(2, Math.round(cssH * dpr));
    // Same-callback recomposite: the realloc cleared the canvas, and RO fires
    // before paint, so the drag never presents a blank frame.
    composite();
  }

  export function sow(): void {
    if (ready) trySpawn();
  }

  export function clearField(): void {
    resetField();
    composite();
  }

  /** Advance the whole simulation by `sec` seconds instantly (for screenshots). */
  export function seekSeconds(sec: number): void {
    const steps = Math.min(4000, Math.ceil(sec / 0.05));
    for (let i = 0; i < steps; i++) advance(0.05);
    composite();
  }

  onMount(() => {
    ctx = canvas?.getContext("2d") ?? null;
    const r = wrap?.getBoundingClientRect();
    resetField();
    lastSig = `${sourceId}|${seed}`;
    if (r) resize(r.width, r.height);
    ready = true;

    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      resize(e.contentRect.width, e.contentRect.height);
    });
    if (wrap) ro.observe(wrap);

    // The loop runs UNCONDITIONALLY — deliberately no prefers-reduced-motion
    // branch. The ambient motion IS the feature ("something to stare into
    // while you think", always on, per the owner's spec), and Linux desktops
    // routinely report `reduce` via GTK while animations are enabled — that
    // setting froze the margin solid for the owner once. OS reduce-motion
    // still tames the UI transitions (pane materialize, fadeRise); it must
    // never still this canvas. The tick never lets one bad frame kill the
    // loop: errors are logged once and the chain continues.
    // PACING — setTimeout, NOT requestAnimationFrame. On Chromium 150 (Electron 43) a
    // continuous main-thread rAF loop pulls the page into a deep frame pipeline that adds
    // ~50ms of input→paint latency to every keystroke in the editor beside this margin
    // (measured 88ms rAF vs 40ms setTimeout; scripts/perf/writer-latency.mjs). setTimeout
    // runs the same draw OUTSIDE the rAF lifecycle, so the editor's input paints stay
    // shallow/instant while this animation still runs always-on at ~60fps. (An OffscreenCanvas
    // worker was tried and measured WORSE — its continuous commits re-deepen the compositor
    // pipeline.) The loop is dt-driven, so setTimeout jitter never changes the motion's speed.
    let last = performance.now();
    let warned = false;
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (import.meta.env.DEV) {
        frames.push(dt * 1000);
        if (frames.length > 300) frames.shift();
      }
      try {
        if (ghost) ghost.age += dt;
        advance(dt);
        composite();
      } catch (err) {
        if (!warned) {
          warned = true;
          console.error("[dynmargin] background frame failed (loop continues):", err);
        }
      }
      timer = setTimeout(tick, 16);
    };
    stopLoop = () => {
      clearTimeout(timer);
      timer = 0;
    };
    startLoop = () => {
      if (timer) return;
      last = performance.now(); // resume without a dt jump
      timer = setTimeout(tick, 16);
    };
    if (!paused) startLoop();

    if (import.meta.env.DEV) {
      const w = window as unknown as { __fluxMargin?: Record<string, unknown> };
      (w.__fluxMargin ??= {}).bg = {
        frames,
        spawns,
        dims: () => ({
          cssW: width,
          cssH: height,
          backingW: canvas?.width ?? 0,
          backingH: canvas?.height ?? 0,
          active: active.length,
          source: sourceId,
          seed,
        }),
        seek: (s: number) => seekSeconds(s),
        sow: () => sow(),
        // Dev-only loop control for the input-latency probe + gate
        // (scripts/perf/writer-latency.mjs, scripts/verify-writer-latency.cjs):
        // measure keystroke INP with this ambient loop paused vs running, so the
        // gate can assert the ambient background adds ~no input latency (the
        // Chromium-150 rAF-coupling regression this file's pacing note guards).
        pause: () => stopLoop(),
        resume: () => startLoop(),
      };
    }

    return () => {
      clearTimeout(timer);
      ro.disconnect();
      if (import.meta.env.DEV) {
        const w = window as unknown as { __fluxMargin?: Record<string, unknown> };
        if (w.__fluxMargin) delete w.__fluxMargin.bg;
      }
    };
  });

  // Only a source/seed change restarts the field — never a resize.
  let lastSig = "";
  $effect(() => {
    const sig = `${sourceId}|${seed}`;
    if (!ready || sig === lastSig) return;
    lastSig = sig;
    snapshotGhost();
    resetField();
    composite();
  });
</script>

<div class="bg" bind:this={wrap} aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .bg {
    position: absolute;
    inset: 0;
    overflow: hidden;
    border-radius: inherit;
    pointer-events: none;
  }
  .bg canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>

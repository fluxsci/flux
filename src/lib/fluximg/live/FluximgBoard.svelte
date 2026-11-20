<script lang="ts">
  /**
   * The live view's control board: the instruments that stand round a live image, on the canvas itself.
   *
   * There is no menu. The image is the middle of a small figure of its own: depth stands at its side like a y axis,
   * time lies under it like an x axis, and the console stands at its other side: the image's name, one strip per
   * channel (its histogram is its contrast control), a row of paper keys, and a map once the frame is zoomed in.
   * Everything is on the surface at once and answers the pointer where it is; the keys are the same everywhere
   * (`actions.ts` `LIVE_KEYS`). What is "in hand" (a rail, a channel's point, the frame) is lit pink: the wheel and
   * a drag on the image drive it.
   *
   * It owns the keyboard and the wheel while the live view is open and changes nothing itself: every change is an
   * `actions.ts` call.
   */
  import { get } from "svelte/store";
  import { yieldsToShellModal, isAnnotateChord } from "../../../shell/agent/annotationVisibility";
  import { project } from "../../store";
  import { fluxFigMenuOpen } from "../../settings";
  import { WheelStepper, wheelDelta } from "../../interact/wheelLaw";
  import { pushToast } from "../../toast";
  import { channelTable } from "../lut";
  import { fluximgLutsReady, fluximgManifests, needLuts, resolveLut } from "../store";
  import { fullCrop } from "../still";
  import { insetsOf } from "../static";
  import type { SplitLayout } from "../panelLayout";
  import { contributingChannelIndices, formatNumber } from "../viewOps";
  import BoardChannel from "./BoardChannel.svelte";
  import BoardLayers from "./BoardLayers.svelte";
  import BoardRail from "./BoardRail.svelte";
  import FluximgNavigator from "./FluximgNavigator.svelte";
  import PaperKey from "./PaperKey.svelte";
  import {
    LIVE_KEYS, PROJECTION_MODES, autoContrast, autoPlan, backOut, channelInHand, cycleFurnitureCorner, defaultArmed, dimKeys, dimLength, holdRail, liveContext, makeInset,
    nudgeFurniture, nudgeGamma, nudgeLayerOpacity, nudgeWindow, panFrame, railDims, resetChannel, resetFrame, resizeProjection, setChannel, setPosition, setProjectionMode, setRun,
    setWindow, soloChannel, splitChannels, splitPlan, stepPosition, stepSpeed, takeChannel, toggleChannel, toggleFurniture, togglePlayback, toggleSmooth, zoomFrame, zoomInset,
  } from "./actions";
  import { boardLayout, type Box } from "./boardLayout";
  import { armLive, cancelLiveEdit, closeFluximgLive, fluximgFrame, fluximgLive, fluximgLiveProblem, fluximgReadout, fluximgTip, liveArm, livePointer, liveSampler, setLive, settleLiveEdit, type LiveSample } from "./session";

  let { image, host, origin, zoom, prefetch, preview = $bindable(null) }: {
    /** The live image's screen bounds, in the canvas host's px. */
    image: Box;
    host: { w: number; h: number };
    /** Where the image's FIGURE has its corner on screen (host px), and the canvas zoom: for previews drawn on the figure. */
    origin: { x: number; y: number };
    zoom: number;
    /** Decode ahead along a dimension (the overlay's driver). */
    prefetch: (dim: string, steps: readonly number[]) => void;
    /** What a hovered key would do, for the overlay to draw on the image: the corner frame it would take, etc. */
    preview?: null | { kind: "split"; plan: SplitLayout };
  } = $props();

  /** The console plate, and the modules that sit in it. */
  const CONSOLE_W = 252, MODULE_W = CONSOLE_W - 10;
  const LAYERS_W = 244;

  const live = $derived($fluximgLive);
  // Reading the project and manifests keeps the board's values live through edits, undo and playback.
  const ctx = $derived.by(() => { void $project; void $fluximgManifests; return live ? liveContext() : null; });
  const dims = $derived(ctx ? railDims(ctx.manifest) : []);
  const keys = $derived(ctx ? dimKeys(ctx.manifest) : {});
  const asset = $derived(ctx ? $project.assets.find((a) => a.id === ctx.element.assetId) : undefined);
  const integer = $derived(!!ctx && ctx.manifest.pixels.encoding.kind === "exact" && !ctx.manifest.pixels.dtype.startsWith("float"));
  $effect(() => { if (live) void needLuts(); });
  const DIM_NAMES: Record<string, string> = { t: "Time", z: "Depth" };
  const dimName = (d: string): string => DIM_NAMES[d] ?? d.charAt(0).toUpperCase() + d.slice(1);
  /** A value as the board prints it: whole numbers for integer data, four significant digits otherwise. */
  const fmt = (v: number): string => (integer ? formatNumber(Math.round(v)) : formatNumber(Number(v.toPrecision(4))));
  /** A channel's ink for small marks: its colour, or a bright entry of its colour map. */
  function inkOf(c: { color: string | null; lut: string | null }): string {
    void $fluximgLutsReady;
    if (c.color) return c.color;
    const t = c.lut ? resolveLut(c.lut) : null;
    return t?.[Math.floor(t.length * 0.72)]?.slice(0, 7) ?? "#cecdc3";
  }
  // One table per colouring, kept: a strip handed the same table again rebuilds nothing.
  const tables = new Map<string, Uint8Array>();
  let tablesFor = false;
  function tableOf(c: { color: string | null; lut: string | null; invert: boolean }): Uint8Array {
    if (tablesFor !== $fluximgLutsReady) { tables.clear(); tablesFor = $fluximgLutsReady; } // colour maps arrived: the fallback tables go
    const k = `${c.color ?? ""}|${c.lut ?? ""}|${c.invert ? 1 : 0}`;
    let t = tables.get(k);
    if (!t) { t = channelTable(c, resolveLut); tables.set(k, t); if (tables.size > 48) tables.delete(tables.keys().next().value as string); }
    return t;
  }

  const SWATCHES = $derived.by(() => {
    void $fluximgLutsReady;
    const ramp = (lut: string): string => {
      const t = channelTable({ color: null, lut, invert: false }, resolveLut);
      return `linear-gradient(90deg,${[0, 64, 128, 192, 255].map((i) => `rgb(${t[i * 4]},${t[i * 4 + 1]},${t[i * 4 + 2]})`).join(",")})`;
    };
    return [
      { label: "gray", lut: "gray", css: ramp("gray") }, { label: "green", color: "#00ff00", css: "#00ff00" }, { label: "magenta", color: "#ff00ff", css: "#ff00ff" },
      { label: "cyan", color: "#00ffff", css: "#00ffff" }, { label: "yellow", color: "#ffff00", css: "#ffff00" }, { label: "red", color: "#ff0000", css: "#ff0000" },
      { label: "blue", color: "#4488ff", css: "#4488ff" }, { label: "viridis", lut: "viridis", css: ramp("viridis") }, { label: "magma", lut: "magma", css: ramp("magma") },
    ];
  });
  const swatchOf = (c: { color: string | null; lut: string | null }): string => SWATCHES.find((s) => (s.color ?? null) === c.color?.toLowerCase() && (s.lut ?? null) === (c.color ? null : c.lut))?.label ?? "";

  // --- what the frame on screen holds: one sample per shown channel ---------------------------------
  const samples = $derived.by((): Map<number, LiveSample> => {
    void $fluximgFrame.serial;
    const out = new Map<number, LiveSample>();
    for (const s of liveSampler.read?.() ?? []) out.set(s.channel, s);
    return out;
  });
  const probes = $derived(new Map(($fluximgReadout?.values ?? []).map((v) => [v.channel, v])));

  // --- the rails -----------------------------------------------------------------------------------
  const vDim = $derived(dims.includes("z") ? "z" : null);
  const hDims = $derived(dims.filter((d) => d !== vDim));
  const shownChannels = $derived(ctx ? contributingChannelIndices(ctx.view).map((i) => ctx.view.channels[i]) : []);
  // A rail's traces, kept while the same channels are shown in the same inks: stepping a plane hands every rail the
  // same array again, so its paths are not rebuilt.
  const traces = new Map<string, { of: unknown; list: Array<{ color: string; values: ReadonlyArray<number | null> }> }>();
  function profilesOf(dim: string): Array<{ color: string; values: ReadonlyArray<number | null> }> {
    const mean = ctx?.manifest.profiles?.[dim]?.mean;
    if (!mean) return [];
    const shown = shownChannels.filter((c) => mean[c.index]);
    const k = `${dim}|${shown.map((c) => `${c.index}:${inkOf(c)}`).join(",")}`, hit = traces.get(dim);
    if (hit && hit.of === mean && (hit as { key?: string }).key === k) return hit.list;
    const list = shown.map((c) => ({ color: inkOf(c), values: mean[c.index] }));
    traces.set(dim, Object.assign({ of: mean, list }, { key: k }));
    return list;
  }
  function scrub(dim: string, index: number, phase: "start" | "move" | "end" | "cancel"): void {
    if (phase === "cancel") { cancelLiveEdit(); return; }
    const before = ctx?.view.index[dim] ?? 0;
    setPosition(dim, index);
    if (index !== before) prefetch(dim, index > before ? [1, 2, 3] : [-1, -2, -3]);
    if (phase === "end") settleLiveEdit();
  }
  function runTo(dim: string, from: number, to: number, phase: "start" | "move" | "end" | "cancel"): void {
    if (phase === "cancel") { cancelLiveEdit(); return; }
    setRun(dim, from, to);
    if (phase === "end") settleLiveEdit();
  }

  // --- the projection chooser ------------------------------------------------------------------------
  let choosing = $state<string | null>(null);
  let choice = $state(0);
  const modes = $derived.by(() => {
    const p = ctx?.view.projection, on = p && p.dim === choosing ? p.mode : null;
    return [{ label: "off", mode: null, on: !on }, ...PROJECTION_MODES.map((m) => ({ label: m, mode: m, on: on === m }))];
  });
  function openChooser(dim: string): void {
    if (choosing === dim) { choosing = null; return; }
    choosing = dim;
    choice = Math.max(0, modes.findIndex((m) => m.on));
  }
  /** Picked by its number, the run is taken in hand (the wheel anywhere sizes it); picked with the mouse, nothing is. */
  function pickMode(i: number, byKey = false): void {
    const dim = choosing, o = modes[i];
    choosing = null;
    if (!dim || !o) return;
    setProjectionMode(dim, o.mode);
    settleLiveEdit();
    if (byKey && o.mode) armLive(`run:${dim}`);
    else { liveArm.explicit = false; setLive({ armed: `pos:${dim}` }); }
  }
  $effect(() => { if (!live) choosing = null; });

  // --- keys ------------------------------------------------------------------------------------------
  /** A scale bar needs to know how big a pixel is; without that, say so instead of switching on nothing. */
  const hasPixelSize = $derived.by(() => { const ax = ctx?.manifest.axes?.x; return !!(ax && typeof ax.scale === "number" && ax.scale > 0 && ax.unit); });
  function toggleScalebar(): void {
    if (!ctx?.view.furniture.scalebar && !hasPixelSize) {
      pushToast("info", "This image does not say how big a pixel is, so it cannot draw a scale bar", { detail: "Save it with pixel_size= and a unit (fp.imsave), then it will." });
      return;
    }
    toggleFurniture("scalebar");
  }
  type Furniture = "scalebar" | "stamp" | "channelLabels" | "colorbar";
  function furniture(kind: Furniture, nextCorner: boolean): void {
    if (!ctx || (kind === "stamp" && !dims.length)) return;
    // Shift walks an annotation that is on round the corners; plain switches it on and off.
    if (nextCorner && ctx.view.furniture[kind]) cycleFurnitureCorner(kind);
    else if (kind === "scalebar") toggleScalebar();
    else toggleFurniture(kind);
  }
  const full = $derived(ctx ? fullCrop(ctx.manifest) : null);
  const whole = $derived(!!ctx && !!full && ctx.crop.width >= full.width - 1e-6 && ctx.crop.height >= full.height - 1e-6);
  function frameKey(): void { if (live?.armed === "zoom") { settleLiveEdit(); liveArm.explicit = false; setLive({ armed: defaultArmed() }); } else armLive("zoom"); }
  function insetKey(): void {
    if (live?.armed !== "inset") { armLive("inset"); return; }
    // Asked again: the frame as it is becomes the inset (when it is a region), and the image shows all of itself.
    if (!whole && makeInset(null)) { liveArm.explicit = false; setLive({ armed: defaultArmed() }); }
    else { liveArm.explicit = false; setLive({ armed: defaultArmed() }); }
  }
  function cycleNorm(i: number): void {
    const c = ctx?.view.channels[i];
    if (!c) return;
    const order = ["linear", "log", "gamma"] as const, next = order[(order.indexOf(c.norm) + 1) % order.length];
    if (next === "log" && !(c.range[0] > 0)) pushToast("info", "A log scale needs a black point above 0", { detail: "Until then this channel is drawn linear." });
    setChannel(i, next === "linear" ? { norm: null as unknown as undefined } : next === "gamma" ? { norm: "gamma", gamma: c.gamma === 1 ? 0.5 : c.gamma } : { norm: "log" });
    settleLiveEdit();
  }
  function bend(i: number, g: number, phase: "start" | "move" | "end" | "cancel"): void {
    if (phase === "cancel") { cancelLiveEdit(); return; }
    setChannel(i, g === 1 ? { gamma: null as unknown as undefined, norm: null as unknown as undefined } : { norm: "gamma", gamma: g }, `gamma-drag:${i}`);
    if (phase === "end") settleLiveEdit();
  }

  /** A key struck from the keyboard goes down on the board too. */
  let rootEl = $state<HTMLDivElement>();
  function strike(id: string): void {
    const el = rootEl?.querySelector<HTMLElement>(`[data-fxb-key="${id}"]`);
    if (!el) return;
    el.classList.add("struck");
    setTimeout(() => el.classList.remove("struck"), 130);
  }

  // --- keyboard --------------------------------------------------------------------------------------
  function onKey(e: KeyboardEvent): void {
    if (!live || !ctx) return;
    if (yieldsToShellModal(e) || isAnnotateChord(e) || get(fluxFigMenuOpen)) return;
    if (e.ctrlKey || e.metaKey) return; // chords (undo, save, copy) stay Flux-wide
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return; // a focused field owns its keys
    if (layersOwnKeys && e.key !== "Escape") return; // the layers card walks its own list (BoardLayers)
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = (): void => { e.preventDefault(); e.stopImmediatePropagation(); };

    if (k === "Escape") {
      done();
      if (choosing) { choosing = null; return; }
      if (layersOwnKeys) { layersOwnKeys = false; return; }
      if (!backOut()) closeFluximgLive();
      return;
    }
    if (choosing) {
      const n = modes.length;
      if (/^[1-9]$/.test(k) && Number(k) <= n) { done(); pickMode(Number(k) - 1, true); return; }
      if (k === "ArrowRight" || k === "ArrowDown") { done(); choice = (choice + 1) % n; return; }
      if (k === "ArrowLeft" || k === "ArrowUp") { done(); choice = (choice + n - 1) % n; return; }
      if (k === "Enter" || k === " ") { done(); pickMode(choice, true); return; }
      if (k === LIVE_KEYS.projection) { done(); choosing = null; return; }
      done(); return; // an open choice swallows stray keys rather than firing some other key
    }
    if (k === "r" && !e.altKey && !e.shiftKey) { done(); if (!e.repeat) closeFluximgLive(); return; }
    if (k === "f" && !e.altKey) { done(); settleLiveEdit(); fluxFigMenuOpen.set(true); return; }
    // Digits are the channels (by the physical key, so Shift and Alt keep their digit): take in hand, show, or solo.
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && Number(digit[1]) <= ctx.view.channels.length) {
      const i = Number(digit[1]) - 1;
      done();
      if (e.repeat) return;
      if (e.shiftKey) toggleChannel(i); else if (e.altKey) soloChannel(i); else takeChannel(i);
      return;
    }
    if (e.altKey) return;
    // The rails answer the arrows spatially: left / right along the first horizontal rail, up / down through depth.
    if (k.startsWith("Arrow")) {
      const by = e.shiftKey ? 10 : 1, horizontal = hDims[0], vertical = vDim ?? undefined;
      if ((k === "ArrowLeft" || k === "ArrowRight") && horizontal) { done(); stepPosition(horizontal, k === "ArrowRight" ? by : -by); return; }
      if ((k === "ArrowUp" || k === "ArrowDown") && (vertical ?? horizontal)) { done(); stepPosition((vertical ?? horizontal)!, k === "ArrowDown" ? by : -by); return; }
      done(); return;
    }
    if (k === " ") {
      const d = live.armed?.startsWith("pos:") ? live.armed.slice(4) : dims[0];
      done();
      // Space is a TAP for play / stop and a HOLD for Space+drag panning, as everywhere in Flux: the movie toggles when
      // the key comes up without the pointer having gone down meanwhile (and auto-repeat never toggles it).
      if (d && !e.repeat) spaceTap = d;
      return;
    }
    if (k === "Enter" && live.armed === "inset") { done(); insetKey(); return; }
    done(); // the board owns unmodified keys: nothing leaks to canvas shortcuts (no stray Delete or nudge)
    if (e.repeat) return;
    for (const d of dims) if (keys[d] === k) { armLive(`pos:${d}`); return; }
    switch (k) {
      case LIVE_KEYS.auto: { const one = channelInHand(live.armed); strike("auto"); autoContrast(one ? live.channel : "all"); return; }
      case LIVE_KEYS.split: strike("split"); splitChannels(); return;
      case LIVE_KEYS.projection: { const d = live.armed?.startsWith("pos:") || live.armed?.startsWith("run:") ? live.armed.slice(4) : dims[0]; if (d) { strike(`project:${d}`); openChooser(d); } return; }
      case LIVE_KEYS.layers: if (ctx.manifest.layers.length) layersOwnKeys = true; return;
      case LIVE_KEYS.frame: if (e.shiftKey) { strike("whole"); resetFrame(); } else { strike("frame"); frameKey(); } return;
      case LIVE_KEYS.inset: strike("inset"); insetKey(); return;
      case LIVE_KEYS.smooth: strike("pixels"); toggleSmooth(); return;
      case LIVE_KEYS.scalebar: strike("scalebar"); furniture("scalebar", e.shiftKey); return;
      case LIVE_KEYS.stamp: strike("stamp"); furniture("stamp", e.shiftKey); return;
      case LIVE_KEYS.channelNames: strike("channelLabels"); furniture("channelLabels", e.shiftKey); return;
      case LIVE_KEYS.colorbar: strike("colorbar"); furniture("colorbar", e.shiftKey); return;
    }
  }
  let spaceTap: string | null = null;
  function onKeyUp(e: KeyboardEvent): void {
    if (e.key !== " " || !spaceTap) return;
    const d = spaceTap;
    spaceTap = null;
    if (live && ctx) { strike(`play:${d}`); togglePlayback(d); }
  }
  const cancelTap = (): void => { spaceTap = null; };
  let layersOwnKeys = $state(false);
  $effect(() => { if (!live) layersOwnKeys = false; });

  // --- wheel -----------------------------------------------------------------------------------------
  const stepper = new WheelStepper();
  function onWheel(e: WheelEvent): void {
    if (!live || !ctx || e.ctrlKey || e.metaKey || get(fluxFigMenuOpen)) return; // Ctrl-wheel is always canvas zoom
    const target = e.target instanceof Element ? e.target : null;
    // Over an instrument the wheel is that instrument's, whatever is in hand.
    const over = target?.closest<HTMLElement>("[data-fxb-wheel]")?.dataset.fxbWheel ?? "";
    if (!over && target?.closest(".scrolls")) return; // a list scrolls
    const onBoard = !!target?.closest("[data-fluximg-live], [data-fxb], [data-fxb-grip], [data-fxb-region]");
    const armed = live.armed;
    if (!over) {
      if (!armed) return;
      // What the view took in hand by itself answers over the image and the board only: everywhere else the wheel
      // is still the canvas's. What YOU took in hand answers anywhere.
      if (!liveArm.explicit && !onBoard) return;
    }
    e.preventDefault(); e.stopPropagation();
    const notches = stepper.steps({ deltaY: wheelDelta(e), deltaMode: e.deltaMode, time: e.timeStamp });
    if (!notches) return;
    const coarse = e.shiftKey ? 10 : 1, fine = e.altKey ? 0.1 : 1;
    if (over.startsWith("chan:")) {
      const i = Number(over.slice(5));
      // On the plot, the nearer of the two points; on the strip's head, the white point.
      const well = target?.closest<SVGSVGElement>("[data-fxb-well]");
      let which: 0 | 1 = 1;
      if (well) { const r = well.getBoundingClientRect(), u = (e.clientX - r.left) / Math.max(1, r.width); which = Math.abs(u - Number(well.dataset.b)) < Math.abs(u - Number(well.dataset.w)) ? 0 : 1; }
      if (live.channel === i && armed === "gamma" && !well) nudgeGamma(i, notches * coarse);
      else nudgeWindow(i, which, notches * coarse, fine);
      return;
    }
    // Wheel DOWN moves forward through a stack (the next plane), as every stack viewer does; values go UP with wheel up.
    if (over.startsWith("rail:")) {
      // Over a run's band the wheel sizes the run; anywhere else on the rail it steps (a run slides).
      const d = over.slice(5), p = ctx.view.projection, railEl = target?.closest<HTMLElement>("[data-fxb-rail]"), track = railEl?.querySelector<SVGSVGElement>("[data-fxb-track]");
      let onRun = armed === `run:${d}`;
      if (!onRun && p && p.dim === d && track && railEl) {
        const r = track.getBoundingClientRect(), n = dimLength(ctx.manifest, d);
        const f = railEl.classList.contains("vertical") ? (e.clientY - r.top) / Math.max(1, r.height) : (e.clientX - r.left) / Math.max(1, r.width);
        onRun = f >= p.from / n && f <= p.to / n;
      }
      if (onRun) resizeProjection(notches * coarse); else stepPosition(d, -notches * coarse);
      return;
    }
    if (over.startsWith("speed:")) { stepSpeed(Math.sign(notches)); return; }
    if (over === "map") { zoomFrame(Math.pow(1.12, notches * coarse * fine), null); return; }
    if (over.startsWith("layer:")) { nudgeLayerOpacity(over.slice(6), notches * coarse); return; }
    if (over.startsWith("furniture:")) { nudgeFurniture(over.slice(10) as Furniture, notches); return; }
    if (over.startsWith("region:")) { zoomInset(over.slice(7), Math.pow(1.1, notches * coarse * fine)); return; }
    if (!armed) return;
    if (armed.startsWith("pos:")) stepPosition(armed.slice(4), -notches * coarse);
    else if (armed.startsWith("run:")) resizeProjection(notches * coarse);
    else if (armed === "black") nudgeWindow(live.channel, 0, notches * coarse, fine);
    else if (armed === "white") nudgeWindow(live.channel, 1, notches * coarse, fine);
    else if (armed === "window") nudgeWindow(live.channel, 2, notches * coarse, fine);
    else if (armed === "gamma") nudgeGamma(live.channel, notches * coarse);
    else if (armed === "zoom") zoomFrame(Math.pow(1.12, notches * coarse * fine), livePointer.locate?.(e.clientX, e.clientY) ?? null);
    else if (armed.startsWith("layer:")) nudgeLayerOpacity(armed.slice(6), notches * coarse);
  }
  // Capture phase and NOT passive: what is in hand takes the wheel before the canvas can pan, and must be able to
  // stop the page from scrolling (a declarative window wheel handler is passive).
  $effect(() => {
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", onWheel, { capture: true });
  });
  // A view that just opened takes its first rail in hand by itself (the wheel over the image steps planes at once).
  $effect(() => { if (live && ctx && live.armed === null && !live.playing) { const a = defaultArmed(); if (a) setLive({ armed: a }); } });

  // --- where everything stands ------------------------------------------------------------------------
  let consoleH = $state(0), layersH = $state(0);
  const hasLayers = $derived(!!ctx && ctx.manifest.layers.length > 0);
  const layout = $derived(boardLayout({
    host, image, depth: !!vDim, rows: hDims.length,
    console: { w: CONSOLE_W, h: consoleH || 60 + (ctx?.view.channels.length ?? 1) * 84 + 44 },
    layers: hasLayers ? { w: LAYERS_W, h: Math.min(layersH || 160, 520) } : null,
  }));
  const at = (b: Box): string => `left:${Math.round(b.x)}px;top:${Math.round(b.y)}px`;

  // --- the head ---------------------------------------------------------------------------------------
  const head = $derived.by(() => {
    if (!ctx) return null;
    const m = ctx.manifest, px = asset?.fluximg?.pixelSize, shape = m.pixels.shape, nd = shape.length;
    const stack = dims.map((d) => `${dimLength(m, d).toLocaleString("en-US")} ${d}`);
    const size = `${shape[nd - 1].toLocaleString("en-US")} × ${shape[nd - 2].toLocaleString("en-US")}`;
    const pixel = px ? `${formatNumber(Number(px.x.toPrecision(4)))} ${px.unit ?? "units"}/px` : "";
    return { name: ctx.element.name ?? asset?.name ?? "Image", facts: [...stack, size, pixel].filter(Boolean) };
  });
  const frameInsets = $derived.by(() => {
    if (!ctx) return [];
    const f = $project.figures.find((g) => g.elements.some((e) => e.id === ctx.element.id));
    return f ? insetsOf(f.elements, ctx.element.id, ctx.element.assetId) : [];
  });
  const zoomWords = $derived(ctx && full ? `${formatNumber(Number((full.width / ctx.crop.width).toPrecision(2)))}×` : "");
  const showMap = $derived(!!ctx && (!whole || live?.armed === "zoom"));

  // --- the board's one label ---------------------------------------------------------------------------
  const tip = $derived($fluximgTip);
  function showTip(e: PointerEvent): void {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-tip]") : null;
    if (!el || !rootEl || e.buttons) { fluximgTip.set(null); return; }
    const r = el.getBoundingClientRect(), o = rootEl.getBoundingClientRect();
    const below = r.top - o.top < 34;
    fluximgTip.set({ text: el.dataset.tip ?? "", hk: el.dataset.hk ?? "", x: Math.min(host.w - 8, Math.max(8, r.left + r.width / 2 - o.left)), y: below ? r.bottom - o.top + 7 : r.top - o.top - 7, below });
  }
  const hideTip = (): void => { fluximgTip.set(null); };

  // What the Auto key would set, shown on the strips while the pointer rests on it.
  let ghosts = $state.raw<Array<[number, number] | null> | null>(null);
  const stop = (e: Event): void => e.stopPropagation();
</script>

<svelte:window onkeydown={onKey} onkeyup={onKeyUp} onpointerdowncapture={cancelTap} onblur={cancelTap} />

{#if live && ctx && head}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fxb" bind:this={rootEl} data-fxb data-armed={live.armed ?? ""} onpointerover={showTip} onpointerout={hideTip} onpointerdowncapture={hideTip}>
    <!-- ------------------------------------------------------------------ the console -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="console" style={`${at(layout.console)};width:${CONSOLE_W}px;max-height:${layout.console.h}px`} data-fxb-console data-side={layout.console.side} onpointerdown={stop} ondblclick={stop}>
      <div class="col" bind:offsetHeight={consoleH}>
        <div class="card headcard">
          <div class="l1">
            <span class="live" class:wait={!$fluximgFrame.sharp || $fluximgFrame.pending > 0} data-tip={$fluximgFrame.sharp ? "Live: every pixel on screen is the image's own" : "Sharpening"}></span>
            <span class="ttl">{head.name}</span>
            <PaperKey quiet size={20} glyph="close" label="Close" hotkey="R" id="close" onpress={() => closeFluximgLive()} />
          </div>
          <div class="l2" data-fxb-readout>
            {#if $fluximgLiveProblem}<span class="bad">{$fluximgLiveProblem}</span>
            {:else if $fluximgReadout}<span class="where"><b>{$fluximgReadout.where[0]}</b><b>{$fluximgReadout.where[1]}</b></span>{#if $fluximgReadout.object}<span class="obj">{$fluximgReadout.object.key}</span>{/if}
            {:else}{#each head.facts as f (f)}<span class="fact">{f}</span>{/each}{/if}
          </div>
        </div>

        {#each ctx.view.channels as c, i (c.index)}
          {@const shown = ctx.view.composite === "single" ? ctx.view.solo === i : c.visible}
          {@const p = probes.get(c.index)}
          <BoardChannel index={i} name={c.name} hotkey={i < 9 ? String(i + 1) : ""} stats={ctx.manifest.channels[c.index].stats} range={c.range} norm={c.norm} gamma={c.gamma} invert={c.invert}
            table={tableOf(c)} ink={inkOf(c)} {shown} solo={ctx.view.composite === "single" && ctx.view.solo === i} inHand={live.channel === i && channelInHand(live.armed)} armed={live.armed}
            sample={shown ? samples.get(c.index) ?? null : null} probe={p ? p.value : null} probeText={p?.text ?? ""} ghost={ghosts?.[i] ?? null} {integer} format={fmt} width={MODULE_W}
            wellH={ctx.view.channels.length > 4 ? 34 : 46} swatches={SWATCHES} current={swatchOf(c)}
            onwindow={(range, phase) => { if (phase === "cancel") cancelLiveEdit(); else { setWindow(i, range); if (phase === "end") settleLiveEdit(); } }}
            ongamma={(g, phase) => bend(i, g, phase)}
            ontake={(point) => takeChannel(i, point)}
            ontoggle={() => toggleChannel(i)} onsolo={() => soloChannel(i)} onauto={() => autoContrast(i)} onnorm={() => cycleNorm(i)}
            oncolor={(s) => { setChannel(i, s.color ? { color: s.color } : { lut: s.lut, color: null as unknown as undefined }); settleLiveEdit(); }}
            oninvert={() => { setChannel(i, { invert: c.invert ? (null as unknown as undefined) : true }); settleLiveEdit(); }}
            onreset={() => resetChannel(i)} />
        {/each}

        <div class="card keypad" data-fxb-keypad>
          <span class="grp">
            <PaperKey glyph="auto" label={channelInHand(live.armed) ? `Auto contrast · ${ctx.view.channels[live.channel]?.name ?? ""}` : "Auto contrast"} hotkey="A" id="auto"
              onpress={() => autoContrast(channelInHand(live.armed) ? live.channel : "all")}
              onenter={() => { const one = channelInHand(live.armed); ghosts = autoPlan(one ? live.channel : "all"); }} onleave={() => (ghosts = null)} />
            {#if ctx.view.channels.length > 1}
              <PaperKey glyph="split" label="Split channels" hotkey="S" id="split" onpress={() => { preview = null; splitChannels(); }}
                onenter={() => { const plan = splitPlan(); preview = plan ? { kind: "split", plan } : null; }} onleave={() => (preview = null)} />
            {/if}
          </span>
          <span class="grp">
            <PaperKey glyph="frame" label="Frame in hand: roll to zoom, drag to move" hotkey="V" id="frame" on={live.armed === "zoom"} onpress={frameKey} />
            <PaperKey glyph="inset" label={live.armed === "inset" ? "Drag a box on the image" : "Inset: drag a box on the image"} hotkey="X" id="inset" on={live.armed === "inset"} onpress={insetKey} />
          </span>
          <span class="grp">
            <PaperKey glyph="scalebar" label={hasPixelSize ? "Scale bar" : "Scale bar (the image has no pixel size)"} hotkey="B" id="scalebar" on={!!ctx.view.furniture.scalebar} onpress={(e) => furniture("scalebar", e.shiftKey)} />
            {#if dims.length}<PaperKey glyph="stamp" label="Position stamp" hotkey="W" id="stamp" on={!!ctx.view.furniture.stamp} onpress={(e) => furniture("stamp", e.shiftKey)} />{/if}
            <PaperKey glyph="names" label="Channel names" hotkey="C" id="channelLabels" on={!!ctx.view.furniture.channelLabels} onpress={(e) => furniture("channelLabels", e.shiftKey)} />
            <PaperKey glyph="colorbar" label="Calibration bar" hotkey="G" id="colorbar" on={!!ctx.view.furniture.colorbar} onpress={(e) => furniture("colorbar", e.shiftKey)} />
          </span>
        </div>

        {#if showMap && asset}
          <div class="card mapcard" class:hand={live.armed === "zoom"} data-fxb-map data-fxb-wheel="map">
            <FluximgNavigator {asset} manifest={ctx.manifest} view={ctx.element.view} resolved={ctx.view} crop={ctx.crop} insets={frameInsets} maxWidth={MODULE_W - 18} maxHeight={132}
              onmove={(x, y, from, phase) => { if (phase === "cancel") cancelLiveEdit(); else { panFrame(x - from.x, y - from.y, "frame-pan", from); if (phase === "end") settleLiveEdit(); } }} />
            <div class="maprow">
              <span class="zoomwords">{zoomWords}</span>
              <span class="showing">{Math.round(ctx.crop.width).toLocaleString("en-US")} × {Math.round(ctx.crop.height).toLocaleString("en-US")} px</span>
              <span class="grp">
                <PaperKey size={22} glyph="pixels" label={ctx.view.smooth ? "Pixels are smoothed · click for true pixels" : "True pixels · click to smooth"} hotkey="N" id="pixels" on={!ctx.view.smooth} onpress={toggleSmooth} />
                <PaperKey size={22} glyph="whole" label="Whole image" hotkey="⇧V" id="whole" disabled={whole} onpress={resetFrame} />
              </span>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <!-- ------------------------------------------------------------------ the rails: the image's axes -->
    {#if layout.depth && vDim}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="part" style={at(layout.depth)} onpointerdown={stop} ondblclick={stop}>
        <BoardRail dim={vDim} hotkey={keys[vDim] ?? ""} label={dimName(vDim)} vertical side={layout.depth.side} w={layout.depth.w} h={layout.depth.h} length={dimLength(ctx.manifest, vDim)} index={ctx.view.index[vDim] ?? 0}
          run={ctx.view.projection?.dim === vDim ? ctx.view.projection : null} mode={ctx.view.projection?.dim === vDim ? ctx.view.projection.mode : null} profiles={profilesOf(vDim)} axis={ctx.manifest.axes?.[vDim]}
          armed={live.armed === `pos:${vDim}` || live.armed === `run:${vDim}`} unit={ctx.manifest.axes?.[vDim]?.unit ?? ""} format={formatNumber}
          playing={live.playing?.dim === vDim} speed={live.speed} choosing={choosing === vDim} {modes} {choice}
          onplay={ctx.view.projection?.dim === vDim ? undefined : () => togglePlayback(vDim)} onspeed={stepSpeed} onproject={() => openChooser(vDim)} onmode={pickMode}
          onscrub={(index, phase) => scrub(vDim, index, phase)} onrun={(from, to, phase) => runTo(vDim, from, to, phase)} onarm={() => holdRail(vDim)} ontake={() => armLive(`pos:${vDim}`)} />
      </div>
    {/if}
    {#each hDims as dim, i (dim)}
      {@const box = layout.rows[i]}
      {#if box}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="part" style={at(box)} onpointerdown={stop} ondblclick={stop}>
          <BoardRail {dim} hotkey={keys[dim] ?? ""} label={dimName(dim)} w={box.w} h={box.h} length={dimLength(ctx.manifest, dim)} index={ctx.view.index[dim] ?? 0}
            run={ctx.view.projection?.dim === dim ? ctx.view.projection : null} mode={ctx.view.projection?.dim === dim ? ctx.view.projection.mode : null} profiles={profilesOf(dim)} axis={ctx.manifest.axes?.[dim]}
            armed={live.armed === `pos:${dim}` || live.armed === `run:${dim}`} unit={ctx.manifest.axes?.[dim]?.unit ?? ""} format={formatNumber}
            playing={live.playing?.dim === dim} speed={live.speed} choosing={choosing === dim} {modes} {choice}
            onplay={ctx.view.projection?.dim === dim ? undefined : () => togglePlayback(dim)} onspeed={stepSpeed} onproject={() => openChooser(dim)} onmode={pickMode}
            onscrub={(index, phase) => scrub(dim, index, phase)} onrun={(from, to, phase) => runTo(dim, from, to, phase)} onarm={() => holdRail(dim)} ontake={() => armLive(`pos:${dim}`)} />
        </div>
      {/if}
    {/each}

    <!-- ------------------------------------------------------------------ layers and their objects -->
    {#if layout.layers && hasLayers}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="part" style={`${at(layout.layers)};width:${LAYERS_W}px`} data-side={layout.layers.under ? "under" : layout.layers.side} onpointerdown={stop} ondblclick={stop}>
        <BoardLayers {ctx} armed={live.armed} width={LAYERS_W} maxHeight={Math.max(96, layout.layers.h)} keys={layersOwnKeys} onkeys={(on) => (layersOwnKeys = on)} onnatural={(h) => (layersH = h)} />
      </div>
    {/if}

    {#if tip && tip.text}
      <div class="tip" class:below={tip.below} style={`left:${tip.x}px;top:${tip.y}px`} role="tooltip">{tip.text}{#if tip.hk}<kbd>{tip.hk}</kbd>{/if}</div>
    {/if}
  </div>
{/if}

<style>
  /* The board is an instrument: dark by nature in every theme (like the X-ray screen), so it reads the raw ramp,
     never the remapped semantic tokens. Paper and the pink of Flux's guides are what the hand touches. */
  .fxb { --fxb-plate: #0b0b0a; --fxb-card: #1a1918; --fxb-well: #070707; --fxb-line: rgba(255, 252, 240, 0.09); --fxb-lift: inset 0 1px 0 rgba(255, 252, 240, 0.05); --fxb-paper: var(--flx-paper); --fxb-pink: var(--c-guide); --fxb-pink-hi: #ff7ab0;
    --fxb-tx: var(--flx-base-200); --fxb-tx-hi: var(--flx-paper); --fxb-tx-dim: var(--flx-base-500); --fxb-shadow: 0 10px 26px -10px rgba(0, 0, 0, 0.7), 0 2px 6px rgba(0, 0, 0, 0.4);
    position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 3; color: var(--fxb-tx); font: 12px var(--font-ui); }
  .part, .console { position: absolute; animation: fxb-in 150ms linear backwards; }
  /* The console is one plate with its modules set into it. */
  .console { box-sizing: border-box; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; border-radius: 12px; background: var(--fxb-plate); border: 1px solid var(--fxb-line); box-shadow: var(--fxb-shadow); animation-delay: 30ms; }
  .col { display: flex; flex-direction: column; gap: 4px; padding: 4px; }
  @keyframes fxb-in { from { opacity: 0; } to { opacity: 1; } }
  /* Where motion is welcome the instruments also settle into place from a few pixels out. */
  @keyframes fxb-settle { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: no-preference) { .part, .console { animation-name: fxb-settle; animation-timing-function: var(--ease-enter); } }
  .card { box-sizing: border-box; border-radius: 8px; background: var(--fxb-card); border: 1px solid var(--fxb-line); box-shadow: var(--fxb-lift); }
  .headcard { padding: 6px 6px 7px 10px; }
  .l1 { display: flex; align-items: center; gap: 8px; height: 22px; }
  /* The lamp: steady pink when what is on screen is final, hollow while a sharper frame is on its way. */
  .live { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--fxb-pink); box-shadow: 0 0 6px 0 var(--fxb-pink); }
  .live.wait { background: transparent; box-shadow: inset 0 0 0 1.5px var(--fxb-pink); }
  .ttl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 13.5px var(--font-serif); color: var(--fxb-tx-hi); }
  .l2 { display: flex; align-items: center; gap: 0; height: 15px; padding-left: 15px; overflow: hidden; white-space: nowrap; font: 10px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fxb-tx-dim); }
  .fact + .fact::before { content: "·"; margin: 0 6px; opacity: 0.6; }
  .where { display: inline-flex; gap: 12px; color: var(--fxb-tx-hi); }
  .where b { font-weight: 500; }
  .obj { margin-left: 12px; color: var(--fxb-pink-hi); overflow: hidden; text-overflow: ellipsis; }
  .bad { color: var(--c-danger); white-space: normal; }
  .keypad { display: flex; align-items: center; gap: 9px; padding: 7px 8px 8px; }
  .grp { display: inline-flex; gap: 3px; }
  .mapcard { padding: 8px 8px 7px; transition: border-color 90ms linear; }
  .mapcard.hand { border-color: color-mix(in oklab, var(--fxb-pink) 62%, transparent); }
  .mapcard :global(.nav) { margin-bottom: 7px; }
  .maprow { display: flex; align-items: center; gap: 8px; font: 10px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fxb-tx-dim); }
  .zoomwords { color: var(--fxb-tx-hi); font-weight: 600; font-size: 11px; }
  .showing { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The one label: what the thing under the pointer is, on paper, with its key. Never in the way. */
  .tip { position: absolute; z-index: 9; display: inline-flex; align-items: center; gap: 7px; padding: 0 9px; height: 21px; border-radius: 11px; background: var(--fxb-paper); border: 1px solid color-mix(in oklab, var(--c-layout-gap) 45%, transparent); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
    color: var(--flx-magenta-600); font: 600 10.5px var(--font-mono); white-space: nowrap; pointer-events: none; transform: translate(-50%, -100%); }
  .tip.below { transform: translate(-50%, 0); }
  .tip kbd { min-width: 14px; height: 14px; padding: 0 3px; border: 1px solid color-mix(in oklab, var(--flx-magenta-600) 45%, transparent); border-bottom-width: 2px; border-radius: 3px; color: var(--flx-magenta-600); font: 600 9.5px/11px var(--font-mono); }
</style>

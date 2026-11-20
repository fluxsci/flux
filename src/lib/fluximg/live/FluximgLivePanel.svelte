<script lang="ts">
  /**
   * The live view's panel: the way in to everything an image can show, in the F-menu's manner.
   *
   * It opens small, beside the image, listing the image's zones with a left-hand key each. A zone opens only when
   * asked for (a channel's histogram, the layers and their objects, the frame); the wheel drives whatever row is
   * armed; Esc backs out one level and `r` closes. It owns the keyboard and the wheel while the live view is open,
   * and does nothing itself: every change is an `actions.ts` call.
   */
  import { tick } from "svelte";
  import { get } from "svelte/store";
  import { yieldsToShellModal, isAnnotateChord } from "../../../shell/agent/annotationVisibility";
  import Logomark from "../../../shell/Logomark.svelte";
  import { project } from "../../store";
  import { fluxFigMenuOpen } from "../../settings";
  import { anchorPanel, reanchorPanel, type Point, type Rect } from "../../ui/anchor";
  import { WheelStepper, wheelDelta } from "../../interact/wheelLaw";
  import { evalExpr } from "../../num";
  import { pushToast } from "../../toast";
  import { channelTable } from "../lut";
  import { describeFluximg } from "../place";
  import { fluximgLutsReady, fluximgManifests, needLuts, resolveLut } from "../store";
  import { fullCrop } from "../still";
  import { describePosition, describeProjection, formatNumber } from "../viewOps";
  import FluximgHistogram from "./FluximgHistogram.svelte";
  import FluximgMiniHist from "./FluximgMiniHist.svelte";
  import FluximgLayerList from "./FluximgLayerList.svelte";
  import {
    LIVE_KEYS, PROJECTION_MODES, autoContrast, backOut, defaultArmed, dimKeys, dimLength, liveContext, makeInset, naturalRate, nudgeGamma,
    nudgeLayerOpacity, nudgeWindow, railDims, resetChannel, resetFrame, resizeProjection, setChannel, setProjectionMode, setWindow, soloChannel,
    splitChannels, stepPosition, toggleChannel, toggleFurniture, togglePlayback, toggleSmooth, zoomFrame, cycleFurnitureCorner,
  } from "./actions";
  import { clippedShares, formatShare } from "./histogram";
  import { armLive, cancelLiveEdit, closeFluximgLive, fluximgLive, fluximgLiveProblem, fluximgLiveRect, fluximgReadout, liveArm, livePointer, setLive, settleLiveEdit } from "./session";

  const live = $derived($fluximgLive);
  // Reading the project and manifests keeps the panel's values live through edits, undo and playback.
  const ctx = $derived.by(() => { void $project; void $fluximgManifests; return live ? liveContext() : null; });
  const dims = $derived(ctx ? railDims(ctx.manifest) : []);
  const keys = $derived(ctx ? dimKeys(ctx.manifest) : {});
  const asset = $derived(ctx ? $project.assets.find((a) => a.id === ctx.element.assetId) : undefined);
  const integer = $derived(!!ctx && ctx.manifest.pixels.encoding.kind === "exact" && !ctx.manifest.pixels.dtype.startsWith("float"));
  $effect(() => { if (live) void needLuts(); });
  const DIM_NAMES: Record<string, string> = { t: "Time", z: "Depth" };
  const dimName = (d: string): string => DIM_NAMES[d] ?? d.charAt(0).toUpperCase() + d.slice(1);
  const channel = $derived(ctx && live ? ctx.view.channels[Math.min(live.channel, ctx.view.channels.length - 1)] : null);
  const table = $derived.by(() => { void $fluximgLutsReady; return channel ? channelTable(channel, resolveLut) : new Uint8Array(1024); });
  /** What the open channel's window clips to its first and last colour, as shares of the channel's values. */
  const clipped = $derived(ctx && channel ? clippedShares(ctx.manifest.channels[channel.index].stats, channel.range) : null);
  /** A value as the panel prints it: whole numbers for integer data, five significant digits otherwise. */
  const fmt = (v: number): string => (integer ? formatNumber(Math.round(v)) : formatNumber(Number(v.toPrecision(4))));
  /** A channel's ink for small plots: its colour, or a bright entry of its colour map. */
  function inkOf(c: { color: string | null; lut: string | null }): string {
    void $fluximgLutsReady;
    if (c.color) return c.color;
    const t = c.lut ? resolveLut(c.lut) : null;
    return t?.[Math.floor(t.length * 0.72)] ?? "#cecdc3";
  }
  /** A swatch for a channel: its colour, or its colour map as a small ramp. */
  function swatch(c: { color: string | null; lut: string | null; invert?: boolean }): string {
    void $fluximgLutsReady;
    if (c.color) return `background:${c.color}`;
    const t = channelTable({ color: null, lut: c.lut, invert: !!c.invert }, resolveLut);
    const stops = [0, 64, 128, 192, 255].map((i) => `rgb(${t[i * 4]},${t[i * 4 + 1]},${t[i * 4 + 2]})`);
    return `background:linear-gradient(90deg,${stops.join(",")})`;
  }

  // --- sub-modes of a zone ----------------------------------------------------------------------
  /** `options`: a row's choices are laid out (projection mode, colour); `field`: a number is being typed. */
  let picking = $state<null | "projection" | "color">(null);
  let optIndex = $state(0);
  let draft = $state<{ key: string; text: string } | null>(null);
  /** The frame the image had when the frame zone opened: an inset restores it. */
  let frameBefore = $state.raw<{ x: number; y: number; width: number; height: number } | null>(null);
  $effect(() => { if (!live) { picking = null; draft = null; frameBefore = null; } });

  const COLORS: Array<{ label: string; color?: string; lut?: string }> = [
    { label: "gray", lut: "gray" }, { label: "green", color: "#00ff00" }, { label: "magenta", color: "#ff00ff" }, { label: "cyan", color: "#00ffff" },
    { label: "yellow", color: "#ffff00" }, { label: "red", color: "#ff0000" }, { label: "blue", color: "#4488ff" }, { label: "viridis", lut: "viridis" }, { label: "magma", lut: "magma" },
  ];
  const projectionDim = $derived(ctx ? (ctx.view.projection?.dim ?? (live?.armed?.startsWith("pos:") ? live.armed.slice(4) : dims[0])) : undefined);
  const projectionOptions = $derived([{ label: "off", mode: null }, ...PROJECTION_MODES.map((m) => ({ label: m, mode: m }))]);

  function openZone(zone: "channel" | "layers" | "frame" | "annotate", index = 0): void {
    liveArm.explicit = true; // a zone's armed row is the user's choice: it takes the wheel anywhere
    picking = null; draft = null;
    if (zone === "channel") setLive({ zone, channel: index, armed: "white" });
    else if (zone === "frame") { frameBefore = ctx ? (ctx.element.crop ? { ...ctx.element.crop } : null) : null; setLive({ zone, armed: "zoom" }); }
    else setLive({ zone, armed: null });
  }
  function home(): void { picking = null; draft = null; liveArm.explicit = false; setLive({ zone: "home", armed: defaultArmed() }); }
  // A view that just opened arms its first rail, exactly as backing out of a zone does: without it the wheel over
  // the image panned the canvas until some zone had been opened and closed. (The session cannot do this itself:
  // which rail comes first is the actions' knowledge, and the manifest may arrive a moment after the open.)
  $effect(() => { if (live && ctx && live.zone === "home" && live.armed === null && !live.playing) { const a = defaultArmed(); if (a) setLive({ armed: a }); } });
  function close(): void { closeFluximgLive(); }

  /** A scale bar needs to know how big a pixel is; without that, say so instead of switching on nothing. */
  function toggleScalebar(): void {
    const ax = ctx?.manifest.axes?.x;
    if (!ctx?.view.furniture.scalebar && !(ax && typeof ax.scale === "number" && ax.scale > 0 && ax.unit)) {
      pushToast("info", "This image does not say how big a pixel is, so it cannot draw a scale bar", { detail: "Save it with pixel_size= and a unit (fp.imsave), then it will." });
      return;
    }
    toggleFurniture("scalebar");
  }

  function pickProjection(i: number): void {
    const o = projectionOptions[i];
    if (!o || !projectionDim) return;
    setProjectionMode(projectionDim, o.mode);
    settleLiveEdit();
    picking = null;
    if (o.mode) armLive(`run:${projectionDim}`);
  }
  function pickColor(i: number): void {
    const o = COLORS[i];
    if (!o || !live) return;
    setChannel(live.channel, o.color ? { color: o.color } : { lut: o.lut });
    settleLiveEdit();
    picking = null;
  }

  // --- keyboard ---------------------------------------------------------------------------------
  function onKey(e: KeyboardEvent): void {
    if (!live || !ctx) return;
    if (yieldsToShellModal(e) || isAnnotateChord(e) || get(fluxFigMenuOpen)) return;
    if (e.ctrlKey || e.metaKey) return; // chords (undo, save, copy) stay Flux-wide
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (typing) return; // a focused field owns its keys (see onField)
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = (): void => { e.preventDefault(); e.stopImmediatePropagation(); };

    if (k === "Escape") {
      done();
      if (picking) { picking = null; return; }
      if (!backOut()) close();
      return;
    }
    if (picking) {
      const n = picking === "projection" ? projectionOptions.length : COLORS.length;
      const pick = picking === "projection" ? pickProjection : pickColor;
      if (/^[1-9]$/.test(k) && Number(k) <= n) { done(); pick(Number(k) - 1); return; }
      if (k === "ArrowRight" || k === "ArrowDown" || k === "d" || k === "s") { done(); optIndex = (optIndex + 1) % n; return; }
      if (k === "ArrowLeft" || k === "ArrowUp" || k === "a" || k === "w") { done(); optIndex = (optIndex + n - 1) % n; return; }
      if (k === "Enter" || k === " ") { done(); pick(optIndex); return; }
      done(); return; // an open choice swallows stray keys rather than firing some other row
    }
    if (k === "r" && !e.altKey && !e.shiftKey) { done(); if (!e.repeat) close(); return; }
    if (k === "f" && !e.altKey) { done(); settleLiveEdit(); fluxFigMenuOpen.set(true); return; }
    // The rails answer the arrows spatially: left / right along the first horizontal rail, up / down through depth.
    if (k.startsWith("Arrow") && live.zone !== "layers") {
      const by = e.shiftKey ? 10 : 1, horizontal = dims.find((d) => d !== "z"), vertical = dims.includes("z") ? "z" : undefined;
      if ((k === "ArrowLeft" || k === "ArrowRight") && horizontal) { done(); stepPosition(horizontal, k === "ArrowRight" ? by : -by); return; }
      if ((k === "ArrowUp" || k === "ArrowDown") && (vertical ?? horizontal)) { done(); stepPosition((vertical ?? horizontal)!, k === "ArrowDown" ? by : -by); return; }
    }
    if (k === " " && live.zone !== "layers") {
      const d = live.armed?.startsWith("pos:") ? live.armed.slice(4) : dims[0];
      done();
      // Space is a TAP for play / stop and a HOLD for Space+drag panning, as everywhere in Flux: the movie toggles when
      // the key comes up without the pointer having gone down meanwhile (and auto-repeat never toggles it).
      if (d && !e.repeat) spaceTap = d;
      return;
    }
    if (live.zone === "home") return void (homeKey(k) && done());
    if (live.zone === "channel") return void (channelKey(k) && done());
    if (live.zone === "frame") return void (frameKey(k) && done());
    if (live.zone === "annotate") return void (annotateKey(k, e.shiftKey) && done());
    // The layers zone handles its own keys (FluximgLayerList); everything else is swallowed here.
    if (live.zone !== "layers") done();
  }

  let spaceTap: string | null = null;
  function onKeyUp(e: KeyboardEvent): void {
    if (e.key !== " " || !spaceTap) return;
    const d = spaceTap;
    spaceTap = null;
    if (live && ctx) togglePlayback(d);
  }
  const cancelTap = (): void => { spaceTap = null; };

  function homeKey(k: string): boolean {
    if (!ctx) return false;
    if (/^[1-6]$/.test(k) && Number(k) <= ctx.view.channels.length) { openZone("channel", Number(k) - 1); return true; }
    for (const d of dims) if (keys[d] === k) { armLive(`pos:${d}`); return true; }
    switch (k) {
      case LIVE_KEYS.auto: autoContrast("all"); return true;
      case LIVE_KEYS.projection: if (dims.length) { picking = "projection"; optIndex = Math.max(0, projectionOptions.findIndex((o) => o.mode === (ctx.view.projection?.mode ?? null))); } return true;
      case LIVE_KEYS.layers: if (ctx.manifest.layers.length) openZone("layers"); return true;
      case LIVE_KEYS.frame: openZone("frame"); return true;
      case LIVE_KEYS.annotations: openZone("annotate"); return true;
    }
    return true; // the panel owns unmodified keys: nothing leaks to canvas shortcuts (no stray Delete or nudge)
  }
  function annotateKey(k: string, shift: boolean): boolean {
    const kind = k === LIVE_KEYS.scalebar ? "scalebar" : k === LIVE_KEYS.stamp ? "stamp" : k === LIVE_KEYS.channelNames ? "channelLabels" : k === LIVE_KEYS.colorbar ? "colorbar" : null;
    if (!kind || !ctx || (kind === "stamp" && !dims.length)) return true;
    // Shift + its key walks an annotation that is on round the corners; the plain key switches it on and off.
    if (shift && ctx.view.furniture[kind]) cycleFurnitureCorner(kind);
    else if (kind === "scalebar") toggleScalebar();
    else toggleFurniture(kind);
    return true;
  }
  const cornerWords = (corner: string): string => corner.replace("-", " ");
  function channelKey(k: string): boolean {
    if (!ctx || !live) return false;
    const i = live.channel;
    if (/^[1-6]$/.test(k) && Number(k) <= ctx.view.channels.length) { setLive({ channel: Number(k) - 1 }); return true; }
    switch (k) {
      case "q": armLive("black"); break;
      case "w": armLive("white"); break;
      case "e": armLive("gamma"); break;
      case LIVE_KEYS.split: splitChannels(); break;
      case "a": autoContrast(i); break;
      case "c": picking = "color"; optIndex = Math.max(0, COLORS.findIndex((o) => (o.color ?? null) === channel?.color && (o.lut ?? null) === channel?.lut)); break;
      case "x": toggleChannel(i); break;
      case "v": soloChannel(i); break;
      case "g": cycleNorm(); break;
      case "z": setChannel(i, { invert: channel?.invert ? (null as unknown as undefined) : true }); settleLiveEdit(); break;
      case "d": resetChannel(i); break;
    }
    return true;
  }
  function cycleNorm(): void {
    if (!channel || !live) return;
    const order = ["linear", "log", "gamma"] as const, next = order[(order.indexOf(channel.norm) + 1) % order.length];
    // A log scale needs a positive black point: say so instead of silently drawing a linear one.
    setChannel(live.channel, next === "linear" ? { norm: null as unknown as undefined } : next === "gamma" ? { norm: "gamma", gamma: channel.gamma === 1 ? 0.5 : channel.gamma } : { norm: "log" });
    settleLiveEdit();
  }
  function frameKey(k: string): boolean {
    switch (k) {
      case "d": resetFrame(); break;
      case "x": case "Enter":
        // First press: the next drag on the image draws the inset's rectangle. Pressed again: the frame as it is.
        if (live?.armed !== "inset" && k === "x") armLive("inset");
        else if (live?.armed === "inset") { if (makeInset(frameBefore)) home(); else armLive("zoom"); }
        break;
      case LIVE_KEYS.smooth: toggleSmooth(); break;
    }
    return true;
  }

  // --- wheel ------------------------------------------------------------------------------------
  const stepper = new WheelStepper();
  function onWheel(e: WheelEvent): void {
    if (!live || !ctx || e.ctrlKey || e.metaKey || get(fluxFigMenuOpen)) return; // Ctrl-wheel is always canvas zoom
    // The mouse alone: the first wheel notch over a channel's row arms that channel's white point, as the wheel
    // over an unarmed F-menu row arms it. The notch itself is spent on arming.
    const row = live.zone === "home" && e.target instanceof Element ? e.target.closest<HTMLElement>(".row.chan[data-channel]") : null;
    if (row) {
      const i = Number(row.dataset.channel);
      if (!(live.channel === i && live.armed === "white")) { e.preventDefault(); e.stopPropagation(); liveArm.explicit = true; setLive({ channel: i, armed: "white" }); stepper.reset(); return; }
    }
    const armed = live.armed;
    // Inside the panel a list scrolls; only an armed row takes the wheel there.
    const inPanel = e.target instanceof Node && !!panelEl?.contains(e.target);
    if (!armed) { if (!inPanel) return; return; }
    if (inPanel && e.target instanceof Element && e.target.closest(".scrolls") && !armed.startsWith("layer:")) return;
    // The rail the view armed by itself answers the wheel over the image and its rails only: everywhere else the
    // wheel is still the canvas's (and the panel's own, when it scrolls). A row YOU armed answers anywhere.
    if (!liveArm.explicit && !(e.target instanceof Element && e.target.closest("[data-fluximg-live], .fx-railpos"))) return;
    e.preventDefault(); e.stopPropagation();
    const notches = stepper.steps({ deltaY: wheelDelta(e), deltaMode: e.deltaMode, time: e.timeStamp });
    if (!notches) return;
    const coarse = e.shiftKey ? 10 : 1, fine = e.altKey ? 0.1 : 1;
    // Wheel DOWN moves forward through a stack (the next plane), as every stack viewer does; values go UP with wheel up.
    if (armed.startsWith("pos:")) stepPosition(armed.slice(4), -notches * coarse);
    else if (armed.startsWith("run:")) resizeProjection(notches * coarse);
    else if (armed === "black") nudgeWindow(live.channel, 0, notches * coarse, fine);
    else if (armed === "white") nudgeWindow(live.channel, 1, notches * coarse, fine);
    else if (armed === "window") nudgeWindow(live.channel, 2, notches * coarse, fine);
    else if (armed === "gamma") nudgeGamma(live.channel, notches * coarse);
    else if (armed === "zoom") zoomFrame(Math.pow(1.12, notches * coarse * fine), livePointer.at);
    else if (armed.startsWith("layer:")) nudgeLayerOpacity(armed.slice(6), notches * coarse);
  }

  // Capture phase and NOT passive: an armed row takes the wheel anywhere on screen before the canvas can pan,
  // and must be able to stop the page from scrolling (a declarative window wheel handler is passive).
  $effect(() => {
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", onWheel, { capture: true });
  });

  // --- typed values -----------------------------------------------------------------------------
  function fieldValue(key: string): string {
    if (draft?.key === key) return draft.text;
    if (!channel) return "";
    return key === "black" ? fmt(channel.range[0]) : key === "white" ? fmt(channel.range[1]) : fmt(channel.gamma);
  }
  function applyField(key: string, text: string): void {
    draft = { key, text };
    const v = evalExpr(text);
    if (v === null || !Number.isFinite(v) || !channel || !live) return;
    if (key === "black") setWindow(live.channel, [v, channel.range[1]], "field:black");
    else if (key === "white") setWindow(live.channel, [channel.range[0], v], "field:white");
    else if (v > 0) setChannel(live.channel, v === 1 ? { gamma: null as unknown as undefined, norm: null as unknown as undefined } : { norm: "gamma", gamma: v }, "field:gamma");
  }
  function onField(e: KeyboardEvent, key: string): void {
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); settleLiveEdit(); draft = null; (e.currentTarget as HTMLInputElement).blur(); void focusPanel(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelLiveEdit(); draft = null; (e.currentTarget as HTMLInputElement).blur(); void focusPanel(); }
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const s = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1);
      if (!live) return;
      draft = null;
      if (key === "gamma") nudgeGamma(live.channel, s); else nudgeWindow(live.channel, key === "black" ? 0 : 1, s, e.altKey ? 0.1 : 1);
    }
    e.stopPropagation();
  }

  // --- placement (the F-menu's law: beside the thing, never on it, never remembered) -------------
  let panelEl = $state<HTMLDivElement>();
  let pos = $state<Point>({ x: 0, y: 0 });
  let placed = $state(false);
  let avoidAtOpen: Rect | null = null;
  const pointer = { x: -1, y: -1 };
  const WIDE = 468, NARROW = 300;
  let side = "right";
  const width = $derived(live?.zone === "channel" || live?.zone === "layers" ? WIDE : NARROW);
  async function focusPanel(): Promise<void> { await tick(); panelEl?.focus({ preventScroll: true }); }
  async function place(): Promise<void> {
    placed = false;
    await tick();
    // The overlay publishes the image's box with its rails a tick after it mounts.
    for (let i = 0; i < 4 && !get(fluximgLiveRect); i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
    const el = panelEl;
    if (!el || !get(fluximgLive)) return;
    avoidAtOpen = get(fluximgLiveRect);
    // Choose the side with the WIDEST zone's width, so opening a zone never sends the panel across the image.
    const r = anchorPanel({ avoid: avoidAtOpen, point: pointer.x >= 0 ? { x: pointer.x, y: pointer.y } : null, size: { w: WIDE, h: Math.max(el.offsetHeight, 300) }, viewport: { w: window.innerWidth, h: window.innerHeight } });
    side = r.side;
    pos = { x: r.side === "left" ? r.x + (WIDE - el.offsetWidth) : r.x, y: r.y };
    placed = true;
    lastWidth = el.offsetWidth;
    void focusPanel();
  }
  let lastWidth = 0;
  function replace(): void {
    if (!placed || !panelEl) return;
    const w = panelEl.offsetWidth;
    // On the image's left the panel grows leftward (its right edge stays by the image); elsewhere it grows rightward.
    let at = pos;
    if (side === "left" && lastWidth && w !== lastWidth) at = { x: pos.x - (w - lastWidth), y: pos.y };
    lastWidth = w;
    const p = reanchorPanel(at, { avoid: get(fluximgLiveRect) ?? avoidAtOpen, size: { w, h: panelEl.offsetHeight }, viewport: { w: window.innerWidth, h: window.innerHeight } });
    if (p.x !== pos.x || p.y !== pos.y) pos = p;
  }
  const openId = $derived(live?.elementId ?? "");
  $effect(() => { if (openId) void place(); else placed = false; });
  $effect(() => {
    if (!panelEl || !placed) return;
    const observer = new ResizeObserver(replace);
    observer.observe(panelEl);
    return () => observer.disconnect();
  });

  const head = $derived.by(() => {
    if (!ctx) return null;
    const info = asset?.fluximg, px = info?.pixelSize;
    const pixel = px ? `${fmtPixel(px.x)}${px.y !== px.x ? ` × ${fmtPixel(px.y)}` : ""} ${px.unit ?? "units"} per pixel` : "";
    return { name: ctx.element.name ?? asset?.name ?? "Image", about: info ? describeFluximg(info) : "", pixel };
  });
  const fmtPixel = (v: number): string => formatNumber(Number(v.toPrecision(4)));
  const full = $derived(ctx ? fullCrop(ctx.manifest) : null);
  const frameWords = $derived.by(() => {
    if (!ctx || !full) return "";
    const c = ctx.crop;
    if (c.width >= full.width - 1e-6 && c.height >= full.height - 1e-6) return "whole image";
    return `${Math.round(c.width)} × ${Math.round(c.height)} of ${full.width} × ${full.height} px`;
  });
  const playing = $derived(live?.playing ?? null);
  const annotationWords = $derived.by(() => {
    if (!ctx) return "";
    const f = ctx.view.furniture, on: string[] = [];
    if (f.scalebar) on.push("scale bar");
    if (f.stamp) on.push("stamp");
    if (f.channelLabels) on.push("names");
    if (f.colorbar) on.push("calibration");
    return on.length ? on.join(" · ") : "none";
  });
  const objectCount = $derived(ctx ? ctx.manifest.layers.reduce((n, l) => n + (l.kind === "intensity" ? 0 : l.count ?? 0), 0) : 0);
</script>

<svelte:window onkeydown={onKey} onkeyup={onKeyUp} onpointerdowncapture={cancelTap} onblur={cancelTap} onpointermove={(e) => { pointer.x = e.clientX; pointer.y = e.clientY; }} onresize={replace} />

<!-- What is under the pointer on the image: always in this one place, always this tall, so nothing jumps. -->
{#snippet readoutStrip()}
  <div class="readout" data-fluximg-readout>
    {#if $fluximgLiveProblem}
      <span class="bad">{$fluximgLiveProblem}</span>
    {:else if $fluximgReadout}
      <span class="where">{$fluximgReadout.where}{#if $fluximgReadout.object}<span class="obj">{$fluximgReadout.object}</span>{/if}</span>
      <span class="vals">{#each $fluximgReadout.values as v (v.name)}<span class="val"><i style={`background:${v.ink}`}></i>{v.name} <b>{v.text}</b></span>{/each}</span>
    {:else if head}
      <!-- Nothing under the pointer: the strip says what the image IS (its size, its pixel, how it is stored). -->
      <span class="what">{head.about}</span>
      <span class="what">{head.pixel}</span>
    {/if}
  </div>
{/snippet}

{#if live && ctx && head}
  <div class="fxwrap">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
    <div class="fluximgPanel" class:placed bind:this={panelEl} tabindex="-1" role="dialog" aria-label="Image view" data-zone={live.zone}
      style={`left:${pos.x}px;top:${pos.y}px;width:${width}px`} onpointerdown={(e) => e.stopPropagation()}>
      <header class="menu-head">
        <span class="mark" aria-hidden="true"><Logomark size={14} /></span>
        <span class="vsep" aria-hidden="true"></span>
        <span class="ttl">{head.name}</span>
        <span class="ctx"></span>
        <button class="xbtn" onclick={close} aria-label="Close the image view">×</button>
      </header>

      {#if live.zone === "home"}
        <div class="body">
          {#each ctx.view.channels as c, i (c.index)}
            {@const shown = ctx.view.composite === "single" ? ctx.view.solo === i : c.visible}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="row chan" class:off={!shown} class:armed={live.channel === i && (live.armed === "white" || live.armed === "black")} data-key={i < 6 ? String(i + 1) : undefined} data-channel={i} onclick={() => openZone("channel", i)}>
              <span class="hk">{i < 6 ? i + 1 : "·"}</span>
              <span class="sw" style={swatch(c)}></span>
              <span class="label">{c.name}</span>
              <button class="eye" onclick={(e) => { e.stopPropagation(); toggleChannel(i); }} title={shown ? "Hide this channel" : "Show this channel"} aria-label={shown ? `Hide ${c.name}` : `Show ${c.name}`}>{shown ? "◉" : "○"}</button>
              <span class="minihist" title={`${fmt(c.range[0])} – ${fmt(c.range[1])}${c.norm === "gamma" && c.gamma !== 1 ? ` · γ ${fmt(c.gamma)}` : c.norm === "log" ? " · log" : ""}`}>
                <FluximgMiniHist stats={ctx.manifest.channels[c.index].stats} range={c.range} ink={inkOf(c)} off={!shown} />
              </span>
            </div>
          {/each}
          {#if dims.length}<div class="sep"></div>{/if}
          {#each dims as d (d)}
            {@const armed = live.armed === `pos:${d}` || live.armed === `run:${d}`}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="row" class:armed data-key={keys[d]} onclick={() => armLive(`pos:${d}`)}>
              <span class="hk">{keys[d]}</span><span class="label">{dimName(d)}</span>
              <span class="value">{ctx.view.projection?.dim === d ? describeProjection(ctx.manifest, ctx.view.projection).replace(new RegExp(`^\\S+\\s+${d}\\s+`), "") : describePosition(ctx.manifest, d, ctx.view.index[d] ?? 0).replace(new RegExp(`^${d}\\s+`), "")}</span>
            </div>
          {/each}
          {#if dims.length}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="row" class:armed={picking === "projection"} class:tall={picking === "projection"} data-key={LIVE_KEYS.projection} onclick={() => { if (picking !== "projection") { picking = "projection"; optIndex = 0; } }}>
              <span class="hk">{LIVE_KEYS.projection}</span><span class="label">Projection</span>
              {#if picking === "projection"}
                <span class="opts" role="listbox" aria-label="Projection">
                  {#each projectionOptions as o, i (o.label)}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <span class="opt" class:cur={i === optIndex} role="option" tabindex="-1" aria-selected={i === optIndex} onpointerenter={() => (optIndex = i)} onclick={(e) => { e.stopPropagation(); pickProjection(i); }}><span class="ok hk">{i + 1}</span>{o.label}</span>
                  {/each}
                </span>
              {:else}
                <span class="value" class:on={!!ctx.view.projection}>{ctx.view.projection ? `${ctx.view.projection.mode} · ${ctx.view.projection.to - ctx.view.projection.from} ${ctx.view.projection.to - ctx.view.projection.from === 1 ? "plane" : "planes"}` : "off"}</span>
              {/if}
            </div>
          {/if}
          <div class="sep"></div>
          {#if ctx.manifest.layers.length}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="row" data-key={LIVE_KEYS.layers} onclick={() => openZone("layers")}><span class="hk">{LIVE_KEYS.layers}</span><span class="label">Layers &amp; objects</span><span class="value">{ctx.manifest.layers.length}{objectCount ? ` · ${objectCount.toLocaleString("en-US")} objects` : ""} ›</span></div>
          {/if}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="row" data-key={LIVE_KEYS.frame} onclick={() => openZone("frame")}><span class="hk">{LIVE_KEYS.frame}</span><span class="label">Frame</span><span class="value">{frameWords} ›</span></div>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="row" data-key={LIVE_KEYS.annotations} onclick={() => openZone("annotate")}><span class="hk">{LIVE_KEYS.annotations}</span><span class="label">Annotations</span><span class="value">{annotationWords} ›</span></div>
        </div>
        {@render readoutStrip()}
        <div class="foot">
          {#if live.armed?.startsWith("pos:")}<span><b class="hk">↕</b> {dimName(live.armed.slice(4)).toLowerCase()}</span>{:else if live.armed?.startsWith("run:")}<span><b class="hk">↕</b> run</span>{:else if live.armed === "white"}<span><b class="hk">↕</b> white point</span>{/if}
          {#if dims.length}<span><b class="hk">␣</b> {playing ? "stop" : "play"}</span>{/if}
          <span><b class="hk">{LIVE_KEYS.auto}</b> auto</span>
          <span><b class="hk">r</b> <b class="hk">esc</b> close</span>
        </div>

      {:else if live.zone === "channel" && channel}
        <div class="body zone">
          <div class="cm-head">
            <span class="hk">{live.channel + 1}</span><span class="sw" style={swatch(channel)}></span> {channel.name}
            {#if ctx.view.channels.length > 1}<span class="tabs">{#each ctx.view.channels as c, i (c.index)}<button class="tab" class:cur={i === live.channel} onclick={() => setLive({ channel: i })}>{i + 1}</button>{/each}</span>{/if}
            <button class="back" onclick={home} title="Back to the image (Esc)">← back <span class="hk">esc</span></button>
          </div>
          <FluximgHistogram stats={ctx.manifest.channels[channel.index].stats} range={channel.range} norm={channel.norm} gamma={channel.gamma} {table} width={436}
            armed={live.armed} {integer} format={fmt}
            onarm={(which) => armLive(which)}
            onwindow={(range, phase) => { if (phase === "cancel") cancelLiveEdit(); else { setWindow(live.channel, range); if (phase === "end") settleLiveEdit(); } }} />
          <div class="fields">
            {#each [["q", "black", "Black"], ["w", "white", "White"], ["e", "gamma", "Gamma"]] as [k, id, label] (id)}
              <label class="field" class:editing={live.armed === id} data-key={k}>
                <span class="fhead"><span class="hk">{k}</span><span class="flabel">{label}</span>{#if clipped && id !== "gamma"}<span class="clip" title={id === "black" ? "The share of this channel's values at or below the black point" : "The share of this channel's values at or above the white point"}>clips {formatShare(id === "black" ? clipped.black : clipped.white)}</span>{/if}</span>
                <input class="nin" type="text" inputmode="decimal" spellcheck="false" value={fieldValue(id)}
                  onfocus={() => armLive(id)} onblur={() => { draft = null; }} oninput={(e) => applyField(id, e.currentTarget.value)} onkeydown={(e) => onField(e, id)} />
              </label>
            {/each}
          </div>
          {#if channel.norm === "gamma" && channel.gamma !== 1}<p class="note">Gamma is not 1: brightness is no longer proportional to signal. Say so in the legend.</p>{/if}
          {#if channel.norm === "log" && !(channel.range[0] > 0)}<p class="note">A log scale needs a black point above 0; until then this channel is drawn linear.</p>{/if}
          <div class="acts" class:picking={picking === "color"}>
            {#if picking === "color"}
              <span class="opts" role="listbox" aria-label="Colour">
                {#each COLORS as o, i (o.label)}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <span class="opt" class:cur={i === optIndex} role="option" tabindex="-1" aria-selected={i === optIndex} onpointerenter={() => (optIndex = i)} onclick={() => pickColor(i)}><span class="ok hk">{i + 1}</span><span class="sw" style={swatch({ color: o.color ?? null, lut: o.lut ?? null })}></span>{o.label}</span>
                {/each}
              </span>
            {:else}
              <button class="act" onclick={() => autoContrast(live.channel)}><span class="hk">a</span>Auto</button>
              <button class="act" onclick={() => { picking = "color"; optIndex = 0; }}><span class="hk">c</span>Colour</button>
              <button class="act" onclick={cycleNorm}><span class="hk">g</span>{channel.norm === "linear" ? "Linear" : channel.norm === "log" ? "Log" : "Gamma"}</button>
              <button class="act" class:on={channel.invert} onclick={() => { setChannel(live.channel, { invert: channel.invert ? (null as unknown as undefined) : true }); settleLiveEdit(); }}><span class="hk">z</span>Invert</button>
              <button class="act" class:on={ctx.view.composite === "single" ? ctx.view.solo === live.channel : channel.visible} onclick={() => toggleChannel(live.channel)}><span class="hk">x</span>Shown</button>
              <button class="act" class:on={ctx.view.composite === "single" && ctx.view.solo === live.channel} onclick={() => soloChannel(live.channel)}><span class="hk">v</span>Solo</button>
              <button class="act" onclick={() => resetChannel(live.channel)}><span class="hk">d</span>Reset</button>
              {#if ctx.view.channels.length > 1}<button class="act" onclick={splitChannels}><span class="hk">{LIVE_KEYS.split}</span>Split channels</button>{/if}
            {/if}
          </div>
        </div>
        {@render readoutStrip()}
        <div class="foot">
          <span><b class="hk">↕</b> {live.armed === "black" ? "black" : live.armed === "gamma" ? "gamma" : live.armed === "window" ? "window" : "white"}</span>
          <span>drag on the image: contrast</span>
          {#if ctx.view.channels.length > 1}<span><b class="hk">1</b>–<b class="hk">{ctx.view.channels.length}</b> channel</span>{/if}
          <span><b class="hk">esc</b> back</span>
        </div>

      {:else if live.zone === "layers"}
        <div class="body zone">
          <div class="cm-head"><span class="hk">{LIVE_KEYS.layers}</span> Layers &amp; objects<button class="back" onclick={home} title="Back to the image (Esc)">← back <span class="hk">esc</span></button></div>
          <FluximgLayerList {ctx} armed={live.armed} />
        </div>
        {@render readoutStrip()}

      {:else if live.zone === "frame"}
        <div class="body zone">
          <div class="cm-head"><span class="hk">{LIVE_KEYS.frame}</span> Frame<button class="back" onclick={home} title="Back to the image (Esc)">← back <span class="hk">esc</span></button></div>
          <div class="row static"><span class="hk">↕</span><span class="label">Showing</span><span class="value">{frameWords}</span></div>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="row" data-key="d" onclick={resetFrame}><span class="hk">d</span><span class="label">Whole image</span><span class="value"></span></div>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="row" class:armed={live.armed === "inset"} data-key="x" onclick={() => frameKey("x")}><span class="hk">x</span><span class="label">Inset</span><span class="value">{live.armed === "inset" ? "draw it on the image" : ""}</span></div>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="row" data-key={LIVE_KEYS.smooth} onclick={toggleSmooth}><span class="hk">{LIVE_KEYS.smooth}</span><span class="label">Pixels</span><span class="value">{ctx.view.smooth ? "smoothed" : "true"}</span></div>
        </div>
        {@render readoutStrip()}
        <div class="foot">{#if live.armed === "inset"}<span>drag a rectangle</span><span><b class="hk">x</b> the frame as it is</span>{:else}<span><b class="hk">↕</b> zoom</span><span>drag moves</span>{/if}<span><b class="hk">esc</b> back</span></div>

      {:else if live.zone === "annotate"}
        <div class="body zone">
          <div class="cm-head"><span class="hk">{LIVE_KEYS.annotations}</span> Annotations<button class="back" onclick={home} title="Back to the image (Esc)">← back <span class="hk">esc</span></button></div>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="row" data-key={LIVE_KEYS.scalebar} onclick={toggleScalebar}><span class="hk">{LIVE_KEYS.scalebar}</span><span class="label">Scale bar</span><span class="value" class:on={!!ctx.view.furniture.scalebar}>{ctx.view.furniture.scalebar ? cornerWords(ctx.view.furniture.scalebar.corner) : ctx.manifest.axes?.x?.unit ? "off" : "no pixel size"}</span></div>
          {#if dims.length}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="row" data-key={LIVE_KEYS.stamp} onclick={() => toggleFurniture("stamp")}><span class="hk">{LIVE_KEYS.stamp}</span><span class="label">Position stamp</span><span class="value" class:on={!!ctx.view.furniture.stamp}>{ctx.view.furniture.stamp ? cornerWords(ctx.view.furniture.stamp.corner) : "off"}</span></div>
          {/if}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="row" data-key={LIVE_KEYS.channelNames} onclick={() => toggleFurniture("channelLabels")}><span class="hk">{LIVE_KEYS.channelNames}</span><span class="label">Channel names</span><span class="value" class:on={!!ctx.view.furniture.channelLabels}>{ctx.view.furniture.channelLabels ? cornerWords(ctx.view.furniture.channelLabels.corner) : "off"}</span></div>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="row" data-key={LIVE_KEYS.colorbar} onclick={() => toggleFurniture("colorbar")}><span class="hk">{LIVE_KEYS.colorbar}</span><span class="label">Calibration bar</span><span class="value" class:on={!!ctx.view.furniture.colorbar}>{ctx.view.furniture.colorbar ? cornerWords(ctx.view.furniture.colorbar.corner) : "off"}</span></div>
        </div>
        {@render readoutStrip()}
        <div class="foot"><span><b class="hk">⇧</b> + key: next corner</span><span><b class="hk">esc</b> back</span></div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* The F-menu's surface, restated: same tokens, same anatomy (FluxFigMenu.svelte). No backdrop: the image under
     the panel stays live, and a click elsewhere on the canvas changes the selection, which closes the view. */
  .fxwrap { position: fixed; inset: 0; z-index: 295; pointer-events: none; }
  .fluximgPanel { pointer-events: auto; position: absolute; visibility: hidden; display: flex; flex-direction: column; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px);
    color: var(--c-tx); font-family: var(--font-serif); font-size: 12.5px; background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-panel); box-shadow: var(--elev-2); outline: none; overflow: hidden; }
  .fluximgPanel.placed { visibility: visible; animation: fx-in 70ms var(--ease-standard) 1; }
  @media (prefers-reduced-motion: reduce) { .fluximgPanel.placed { animation: none; } }
  @keyframes fx-in { from { opacity: 0; } to { opacity: 1; } }
  .menu-head { display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 6px 0 10px; border-bottom: 1px solid var(--c-line); background: var(--c-bg-raised); flex: none; }
  .mark { display: inline-flex; width: 14px; height: 14px; flex-shrink: 0; }
  .vsep { width: 1px; height: 14px; background: var(--c-line-strong); flex-shrink: 0; }
  .ttl { font: 600 13px var(--font-serif); color: var(--c-tx-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 40px; flex: 0 1 auto; }
  .ctx { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx-muted); font: 10.5px var(--font-mono); }
  .xbtn { width: 22px; height: 22px; padding: 0; background: none; border: 0; color: var(--c-tx-muted); font-size: 16px; cursor: var(--cursor-cross-hover); border-radius: var(--r-ui); flex: none; }
  .xbtn:hover { color: var(--c-tx-hi); background: var(--c-surface-2); }
  .hk { color: var(--c-accent); min-width: 17px; height: 16px; }
  .body { overflow-y: auto; padding: 4px 8px 8px; min-height: 0; }
  .body.zone { padding: 8px 10px 10px; }
  /* One line per row: key, name, and its current value in mono at the right (the F-menu's search-result row). */
  .row { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 8px; align-items: center; min-height: 26px; padding: 0 6px 0 4px; cursor: var(--cursor-cross-hover); }
  .row.chan { grid-template-columns: 18px 16px minmax(0, 1fr) 18px 84px; gap: 7px; }
  .row.static { cursor: var(--cursor-cross); }
  .row:not(.static):hover { background: var(--c-surface-2); }
  .row.armed { background: var(--c-accent-tint); box-shadow: inset 2px 0 0 var(--c-accent); }
  .row.armed .hk, .field.editing .hk { background: var(--c-accent-tint); }
  .row.tall { grid-template-columns: 18px auto minmax(0, 1fr); padding-top: 3px; padding-bottom: 3px; align-items: start; }
  .label { color: var(--c-tx); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.chan.off .label { color: var(--c-tx-muted); }
  .row.chan.off .sw { opacity: 0.35; }
  .value { font: 11px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--c-tx-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px; text-align: right; }
  .value.on { color: var(--c-tx-hi); }
  .sw { display: inline-block; width: 14px; height: 14px; border-radius: var(--r-ui); border: 1px solid color-mix(in oklab, var(--c-tx-hi) 18%, transparent); box-sizing: border-box; flex: none; }
  .eye { width: 18px; height: 20px; padding: 0; border: 0; background: none; color: var(--c-tx-2); font: 12px var(--font-mono); cursor: var(--cursor-cross-hover); }
  .eye:hover { color: var(--c-tx-hi); }
  .opts { display: flex; flex-wrap: wrap; gap: 3px; justify-content: flex-end; }
  .opt { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 7px 0 4px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: var(--c-bg); color: var(--c-tx-2); cursor: var(--cursor-cross-hover); font-size: 12px; white-space: nowrap; }
  .opt .ok { min-width: 15px; height: 14px; padding: 0 3px; font-size: 9px; line-height: 12px; }
  .opt.cur { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .cm-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--c-tx-hi); margin-bottom: 8px; min-height: 20px; }
  .cm-head .back { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 6px; background: none; border: 1px solid transparent; border-radius: var(--r-ui); color: var(--c-tx-muted); font: 11px var(--font-ui); cursor: var(--cursor-cross-hover); }
  .cm-head .back:hover { color: var(--c-tx-hi); border-color: var(--c-line-strong); }
  .tabs { display: inline-flex; gap: 2px; margin-left: 6px; }
  .tab { min-width: 20px; height: 18px; padding: 0 4px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: none; color: var(--c-tx-muted); font: 10px var(--font-mono); cursor: var(--cursor-cross-hover); }
  .tab.cur { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-top: 6px; }
  .field { display: flex; flex-direction: column; gap: 2px; padding: 3px 4px 4px; }
  .field.editing { background: var(--c-accent-tint); box-shadow: inset 2px 0 0 var(--c-accent); }
  .fhead { display: flex; align-items: center; gap: 6px; min-height: 16px; }
  .flabel { color: var(--c-tx); white-space: nowrap; }
  .fhead .clip { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; font: 10px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--c-tx-muted); white-space: nowrap; }
  .nin { width: 100%; height: 22px; background: var(--c-bg); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx); padding: 0 6px; font: 12px var(--font-mono); font-variant-numeric: tabular-nums; outline: none; box-sizing: border-box; text-align: right; }
  .nin:focus { border-color: var(--c-accent); }
  .acts { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .acts.picking .opts { justify-content: flex-start; }
  .act { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px 0 4px; background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); cursor: var(--cursor-cross-hover); font: 12px var(--font-serif); }
  .act:hover { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  .act.on { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .act .hk { min-width: 15px; height: 14px; font-size: 9px; }
  .note { margin: 6px 2px 0; font: 11px var(--font-ui); color: var(--c-warning); }
  .sep { height: 1px; margin: 4px 4px; background: var(--c-line); }
  .readout { display: flex; flex-direction: column; justify-content: center; gap: 1px; height: 36px; padding: 0 12px; border-top: 1px solid var(--c-line); font: 10.5px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--c-tx-2); white-space: nowrap; overflow: hidden; flex: none; }
  .readout .where { color: var(--c-tx-hi); overflow: hidden; text-overflow: ellipsis; }
  .readout .obj { margin-left: 12px; color: var(--c-accent-bright); }
  .readout .vals { display: flex; gap: 12px; overflow: hidden; }
  .readout .val { display: inline-flex; align-items: center; gap: 5px; }
  .readout .val i { width: 8px; height: 8px; border-radius: var(--r-ui); border: 1px solid color-mix(in oklab, var(--c-tx-hi) 22%, transparent); box-sizing: border-box; }
  .readout .val b { font-weight: 500; color: var(--c-tx-hi); }
  .readout .bad { color: var(--c-danger); white-space: normal; }
  .readout .what { color: var(--c-tx-muted); overflow: hidden; text-overflow: ellipsis; }
  .minihist { display: inline-flex; align-items: center; }
  .foot { display: flex; gap: 14px; min-height: 26px; align-items: center; padding: 0 10px; border-top: 1px solid var(--c-line); font: 11px var(--font-ui); color: var(--c-tx-muted); background: var(--c-bg-raised); flex: none; white-space: nowrap; overflow: hidden; }
  .foot span { display: inline-flex; align-items: center; gap: 4px; }
</style>

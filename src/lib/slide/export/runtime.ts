// ---------------------------------------------------------------------------
// Flux Slide — the EXPORT runtime (§7.1). The one entry esbuild bundles into a
// single IIFE inlined in the portable .html. It boots the SAME framework-agnostic
// player (one renderer, two hosts) over an inlined deck + assets, with no Svelte,
// no network, no Flux — just `FluxSlideRuntime.boot(mount, payload)`.
//
// Vanilla port of PresentOverlay: scale-to-fit/letterbox + the §6.1 clicker
// keymap + a click-advance + a minimal HUD. Plots are seeded into the shared
// plot cache before the player renders, so semantic parts stay animatable offline.
// ---------------------------------------------------------------------------

import { get } from "svelte/store";
import { cachePlot, plotManifests } from "../../plot/store";
import { createPlayer, renderStaticAt, type Player } from "../player/player";
import { reducePresentKey, hudModel, panelModel, clockText, NEXT_W, type PresentState } from "../present/core";
import { resolveTheme } from "../theme";
import type { Deck } from "../types";
import type { FluxPlotManifest } from "../../plot/types";

export interface ExportPayload {
  deck: Deck;
  /** assetId → { inline plot SVG, its manifest } (semantic parts stay live). */
  plots?: Record<string, { svg: string; manifest: FluxPlotManifest }>;
  /** assetId → data: URI (raster images; plot <image> fallbacks). */
  assets?: Record<string, string>;
  /** assetId → intrinsic display size (crop rendering of raster elements). */
  assetSizes?: Record<string, { width: number; height: number }>;
}

export function boot(mount: HTMLElement, payload: ExportPayload): Player {
  const { deck } = payload;
  for (const [id, p] of Object.entries(payload.plots ?? {})) cachePlot(id, p.svg, p.manifest);
  const theme = resolveTheme(deck.theme);

  mount.innerHTML = "";
  mount.style.cssText = "position:fixed;inset:0;background:#000;overflow:hidden;outline:none;";
  mount.tabIndex = 0;

  const fit = document.createElement("div");
  fit.style.cssText = "position:absolute;top:50%;left:50%;transform-origin:center center;";
  fit.style.width = `${deck.stage.width}px`;
  fit.style.height = `${deck.stage.height}px`;
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0;";
  fit.appendChild(host);
  mount.appendChild(fit);

  // HUD: progress dots + slide counter
  const hud = document.createElement("div");
  hud.style.cssText =
    "position:absolute;bottom:14px;left:0;right:0;display:flex;gap:14px;align-items:center;justify-content:center;" +
    "font:12px Georgia,serif;color:rgba(255,255,255,.45);opacity:0;transition:opacity .2s;pointer-events:none;";
  mount.appendChild(hud);
  mount.addEventListener("mousemove", () => { hud.style.opacity = "1"; clearTimeout(hudT); hudT = setTimeout(() => (hud.style.opacity = "0"), 1800); });
  let hudT: ReturnType<typeof setTimeout>;

  // Presenter panel (S): timer + position + next-slide preview + notes — the same
  // speaker support the app's present mode has, now inside the portable file (C1).
  // WS-3.3: NEXT_W comes from present/core (ONE value, both hosts — was 260
  // here vs 300 in the app); the panel widened 300→340 so the thumbnail fits.
  const nextScale = NEXT_W / deck.stage.width;
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:absolute;top:16px;right:16px;z-index:12;width:340px;max-height:94vh;display:none;flex-direction:column;gap:9px;" +
    "padding:13px 15px;background:rgba(16,16,18,.9);border:1px solid rgba(255,255,255,.12);border-radius:10px;color:rgba(255,255,255,.82);font:13px Georgia,serif;";
  const nextScaled = document.createElement("div");
  nextScaled.style.cssText = `position:absolute;top:0;left:0;width:${deck.stage.width}px;height:${deck.stage.height}px;transform:scale(${nextScale});transform-origin:0 0;`;
  mount.appendChild(panel);
  let showPanel = false, elapsed = 0;

  let reducedMotion = false;
  let player: Player;
  function buildPlayer(at: { slide: number; beat: number }) {
    player?.destroy();
    player = createPlayer(host, deck, {
      mode: "export",
      theme,
      assetUrl: (id) => payload.assets?.[id],
      assetSize: (id) => payload.assetSizes?.[id],
      plotManifest: (id) => get(plotManifests)[id],
      reducedMotion, // default OFF: a talk is meant to animate regardless of OS setting (C15)
    });
    player.on("change", () => { renderHud(); renderPanel(); });
    player.goTo(at.slide, at.beat);
    exposeHook();
    renderHud();
  }

  function fitToViewport() {
    const s = Math.min(window.innerWidth / deck.stage.width, window.innerHeight / deck.stage.height);
    fit.style.transform = `translate(-50%,-50%) scale(${s})`;
  }
  function renderHud() {
    // WS-3.3: view-model from present/core; this host string-templates it.
    const m = hudModel(player.state());
    let dots = "";
    for (const on of m.dots) dots += `<span style="width:7px;height:7px;border-radius:50%;display:inline-block;margin:0 2px;background:${on ? theme.accent : "rgba(255,255,255,.22)"}"></span>`;
    hud.innerHTML = `<span>${m.counter}</span><span>${dots}</span>`;
  }
  function renderPanel() {
    if (!showPanel) return;
    const st = player.state();
    // WS-3.3: view-model from present/core; this host string-templates it
    // (notes escaped here — innerHTML sink is host-specific).
    const pm = panelModel({
      slide: st.slide, beat: st.beat, totalSlides: st.totalSlides, totalBeats: st.totalBeats,
      notes: deck.slides[st.slide]?.notes, elapsedSec: elapsed, reducedMotion, stageWidth: deck.stage.width,
    });
    const notes = pm.notes.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));
    panel.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:baseline">` +
      `<span class="pv-clock" style="font:600 21px ui-monospace,monospace;color:#fff">${pm.clock}</span>` +
      `<span style="font-size:11px;color:rgba(255,255,255,.45)">${pm.pos}</span></div>` +
      `<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.4)">${pm.nextLabel}</div>`;
    if (pm.nextIdx >= 0) {
      const frame = document.createElement("div");
      frame.style.cssText = `position:relative;overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:6px;width:${NEXT_W}px;height:${deck.stage.height * nextScale}px;background:${deck.slides[pm.nextIdx].background ?? deck.background ?? theme.background};`;
      nextScaled.innerHTML = "";
      const inner = document.createElement("div");
      inner.style.cssText = `position:relative;width:${deck.stage.width}px;height:${deck.stage.height}px;`;
      nextScaled.appendChild(inner);
      try { renderStaticAt(inner, deck.slides[pm.nextIdx], deck.stage, Math.max(0, deck.slides[pm.nextIdx].beats.length - 1), { mode: "export", theme, assetUrl: (id) => payload.assets?.[id], assetSize: (id) => payload.assetSizes?.[id], plotManifest: (id) => get(plotManifests)[id], deckBackground: deck.background }); } catch (_e) { /* preview best-effort */ }
      frame.appendChild(nextScaled);
      panel.appendChild(frame);
    }
    const body = document.createElement("div");
    body.style.cssText = "font:15px/1.5 Georgia,serif;white-space:pre-wrap;overflow-y:auto";
    body.innerHTML = notes;
    panel.appendChild(body);
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:10px;color:rgba(255,255,255,.35);letter-spacing:.03em";
    hint.textContent = pm.hint;
    panel.appendChild(hint);
  }
  // SLD-12: the per-second timer must only update the CLOCK text — the old code
  // re-ran the whole panel render (incl. renderStaticAt of the next-slide preview:
  // importNode + KaTeX + DOM rebuild) every second. The preview only changes on
  // navigation (player "change" → renderPanel), so tick just the clock here.
  function tickClock() {
    const el = panel.querySelector(".pv-clock");
    if (el) el.textContent = clockText(elapsed);
  }
  setInterval(() => { elapsed++; if (showPanel) tickClock(); }, 1000);

  // WS-3.3: clicker semantics live in present/core's reducer — this host only
  // applies the returned state to its imperative DOM and runs the effects.
  // ("close" maps to none here: the export IS the page. Digit-jump buffer now
  // survives modifier keys, matching the app overlay.)
  let blank: HTMLElement | null = null;
  function applyBlank(want: PresentState["blank"]) {
    blank?.remove();
    blank = null;
    if (!want) return;
    blank = document.createElement("div");
    blank.style.cssText = `position:absolute;inset:0;z-index:5;background:${want === "black" ? "#000" : "#fff"};`;
    mount.appendChild(blank);
  }
  let pstate: PresentState = { blank: "", showNotes: false, digits: "", reducedMotion: false };
  function onKey(e: KeyboardEvent) {
    const r = reducePresentKey(e.key, e.shiftKey, pstate, player, deck.slides.length);
    if (r.preventDefault) e.preventDefault();
    const prev = pstate;
    pstate = r.state;
    if (pstate.blank !== prev.blank) applyBlank(pstate.blank);
    if (pstate.showNotes !== prev.showNotes) {
      showPanel = pstate.showNotes;
      panel.style.display = showPanel ? "flex" : "none";
      renderPanel();
    }
    reducedMotion = pstate.reducedMotion;
    switch (r.effect.kind) {
      case "fullscreen":
        if (document.fullscreenElement) void document.exitFullscreen();
        else mount.requestFullscreen?.();
        break;
      case "rebuild":
        buildPlayer(player.state());
        renderPanel();
        break;
      case "resetTimer":
        elapsed = 0;
        tickClock();
        break;
      // "close": nothing to exit in the portable file
    }
  }
  mount.addEventListener("keydown", onKey);
  mount.addEventListener("click", (e) => {
    // clicks on the presenter panel / video controls must not advance the deck
    const t = e.target as HTMLElement;
    if (t.closest("video") || panel.contains(t)) return;
    (e as MouseEvent).clientX < window.innerWidth * 0.25 ? player.prev() : player.next();
  });
  window.addEventListener("resize", fitToViewport);

  // §7.3 deterministic frame-step hook: a capture pass (PDF/video, a trivial
  // later add) drives goTo with animation OFF and reads resting state per frame.
  // Re-exposed after each (re)build so it always points at the live player.
  function exposeHook() {
    (window as unknown as { fluxDeck?: unknown }).fluxDeck = {
      goTo: (s: number, b: number) => player.goTo(s, b, { animate: false }),
      state: () => player.state(),
      slideCount: deck.slides.length,
      beatsOf: (s: number) => deck.slides[s]?.beats.length ?? 0,
    };
  }

  buildPlayer({ slide: 0, beat: 0 });
  fitToViewport();
  mount.focus();
  return player!;
}

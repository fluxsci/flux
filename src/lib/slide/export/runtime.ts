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
import { createPlayer, type Player } from "../player/player";
import { resolveTheme } from "../theme";
import type { Deck } from "../types";
import type { FluxPlotManifest } from "../../plot/types";

export interface ExportPayload {
  deck: Deck;
  /** assetId → { inline plot SVG, its manifest } (semantic parts stay live). */
  plots?: Record<string, { svg: string; manifest: FluxPlotManifest }>;
  /** figureId → standalone SVG markup (embedFigure). */
  figures?: Record<string, string>;
  /** assetId → data: URI (images/video). */
  assets?: Record<string, string>;
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

  const player = createPlayer(host, deck, {
    mode: "export",
    theme,
    assetUrl: (id) => payload.assets?.[id],
    figureSvg: (id) => payload.figures?.[id],
    plotManifest: (id) => get(plotManifests)[id],
  });

  function fitToViewport() {
    const s = Math.min(window.innerWidth / deck.stage.width, window.innerHeight / deck.stage.height);
    fit.style.transform = `translate(-50%,-50%) scale(${s})`;
  }
  function renderHud() {
    const st = player.state();
    let dots = "";
    for (let i = 0; i < st.totalBeats; i++) dots += `<span style="width:7px;height:7px;border-radius:50%;display:inline-block;margin:0 2px;background:${i <= st.beat ? theme.accent : "rgba(255,255,255,.22)"}"></span>`;
    hud.innerHTML = `<span>${st.slide + 1} / ${st.totalSlides}</span><span>${dots}</span>`;
  }
  player.on("change", renderHud);

  let blank: HTMLElement | null = null;
  function toggleBlank(color: string) {
    if (blank) { blank.remove(); blank = null; return; }
    blank = document.createElement("div");
    blank.style.cssText = `position:absolute;inset:0;z-index:5;background:${color};`;
    mount.appendChild(blank);
  }
  let digits = "";
  function onKey(e: KeyboardEvent) {
    const k = e.key;
    if (blank && !/^[bBwW]$/.test(k)) { blank.remove(); blank = null; }
    if (/^[0-9]$/.test(k)) { digits += k; return; }
    if (k === "Enter" && digits) { player.goTo(Math.max(0, Math.min(deck.slides.length - 1, +digits - 1)), 0); digits = ""; return; }
    digits = "";
    switch (k) {
      case "ArrowRight": case " ": case "PageDown": e.preventDefault(); e.shiftKey ? player.nextSlide() : player.next(); break;
      case "ArrowLeft": case "Backspace": case "PageUp": e.preventDefault(); e.shiftKey ? player.prevSlide() : player.prev(); break;
      case "ArrowDown": e.preventDefault(); player.nextSlide(); break;
      case "ArrowUp": e.preventDefault(); player.prevSlide(); break;
      case "Home": player.goTo(0, 0); break;
      case "End": player.goTo(deck.slides.length - 1, 0); break;
      case "b": case "B": toggleBlank("#000"); break;
      case "w": case "W": toggleBlank("#fff"); break;
      case "f": case "F": document.fullscreenElement ? document.exitFullscreen() : mount.requestFullscreen?.(); break;
    }
  }
  mount.addEventListener("keydown", onKey);
  mount.addEventListener("click", (e) => { (e as MouseEvent).clientX < window.innerWidth * 0.25 ? player.prev() : player.next(); });
  window.addEventListener("resize", fitToViewport);

  // §7.3 deterministic frame-step hook: a capture pass (PDF/video, a trivial
  // later add) drives goTo with animation OFF and reads resting state per frame.
  (window as unknown as { fluxDeck?: unknown }).fluxDeck = {
    goTo: (s: number, b: number) => player.goTo(s, b, { animate: false }),
    state: () => player.state(),
    slideCount: deck.slides.length,
    beatsOf: (s: number) => deck.slides[s]?.beats.length ?? 0,
  };

  fitToViewport();
  renderHud();
  mount.focus();
  return player;
}

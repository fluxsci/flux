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
import { resolveTheme } from "../theme";
import type { Deck } from "../types";
import type { FluxPlotManifest } from "../../plot/types";

export interface ExportPayload {
  deck: Deck;
  /** assetId → { inline plot SVG, its manifest } (semantic parts stay live). */
  plots?: Record<string, { svg: string; manifest: FluxPlotManifest }>;
  /** figureId (or "figureId::groupId" for group-scoped embeds) → standalone SVG markup. */
  figures?: Record<string, string>;
  /** figureId → memberElementId → {type, name?, plot assetId} — lets the
   *  runtime resolve "el:<mid>/<partId>" tracks via the member plot manifest
   *  (which rides in `plots` keyed by that assetId). */
  figureMembers?: Record<string, Record<string, { type: string; name?: string; assetId?: string }>>;
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

  // Presenter panel (S): timer + position + next-slide preview + notes — the same
  // speaker support the app's present mode has, now inside the portable file (C1).
  const NEXT_W = 260;
  const nextScale = NEXT_W / deck.stage.width;
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:absolute;top:16px;right:16px;z-index:12;width:300px;max-height:94vh;display:none;flex-direction:column;gap:9px;" +
    "padding:13px 15px;background:rgba(16,16,18,.9);border:1px solid rgba(255,255,255,.12);border-radius:10px;color:rgba(255,255,255,.82);font:13px Georgia,serif;";
  const nextScaled = document.createElement("div");
  nextScaled.style.cssText = `position:absolute;top:0;left:0;width:${deck.stage.width}px;height:${deck.stage.height}px;transform:scale(${nextScale});transform-origin:0 0;`;
  mount.appendChild(panel);
  let showPanel = false, elapsed = 0;
  const twoDig = (n: number) => String(n).padStart(2, "0");

  let reducedMotion = false;
  let player: Player;
  function buildPlayer(at: { slide: number; beat: number }) {
    player?.destroy();
    player = createPlayer(host, deck, {
      mode: "export",
      theme,
      assetUrl: (id) => payload.assets?.[id],
      figureSvg: (id, gid) => payload.figures?.[gid ? `${id}::${gid}` : id],
      plotManifest: (id) => get(plotManifests)[id],
      figureMember: (fid, mid) => payload.figureMembers?.[fid]?.[mid],
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
    const st = player.state();
    let dots = "";
    for (let i = 0; i < st.totalBeats; i++) dots += `<span style="width:7px;height:7px;border-radius:50%;display:inline-block;margin:0 2px;background:${i <= st.beat ? theme.accent : "rgba(255,255,255,.22)"}"></span>`;
    hud.innerHTML = `<span>${st.slide + 1} / ${st.totalSlides}</span><span>${dots}</span>`;
  }
  function renderPanel() {
    if (!showPanel) return;
    const st = player.state();
    const s = deck.slides[st.slide];
    const nextIdx = st.slide + 1 < deck.slides.length ? st.slide + 1 : -1;
    const notes = (s?.notes || "No notes for this slide.").replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));
    const clock = `${Math.floor(elapsed / 60)}:${twoDig(elapsed % 60)}`;
    panel.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:baseline">` +
      `<span class="pv-clock" style="font:600 21px ui-monospace,monospace;color:#fff">${clock}</span>` +
      `<span style="font-size:11px;color:rgba(255,255,255,.45)">slide ${st.slide + 1}/${st.totalSlides} · beat ${st.beat + 1}/${st.totalBeats}</span></div>` +
      `<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.4)">${nextIdx >= 0 ? "Next" : "End of deck"}</div>`;
    if (nextIdx >= 0) {
      const frame = document.createElement("div");
      frame.style.cssText = `position:relative;overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:6px;width:${NEXT_W}px;height:${deck.stage.height * nextScale}px;background:${deck.slides[nextIdx].background ?? theme.background};`;
      nextScaled.innerHTML = "";
      const inner = document.createElement("div");
      inner.style.cssText = `position:relative;width:${deck.stage.width}px;height:${deck.stage.height}px;`;
      nextScaled.appendChild(inner);
      try { renderStaticAt(inner, deck.slides[nextIdx], deck.stage, Math.max(0, deck.slides[nextIdx].beats.length - 1), { mode: "export", theme, assetUrl: (id) => payload.assets?.[id], figureSvg: (id, gid) => payload.figures?.[gid ? `${id}::${gid}` : id], plotManifest: (id) => get(plotManifests)[id], figureMember: (fid, mid) => payload.figureMembers?.[fid]?.[mid] }); } catch (_e) { /* preview best-effort */ }
      frame.appendChild(nextScaled);
      panel.appendChild(frame);
    }
    const body = document.createElement("div");
    body.style.cssText = "font:15px/1.5 Georgia,serif;white-space:pre-wrap;overflow-y:auto";
    body.innerHTML = notes;
    panel.appendChild(body);
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:10px;color:rgba(255,255,255,.35);letter-spacing:.03em";
    hint.textContent = `S notes · M motion ${reducedMotion ? "off" : "on"} · B/W blank · R reset · F full`;
    panel.appendChild(hint);
  }
  // SLD-12: the per-second timer must only update the CLOCK text — the old code
  // re-ran the whole panel render (incl. renderStaticAt of the next-slide preview:
  // importNode + KaTeX + DOM rebuild) every second. The preview only changes on
  // navigation (player "change" → renderPanel), so tick just the clock here.
  function tickClock() {
    const el = panel.querySelector(".pv-clock");
    if (el) el.textContent = `${Math.floor(elapsed / 60)}:${twoDig(elapsed % 60)}`;
  }
  setInterval(() => { elapsed++; if (showPanel) tickClock(); }, 1000);

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
      case "s": case "S": showPanel = !showPanel; panel.style.display = showPanel ? "flex" : "none"; renderPanel(); break;
      case "r": case "R": elapsed = 0; tickClock(); break;
      case "m": case "M": reducedMotion = !reducedMotion; buildPlayer(player.state()); renderPanel(); break;
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

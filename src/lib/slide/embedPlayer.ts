import { prefersReducedMotion } from "../motion/motion";
import { createPlayer, type Player } from "./player/player";
import { embedPlayerOptions, namespaceEmbedDeck } from "./embedRender";
import type { ExportPayload } from "./payload";

export const SLIDE_EMBED_CSS = `.flux-slide-embed{display:block;position:relative;max-width:100%;margin:16px auto;color:inherit;contain:layout style}.flux-slide-art{position:relative;overflow:hidden;width:100%;outline-offset:3px}.flux-slide-fit{position:absolute;left:0;top:0;transform-origin:0 0}.flux-slide-bar{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:4px;padding:7px 0;font:11px system-ui,sans-serif;min-height:30px}.flux-slide-bar button,.flux-slide-sizes button{font:inherit;color:inherit;border:1px solid #8886;background:transparent;border-radius:4px;padding:3px 5px;cursor:pointer;white-space:nowrap}.flux-slide-bar button:disabled{opacity:.35;cursor:default}.flux-slide-title{flex:1;min-width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.flux-slide-caption{font:inherit;margin:4px 0 10px;white-space:pre-wrap}.flux-slide-error{padding:14px;border:1px solid #c95454;border-radius:4px;font:13px system-ui}.flux-slide-poster{display:none;width:100%;height:auto}.flux-slide-status{font:12px system-ui;opacity:.8}.flux-slide-sizes{display:flex;flex-wrap:wrap;justify-content:center;gap:4px;font:11px system-ui;opacity:.7}.flux-slide-sizes:hover,.flux-slide-sizes:focus-within{opacity:1}.flux-slide-grip{position:absolute;right:-4px;top:0;height:calc(100% - 42px);width:9px;cursor:ew-resize;touch-action:none}.flux-slide-grip:hover{background:#8884}@media print{.flux-slide-art,.flux-slide-bar,.flux-slide-sizes,.flux-slide-grip{display:none!important}.flux-slide-poster{display:block}.flux-slide-embed{break-inside:avoid}}`;
let sequence = 0;
export interface EmbedPlaybackState { beatId: string; reduced?: boolean }
export interface EmbedPlayerOptions { state?: EmbedPlaybackState; onState?: (state: EmbedPlaybackState) => void; onOpen?: () => void; onEscape?: () => void }
export interface SlideEmbedPlayer { player: Player; pauseOffscreen(): void; destroy(): void }
export function mountSlideEmbed(host: HTMLElement, payload: ExportPayload, options: EmbedPlayerOptions = {}): SlideEmbedPlayer {
  const deck = namespaceEmbedDeck(payload.deck, `slideembed-${++sequence}`), slide = deck.slides[0];
  host.replaceChildren();
  const art = document.createElement("div"); art.className = "flux-slide-art"; art.tabIndex = 0;
  art.setAttribute("role", "group"); art.setAttribute("aria-label", `${slide.name || "Slide"} animation. Right arrow advances; left arrow goes back.`);
  art.style.aspectRatio = `${deck.stage.width}/${deck.stage.height}`;
  const fit = document.createElement("div"); fit.className = "flux-slide-fit";
  art.append(fit); host.append(art);
  const bar = document.createElement("div"); bar.className = "flux-slide-bar";
  const title = document.createElement("span"); title.className = "flux-slide-title"; title.textContent = `${deck.title} · ${slide.name || "Slide"}`; bar.append(title);
  const button = (text: string, label: string, action: () => void) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.title = label; b.setAttribute("aria-label", label); b.addEventListener("click", e => { e.stopPropagation(); action(); }); bar.append(b); return b; };
  let reduced = options.state?.reduced ?? prefersReducedMotion();
  const player = createPlayer(fit, deck, embedPlayerOptions(payload));
  const advance = () => player.next({ animate: !reduced });
  const back = button("‹", "Previous animation step", () => player.prev());
  const status = document.createElement("span"); status.setAttribute("aria-live", "polite"); bar.append(status);
  const next = button("›", "Next animation step", advance);
  const media = button("Pause video", "Pause or resume video clips", () => { if (player.state().mediaPlaying) player.pause(); else player.resume(); });
  const reset = button("↺", "Reset to step 0", () => player.goTo(0, 0));
  const motion = button("Animation", "Toggle animation", () => { reduced = !reduced; if (player.state().playing) player.goTo(0, player.state().beat); update(); });
  if (options.onOpen) button("↗", "Open in Slide", options.onOpen);
  host.append(bar);
  const issues = document.createElement("div"); issues.className = "flux-slide-status"; host.append(issues);
  const update = () => {
    const s = player.state(), count = Math.max(0, slide.beats.length - 1);
    back.disabled = reset.disabled = s.beat === 0;
    next.disabled = s.beat >= count && !s.playing;
    media.hidden = !s.mediaPlaying && !s.mediaPaused;
    media.textContent = s.mediaPlaying ? "Pause video" : "Resume video";
    motion.setAttribute("aria-pressed", String(!reduced));
    if (!s.playing) status.textContent = `Step ${s.beat} / ${count}`;
    for (const el of [back, next, reset, motion, status]) el.hidden = count === 0;
    issues.textContent = s.issues.map(i => i.reason).filter((v, i, a) => a.indexOf(v) === i).join(" ");
    options.onState?.({ beatId: slide.beats[s.beat]?.id ?? "", reduced });
  };
  player.on("change", update);
  if (options.state) player.goTo(0, Math.max(0, slide.beats.findIndex(b => b.id === options.state!.beatId)));
  update();
  const click = () => advance(); art.addEventListener("click", click);
  const key = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof HTMLButtonElement && ["Enter", " "].includes(e.key)) { e.stopPropagation(); return; }
    const action = e.key === "ArrowRight" || e.key === "Enter" || e.key === " " ? advance : e.key === "ArrowLeft" ? () => player.prev() : e.key === "Home" ? () => player.goTo(0, 0) : e.key === "Escape" ? options.onEscape : undefined;
    if (action) { e.preventDefault(); e.stopPropagation(); action(); }
  }; host.addEventListener("keydown", key);
  const resize = () => { fit.style.transform = `scale(${art.clientWidth / deck.stage.width})`; };
  const ro = new ResizeObserver(resize); ro.observe(art); resize();
  return { player, pauseOffscreen: () => player.pause(), destroy: () => { ro.disconnect(); host.removeEventListener("keydown", key); art.removeEventListener("click", click); player.destroy(); host.replaceChildren(); } };
}

/** Offline enhancement host. No editor stores, presentation HUD, or global clicker keys. */
import { mountSlideEmbed, type EmbedPlaybackState, type SlideEmbedPlayer } from "./embedPlayer";
import type { ExportPayload } from "./payload";
interface Data { live: boolean; documentKey: string; payloads: Record<string, ExportPayload>; occurrences: { id: string; source: string }[] }
export function boot(): void {
  const node = document.getElementById("flux-slide-data");
  if (!node) return;
  const data = JSON.parse(node.textContent || "{}") as Data;
  const states: Record<string, EmbedPlaybackState & { source: string }> = {};
  const players = new Map<string, SlideEmbedPlayer>();
  let ready = !data.live || parent === window;
  const publish = () => { if (data.live && parent !== window) parent.postMessage({ fluxSlideStates: states, documentKey: data.documentKey }, "*"); };
  const visible = new Set<string>();
  const mount = (id: string) => {
    if (!ready || players.has(id)) return;
    const ref = data.occurrences.find(r => r.id === id), host = document.getElementById(id)?.querySelector<HTMLElement>(".flux-slide-live");
    if (!ref || !host) return;
    try {
      const controller = mountSlideEmbed(host, data.payloads[ref.source], { state: states[id]?.source === ref.source ? states[id] : undefined,
        onState: value => { states[id] = { ...value, source: ref.source }; publish(); } });
      players.set(id, controller);
      document.getElementById(id)?.classList.add("flux-slide-enhanced");
    } catch (e) { const message = document.createElement("div"); message.className = "flux-slide-error"; message.textContent = `Slide unavailable: ${String(e)}`; host.replaceChildren(message); }
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).id;
      if (entry.isIntersecting) { visible.add(id); mount(id); }
      else { visible.delete(id); const p = players.get(id); p?.pauseOffscreen(); p?.destroy(); players.delete(id); document.getElementById(id)?.classList.remove("flux-slide-enhanced"); }
    }
  }, { rootMargin: "200px" });
  for (const ref of data.occurrences) { const el = document.getElementById(ref.id); if (el) observer.observe(el); }
  const restore = (e: MessageEvent) => {
    if (!data.live || e.source !== parent || e.data?.documentKey !== data.documentKey || !e.data?.fluxSlideRestore) return;
    for (const ref of data.occurrences) {
      const value = e.data.fluxSlideRestore[ref.id];
      if (value && value.source === ref.source && typeof value.beatId === "string") states[ref.id] = { source: ref.source, beatId: value.beatId, reduced: value.reduced === true };
    }
    ready = true; for (const id of visible) mount(id);
  };
  window.addEventListener("message", restore);
  const visibility = () => { if (document.hidden) for (const p of players.values()) p.pauseOffscreen(); };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", event => {
    observer.disconnect(); window.removeEventListener("message", restore);
    document.removeEventListener("visibilitychange", visibility);
    for (const [id, p] of players) { p.destroy(); document.getElementById(id)?.classList.remove("flux-slide-enhanced"); }
    players.clear();
    if (event.persisted) window.addEventListener("pageshow", () => boot(), { once: true });
  }, { once: true });
}
boot();

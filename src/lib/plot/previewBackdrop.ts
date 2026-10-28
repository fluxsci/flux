// Every source-image preview uses the same ink-aware backdrop law as the Plots rail.
// Keep the full-resolution image for zooming; acquire only a small cached raster's analysis.
import { fileBridge } from "../project/types";
import { acquireThumb, type ThumbState } from "../plotsRail/thumbClient";
import { railPrefs } from "../plotsRail/railPrefs";
import { derived } from "svelte/store";
import { project, activeFigureId } from "../store";
import { chooseBackdrop, backdropTone, BACKDROPS, type BackdropMode } from "../plotsRail/rules";

export interface PreviewBackdropOptions { path: string; destination?: string | null; stamp?: string; version?: unknown }
const activeBackground = derived([project, activeFigureId], ([$project, $active]) => $project.figures.find(f => f.id === $active)?.background ?? null);

export function previewBackdrop(node: HTMLElement, initial: PreviewBackdropOptions) {
  const original = { color: node.style.backgroundColor, image: node.style.backgroundImage, size: node.style.backgroundSize };
  let options = initial, generation = 0, release: (() => void) | undefined;
  let mode: BackdropMode = "auto", thumb: ThumbState | null = null;
  let destination: string | null = null, releaseDestination: (() => void) | undefined;
  function paint() {
    if (!options.path) {
      delete node.dataset.backdrop;
      node.style.backgroundColor = original.color; node.style.backgroundImage = original.image; node.style.backgroundSize = original.size;
      node.classList.remove("cursor-on-light", "cursor-on-dark");
      return;
    }
    const choice = chooseBackdrop(thumb?.stats, { manifestPaper: thumb?.paper, mode, destination: options.destination === undefined ? destination : options.destination });
    node.dataset.backdrop = choice.kind;
    node.style.backgroundColor = choice.kind === "checker" ? "#8f8d87" : choice.color || BACKDROPS.paper;
    node.style.backgroundImage = choice.kind === "checker" ? "conic-gradient(#a7a59e 25%, transparent 0 50%, #a7a59e 0 75%, transparent 0)" : "none";
    node.style.backgroundSize = choice.kind === "checker" ? "16px 16px" : "auto";
    node.classList.toggle("cursor-on-light", backdropTone(choice) === "light");
    node.classList.toggle("cursor-on-dark", backdropTone(choice) !== "light");
  }
  function followDestination() {
    if (options.path && mode === "destination" && options.destination === undefined) {
      releaseDestination ??= activeBackground.subscribe(value => { destination = value; paint(); });
    } else { releaseDestination?.(); releaseDestination = undefined; }
  }
  const unsubscribe = railPrefs.subscribe(p => { mode = p.backdrop; followDestination(); paint(); });
  async function load() {
    const mine = ++generation, path = options.path;
    release?.(); release = undefined; thumb = null; paint();
    if (!path || !/\.(svg|png|jpe?g|gif|webp)$/i.test(path)) return;
    let stamp = options.stamp || "?";
    if (!options.stamp) {
      try { const st = await fileBridge()?.stat?.(path); if (st) stamp = `${st.size}:${st.mtimeMs}`; } catch { /* readable fallback stays paper */ }
    }
    if (mine !== generation) return;
    release = acquireThumb(path, stamp, 256, 1, 0, value => { if (mine === generation) { thumb = value; paint(); } });
  }
  void load();
  return {
    update(next: PreviewBackdropOptions) {
      const changed = next.path !== options.path || next.stamp !== options.stamp || next.version !== options.version;
      options = next;
      followDestination();
      if (changed) void load(); else paint();
    },
    destroy() { generation++; release?.(); releaseDestination?.(); unsubscribe(); },
  };
}

<script lang="ts">
  // The Figure editor's left rail: a 28 px tab row — [Layers | Plots], and in the Plots view the
  // destination chip (where Enter / double-click place plots; also the figure switcher, since the
  // Figures list is in the other view) and the ⋯ view menu — over either view. Alt+G and the tabs
  // switch views; each view keeps its own width (FigureMode).
  import { get } from "svelte/store";
  import Sidebar from "../Sidebar.svelte";
  import PlotsRail from "./PlotsRail.svelte";
  import RailMenu, { type RailMenuItem } from "./RailMenu.svelte";
  import { figureLayout } from "../figureLayoutStore";
  import { railPrefs, TILE_H_MIN, TILE_H_MAX } from "./railPrefs";
  import { insertFlash } from "./insert";
  import { project, activeFigureId, activeCanvasId, setActiveCanvas, importerOpen, embeddedProjectRoot, projectDir } from "../store";
  import { centerOnFigure } from "../viewportNav";
  import { familyById, shortBadge } from "../figfamily";
  import type { HitBridgeHolder } from "../interact/canvasHitBridge";

  let { paneActive = true, hitBridge = null }: { paneActive?: boolean; hitBridge?: HitBridgeHolder | null } = $props();

  const view = $derived($figureLayout.leftView);
  const destination = $derived($project.figures.find((f) => f.id === $activeFigureId) ?? null);
  const destLabel = $derived(destination ? (destination.nickname || destination.name || "Figure") : "No figure");
  let menu = $state<{ x: number; y: number; items: RailMenuItem[]; label: string } | null>(null);
  let refreshKey = $state(0);
  let flash = $state(false);
  let lastFlash = get(insertFlash);
  $effect(() => {
    const n = $insertFlash;
    if (n === lastFlash) return;
    lastFlash = n;
    flash = true;
    const t = setTimeout(() => { flash = false; }, 90);
    return () => clearTimeout(t);
  });

  function setView(v: "layers" | "plots") {
    figureLayout.update((l) => ({ ...l, leftView: v }));
  }
  function destinationMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: RailMenuItem[] = [];
    for (const c of $project.canvases) {
      const figs = $project.figures.filter((f) => f.canvasId === c.id);
      if (!figs.length) continue;
      if ($project.canvases.length > 1) items.push({ kind: "heading", label: c.name });
      for (const f of figs) items.push({
        kind: "action",
        label: `${shortBadge(familyById(f.family, $project.figureFamilies), f.number ?? 0)}  ${f.nickname || f.name}`,
        checked: f.id === $activeFigureId,
        run: () => { if (get(activeCanvasId) !== f.canvasId) setActiveCanvas(f.canvasId); activeFigureId.set(f.id); requestAnimationFrame(() => centerOnFigure(f.id)); },
      });
    }
    if (!items.length) items.push({ kind: "heading", label: "No figures yet" });
    menu = { x: r.left, y: r.bottom + 2, items, label: "Place plots in" };
  }
  function viewMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const p = $railPrefs;
    const set = (patch: Partial<typeof p>) => railPrefs.update((v) => ({ ...v, ...patch }));
    menu = { x: r.right - 220, y: r.bottom + 2, label: "Plots view", items: [
      { kind: "heading", label: "Sort" },
      { kind: "action", label: "By folder", checked: p.sort === "folders", run: () => set({ sort: "folders" }) },
      { kind: "action", label: "Recent first", checked: p.sort === "recent", run: () => set({ sort: "recent" }) },
      { kind: "heading", label: "Tiles" },
      { kind: "slider", label: "Size", min: TILE_H_MIN, max: TILE_H_MAX, step: 4, value: p.tileH, set: (v) => set({ tileH: v }) },
      { kind: "action", label: "Show names", checked: p.names, run: () => set({ names: !p.names }) },
      { kind: "heading", label: "Backdrop" },
      { kind: "action", label: "Automatic", hint: "every element visible", checked: p.backdrop === "auto", run: () => set({ backdrop: "auto" }) },
      { kind: "action", label: "Paper", checked: p.backdrop === "paper", run: () => set({ backdrop: "paper" }) },
      { kind: "action", label: "Dark", checked: p.backdrop === "dark", run: () => set({ backdrop: "dark" }) },
      { kind: "action", label: "Checkerboard", checked: p.backdrop === "checker", run: () => set({ backdrop: "checker" }) },
      { kind: "action", label: "The figure's background", checked: p.backdrop === "destination", run: () => set({ backdrop: "destination" }) },
      { kind: "separator" },
      { kind: "action", label: "Reveal the selected plot", hint: "auto", checked: p.autoReveal, run: () => set({ autoReveal: !p.autoReveal }) },
      { kind: "action", label: "Refresh", run: () => { refreshKey++; } },
      { kind: "action", label: "Open the full gallery", hint: "Shift+Alt+G", disabled: !($embeddedProjectRoot || $projectDir), run: () => importerOpen.set(true) },
    ] };
  }
</script>

<div class="left-rail" data-left-rail={view}>
  <div class="rail-tabs" role="tablist" aria-label="Left rail">
    <button role="tab" class="rail-tab" aria-selected={view === "layers"} class:chosen={view === "layers"} title="Canvases, figures and layers" onclick={() => setView("layers")} data-rail-tab="layers">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 14 5 8 8 2 5Z"/><path d="M2 8l6 3 6-3"/><path d="M2 11l6 3 6-3"/></svg><span class="lbl">Layers</span>
    </button>
    <button role="tab" class="rail-tab" aria-selected={view === "plots"} class:chosen={view === "plots"} title="Plot gallery and dissections (Alt+G)" onclick={() => setView("plots")} data-rail-tab="plots">
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/></svg><span class="lbl">Plots</span>
    </button>
    {#if view === "plots"}
      <span class="grow"></span>
      <button class="dest" class:flash disabled={!destination && !$project.figures.length} title={destination ? `Plots go into ${destLabel} — click to choose another figure` : "No figure to place plots in"} onclick={destinationMenu} data-rail-destination>→ <span class="dn">{destLabel}</span> ▾</button>
      <button class="more" title="View options" aria-label="Plots view options" onclick={viewMenu} data-rail-menu>⋯</button>
    {/if}
  </div>
  {#if view === "plots"}
    <PlotsRail active={paneActive} {hitBridge} {refreshKey} />
  {:else}
    <Sidebar {paneActive} />
  {/if}
  {#if menu}<RailMenu items={menu.items} x={menu.x} y={menu.y} label={menu.label} onClose={() => (menu = null)} />{/if}
</div>

<style>
  .left-rail { display: flex; flex-direction: column; width: var(--sb-w, 200px); flex: 0 0 var(--sb-w, 200px); min-height: 0; background: var(--c-bg-raised); border-right: 1px solid var(--c-line); }
  .rail-tabs { display: flex; align-items: center; gap: 2px; height: 28px; flex-shrink: 0; padding: 0 4px; border-bottom: 1px solid var(--c-line); }
  .rail-tab { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 7px; border: 0; border-radius: var(--r-ui); background: none; color: var(--c-tx-muted); font: 11.5px var(--font-ui); cursor: var(--cursor-cross-hover); }
  .rail-tab svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.2; }
  .rail-tab:hover { color: var(--c-tx-hi); }
  .rail-tab.chosen { color: var(--c-tx-hi); background: var(--c-accent-tint); box-shadow: inset 0 -2px 0 var(--c-accent); }
  .grow { flex: 1; }
  .dest { display: inline-flex; align-items: center; gap: 3px; min-width: 0; max-width: 55%; height: 20px; padding: 0 6px; border: 1px solid var(--c-line); border-radius: var(--r-ui); background: none; color: var(--c-tx-2); font: 11px var(--font-ui); white-space: nowrap; cursor: var(--cursor-cross-hover); transition: background-color 90ms linear; }
  .dest:hover:not(:disabled) { border-color: var(--c-line-strong); color: var(--c-tx-hi); }
  .dest.flash { background: var(--c-accent-tint); border-color: var(--c-accent); }
  .dest .dn { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .more { width: 22px; height: 20px; flex: 0 0 22px; padding: 0; border: 0; border-radius: var(--r-ui); background: none; color: var(--c-tx-muted); font-size: 14px; line-height: 1; cursor: var(--cursor-cross-hover); }
  .more:hover { color: var(--c-tx-hi); background: var(--c-surface-2); }
  @container (max-width: 239px) { .lbl { display: none; } }
  .left-rail { container-type: inline-size; }
  @media (prefers-reduced-motion: reduce) { .dest { transition: none; } }
</style>

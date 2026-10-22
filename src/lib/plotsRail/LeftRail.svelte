<script lang="ts">
  // A mode's left rail with the Plots view beside the mode's own view: a 28 px tab row —
  // Figure: [Layers | Plots], Slide: [Slides | Plots] — and, in the Plots view, the destination
  // chip (where Enter / double-click place plots; also the figure / slide switcher, since the
  // mode's own list is in the other view) and the ⋯ view menu. Alt+G and the tabs switch views;
  // each view keeps its own width (the mode sets --sb-w).
  import { get } from "svelte/store";
  import type { Snippet } from "svelte";
  import Sidebar from "../Sidebar.svelte";
  import PlotsRail from "./PlotsRail.svelte";
  import RailMenu, { type RailMenuItem } from "./RailMenu.svelte";
  import { figureLayout } from "../figureLayoutStore";
  import { railPrefs, TILE_H_MIN, TILE_H_MAX, type RailPrefs } from "./railPrefs";
  import { insertFlash, destinationName, type PlaceAdapter } from "./insert";
  import { freshPlots, clearFresh } from "./plotIndex";
  import { project, activeFigureId, activeCanvasId, setActiveCanvas, importerOpen, importerPinRequested, embeddedProjectRoot, projectDir } from "../store";
  import { centerOnFigure } from "../viewportNav";
  import { familyById, shortBadge } from "../figfamily";
  import type { HitBridgeHolder } from "../interact/canvasHitBridge";

  let {
    paneActive = true,
    hitBridge = null,
    unit = "figure",
    slideView = "slides",
    onSlideView,
    slides,
    onPickSlide,
    place = null,
    accept,
  }: {
    paneActive?: boolean;
    hitBridge?: HitBridgeHolder | null;
    /** Figure: [Layers | Plots] over figureLayout; Slide: [Slides | Plots], the view owned by SlideMode. */
    unit?: "figure" | "slide";
    slideView?: "slides" | "plots";
    onSlideView?: (v: "slides" | "plots") => void;
    /** Slide: the filmstrip (the other view). */
    slides?: Snippet;
    /** Slide: the destination menu activates a slide through SlideMode. */
    onPickSlide?: (id: string) => void;
    place?: PlaceAdapter | null;
    accept?: string;
  } = $props();

  const slide = $derived(unit === "slide");
  const plots = $derived(slide ? slideView === "plots" : $figureLayout.leftView === "plots");
  const otherKey = $derived(slide ? "slides" : "layers");
  const destination = $derived($project.figures.find((f) => f.id === $activeFigureId) ?? null);
  const destLabel = $derived(destination ? destinationName(destination, $project.figures) : slide ? "No slide" : "No figure");
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

  function setView(v: "other" | "plots") {
    if (slide) onSlideView?.(v === "plots" ? "plots" : "slides");
    else figureLayout.update((l) => ({ ...l, leftView: v === "plots" ? "plots" : "layers" }));
  }
  function destinationMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: RailMenuItem[] = [];
    if (slide) {
      $project.figures.forEach((f, i) => items.push({ kind: "action", label: `${i + 1}  ${destinationName(f, $project.figures)}`, checked: f.id === $activeFigureId, run: () => onPickSlide?.(f.id) }));
    } else {
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
    }
    if (!items.length) items.push({ kind: "heading", label: slide ? "No slides yet" : "No figures yet" });
    menu = { x: r.left, y: r.bottom + 2, items, label: slide ? "Place plots on" : "Place plots in" };
  }
  function viewMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const p = $railPrefs;
    const set = (patch: Partial<RailPrefs>) => railPrefs.update((v) => ({ ...v, ...patch }));
    const fresh = get(freshPlots).size;
    menu = { x: r.right - 240, y: r.bottom + 2, label: "Plots view", items: [
      { kind: "heading", label: "Sort" },
      { kind: "action", label: "By folder", checked: p.sort === "folders", run: () => set({ sort: "folders" }) },
      { kind: "action", label: "Recent first", checked: p.sort === "recent", run: () => set({ sort: "recent" }) },
      { kind: "heading", label: "Show only" },
      { kind: "action", label: "Unused", hint: "placed nowhere", checked: p.filterUnused, run: () => set({ filterUnused: !p.filterUnused }) },
      { kind: "action", label: "Fluxplots", hint: "◆ editable", checked: p.filterFluxplot, run: () => set({ filterFluxplot: !p.filterFluxplot }) },
      { kind: "action", label: "Has dissections", hint: "⧉", checked: p.filterDissected, disabled: p.scope !== "project", run: () => set({ filterDissected: !p.filterDissected }) },
      { kind: "heading", label: "Tiles" },
      { kind: "slider", label: "Gallery", min: TILE_H_MIN, max: TILE_H_MAX, step: 4, value: p.tileH, unit: " px", hint: "Gallery tile height · Ctrl+wheel or Ctrl+= / Ctrl+− in the gallery", set: (v) => set({ tileH: v }) },
      { kind: "slider", label: "Dissections", min: TILE_H_MIN, max: TILE_H_MAX, step: 4, value: p.dissectTileH, unit: " px", hint: "Dissections tile height · Ctrl+wheel in the pane", set: (v) => set({ dissectTileH: v }) },
      { kind: "action", label: "Show names", checked: p.names, run: () => set({ names: !p.names }) },
      { kind: "action", label: "Width class badge", hint: "1c · 1.5c · 2c", checked: p.widthBadge, run: () => set({ widthBadge: !p.widthBadge }) },
      { kind: "action", label: "Stack variants", hint: "_a…_f · _v1…", checked: p.stacks, run: () => set({ stacks: !p.stacks }) },
      { kind: "action", label: "Reset sizes", hint: "112 · 84", disabled: p.tileH === 112 && p.dissectTileH === 84, run: () => set({ tileH: 112, dissectTileH: 84 }) },
      { kind: "heading", label: "Backdrop" },
      { kind: "action", label: "Automatic", hint: "every element visible", checked: p.backdrop === "auto", run: () => set({ backdrop: "auto" }) },
      { kind: "action", label: "Paper", checked: p.backdrop === "paper", run: () => set({ backdrop: "paper" }) },
      { kind: "action", label: "Dark", checked: p.backdrop === "dark", run: () => set({ backdrop: "dark" }) },
      { kind: "action", label: "Checkerboard", checked: p.backdrop === "checker", run: () => set({ backdrop: "checker" }) },
      { kind: "action", label: slide ? "The slide's background" : "The figure's background", checked: p.backdrop === "destination", run: () => set({ backdrop: "destination" }) },
      { kind: "separator" },
      { kind: "action", label: "Peek on hover", hint: "Shift+Space", checked: p.peek, run: () => set({ peek: !p.peek }) },
      { kind: "action", label: slide ? "Reveal the plot selected on the slide" : "Reveal the selected plot", hint: "auto", checked: p.autoReveal, run: () => set({ autoReveal: !p.autoReveal }) },
      { kind: "action", label: fresh ? `Clear the new-file dots (${fresh})` : "Clear the new-file dots", disabled: !fresh, run: () => clearFresh() },
      { kind: "action", label: "Refresh", run: () => { refreshKey++; } },
      { kind: "action", label: "Open the full gallery", hint: "Shift+Alt+G", disabled: !($embeddedProjectRoot || $projectDir), run: () => { importerPinRequested.set(false); importerOpen.set(true); } },
    ] };
  }
</script>

<div class="left-rail" data-left-rail={plots ? "plots" : otherKey}>
  <div class="rail-tabs" role="tablist" aria-label="Left rail">
    {#if slide}
      <button role="tab" class="rail-tab" aria-selected={!plots} class:chosen={!plots} title="The deck's slides" onclick={() => setView("other")} data-rail-tab="slides">
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2" width="11" height="5" rx="1"/><rect x="2.5" y="9" width="11" height="5" rx="1"/></svg><span class="lbl">Slides</span>
      </button>
    {:else}
      <button role="tab" class="rail-tab" aria-selected={!plots} class:chosen={!plots} title="Canvases, figures and layers" onclick={() => setView("other")} data-rail-tab="layers">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 14 5 8 8 2 5Z"/><path d="M2 8l6 3 6-3"/><path d="M2 11l6 3 6-3"/></svg><span class="lbl">Layers</span>
      </button>
    {/if}
    <button role="tab" class="rail-tab" aria-selected={plots} class:chosen={plots} title="Plot gallery and dissections (Alt+G)" onclick={() => setView("plots")} data-rail-tab="plots">
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/></svg><span class="lbl">Plots</span>
    </button>
    {#if plots}
      <span class="grow"></span>
      <button class="dest" class:flash disabled={!destination && !$project.figures.length} title={destination ? `Plots go ${slide ? "onto" : "into"} ${destLabel} — click to choose another ${slide ? "slide" : "figure"}` : `No ${slide ? "slide" : "figure"} to place plots in`} onclick={destinationMenu} data-rail-destination>→ <span class="dn">{destLabel}</span> ▾</button>
      <button class="more" title="View options" aria-label="Plots view options" onclick={viewMenu} data-rail-menu>⋯</button>
    {/if}
  </div>
  {#if plots}
    <PlotsRail active={paneActive} {hitBridge} {refreshKey} {place} {unit} accept={accept ?? (slide ? "svg,png,glb,mp4,mov" : "svg,png,glb")} />
  {:else if slide}
    {@render slides?.()}
  {:else}
    <Sidebar {paneActive} />
  {/if}
  {#if menu}<RailMenu items={menu.items} x={menu.x} y={menu.y} label={menu.label} minWidth={220} onClose={() => (menu = null)} />{/if}
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

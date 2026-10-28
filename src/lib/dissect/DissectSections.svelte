<script lang="ts" module>
  import { writable } from "svelte/store";
  const ROW_KEY = "flux-dissect-row-h";
  export const DISSECT_ROW_MIN = 72;
  export const DISSECT_ROW_MAX = 520;
  function loadRowH(): number {
    try {
      const v = Number(localStorage.getItem(ROW_KEY));
      return v >= DISSECT_ROW_MIN && v <= DISSECT_ROW_MAX ? v : 200;
    } catch { return 200; }
  }
  /** The full-size viewers' tile height ([ / ] and Ctrl+wheel); the rail keeps its own. */
  export const dissectRowH = writable(loadRowH());
  export function zoomDissectRows(dir: number): void {
    dissectRowH.update((h) => {
      const next = Math.max(DISSECT_ROW_MIN, Math.min(DISSECT_ROW_MAX, Math.round(h * (dir > 0 ? 1.15 : 1 / 1.15))));
      try { localStorage.setItem(ROW_KEY, String(next)); } catch {}
      return next;
    });
  }
</script>

<script lang="ts">
  // The Dissect viewers' grid (the full-screen overlay and the gallery preview's Dissections
  // tab): the Plots rail's Dissections pane at full size. The same sections (Summary tables,
  // one section per image group, Other files), justified rows of pages at their own aspect, and
  // the rail's tiles, mini-tables and file rows. Hosts own the selection and the detail view.
  import JustifiedGrid, { type GridItem, type GridSection, type TileFlags } from "../plotsRail/JustifiedGrid.svelte";
  import Tile from "../plotsRail/Tile.svelte";
  import TableCard from "../plotsRail/TableCard.svelte";
  import { tableCardHeight, type TablePreview } from "../plotsRail/tableCard";
  import { arrangeDissections, probeDissectionFiles, type DissectionImageSize } from "../plotsRail/dissectionsModel";
  import { railPrefs } from "../plotsRail/railPrefs";
  import { project, activeFigureId } from "../store";
  import type { DissectListing, DissectFile } from "./loader";

  type File = DissectFile & { group: string };
  let { listing, selected, onSelect, onOpen }: {
    listing: DissectListing;
    /** The selected file's absolute path. */
    selected: string;
    onSelect: (file: File) => void;
    onOpen: (file: File) => void;
  } = $props();

  const sections = $derived(arrangeDissections(listing));
  let collapsed = $state.raw(new Set<string>());
  let sizes = $state.raw<Map<string, DissectionImageSize>>(new Map());
  let tables = $state.raw<Map<string, TablePreview>>(new Map());
  $effect(() => {
    const files = sections.flatMap((s) => s.files);
    let alive = true;
    void probeDissectionFiles(files).then((next) => { if (alive) { sizes = next.sizes; tables = next.tables; } });
    return () => { alive = false; };
  });

  const CAPTION_H = 16;
  const TEXT_RE = /\.(txt|md)$/i, NOTE_RE = /\.txt$/i;
  const gridSections: GridSection[] = $derived(sections.map((sec) => ({
    key: sec.id,
    title: sec.title,
    meta: `· ${sec.files.length}`,
    depth: 0,
    collapsed: collapsed.has(sec.id),
    collapsible: true,
    headerH: 26,
    items: sec.files.map((f): GridItem => {
      if (f.kind === "table") return { id: f.abs, aspect: 1, block: tableCardHeight(tables.get(f.abs) ?? null), data: f };
      if (f.kind !== "image") return { id: f.abs, aspect: 1, block: 24, data: f };
      const sz = sizes.get(f.abs);
      return { id: f.abs, aspect: sz && sz.w && sz.h ? sz.w / sz.h : 4 / 3, data: f };
    }),
  })));
  const destination = $derived($project.figures.find((f) => f.id === $activeFigureId)?.background ?? null);

  let grid = $state<ReturnType<typeof JustifiedGrid>>();
  const fileOf = (g: GridItem) => g.data as File;
  /** Arrows, Home/End and PageUp/PageDown, for hosts that capture keys. */
  export function navigate(e: KeyboardEvent): boolean { return grid?.navigate(e) ?? false; }
  /** 1–9: select the first file of the nth section (expanding it) and bring it to the top. */
  export function jumpTo(n: number): void {
    const sec = sections[n];
    const first = sec?.files[0];
    if (!sec || !first) return;
    if (collapsed.has(sec.id)) { const next = new Set(collapsed); next.delete(sec.id); collapsed = next; }
    onSelect(first);
    queueMicrotask(() => grid?.anchorTo(first.abs, 34));
  }
  export function reveal(abs: string): void { grid?.reveal(abs, "center"); }
  export function focus(): void { grid?.focusGrid(); }
  function toggle(sec: GridSection) {
    const next = new Set(collapsed);
    if (next.has(sec.key)) next.delete(sec.key); else next.add(sec.key);
    collapsed = next;
  }
  function onKey(e: KeyboardEvent, focused: GridItem | null) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (focused && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(fileOf(focused)); }
    else if (/^[1-9]$/.test(e.key)) { e.preventDefault(); jumpTo(Number(e.key) - 1); }
    else if (e.key === "[" || e.key === "]") { e.preventDefault(); zoomDissectRows(e.key === "]" ? 1 : -1); }
  }
</script>

<div class="sections" data-dissect-grid>
<JustifiedGrid
  bind:this={grid}
  sections={gridSections}
  rowHeight={$dissectRowH}
  captionH={CAPTION_H}
  gap={10}
  blockGap={2}
  padX={16}
  minAspect={0.5}
  selected={new Set(selected ? [selected] : [])}
  focusId={selected}
  label="Dissection files"
  onItemPress={(g) => { onSelect(fileOf(g)); grid?.focusGrid(); }}
  onItemOpen={(g) => onOpen(fileOf(g))}
  onHeaderToggle={toggle}
  onFocusChange={(g) => onSelect(fileOf(g))}
  onKeyDown={onKey}
  onZoom={zoomDissectRows}>
  {#snippet tile(g: GridItem, w: number, h: number, flags: TileFlags)}
    {@const f = fileOf(g)}
    <div class="cell" class:selected={flags.selected} data-dissect-cell data-name={f.name} data-kind={f.kind} data-group={f.group}>
      {#if f.kind === "table"}
        <TableCard name={f.name} preview={tables.get(f.abs) ?? null} selected={flags.selected} focused={flags.focused} />
      {:else if f.kind === "image"}
        <Tile
          path={f.abs}
          stamp={sizes.get(f.abs)?.stamp ?? "?"}
          aspect={g.aspect}
          {w}
          {h}
          captionH={CAPTION_H}
          name={f.name.replace(/\.(svg|png|jpe?g|gif|webp)$/i, "")}
          title={`${f.group ? `${f.group}/` : ""}${f.name}`}
          backdrop={$railPrefs.backdrop}
          {destination}
          selected={flags.selected}
          focused={flags.focused}
          priority={flags.priority}
          glyph={f.semantic ? "◆" : ""}
          glyphTitle="Fluxplot" />
      {:else}
        <div class="other" class:selected={flags.selected} class:focused={flags.focused}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5l3 3v10h-8.5Z M9.5 1.5v3h3" />{#if TEXT_RE.test(f.name)}<path d="M6 8h4.5M6 10.5h4.5" />{/if}</svg>
          <span class="nm">{f.name}</span>
          {#if f.group}<span class="grp">{f.group}</span>{/if}
          <span class="act">{NOTE_RE.test(f.name) ? "edit" : "open"} ↵</span>
        </div>
      {/if}
    </div>
  {/snippet}
</JustifiedGrid>
</div>

<style>
  .sections { flex: 1; min-height: 0; display: flex; }
  .cell { position: absolute; inset: 0; }
  .other { position: absolute; inset: 0; display: flex; align-items: center; gap: 8px; padding: 0 8px; border: 1px solid transparent; border-radius: var(--r-ui); color: var(--c-tx-2); font: 11px var(--font-mono); white-space: nowrap; overflow: hidden; cursor: var(--cursor-cross-hover); }
  .other:hover { background: var(--c-surface-2); color: var(--c-tx-hi); }
  .other.selected { border-color: var(--c-accent); background: var(--c-accent-tint); color: var(--c-tx-hi); }
  .other svg { flex: 0 0 13px; width: 13px; height: 13px; fill: none; stroke: var(--c-tx-muted); stroke-width: 1.1; stroke-linejoin: round; }
  .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .grp { flex-shrink: 0; color: var(--c-tx-faint); }
  .act { flex-shrink: 0; margin-left: auto; color: var(--c-tx-faint); opacity: 0; }
  .other:hover .act, .other.selected .act { opacity: 1; }
</style>

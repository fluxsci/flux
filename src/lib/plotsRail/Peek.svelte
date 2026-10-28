<script lang="ts">
  // The Plots rail's Peek (peek.ts): a non-interactive popover against the rail's right edge,
  // level with the tile it describes, clamped on-screen. The image is the 1024 px raster — never
  // the vector original (a 20 MB SVG in an <img> costs hundreds of ms on the main thread) — on
  // the SAME backdrop as its tile, with the law's reason beside a swatch: the legend that
  // explains why tiles sit on different colours. The "reads poorly on this figure" warning
  // lives here and only here.
  import { untrack } from "svelte";
  import { peekState, type PeekContent } from "./peek";
  import { acquireThumb, type ThumbState } from "./thumbClient";
  import { chooseBackdrop, readsPoorlyOn, backdropTone, BACKDROPS, type BackdropChoice } from "./rules";
  import { railPrefs } from "./railPrefs";
  import { widthClass, relativeTime, formatBytes } from "./galleryModel";
  import { formatSizeMm } from "../figure/physicalUnits";
  import { settings } from "../settings";
  import { listDissections } from "../dissect/loader";
  import { project, activeFigureId, embeddedProjectRoot, projectDir } from "../store";

  let { unit = "figure", railEl = null }: { unit?: "figure" | "slide"; /** This rail: a split workspace mounts several, each renders only its own tiles' Peek. */ railEl?: HTMLElement | null } = $props();

  const MAX_IMG = 520;
  const st = $derived($peekState && railEl?.contains($peekState.cell) ? $peekState : null);
  const c = $derived(st?.content ?? null);
  const root = $derived($embeddedProjectRoot || $projectDir || "");
  const dest = $derived($project.figures.find((f) => f.id === $activeFigureId) ?? null);
  const destName = $derived(dest ? (dest.nickname || dest.name || (unit === "slide" ? "this slide" : "this figure")) : "");

  // ---- the image: 1024 bucket, the on-screen tile's picture meanwhile
  let thumb = $state.raw<ThumbState | null>(null);
  $effect(() => {
    const cur = c;
    thumb = null;
    if (!cur || (cur.kind === "dissection" && cur.table)) return;
    const dpr = window.devicePixelRatio || 1;
    return untrack(() => acquireThumb(cur.abs, cur.stamp, 1024 / dpr, dpr, -1, (s) => { thumb = s; }));
  });
  const imgUrl = $derived(thumb?.url || c?.placeholder || "");

  // ---- position and size
  let boxH = $state(0);
  const place = $derived.by(() => {
    if (!st) return null;
    void boxH;
    const cell = st.cell.getBoundingClientRect();
    const rail = (st.cell.closest("[data-left-rail]") as HTMLElement | null)?.getBoundingClientRect() ?? cell;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.round(rail.right + 8);
    const room = Math.max(160, vw - left - 12);
    const aspect = c && c.aspect > 0 && Number.isFinite(c.aspect) ? c.aspect : 4 / 3;
    const maxW = Math.min(MAX_IMG, room - 20), maxH = Math.min(MAX_IMG, vh - 200);
    let iw = maxW, ih = iw / aspect;
    if (ih > maxH) { ih = Math.max(60, maxH); iw = ih * aspect; }
    const width = Math.round(Math.max(260, Math.min(room, iw + 20)));
    const h = boxH || ih + 120;
    const top = Math.round(Math.min(vh - h - 8, Math.max(8, cell.top + cell.height / 2 - h / 2)));
    return { left, top, width, iw: Math.round(iw), ih: Math.round(ih) };
  });

  // ---- plot facts
  const stats = $derived(c?.kind === "plot" ? (thumb?.stats ?? c.stats) : (thumb?.stats ?? null));
  const paper = $derived(c?.kind === "plot" ? (thumb?.paper ?? c.paper) : null);
  const destBg = $derived(dest?.background ?? null);
  const isVideoOr3d = $derived(!!c && /\.(glb|mp4|mov)$/i.test(c.abs));
  // The tile's own rule: videos and 3D previews sit on the dark backdrop under Automatic.
  const MEDIA: BackdropChoice = { kind: "dark", color: BACKDROPS.dark, reason: "Videos and 3D models sit on the dark backdrop" };
  const choice = $derived(isVideoOr3d && $railPrefs.backdrop === "auto" ? MEDIA : chooseBackdrop(stats, { manifestPaper: paper, mode: $railPrefs.backdrop, destination: destBg }));
  const poor = $derived(!!c && !isVideoOr3d && !!destBg && readsPoorlyOn(stats, destBg));
  const wc = $derived(c?.kind === "plot" ? widthClass(c.physMm) : null);
  // In the user's unit (inches by default — matplotlib's figsize).
  const sizeText = $derived(c ? formatSizeMm(c.physMm, $settings.physicalUnit) : "");

  // ---- dissection groups (one listing per key and count)
  let groups = $state.raw<{ name: string; n: number }[] | null>(null);
  const memo = new Map<string, { name: string; n: number }[]>();
  $effect(() => {
    const cur = c, r = root;
    groups = null;
    if (!cur || cur.kind !== "plot" || !cur.dissectKey || !cur.dissections || !r) return;
    const k = `${r}|${cur.dissectKey}|${cur.dissections}`;
    const hit = memo.get(k);
    if (hit) { groups = hit; return; }
    let alive = true;
    void listDissections(r, cur.dissectKey, { ownEpoch: true }).then((l) => {
      const g = (l.groups ?? []).map((x) => ({ name: x.name || "loose files", n: x.files.length })).filter((x) => x.n > 0);
      if (memo.size > 200) memo.clear();
      memo.set(k, g);
      if (alive) groups = g;
    }).catch(() => {});
    return () => { alive = false; };
  });

  const swatch = $derived(choice.kind === "checker" ? "" : choice.color ?? (choice.kind === "own" ? "var(--flx-paper)" : ""));
  function kindRow(x: PeekContent): string {
    return x.kind === "plot" ? x.kindLabel : "";
  }
</script>

{#if st && c && place}
  <div class="peek" style:left={`${place.left}px`} style:top={`${place.top}px`} style:width={`${place.width}px`} bind:clientHeight={boxH} role="tooltip" aria-live="polite" data-plots-peek={c.abs}>
    {#if c.kind === "dissection" && c.table}
      <div class="tablewrap">
        <table>
          {#if c.table.header.length}<thead><tr>{#each c.table.header as h}<th>{h}</th>{/each}</tr></thead>{/if}
          <tbody>{#each c.table.rows.slice(0, 20) as row}<tr>{#each row as cell}<td>{cell}</td>{/each}</tr>{/each}</tbody>
        </table>
        {#if c.table.rowCount > c.table.rows.length}<div class="more">… {c.table.complete ? `${c.table.rowCount - c.table.rows.length} more rows` : "more rows"}</div>{/if}
      </div>
    {:else}
      <div class="img {backdropTone(choice) === 'light' ? 'on-light' : 'on-dark'}" class:checker={choice.kind === "checker"} style:width={`${place.iw}px`} style:height={`${place.ih}px`} style:background-color={choice.kind === "checker" ? null : swatch || null}>
        {#if imgUrl}<img src={imgUrl} alt="" draggable="false" />{:else if thumb?.error}<span class="na">{thumb.error}</span>{/if}
      </div>
    {/if}
    <div class="meta">
      <div class="name" data-peek-name>{c.name}{#if c.kind === "plot" && c.fresh}<span class="fresh" title="New or changed since the rail last listed it">● new</span>{/if}</div>
      {#if c.kind === "plot"}
        <div class="folder">{c.folder}</div>
        <div class="facts">
          {#if sizeText}<span data-peek-size>{sizeText}{#if wc}{" · "}<b>{wc.label}</b>{/if}</span>{/if}
          {#if c.mtimeMs}<span>modified {relativeTime(c.mtimeMs)}</span>{/if}
          {#if c.size}<span>{formatBytes(c.size)}</span>{/if}
          {#if kindRow(c)}<span class:accent={c.kind === "plot" && kindRow(c).startsWith("◆")}>{kindRow(c)}</span>{/if}
        </div>
        <div class="row" data-peek-placements>
          {#if c.placements.length}
            {unit === "slide" ? "On" : "Placed in"} {#each c.placements.slice(0, 6) as p, i}{i ? ", " : ""}<span class:accent={p.active}>{p.name}</span>{/each}{#if c.placements.length > 6}, +{c.placements.length - 6}{/if}
          {:else}
            <span class="muted">{unit === "slide" ? "On no slide of this deck yet" : "In no figure yet"}</span>
          {/if}
        </div>
        {#if c.dissections > 0}
          <div class="row" data-peek-dissections>⧉ {c.dissections} dissection {c.dissections === 1 ? "file" : "files"}{#if groups && groups.length}{" · "}{#each groups.slice(0, 6) as g, i}{i ? ", " : ""}{g.name} <span class="muted">{g.n}</span>{/each}{#if groups.length > 6}, …{/if}{/if}</div>
        {/if}
      {:else}
        <div class="folder">{c.group ? `${c.group}/` : ""}{c.name}</div>
        {#if sizeText || c.mtimeMs}
          <div class="facts">
            {#if sizeText}<span data-peek-size>{sizeText}{#if widthClass(c.physMm)}{" · "}<b>{widthClass(c.physMm)?.label}</b>{/if}</span>{/if}
            {#if c.mtimeMs}<span>modified {relativeTime(c.mtimeMs)}</span>{/if}
          </div>
        {/if}
      {/if}
      {#if !(c.kind === "dissection" && c.table)}
        <div class="backdrop" data-peek-backdrop={choice.kind}>
          <span class="sw" class:checker={choice.kind === "checker"} style:background-color={choice.kind === "checker" ? null : swatch || null}></span>
          <span>{choice.reason}</span>
        </div>
      {/if}
      {#if poor}
        <div class="warn" data-peek-warning>⚠ Some of this plot's ink reads poorly on {destName}'s background ({destBg}).</div>
      {/if}
      {#if c.kind === "plot"}<div class="keys" data-peek-keys><kbd>Enter</kbd> place · <kbd>Space</kbd> preview · drag onto a {unit}</div>{/if}
    </div>
  </div>
{/if}

<style>
  .peek { position: fixed; z-index: 450; pointer-events: none; display: flex; flex-direction: column; gap: 8px; padding: 10px; box-sizing: border-box; background: var(--c-bg-raised); border: 1px solid var(--c-line-strong); border-radius: var(--r-1, 6px); box-shadow: var(--elev-3, 0 8px 28px rgba(0,0,0,.28)); color: var(--c-tx); font: 11.5px/1.4 var(--font-ui); }
  .img { position: relative; align-self: center; box-shadow: 0 0 0 1px var(--c-line); overflow: hidden; }
  .img img { display: block; width: 100%; height: 100%; object-fit: contain; }
  .img.checker, .sw.checker { background-color: #8f8d87; background-image: conic-gradient(#a7a59e 25%, transparent 0 50%, #a7a59e 0 75%, transparent 0); background-size: 16px 16px; }
  .na { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--c-tx-muted); background: var(--c-surface); }
  .meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .name { color: var(--c-tx-hi); font: 600 12px var(--font-mono); word-break: break-all; }
  .fresh { margin-left: 6px; color: var(--c-accent); font: 600 10px var(--font-ui); }
  .folder { color: var(--c-tx-muted); font: 10.5px var(--font-mono); word-break: break-all; }
  .facts { display: flex; flex-wrap: wrap; gap: 2px 10px; color: var(--c-tx-2); }
  .facts b { color: var(--c-tx-hi); }
  .row { color: var(--c-tx-2); }
  .accent { color: var(--c-accent); }
  .muted { color: var(--c-tx-muted); }
  .backdrop { display: flex; align-items: center; gap: 6px; color: var(--c-tx-2); }
  .sw { width: 12px; height: 12px; flex: 0 0 12px; border-radius: 2px; box-shadow: 0 0 0 1px var(--c-line-strong); }
  .keys { margin-top: 2px; color: var(--c-tx-muted); font-size: 10.5px; }
  .keys kbd { padding: 0 3px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); font: 9.5px var(--font-mono); }
  .warn { margin-top: 2px; padding: 4px 6px; border-radius: var(--r-ui); background: color-mix(in oklab, var(--c-warning) 16%, transparent); color: var(--c-tx-hi); }
  .tablewrap { max-height: 360px; overflow: hidden; }
  table { border-collapse: collapse; font: 10.5px var(--font-mono); }
  th, td { padding: 1px 6px; border-bottom: 1px solid var(--c-line); text-align: right; white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
  th { color: var(--c-tx-hi); font-weight: 600; }
  td:first-child, th:first-child { text-align: left; }
  .more { padding-top: 4px; color: var(--c-tx-muted); font-size: 10.5px; }
</style>

<script lang="ts" module>
  import { createMeasurer } from "./ellipsis";
  let measure: ((s: string) => number) | null = null;
  /** One canvas measurer for every caption (10.5px mono). */
  export function captionMeasure(): (s: string) => number {
    return (measure ??= createMeasurer("10.5px ui-monospace, SFMono-Regular, Menlo, monospace"));
  }
</script>

<script lang="ts">
  // One thumbnail tile of the Plots rail. The tile's box IS the plot's page: the backdrop paints
  // exactly the image's extent at its true aspect (a hairline gives an opaque white plot an
  // edge), chosen per image by the backdrop law (electron/plotThumbRules.mjs) — every element of
  // a transparent plot stays visible. The raster comes from the shared thumbnail client
  // (bucketed by the tile's width × DPR); a tile that unmounts releases its request.
  import { untrack, onDestroy } from "svelte";
  import { acquireThumb, setThumbPriority, type ThumbState } from "./thumbClient";
  import { bucketFor, chooseBackdrop, backdropTone, type BackdropMode, type InkStats } from "./rules";
  import { middleEllipsis } from "./ellipsis";

  let {
    path,
    stamp,
    aspect,
    w,
    h,
    captionH,
    name,
    title = "",
    stats: knownStats = null,
    paper = null,
    backdrop = "auto",
    destination = null,
    selected = false,
    focused = false,
    linked = false,
    priority = 0,
    inUse = null,
    dissections = 0,
    glyph = "",
    glyphTitle = "",
    onDissections,
  }: {
    path: string;
    stamp: string;
    /** The image's true width / height (it is contained in the box at this aspect). */
    aspect: number;
    w: number;
    h: number;
    captionH: number;
    name: string;
    title?: string;
    stats?: InkStats | null;
    paper?: string | null;
    backdrop?: BackdropMode;
    destination?: string | null;
    selected?: boolean;
    focused?: boolean;
    linked?: boolean;
    priority?: number;
    /** Placements: in the active figure (accent) or elsewhere (muted), with a count. */
    inUse?: { active: boolean; count: number } | null;
    dissections?: number;
    glyph?: string;
    glyphTitle?: string;
    onDissections?: () => void;
  } = $props();

  let thumb = $state.raw<ThumbState>({ url: "", width: 0, height: 0, stats: null, paper: null, pending: true, error: "" });
  let loaded = $state(false);
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const bucket = $derived(bucketFor(w, dpr));

  let shownVersion = "";
  // The request in use, and the previous one kept until its replacement has a picture (a zoom
  // changes the bucket: the old raster stays on screen meanwhile — no skeleton flash).
  let current: (() => void) | null = null;
  let previous: (() => void) | null = null;
  const dropPrevious = () => { previous?.(); previous = null; };
  $effect(() => {
    const p = path, s = stamp, b = bucket;
    // Priority is read once here; later changes only re-rank (below) — never cancel + resend.
    const prio = untrack(() => priority);
    const newVersion = shownVersion !== `${p}|${s}`;
    if (newVersion) { shownVersion = `${p}|${s}`; loaded = false; }
    dropPrevious();
    if (newVersion) { current?.(); current = null; } else { previous = current; current = null; }
    // `b` picks the cache bucket; the client is told the CSS width that produced it.
    // Untracked: the client may answer synchronously, and the answer reads + writes `thumb` —
    // tracked, that would make this effect depend on its own output.
    current = untrack(() => acquireThumb(p, s, b / dpr, dpr, prio, (st) => {
      if (!st.url && st.pending && previous && thumb.url) { thumb = { ...st, url: thumb.url }; return; }
      thumb = st;
      if (st.url || !st.pending) dropPrevious();
    }));
  });
  $effect(() => { const prio = priority; untrack(() => setThumbPriority(path, stamp, bucket / dpr, dpr, prio)); });
  onDestroy(() => { dropPrevious(); current?.(); current = null; });

  // The page box: the true aspect contained in the tile box.
  const page = $derived.by(() => {
    const a = aspect > 0 && Number.isFinite(aspect) ? aspect : w / Math.max(1, h);
    let pw = w, ph = w / a;
    if (ph > h) { ph = h; pw = h * a; }
    return { w: Math.max(1, pw), h: Math.max(1, ph), x: (w - pw) / 2, y: (h - ph) / 2 };
  });
  const choice = $derived(chooseBackdrop(thumb.stats ?? knownStats, { manifestPaper: thumb.paper ?? paper, mode: backdrop, destination }));
  const tone = $derived(backdropTone(choice));
  const showCaption = $derived(captionH > 0 && w >= 90);
  const caption = $derived(showCaption ? middleEllipsis(name, w - 4, captionMeasure()) : "");
</script>

<div class="tile" class:selected class:focused class:linked title={title || name} data-tile={path} data-backdrop={choice.kind}>
  <div
    class="page {tone === 'light' ? 'cursor-on-light' : 'cursor-on-dark'}"
    class:checker={choice.kind === "checker"}
    class:skeleton={!thumb.url && thumb.pending}
    style:left={`${page.x}px`}
    style:top={`${page.y}px`}
    style:width={`${page.w}px`}
    style:height={`${page.h}px`}
    style:background-color={choice.color ?? (choice.kind === "own" ? "var(--flx-paper)" : null)}>
    {#if thumb.url}
      <img src={thumb.url} alt="" draggable="false" class:shown={loaded} onload={() => (loaded = true)} />
    {:else if thumb.error}
      <span class="unavailable" title={thumb.error}>Preview unavailable</span>
    {/if}
  </div>
  {#if inUse && inUse.count > 0}
    <span class="chip use" class:active={inUse.active} title={inUse.active ? `Placed in the active figure${inUse.count > 1 ? ` (${inUse.count} placements)` : ""}` : `Placed in ${inUse.count} ${inUse.count === 1 ? "place" : "places"} in this project`} style:left={`${page.x + 3}px`} style:top={`${page.y + 3}px`}>●{#if inUse.count > 1}<span class="n">{inUse.count}</span>{/if}</span>
  {/if}
  {#if dissections > 0}
    <button class="chip dis" title={`${dissections} dissection ${dissections === 1 ? "file" : "files"} — show them`} style:right={`${w - page.x - page.w + 3}px`} style:top={`${page.y + 3}px`} onclick={(e) => { e.stopPropagation(); onDissections?.(); }} ondblclick={(e) => e.stopPropagation()} data-dissections-chip>⧉ {dissections}</button>
  {/if}
  {#if glyph}
    <span class="chip kind" title={glyphTitle} style:right={`${w - page.x - page.w + 3}px`} style:bottom={`${h - page.y - page.h + 3 + 0}px`} style:--cap={`${captionH}px`}>{glyph}</span>
  {/if}
  {#if showCaption}
    <div class="caption" style:top={`${h}px`} style:height={`${captionH}px`}>{caption}</div>
  {/if}
</div>

<style>
  .tile { position: absolute; inset: 0; }
  .page { position: absolute; overflow: hidden; box-shadow: 0 0 0 1px var(--c-line); border-radius: var(--r-0, 0); }
  .page.skeleton { background-color: var(--c-surface-2); }
  .page.checker { background-color: #8f8d87; background-image: conic-gradient(#a7a59e 25%, transparent 0 50%, #a7a59e 0 75%, transparent 0); background-size: 16px 16px; }
  img { display: block; width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity 80ms linear; }
  img.shown { opacity: 1; }
  .unavailable { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 4px; color: var(--c-tx-muted); font: 10.5px var(--font-ui); text-align: center; background: var(--c-surface); }
  .tile.selected .page { box-shadow: 0 0 0 2px var(--c-accent); }
  .tile.linked:not(.selected) .page { outline: 1px dashed var(--c-accent); outline-offset: 2px; }
  .tile.focused .page { outline: 1px solid var(--c-accent-bright, var(--c-accent)); outline-offset: 3px; }
  .chip { position: absolute; z-index: 1; display: inline-flex; align-items: center; gap: 2px; height: 15px; padding: 0 4px; border-radius: var(--r-ui); background: color-mix(in oklab, var(--c-bg-raised) 88%, transparent); color: var(--c-tx-2); font: 600 9.5px/15px var(--font-mono); pointer-events: none; }
  .chip.use { color: var(--c-tx-muted); }
  .chip.use.active { color: var(--c-accent); }
  .chip .n { color: var(--c-tx-2); font-weight: 400; }
  .chip.dis { border: 0; pointer-events: auto; cursor: var(--cursor-cross-hover); }
  .chip.dis:hover { color: var(--c-tx-hi); background: var(--c-surface); }
  .chip.kind { color: var(--c-accent-bright, var(--c-accent)); font-size: 9px; }
  .caption { position: absolute; left: 0; right: 0; display: flex; align-items: center; padding: 0 2px; color: var(--c-tx-muted); font: 10.5px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; overflow: hidden; }
  .tile.selected .caption { color: var(--c-tx-hi); background: var(--c-accent-tint); }
  @media (prefers-reduced-motion: reduce) { img { transition: none; } }
</style>

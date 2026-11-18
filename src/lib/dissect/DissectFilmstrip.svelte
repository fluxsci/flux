<script lang="ts">
  // The Dissect viewer's rolodex: every file of the plot in one strip under the open one, so
  // ← / → (or a click) flips through per-subject panels without going back to the grid. The
  // open file stays in the middle; its neighbours are the next and previous things you would
  // look at; a group's name marks where each group starts.
  //
  // Windowed: a plot can have hundreds of panels, and each mounted thumbnail holds a request on
  // the shared thumbnail client. Only what is in view (plus a margin) exists.
  import Tile from "../plotsRail/Tile.svelte";
  import { railPrefs } from "../plotsRail/railPrefs";
  import { nativeClick, nativeScroll } from "../ui/nativeEvents";
  import type { DissectFile } from "./loader";
  import type { DissectionImageSize } from "../plotsRail/dissectionsModel";

  type File = DissectFile & { group: string };
  let { sections, sizes, current, onPick }: {
    /** The viewer's sections, in order (Summary, each group, Other files). */
    sections: { id: string; title: string; files: File[] }[];
    sizes: Map<string, DissectionImageSize>;
    /** The open file's absolute path. */
    current: string;
    onPick: (file: File) => void;
  } = $props();

  const THUMB_H = 52, GAP = 6, PAD = 12, OVERSCAN = 400;
  /** Each item's box: an image at its own aspect (kept within sensible bounds), a file as a chip. */
  const layout = $derived.by(() => {
    let x = PAD;
    const items: { file: File; x: number; w: number; aspect: number; title: string }[] = [];
    for (const section of sections) {
      if (items.length && section.files.length) x += 12;
      section.files.forEach((file, i) => {
        const size = file.kind === "image" ? sizes.get(file.abs) : undefined;
        const aspect = size && size.w && size.h ? size.w / size.h : 4 / 3;
        const w = file.kind === "image" ? Math.round(Math.max(34, Math.min(128, THUMB_H * aspect))) : 78;
        items.push({ file, x, w, aspect, title: i === 0 ? section.title : "" });
        x += w + GAP;
      });
    }
    return { items, width: Math.max(0, x - GAP + PAD) };
  });

  let scroller = $state<HTMLDivElement | null>(null);
  let scrollLeft = $state(0), viewW = $state(0);
  $effect(() => {
    const el = scroller;
    if (!el) return;
    const view = el.ownerDocument.defaultView as Window & typeof globalThis;
    const ro = new view.ResizeObserver(() => (viewW = el.clientWidth));
    ro.observe(el);
    viewW = el.clientWidth;
    return () => ro.disconnect();
  });
  const visible = $derived(layout.items.filter((it) => it.x + it.w > scrollLeft - OVERSCAN && it.x < scrollLeft + viewW + OVERSCAN));
  const currentItem = $derived(layout.items.find((it) => it.file.abs === current) ?? null);

  // The open file sits in the middle of the strip. Set, not animated: a flip is instant.
  $effect(() => {
    const el = scroller, it = currentItem, w = viewW;
    if (!el || !it || !w) return;
    const target = Math.max(0, Math.min(layout.width - w, it.x + it.w / 2 - w / 2));
    if (Math.abs(el.scrollLeft - target) > 1) el.scrollLeft = target;
    scrollLeft = el.scrollLeft;
  });
  function onScroll() { if (scroller) scrollLeft = scroller.scrollLeft; }
  // A vertical wheel turns the strip (it has nowhere else to go).
  function onWheel(e: WheelEvent) {
    if (!scroller || e.ctrlKey || e.metaKey) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    scroller.scrollLeft += delta;
  }
  /** A file that is not a picture is named in its chip: its name without the extension. */
  const label = (f: File) => f.name.replace(/\.[A-Za-z0-9]{1,8}$/, "");
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="strip" data-dissect-strip bind:this={scroller} use:nativeScroll={onScroll} onwheel={onWheel} role="listbox" aria-label="Files of this plot" aria-orientation="horizontal" tabindex="-1">
  <div class="track" style:width={`${layout.width}px`}>
    {#each visible as it (it.file.abs)}
      {#if it.title}<span class="group" style:left={`${it.x}px`}>{it.title}</span>{/if}
      <button
        class="item"
        class:current={it.file.abs === current}
        class:chip={it.file.kind !== "image"}
        data-strip-item={it.file.name}
        role="option"
        aria-selected={it.file.abs === current}
        title={`${it.file.group ? `${it.file.group}/` : ""}${it.file.name}`}
        style:left={`${it.x}px`}
        style:width={`${it.w}px`}
        use:nativeClick={() => onPick(it.file)}
      >
        {#if it.file.kind === "image"}
          <Tile path={it.file.abs} stamp={sizes.get(it.file.abs)?.stamp ?? "?"} aspect={it.aspect} w={it.w} h={THUMB_H} captionH={0} name="" backdrop={$railPrefs.backdrop} selected={false} focused={false} priority={it.file.abs === current ? 2 : 0} />
        {:else}
          <svg viewBox="0 0 16 16" aria-hidden="true">{#if it.file.kind === "table"}<path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.5 3.5v9" />{:else}<path d="M4 1.5h5.5l3 3v10H4zM9.5 1.5v3h3M6 8h4.5M6 10.5h4.5" />{/if}</svg>
          <span>{label(it.file)}</span>
        {/if}
      </button>
    {/each}
  </div>
</div>

<style>
  /* No scrollbar: the strip follows the open file, and the wheel, the arrows and a click all turn it. */
  .strip { flex: 0 0 auto; height: 86px; overflow-x: auto; overflow-y: hidden; background: var(--c-bg-raised); border-top: 1px solid var(--c-line); scrollbar-width: none; outline: none; }
  .strip::-webkit-scrollbar { display: none; }
  .track { position: relative; height: 100%; }
  /* Where a group starts: its name, above its first file. */
  .group { position: absolute; top: 5px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx-faint); font: 600 9.5px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; pointer-events: none; }
  .item { position: absolute; top: 21px; height: 52px; padding: 0; border: 0; border-radius: var(--r-ui); background: transparent; cursor: var(--cursor-cross-hover); opacity: .62; transition: opacity 80ms linear; }
  .item:hover { opacity: 1; }
  /* The open file: full strength, on a rail of the accent. */
  .item.current { opacity: 1; box-shadow: 0 0 0 1px var(--c-bg-raised), 0 0 0 3px var(--c-accent); }
  .item.current::after { content: ""; position: absolute; left: 0; right: 0; bottom: -9px; height: 2px; background: var(--c-accent); }
  .chip { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 0 5px; border: 1px solid var(--c-line); background: var(--c-bg); color: var(--c-tx-muted); font: 9.5px var(--font-mono); }
  .chip span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.1; stroke-linejoin: round; }
  .chip.current { color: var(--c-tx-hi); }
  @media (prefers-reduced-motion: reduce) { .item { transition: none; } }
</style>

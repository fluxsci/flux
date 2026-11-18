<script lang="ts">
  // The Dissect viewer's rolodex: every file of the plot in one strip under the open one, so
  // ← / → (or a click) flips through per-subject panels without going back to the grid. The
  // open file stays in the middle; its neighbours are the next and previous things you would
  // look at; a group's name marks where each group starts.
  //
  // Names (2026-11-18, round 2): a plot's files are named after the plot, so a label is the
  // name WITHOUT that shared front (names.ts): "rem-sorted", not "sd-early-rem-state-barc…".
  // A group's name is clipped to its own group and never runs over the next one; a table or
  // other file is a chip sized to its whole (short) name; a picture has its name under it.
  //
  // Windowed: a plot can have hundreds of panels, and each mounted thumbnail holds a request on
  // the shared thumbnail client. Only what is in view (plus a margin) exists.
  import Tile from "../plotsRail/Tile.svelte";
  import { railPrefs } from "../plotsRail/railPrefs";
  import { nativeClick, nativeScroll } from "../ui/nativeEvents";
  import type { DissectFile } from "./loader";
  import type { DissectionImageSize } from "../plotsRail/dissectionsModel";
  import { fileLabel, groupLabel, monoWidth } from "./names";

  type File = DissectFile & { group: string };
  let { sections, sizes, current, onPick, stem = "" }: {
    /** The viewer's sections, in order (Summary, each group, Other files). */
    sections: { id: string; kind?: string; title: string; group?: string; files: File[] }[];
    sizes: Map<string, DissectionImageSize>;
    /** The open file's absolute path. */
    current: string;
    onPick: (file: File) => void;
    /** The plot's own name: labels drop it from their front. */
    stem?: string;
  } = $props();

  const THUMB_H = 52, GAP = 6, PAD = 12, OVERSCAN = 400, GROUP_GAP = 16, LABEL_MAX = 168;
  /** A chip: what it is (and whose) on one small line, then its name on at most two (9.5 px mono). */
  const CHAR = 5.7, SMALL = 5.5, CHIP_PAD = 16;
  type Item = { file: File; x: number; w: number; aspect: number; label: string; ext: string; from: string; tip: string };
  type Group = { id: string; x: number; w: number; title: string; full: string };
  const layout = $derived.by(() => {
    let x = PAD;
    const items: Item[] = [], groups: Group[] = [];
    for (const section of sections) {
      if (!section.files.length) continue;
      if (items.length) x += GROUP_GAP;
      const start = x;
      // Summary and Other files gather from several groups: there a chip also says which.
      const mixed = new Set(section.files.map((f) => f.group)).size > 1;
      for (const file of section.files) {
        const named = fileLabel(file.name, file.group, stem);
        const from = mixed && file.group ? groupLabel(file.group, stem) : "";
        const label = named.label || (from ? "" : named.ext || file.name);
        const size = file.kind === "image" ? sizes.get(file.abs) : undefined;
        const aspect = size && size.w && size.h ? size.w / size.h : 4 / 3;
        let w: number;
        if (file.kind === "image") w = Math.round(Math.max(40, Math.min(128, THUMB_H * aspect)));
        else {
          // Wide enough for the whole name on two lines, and for the line that says what it is.
          const perLine = label.length > 14 ? Math.ceil(label.length / 2) + 1 : label.length;
          const top = 14 + ((named.ext || file.kind).length + (from ? Math.min(from.length, 22) + 3 : 0)) * SMALL;
          w = Math.round(Math.max(60, Math.min(180, Math.max(perLine * CHAR, top) + CHIP_PAD)));
        }
        items.push({ file, x, w, aspect, label, ext: named.ext, from, tip: `${file.group ? `${file.group}/` : ""}${file.name}` });
        x += w + GAP;
      }
      // A group's name fits its own group: a short group is given the room its name needs.
      const full = section.kind === "images" && section.group ? section.group : section.title;
      const title = section.kind === "images" && section.group ? groupLabel(section.group, stem) : section.title;
      const span = x - GAP - start, wanted = Math.min(LABEL_MAX, monoWidth(title, 9.5, 0.08) + 4);
      if (span < wanted) x += wanted - span;
      groups.push({ id: section.id, x: start, w: Math.max(span, wanted), title, full });
    }
    return { items, groups, width: Math.max(0, x - GAP + PAD) };
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
  const visibleGroups = $derived(layout.groups.filter((g) => g.x + g.w > scrollLeft - OVERSCAN && g.x < scrollLeft + viewW + OVERSCAN));
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
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="strip" data-dissect-strip bind:this={scroller} use:nativeScroll={onScroll} onwheel={onWheel} role="listbox" aria-label="Files of this plot" aria-orientation="horizontal" tabindex="-1">
  <div class="track" style:width={`${layout.width}px`}>
    {#each visibleGroups as g (g.id)}
      <span class="group" data-strip-group style:left={`${g.x}px`} style:width={`${g.w}px`} title={g.full}>{g.title}</span>
    {/each}
    {#each visible as it (it.file.abs)}
      <button
        class="item"
        class:current={it.file.abs === current}
        class:chip={it.file.kind !== "image"}
        data-strip-item={it.file.name}
        role="option"
        aria-selected={it.file.abs === current}
        title={it.tip}
        style:left={`${it.x}px`}
        style:width={`${it.w}px`}
        use:nativeClick={() => onPick(it.file)}
      >
        {#if it.file.kind === "image"}
          <span class="thumb"><Tile path={it.file.abs} stamp={sizes.get(it.file.abs)?.stamp ?? "?"} aspect={it.aspect} w={it.w} h={THUMB_H} captionH={0} name="" backdrop={$railPrefs.backdrop} selected={false} focused={false} priority={it.file.abs === current ? 2 : 0} /></span>
          <span class="cap">{it.label}</span>
        {:else}
          <span class="what"><svg viewBox="0 0 16 16" aria-hidden="true">{#if it.file.kind === "table"}<path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.5 3.5v9" />{:else}<path d="M4 1.5h5.5l3 3v10H4zM9.5 1.5v3h3M6 8h4.5M6 10.5h4.5" />{/if}</svg><span class="ext">{it.ext || it.file.kind}</span>{#if it.from}<span class="from">{it.from}</span>{/if}</span>
          <span class="name">{it.label || it.from}</span>
        {/if}
      </button>
    {/each}
  </div>
</div>

<style>
  /* No scrollbar: the strip follows the open file, and the wheel, the arrows and a click all turn it. */
  .strip { flex: 0 0 auto; height: 102px; overflow-x: auto; overflow-y: hidden; background: var(--c-bg-raised); border-top: 1px solid var(--c-line); scrollbar-width: none; outline: none; }
  .strip::-webkit-scrollbar { display: none; }
  .track { position: relative; height: 100%; }
  /* Where a group starts: its name over its own files, cut at the group's end, with a tick. */
  .group { position: absolute; top: 6px; box-sizing: border-box; height: 12px; padding-left: 5px; border-left: 1px solid var(--c-line-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx-muted); font: 600 9.5px/12px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; pointer-events: none; }
  .item { position: absolute; top: 23px; height: 70px; display: flex; flex-direction: column; align-items: stretch; gap: 3px; padding: 0; border: 0; border-radius: var(--r-ui); background: transparent; color: var(--c-tx-muted); cursor: var(--cursor-cross-hover); opacity: .66; transition: opacity 80ms linear; }
  .item:hover { opacity: 1; }
  .thumb { position: relative; display: block; height: 52px; border-radius: var(--r-ui); }
  /* A picture's name, under it: one line, cut at the picture's own width. */
  .cap { height: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; font: 9px/12px var(--font-mono); color: var(--c-tx-faint); }
  /* The open file: full strength, ringed in the accent, on a rail of it. */
  .item.current { opacity: 1; }
  .item.current .thumb, .item.chip.current { box-shadow: 0 0 0 1px var(--c-bg-raised), 0 0 0 3px var(--c-accent); }
  .item.current .cap { color: var(--c-tx-hi); }
  .item.current::after { content: ""; position: absolute; left: 0; right: 0; bottom: -6px; height: 2px; background: var(--c-accent); }
  /* A table or other file: what it is on one small line, then its whole name. */
  .chip { height: 52px; box-sizing: border-box; justify-content: center; gap: 3px; padding: 4px 7px 5px; border: 1px solid var(--c-line); background: var(--c-bg); text-align: left; font: 9.5px/12px var(--font-mono); }
  .chip:hover { border-color: var(--c-line-strong); }
  .what { display: flex; align-items: center; gap: 4px; min-width: 0; height: 10px; color: var(--c-tx-faint); font: 600 8px/10px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; }
  .what svg { width: 10px; height: 10px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linejoin: round; }
  .name { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; color: var(--c-tx-2); }
  .from { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 400; } .from::before { content: "· "; }
  .chip.current { border-color: transparent; }
  .chip.current .name { color: var(--c-tx-hi); }
  @media (prefers-reduced-motion: reduce) { .item { transition: none; } }
</style>

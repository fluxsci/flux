<script lang="ts">
  // One thumbnail cell. Lazy: requests its thumb URL only when it exists in
  // the window; decodes off-DOM before swapping src so a set switch is a hard
  // cut (old image stays until the new one can paint — never a blank frame).
  // A generation counter drops responses that arrive after the cell moved on.
  // px 0 = the cell outgrew the largest thumb bucket — load the original.
  import { store } from "./store.svelte";

  let {
    itemKey,
    setId,
    px,
    cellW,
    cellH,
    capH,
  }: { itemKey: string; setId: string; px: number; cellW: number; cellH: number; capH: number } = $props();

  const cell = $derived(store.cellFor(setId, itemKey));
  const selected = $derived(store.selectedKey === itemKey);
  const annot = $derived(store.annotFor(itemKey));

  let src = $state<string | null>(null);
  let gen = 0;

  $effect(() => {
    const present = cell?.present ?? false;
    const s = setId;
    const k = itemKey;
    const p = px;
    const my = ++gen;
    if (!present) {
      src = null;
      return;
    }
    void (async () => {
      const url = p === 0 ? await store.api?.fullUrl(s, k) : await store.api?.thumbUrl(s, k, p);
      if (my !== gen || !url) return;
      const im = new Image();
      im.decoding = "async";
      im.src = url;
      try {
        await im.decode();
      } catch {
        // undecodable is fine — the <img> just won't paint
      }
      if (my !== gen) return;
      store.reportAspect(im.naturalWidth, im.naturalHeight); // drives the grid's cell aspect
      src = url;
    })();
  });

  function onClick(e: MouseEvent) {
    if (e.ctrlKey || e.metaKey) store.openCompare(itemKey); // this item across ALL sets
    else store.openDetail(itemKey);
  }
</script>

<button
  class="cell"
  class:selected
  class:valid={annot?.mark === "valid"}
  class:exclude={annot?.mark === "exclude"}
  data-cell
  data-key={itemKey}
  data-missing={cell && !cell.present ? "" : undefined}
  data-mark={annot?.mark}
  style:width={`${cellW}px`}
  tabindex="-1"
  onclick={onClick}
  title={cell?.file ?? itemKey}
>
  <div class="surface" style:height={`${cellH}px`}>
    {#if cell?.present}
      {#if src}
        <img {src} alt={itemKey} draggable="false" />
      {/if}
    {:else}
      <div class="missing"><span>{itemKey}</span></div>
    {/if}
  </div>
  {#if capH > 0}
    <div class="caption" style:height={`${capH}px`}>
      <span class="capname">{cell?.file ?? itemKey}</span>
      {#if annot?.notes}<span class="star" title={annot.notes}>*</span>{/if}
    </div>
  {/if}
</button>

<style>
  .cell {
    display: block;
    text-align: left;
    border-radius: var(--radius-s);
  }
  .surface {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--c-image-surface);
    border-radius: var(--radius-s);
    overflow: hidden;
    outline: 1px solid var(--c-line);
    outline-offset: -1px;
  }
  .cell:hover .surface {
    outline-color: var(--c-line-strong);
  }
  .cell.selected .surface {
    outline: 2px solid var(--c-accent);
    outline-offset: 0;
    box-shadow: 0 0 0 3px var(--c-accent-tint);
  }
  /* Annotation marks own the outline; selection stays visible as the halo. */
  .cell.valid .surface {
    outline: 2px solid var(--c-valid);
    outline-offset: 0;
  }
  .cell.exclude .surface {
    outline: 2px solid var(--c-exclude);
    outline-offset: 0;
  }
  .cell.selected.valid .surface {
    box-shadow: 0 0 0 3px var(--c-valid-tint), 0 0 0 5px var(--c-accent-tint);
  }
  .cell.selected.exclude .surface {
    box-shadow: 0 0 0 3px var(--c-exclude-tint), 0 0 0 5px var(--c-accent-tint);
  }
  img {
    /* Fill the cell in BOTH directions — small sources upscale rather than
       float in the middle of a large cell (the cell aspect tracks the images'
       measured aspect, so contain-letterboxing stays negligible). */
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .missing {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--c-tx-faint);
    font-size: 11px;
    padding: 4px;
  }
  .missing span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .caption {
    display: flex;
    align-items: baseline;
    color: var(--c-tx-muted);
    font-size: 11px;
    line-height: 20px;
    padding: 0 2px;
  }
  .capname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The notes star never ellipses away, however long the filename. */
  .star {
    flex: none;
    margin-left: 2px;
    color: var(--c-accent-bright);
    font-weight: 700;
  }
  .cell.selected .caption {
    color: var(--c-tx-2);
  }
</style>

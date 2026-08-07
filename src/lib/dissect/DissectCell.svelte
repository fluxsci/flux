<script lang="ts">
  // One grid cell. Images are lazy: the data URL is requested only while the cell is in the
  // window, and DECODED off-DOM before src swaps in — the previous paint holds until the new
  // one is ready (never a blank frame); a generation counter drops stale responses. Tables
  // and other files render as name cards (the detail view renders tables for real).
  import { imageUrl, type DissectFile } from "./loader";

  let {
    file,
    cellW,
    cellH,
    capH,
    selected,
    onSelect,
    onOpen,
    reportAspect,
  }: {
    file: DissectFile;
    cellW: number;
    cellH: number;
    capH: number;
    selected: boolean;
    onSelect: () => void;
    onOpen: () => void;
    reportAspect: (w: number, h: number) => void;
  } = $props();

  let src = $state<string | null>(null);
  let failed = $state(false);
  let gen = 0;

  $effect(() => {
    const abs = file.abs;
    const kind = file.kind;
    const my = ++gen;
    if (kind !== "image") {
      src = null;
      return;
    }
    void (async () => {
      const url = await imageUrl(abs);
      if (my !== gen) return;
      if (!url) {
        failed = true;
        return;
      }
      const im = new Image();
      im.decoding = "async";
      im.src = url;
      try {
        await im.decode();
      } catch {
        // undecodable is fine — the <img> just won't paint
      }
      if (my !== gen) return;
      reportAspect(im.naturalWidth, im.naturalHeight);
      src = url;
    })();
  });
</script>

<button
  class="cell"
  class:selected
  data-dissect-cell
  data-name={file.name}
  data-kind={file.kind}
  style:width={`${cellW}px`}
  tabindex="-1"
  title={file.name}
  onclick={onSelect}
  ondblclick={onOpen}
>
  <div class="surface" style:height={`${cellH}px`}>
    {#if file.kind === "image"}
      {#if src}
        <img {src} alt={file.name} draggable="false" />
      {:else if failed}
        <div class="card"><span class="ic">⚠</span><span class="lbl">unreadable</span></div>
      {/if}
    {:else if file.kind === "table"}
      <div class="card"><span class="ic">▦</span><span class="lbl">{file.name.replace(/\.(csv|tsv)$/i, "")}</span><span class="sub">{file.name.toLowerCase().endsWith(".tsv") ? "TSV" : "CSV"}</span></div>
    {:else}
      <div class="card"><span class="ic">📄</span><span class="lbl">{file.name}</span></div>
    {/if}
  </div>
  {#if capH > 0}
    <div class="caption" style:height={`${capH}px`}>
      {file.name}{#if file.semantic}<span class="sem" title="semantic fluxplot">◆</span>{/if}
    </div>
  {/if}
</button>

<style>
  .cell {
    display: block;
    text-align: left;
    background: none;
    border: none;
    padding: 0;
    font-family: inherit;
    cursor: pointer;
    border-radius: var(--r-2, 6px);
  }
  .surface {
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in oklab, var(--c-tx-hi) 3%, var(--c-bg));
    border-radius: var(--r-2, 6px);
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
  img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    height: 100%;
    padding: 8px;
    color: var(--c-tx-2);
  }
  .card .ic {
    font-size: 26px;
    color: var(--c-accent-bright);
  }
  .card .lbl {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
  }
  .card .sub {
    font-size: 10px;
    letter-spacing: 0.4px;
    color: var(--c-tx-muted);
  }
  .caption {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--c-tx-muted);
    font-size: 11px;
    line-height: 20px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 2px;
  }
  .cell.selected .caption {
    color: var(--c-tx);
  }
  .sem {
    color: var(--c-accent-bright);
    font-size: 9px;
  }
</style>

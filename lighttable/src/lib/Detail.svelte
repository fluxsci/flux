<script lang="ts">
  // Fullscreen viewer. The (already-decoded) grid thumbnail paints instantly
  // as an underlay while the full-res original decodes — never a blank frame.
  // Zoom model: "fit" mode is pure CSS (object-fit: contain); user zoom
  // renders the image at natural size inside a translated+scaled wrapper.
  import { store } from "./store.svelte";

  const setId = $derived(store.currentSet?.id ?? "");
  const itemKey = $derived(store.selectedKey);
  const cell = $derived(itemKey ? store.cellFor(setId, itemKey) : null);
  const pos = $derived(store.selIdx);
  const count = $derived(store.filteredKeys.length);

  let stage = $state<HTMLDivElement | null>(null);
  let sw = $state(0);
  let sh = $state(0);
  let natW = $state(0);
  let natH = $state(0);
  let thumbSrc = $state<string | null>(null);
  let fullSrc = $state<string | null>(null);
  let userZoomed = $state(false);
  let z = $state(1); // display px per natural px (only meaningful when userZoomed)
  let tx = $state(0);
  let ty = $state(0);
  let gen = 0;

  const fitScale = $derived(natW && natH && sw && sh ? Math.min(sw / natW, sh / natH, 1) : 1);

  $effect(() => {
    const el = stage;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      sw = el.clientWidth;
      sh = el.clientHeight;
    });
    ro.observe(el);
    sw = el.clientWidth;
    sh = el.clientHeight;
    return () => ro.disconnect();
  });

  $effect(() => {
    const s = setId;
    const k = itemKey;
    const present = cell?.present ?? false;
    const my = ++gen;
    natW = 0;
    natH = 0;
    thumbSrc = null;
    fullSrc = null;
    userZoomed = false;
    tx = 0;
    ty = 0;
    if (!k || !present) return;
    void (async () => {
      const t = await store.api?.thumbUrl(s, k, 512);
      if (my === gen && t) {
        const ti = new Image();
        ti.src = t;
        try {
          await ti.decode();
        } catch {}
        if (my === gen && !fullSrc) thumbSrc = t;
      }
      const f = await store.api?.fullUrl(s, k);
      if (!f || my !== gen) return;
      const im = new Image();
      im.decoding = "async";
      im.src = f;
      try {
        await im.decode();
      } catch {}
      if (my !== gen) return;
      natW = im.naturalWidth || 0;
      natH = im.naturalHeight || 0;
      fullSrc = f;
    })();
  });

  function toggleFit() {
    if (userZoomed) {
      userZoomed = false;
    } else if (natW && natH) {
      userZoomed = true; // 1:1
      z = 1;
      tx = 0;
      ty = 0;
    }
  }
  function zoomBy(f: number, cx = 0, cy = 0) {
    if (!natW || !natH) return;
    const oldZ = userZoomed ? z : fitScale;
    const newZ = Math.min(8, Math.max(fitScale * 0.25, oldZ * f));
    if (!userZoomed) {
      userZoomed = true;
      tx = 0;
      ty = 0;
    }
    // keep the point under (cx, cy) — stage-center coords — fixed
    tx = cx - ((cx - tx) * newZ) / oldZ;
    ty = cy - ((cy - ty) * newZ) / oldZ;
    z = newZ;
  }
  function resetZoom() {
    userZoomed = false;
    tx = 0;
    ty = 0;
  }

  $effect(() => {
    store.detailApi = { toggleFit, zoomBy: (f) => zoomBy(f), resetZoom };
    return () => {
      store.detailApi = null;
    };
  });

  function onWheel(e: WheelEvent) {
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    const cx = e.clientX - r.left - r.width / 2;
    const cy = e.clientY - r.top - r.height / 2;
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, cx, cy);
  }

  let dragging = $state(false);
  let lastX = 0;
  let lastY = 0;
  function onPointerDown(e: PointerEvent) {
    if (!userZoomed) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
  }
  function onPointerUp() {
    dragging = false;
  }

  // Click on the backdrop (not the image) returns to the grid.
  function onStageClick(e: MouseEvent) {
    if (e.target === stage) store.closeDetail();
  }
</script>

<div class="detail" data-detail>
  <div
    class="stage"
    bind:this={stage}
    onwheel={onWheel}
    onclick={onStageClick}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    role="presentation"
  >
    {#if cell?.present}
      {#if !userZoomed}
        {#if thumbSrc && !fullSrc}
          <img class="fit" src={thumbSrc} alt="" draggable="false" />
        {/if}
        {#if fullSrc}
          <img class="fit" src={fullSrc} alt={itemKey} draggable="false" />
        {/if}
      {:else}
        <div
          class="zoomwrap"
          class:dragging
          style:width={`${natW}px`}
          style:height={`${natH}px`}
          style:margin-left={`${-natW / 2}px`}
          style:margin-top={`${-natH / 2}px`}
          style:transform={`translate(${tx}px, ${ty}px) scale(${z})`}
        >
          <img src={fullSrc ?? thumbSrc} alt={itemKey} draggable="false" />
        </div>
      {/if}
    {:else}
      <div class="absent" data-detail-missing>
        <span class="k">{itemKey}</span>
        <span class="msg">not in “{store.currentSet?.name}”</span>
        <span class="hint">↑/↓ to switch sets</span>
      </div>
    {/if}
  </div>
  <div class="caption-bar">
    <span class="fname" data-detail-file>{cell?.file ?? itemKey}</span>
    <span class="dot">·</span>
    <span class="sname" data-detail-set>{store.currentSet?.name}</span>
    <span class="grow"></span>
    <span class="pos">{pos + 1} / {count}</span>
    <span class="zoom">{userZoomed ? `${Math.round(z * 100)}%` : "fit"}</span>
  </div>
</div>

<style>
  .detail {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    background: var(--c-detail-surface);
  }
  .stage {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  img.fit {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    padding: 16px;
    box-sizing: border-box;
  }
  .zoomwrap {
    position: absolute;
    left: 50%;
    top: 50%;
    cursor: grab;
  }
  .zoomwrap.dragging {
    cursor: grabbing;
  }
  .zoomwrap img {
    width: 100%;
    height: 100%;
    image-rendering: auto;
  }
  .absent {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--c-tx-muted);
  }
  .absent .k {
    font-size: 16px;
    color: var(--c-tx-2);
  }
  .absent .hint {
    font-size: 11px;
    color: var(--c-tx-faint);
  }
  .caption-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    background: var(--c-bg-raised);
    border-top: 1px solid var(--c-line);
    color: var(--c-tx-2);
    font-size: 12px;
  }
  .fname {
    color: var(--c-tx);
  }
  .dot {
    color: var(--c-tx-faint);
  }
  .grow {
    flex: 1;
  }
  .pos,
  .zoom {
    color: var(--c-tx-muted);
    font-variant-numeric: tabular-nums;
  }
</style>

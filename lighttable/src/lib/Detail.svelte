<script lang="ts">
  // Fullscreen viewer. The (already-decoded) grid thumbnail paints instantly
  // as an underlay while the full-res original decodes — never a blank frame.
  // Zoom model: "fit" mode is pure CSS (object-fit: contain); user zoom
  // renders the image at natural size inside a translated+scaled wrapper.
  // Controls: Ctrl/⌘+scroll zooms at the cursor (trackpad pinch arrives as
  // ctrl+wheel), plain scroll pans ↑↓, Shift+scroll pans ↔, and holding
  // Space + drag pans freely (the hand tool).
  import { store } from "./store.svelte";

  const setId = $derived(store.currentSet?.id ?? "");
  const itemKey = $derived(store.selectedKey);
  const cell = $derived(itemKey ? store.cellFor(setId, itemKey) : null);
  const pos = $derived(store.selIdx);
  const count = $derived(store.filteredKeys.length);
  const annot = $derived(store.annotFor(itemKey));

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

  // Ctrl/⌘+scroll = zoom at the cursor; the exponential factor makes mouse
  // notches (±120) and fine trackpad-pinch deltas both feel right. Plain
  // scroll = pan ↑↓; Shift+scroll = pan ↔ (some platforms pre-swap shifted
  // wheel into deltaX — native deltaX always pans ↔, so both arrivals work).
  function onWheel(e: WheelEvent) {
    if (!stage) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault(); // Chromium page-zooms on ctrl+wheel otherwise
      const r = stage.getBoundingClientRect();
      const cx = e.clientX - r.left - r.width / 2;
      const cy = e.clientY - r.top - r.height / 2;
      zoomBy(Math.pow(1.0015, -e.deltaY), cx, cy);
      return;
    }
    if (!userZoomed) return;
    e.preventDefault();
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    tx -= dx;
    ty -= dy;
  }

  // Svelte's `onwheel` attribute registers a passive listener; zoom needs
  // preventDefault (to stop ctrl+wheel page zoom), so attach by hand.
  $effect(() => {
    const el = stage;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // Drag-pan is the hand tool: it requires holding Space. A bare click-drag
  // neither pans nor closes the viewer.
  let spaceHeld = $state(false);
  let dragging = $state(false);
  let lastX = 0;
  let lastY = 0;
  let pressX = 0;
  let pressY = 0;
  let pressedOnBackdrop = false;
  let moved = false;

  $effect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      spaceHeld = true;
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld = false;
    };
    const clear = () => {
      spaceHeld = false;
      dragging = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  });

  function onPointerDown(e: PointerEvent) {
    pressedOnBackdrop = e.target === stage;
    pressX = e.clientX;
    pressY = e.clientY;
    moved = false;
    if (!spaceHeld || !userZoomed) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onPointerMove(e: PointerEvent) {
    if (e.buttons & 1 && Math.abs(e.clientX - pressX) + Math.abs(e.clientY - pressY) > 3) moved = true;
    if (!dragging) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
  }
  function onPointerUp() {
    dragging = false;
  }

  // Click on the backdrop (not the image) returns to the grid. Guards:
  // pointer capture during a Space-pan retargets the release click to the
  // stage itself, so e.target alone can't tell a backdrop click from a pan —
  // close only for a stationary press that STARTED on the backdrop, sans pan.
  function onStageClick(e: MouseEvent) {
    if (moved || !pressedOnBackdrop || spaceHeld) return;
    if (e.target === stage) store.closeDetail();
  }
</script>

<div class="detail" data-detail>
  <div
    class="stage"
    class:panready={spaceHeld && userZoomed}
    class:dragging
    bind:this={stage}
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
    {#if annot?.mark}
      <div class="markring" class:valid={annot.mark === "valid"} class:exclude={annot.mark === "exclude"} data-detail-mark={annot.mark}></div>
    {/if}
  </div>
  <div class="caption-bar">
    <span class="fname" data-detail-file>{cell?.file ?? itemKey}</span>
    {#if annot?.notes}<span class="star" title={annot.notes}>*</span>{/if}
    <span class="dot">·</span>
    <span class="sname" data-detail-set>{store.currentSet?.name}</span>
    {#if annot?.mark === "valid"}
      <span class="badge valid">✓ valid</span>
    {:else if annot?.mark === "exclude"}
      <span class="badge exclude">✕ excluded</span>
    {/if}
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
  .stage.panready {
    cursor: grab;
  }
  .stage.dragging {
    cursor: grabbing;
  }
  .zoomwrap {
    position: absolute;
    left: 50%;
    top: 50%;
  }
  .zoomwrap img {
    width: 100%;
    height: 100%;
    image-rendering: auto;
  }
  /* The annotation mark as a ring just inside the stage edge — visible at any
     zoom, never over the image content. */
  .markring {
    position: absolute;
    inset: 4px;
    border-radius: var(--radius-m);
    pointer-events: none;
  }
  .markring.valid {
    box-shadow: inset 0 0 0 3px var(--c-valid);
  }
  .markring.exclude {
    box-shadow: inset 0 0 0 3px var(--c-exclude);
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
  .star {
    color: var(--c-accent-bright);
    font-weight: 700;
    margin-left: -4px;
  }
  .badge {
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge.valid {
    color: var(--c-valid);
    background: var(--c-valid-tint);
  }
  .badge.exclude {
    color: var(--c-exclude);
    background: var(--c-exclude-tint);
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

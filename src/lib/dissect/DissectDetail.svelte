<script lang="ts">
  // The expanded view of one dissection file. Images get the lighttable viewer feel (ported,
  // not imported): "fit" is pure CSS object-fit; user zoom renders at natural size inside a
  // translated+scaled wrapper. Ctrl/⌘+scroll zooms at the cursor (trackpad pinch arrives as
  // ctrl+wheel), plain scroll pans ↑↓, Shift+scroll pans ↔, Space+drag is the hand tool.
  // Tables render the windowed DissectTable; other files say so honestly.
  import DissectTable from "./DissectTable.svelte";
  import { imageUrl, tableText, type DissectFile } from "./loader";

  let {
    file,
    pos,
    count,
    groupName,
    onClose,
  }: {
    file: DissectFile;
    pos: number;
    count: number;
    groupName: string;
    onClose: () => void;
  } = $props();

  let stage = $state<HTMLDivElement | null>(null);
  let sw = $state(0);
  let sh = $state(0);
  let natW = $state(0);
  let natH = $state(0);
  let src = $state<string | null>(null);
  let text = $state<string | null>(null);
  let failed = $state(false);
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
    const f = file;
    const my = ++gen;
    natW = 0;
    natH = 0;
    src = null;
    text = null;
    failed = false;
    userZoomed = false;
    tx = 0;
    ty = 0;
    void (async () => {
      if (f.kind === "image") {
        const url = await imageUrl(f.abs);
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
        } catch {}
        if (my !== gen) return;
        natW = im.naturalWidth || 0;
        natH = im.naturalHeight || 0;
        src = url;
      } else if (f.kind === "table") {
        const t = await tableText(f.abs);
        if (my !== gen) return;
        if (t === null) failed = true;
        else text = t;
      }
    })();
  });

  export function toggleFit() {
    if (userZoomed) userZoomed = false;
    else if (natW && natH) {
      userZoomed = true; // 1:1
      z = 1;
      tx = 0;
      ty = 0;
    }
  }
  export function zoomBy(f: number, cx = 0, cy = 0) {
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
  export function resetZoom() {
    userZoomed = false;
    tx = 0;
    ty = 0;
  }

  // Ctrl/⌘+scroll = zoom at the cursor; plain scroll = pan ↑↓; Shift+scroll = pan ↔.
  // Svelte's `onwheel` attribute registers passive; zoom needs preventDefault (Chromium
  // page-zooms on ctrl+wheel), so attach by hand.
  function onWheel(e: WheelEvent) {
    if (!stage || file.kind !== "image") return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
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
  $effect(() => {
    const el = stage;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // Space+drag = the hand tool (a bare click-drag neither pans nor closes).
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

  // Click the backdrop beside the image → back to the grid. Pointer capture during a
  // Space-pan retargets the release click to the stage itself, so e.target alone can't
  // tell a backdrop click from a pan — close only for a stationary backdrop press sans pan.
  function onStageClick(e: MouseEvent) {
    if (moved || !pressedOnBackdrop || spaceHeld) return;
    if (e.target === stage) onClose();
  }
</script>

<div class="detail" data-dissect-detail>
  {#if file.kind === "image"}
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
      {#if failed}
        <div class="absent">couldn't read {file.name}</div>
      {:else if !userZoomed}
        {#if src}<img class="fit" {src} alt={file.name} draggable="false" />{/if}
      {:else}
        <div
          class="zoomwrap"
          style:width={`${natW}px`}
          style:height={`${natH}px`}
          style:margin-left={`${-natW / 2}px`}
          style:margin-top={`${-natH / 2}px`}
          style:transform={`translate(${tx}px, ${ty}px) scale(${z})`}
        >
          <img {src} alt={file.name} draggable="false" />
        </div>
      {/if}
    </div>
  {:else if file.kind === "table"}
    {#if failed}
      <div class="stage"><div class="absent">couldn't read {file.name}</div></div>
    {:else if text !== null}
      <DissectTable {text} name={file.name} />
    {/if}
  {:else}
    <div class="stage">
      <div class="absent">
        <span class="k">{file.name}</span>
        <span>no viewer for this file type yet</span>
      </div>
    </div>
  {/if}
  <div class="caption-bar">
    <span class="fname">{file.name}</span>
    {#if groupName}<span class="dot">·</span><span class="gname">{groupName}</span>{/if}
    <span class="grow"></span>
    <span class="pos">{pos + 1} / {count}</span>
    {#if file.kind === "image"}
      <span class="zoom" data-dissect-zoom>{userZoomed ? `${Math.round(z * 100)}%` : "fit"}</span>
    {/if}
  </div>
</div>

<style>
  .detail {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: color-mix(in oklab, var(--c-bg) 94%, black);
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
  }
  .absent {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--c-tx-muted);
    font-style: italic;
  }
  .absent .k {
    font-style: normal;
    color: var(--c-tx-2);
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
  .gname {
    color: var(--c-tx-muted);
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

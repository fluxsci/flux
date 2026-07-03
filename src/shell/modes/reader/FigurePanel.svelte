<script lang="ts">
  // A floating figure panel (R5): a page region rendered at 2× into an <img>, kept
  // on screen while you read elsewhere — ReadCube's "pop out the figure". Drag by
  // the header, resize from the corner (CSS resize), click to raise. The image is a
  // data URL rendered by PdfView.renderRegion, so panels survive page virtualization.
  let {
    src,
    page,
    x,
    y,
    z = 70,
    onClose,
    onJump,
    onFocus,
  }: {
    src: string;
    page: number;
    x: number;
    y: number;
    z?: number;
    onClose?: () => void;
    onJump?: () => void;
    onFocus?: () => void;
  } = $props();

  let px = $state(0);
  let py = $state(0);
  let seeded = false;
  $effect(() => {
    if (!seeded) {
      seeded = true;
      px = x;
      py = y;
    }
  });

  let drag: { dx: number; dy: number } | null = null;
  function down(e: MouseEvent) {
    drag = { dx: e.clientX - px, dy: e.clientY - py };
    onFocus?.();
    e.preventDefault();
  }
  function move(e: MouseEvent) {
    if (!drag) return;
    px = Math.min(Math.max(e.clientX - drag.dx, 8), window.innerWidth - 80);
    py = Math.min(Math.max(e.clientY - drag.dy, 40), window.innerHeight - 40);
  }
  const up = () => (drag = null);
</script>

<svelte:window onmousemove={move} onmouseup={up} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="figpanel" data-testid="figure-panel" style:left="{px}px" style:top="{py}px" style:z-index={z} onmousedown={() => onFocus?.()}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fhead" onmousedown={down}>
    <span class="ftitle">Figure · p.{page}</span>
    <span class="spacer"></span>
    <button class="fb" title="Go to page {page}" aria-label="Go to source page" onclick={onJump}>p.{page} →</button>
    <button class="fb" title="Close" aria-label="Close figure panel" onclick={onClose}>✕</button>
  </div>
  <div class="fbody">
    <img {src} alt="Popped-out region of page {page}" draggable="false" />
  </div>
</div>

<style>
  .figpanel {
    position: fixed;
    width: 480px;
    min-width: 220px;
    min-height: 120px;
    max-width: 90vw;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2, 8px);
    box-shadow: var(--elev-2, 0 6px 24px rgba(0, 0, 0, 0.45));
    overflow: hidden;
    resize: both;
  }
  .fhead {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--c-bg);
    border-bottom: 1px solid var(--c-line);
    cursor: grab;
    user-select: none;
  }
  .fhead:active {
    cursor: grabbing;
  }
  .ftitle {
    font-size: var(--ts-xs);
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--c-tx-faint);
  }
  .spacer {
    flex: 1 1 auto;
  }
  .fb {
    border: none;
    background: none;
    color: var(--c-tx-faint);
    cursor: pointer;
    font-size: var(--ts-xs);
    padding: 2px 5px;
    border-radius: var(--r-1);
  }
  .fb:hover {
    color: var(--c-accent);
  }
  .fbody {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    background: #fff;
  }
  .fbody img {
    display: block;
    width: 100%;
    height: auto;
  }
</style>

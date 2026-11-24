<script lang="ts">
  // The card that opens on a comment's mark in an artifact page (or to write a new one). The
  // page is in a frame, so the card is the app's and hangs from a box the page reported: the
  // mark's place in the frame, turned into window coordinates here. Drawn as Paper's comment
  // card is (the Comments pane's ink on the margin kit).
  import { computePosition, offset, flip, shift } from "@floating-ui/dom";
  import type { Snippet } from "svelte";
  import type { FrameRect } from "../../../../lib/artifacts/frameProtocol";
  import "../margin/marginKit.css";

  let { rect, stage, pinned = false, id = "", children, onenter, onleave, onpin, onClose }: {
    /** The mark, in the frame's own viewport. */
    rect: FrameRect;
    /** The element the frame fills. */
    stage: HTMLElement;
    pinned?: boolean;
    id?: string;
    children: Snippet;
    onenter?: () => void;
    onleave?: () => void;
    /** Something in the card took the keyboard: it is being worked in. */
    onpin?: () => void;
    onClose: () => void;
  } = $props();

  let card = $state<HTMLDivElement | undefined>(undefined);
  let x = $state(0), y = $state(0), ready = $state(false), away = $state(false);
  $effect(() => {
    const el = card, r = rect, host = stage;
    if (!el || !host) return;
    const box = host.getBoundingClientRect();
    // Its mark scrolled out of the page's view: the card goes with it (and comes back with it).
    away = r.y + r.h < 0 || r.y > box.height || r.x + r.w < 0 || r.x > box.width;
    const left = box.left + Math.max(0, r.x), top = box.top + Math.max(0, r.y);
    const right = box.left + Math.min(box.width, r.x + r.w), bottom = box.top + Math.min(box.height, r.y + r.h);
    const reference = { getBoundingClientRect: () => new DOMRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top)) };
    let stale = false;
    void computePosition(reference, el, { strategy: "fixed", placement: "bottom-start", middleware: [offset(7), flip({ fallbackPlacements: ["top-start", "bottom-end", "top-end"], padding: 10 }), shift({ padding: 10 })] }).then((pos) => {
      if (stale) return;
      x = Math.round(pos.x); y = Math.round(pos.y); ready = true;
    });
    return () => { stale = true; };
  });
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="artifact-card mk-host" class:ready class:pinned class:away bind:this={card} data-artifact-card={id} style:left={`${x}px`} style:top={`${y}px`} role="dialog" aria-label="Comment" tabindex="-1" onmouseenter={onenter} onmouseleave={onleave} onfocusin={onpin} onkeydown={onKey}>
  <div class="mk body" style="--pane-c: var(--flx-magenta-600)">{@render children()}</div>
</div>

<style>
  .artifact-card { position: fixed; z-index: 70; width: min(340px, calc(100vw - 20px)); opacity: 0; pointer-events: none; outline: none; }
  .artifact-card.ready { opacity: 1; pointer-events: auto; animation: artifact-card-in 90ms ease-out; }
  .artifact-card.away { visibility: hidden; pointer-events: none; }
  @keyframes artifact-card-in { from { opacity: 0; transform: translateY(-3px); } }
  .body { display: grid; gap: 9px; max-height: min(62vh, 460px); overflow: auto; padding: 10px 12px 9px; border: 1.5px solid color-mix(in oklab, var(--pane-c) 55%, var(--flx-paper)); border-radius: var(--r-2); background: var(--flx-paper); box-shadow: 0 1px 0 rgba(16, 15, 15, 0.03), 0 12px 28px -12px rgba(74, 56, 16, 0.5); color: var(--c-tx); font-family: var(--font-serif); font-size: var(--ts-sm); scrollbar-width: thin; }
  .pinned .body { border-color: var(--pane-c); }
  @media (prefers-reduced-motion: reduce) { .artifact-card.ready { animation: none; } }
</style>

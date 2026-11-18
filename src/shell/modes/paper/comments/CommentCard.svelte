<script lang="ts">
  // The card that opens on commented text: rest the pointer on a highlight (or click it) and its
  // thread is right there to read, answer, edit, tag, resolve or delete. A new comment is written
  // in the same card, on the selection it is about. Drawn in the Comments pane's ink on the
  // margin kit, so it is the pane's card, floating.
  import { computePosition, autoUpdate, offset, flip, shift, hide } from "@floating-ui/dom";
  import type { CommentBridge } from "../margin/types";
  import type { CommentThread } from "./comments";
  import CommentThreadView from "./CommentThreadView.svelte";
  import "../margin/marginKit.css";

  let { thread, api, anchor, pinned = false, onenter, onleave, onpin, onlost, onClose, onOpenInMargin }: {
    thread: CommentThread & { draft?: boolean };
    api: CommentBridge;
    /** The piece of highlight the card hangs from. */
    anchor: HTMLElement;
    /** Opened by a click or to write in: it stays until dismissed. */
    pinned?: boolean;
    onenter?: () => void;
    onleave?: () => void;
    /** Something in the card took the keyboard: it is being worked in. */
    onpin?: () => void;
    /** The anchor element is no longer in the page (the editor redrew or dropped its line). */
    onlost?: () => void;
    onClose: () => void;
    onOpenInMargin: () => void;
  } = $props();

  let card = $state<HTMLDivElement | undefined>(undefined);
  let x = $state(0), y = $state(0), ready = $state(false), away = $state(false);

  // Keep it on its text while the page scrolls or the thread grows; let go when its text is gone.
  $effect(() => {
    const el = card, at = anchor;
    if (!el || !at) return;
    return autoUpdate(at, el, async () => {
      if (!at.isConnected) { away = true; onlost?.(); return; }
      const pos = await computePosition(at, el, { strategy: "fixed", placement: "bottom-start", middleware: [offset(7), flip({ fallbackPlacements: ["top-start", "bottom-end", "top-end"], padding: 10 }), shift({ padding: 10 }), hide()] });
      // Its text scrolled out of the page's view: the card goes with it (and comes back with it).
      x = Math.round(pos.x); y = Math.round(pos.y); away = !!pos.middlewareData.hide?.referenceHidden; ready = true;
    });
  });
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="comment-card mk-host" class:ready class:pinned class:away bind:this={card} data-comment-card={thread.id} style:left={`${x}px`} style:top={`${y}px`} role="dialog" aria-label="Comment" tabindex="-1" onmouseenter={onenter} onmouseleave={onleave} onfocusin={onpin} onkeydown={onKey}>
  <div class="mk body" style="--pane-c: var(--flx-magenta-600)">
    <p class="about mk-clip" title={thread.anchor.quote}><span class="mk-eyebrow">{thread.draft ? "New comment on" : "On"}</span><q>{thread.anchor.quote.trim()}</q></p>
    <CommentThreadView {thread} {api} {onOpenInMargin} onDone={onClose} lead={pinned} />
  </div>
</div>

<style>
  .comment-card {
    position: fixed;
    z-index: 70;
    width: min(340px, calc(100vw - 20px));
    opacity: 0;
    pointer-events: none;
    outline: none;
  }
  .comment-card.ready {
    opacity: 1;
    pointer-events: auto;
    animation: comment-card-in 90ms ease-out;
  }
  .comment-card.away {
    visibility: hidden;
    pointer-events: none;
  }
  @keyframes comment-card-in {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
  }
  /* The Comments pane's card: paper, outlined in its ink. A pinned one holds the ink at full strength. */
  .body {
    display: grid;
    gap: 9px;
    max-height: min(62vh, 460px);
    overflow: auto;
    padding: 10px 12px 9px;
    border: 1.5px solid color-mix(in oklab, var(--pane-c) 55%, var(--flx-paper));
    border-radius: var(--r-2);
    background: var(--flx-paper);
    box-shadow:
      0 1px 0 rgba(16, 15, 15, 0.03),
      0 12px 28px -12px rgba(74, 56, 16, 0.5);
    color: var(--c-tx);
    font-family: var(--font-serif);
    font-size: var(--ts-sm);
    scrollbar-width: thin;
  }
  .pinned .body {
    border-color: var(--pane-c);
  }
  /* What it is about, in a line. */
  .about {
    display: flex;
    align-items: baseline;
    gap: 7px;
    margin: 0;
    min-width: 0;
    padding-bottom: 7px;
    border-bottom: 1px solid var(--c-line);
    color: var(--c-tx-muted);
    font-size: var(--ts-xs);
  }
  .about q {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-style: italic;
    quotes: "“" "”";
  }
  @media (prefers-reduced-motion: reduce) {
    .comment-card.ready {
      animation: none;
    }
  }
</style>

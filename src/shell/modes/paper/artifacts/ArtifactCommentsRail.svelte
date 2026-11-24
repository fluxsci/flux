<script lang="ts">
  // Every comment on the artifact, beside the page: the ones on what you are looking at first,
  // then the ones elsewhere in it (another page, another view), then the ones whose passage the
  // page no longer has, and the resolved ones folded away. The page's own Comments pane.
  import type { Snippet } from "svelte";
  import type { ArtifactThread, ThreadPlace } from "../../../../lib/artifacts/comments";
  import "../margin/marginKit.css";

  let { threads, placeOf, activeId = "", row, onPick, onClose }: {
    threads: ArtifactThread[];
    placeOf: (thread: ArtifactThread) => ThreadPlace;
    activeId?: string;
    /** One thread, drawn by the view that owns what can be done to it. */
    row: Snippet<[ArtifactThread, ThreadPlace]>;
    /** Start a comment on a part of the page. */
    onPick: () => void;
    onClose: () => void;
  } = $props();

  let showResolved = $state(false);
  const open = $derived(threads.filter((t) => !t.resolved));
  const resolved = $derived(threads.filter((t) => t.resolved));
  const ORDER: Record<ThreadPlace, number> = { here: 0, page: 1, "other-view": 2, "other-page": 3, lost: 4 };
  const sorted = $derived([...open].map((t) => ({ t, place: placeOf(t) })).sort((a, b) => ORDER[a.place] - ORDER[b.place]));
</script>

<aside class="arail mk-host" aria-label="Comments on this artifact">
  <div class="mk" style="--pane-c: var(--flx-magenta-600)">
    <header>
      <span class="mk-eyebrow">Comments</span>
      <span class="count mk-num">{open.length} open</span>
      <span class="mk-grow"></span>
      <button class="mk-btn sm quiet" onclick={onPick} title="Comment on a plot, a figure or any part of the page: click it">On a part…</button>
      <button class="x" aria-label="Close comments" title="Close (Alt+A)" onclick={onClose}><svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg></button>
    </header>
    <div class="list">
      {#each sorted as { t, place } (t.id)}
        <section class="one" class:on={t.id === activeId} data-rail-thread={t.id}>{@render row(t, place)}</section>
      {/each}
      {#if !open.length}
        <p class="mk-empty">No open comments on this artifact. Select words in the page and choose <b>Comment</b>, or use <b>On a part…</b> for a plot or a figure. An agent that answers shows up here and on the page.</p>
      {/if}
      {#if resolved.length}
        <button class="fold" aria-expanded={showResolved} onclick={() => (showResolved = !showResolved)}>
          <svg class:open={showResolved} viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>Resolved <span class="mk-num">{resolved.length}</span>
        </button>
        {#if showResolved}
          {#each resolved as t (t.id)}
            <section class="one done" data-rail-thread={t.id}>{@render row(t, placeOf(t))}</section>
          {/each}
        {/if}
      {/if}
    </div>
  </div>
</aside>

<style>
  .arail { flex: 0 0 328px; min-width: 0; display: flex; border-left: 1px solid var(--c-line-strong); background: var(--flx-paper); }
  .mk { flex: 1; min-width: 0; display: flex; flex-direction: column; font-family: var(--font-serif); font-size: var(--ts-sm); color: var(--c-tx); }
  header { flex: none; display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 8px 0 12px; border-bottom: 1px solid var(--c-line); }
  .count { color: var(--c-tx-faint); font-size: var(--ts-xs); }
  .x { display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: var(--r-1); background: none; color: var(--c-tx-muted); cursor: var(--cursor-cross-hover); }
  .x:hover { background: var(--mk-tint-2); color: var(--pane-c); }
  .x svg, .fold svg { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .list { flex: 1; min-height: 0; overflow: auto; padding: 10px 10px 16px; display: grid; gap: 10px; align-content: start; scrollbar-width: thin; }
  .one { padding: 10px 11px 8px; border: 1px solid var(--c-line-strong); border-radius: var(--r-2); background: #fffefa; }
  .one.on { border-color: var(--pane-c); box-shadow: inset 2px 0 0 var(--pane-c); }
  .one.done { opacity: .78; }
  .fold { justify-self: start; display: inline-flex; align-items: center; gap: 5px; padding: 3px 6px; border: 0; border-radius: var(--r-1); background: none; color: var(--c-tx-muted); font: var(--ts-xs) var(--font-serif); cursor: var(--cursor-cross-hover); }
  .fold:hover { background: var(--mk-tint-2); color: var(--pane-c); }
  .fold svg { transition: transform 80ms linear; }
  .fold svg.open { transform: rotate(90deg); }
  .x:focus-visible, .fold:focus-visible { outline: 2px solid var(--c-accent); outline-offset: -1px; }
</style>

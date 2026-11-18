<script lang="ts">
  // The margin's Comments pane: every thread on this document, newest reading last, each one
  // the same view the card on the page shows (CommentThreadView). Tags in use become a filter
  // row; with no tags there is no row (owner, 2026-11-18: "don't have any tags by default, so
  // that only comes into play for users who want it").
  import type { MarginHost, MarginApi } from "../types";
  import { commentInInbox } from "../../../../../lib/project/comments";
  import { tagColor } from "../../../../../lib/project/commentTags";
  import FluxAiMark from "../../../../agent/FluxAiMark.svelte";
  import CommentThreadView from "../../comments/CommentThreadView.svelte";

  let { host }: { host: MarginHost; margin: MarginApi } = $props();

  const c = $derived(host.comments);

  // What the filter row offers: each tag in use (with how many open comments carry it), and
  // "Flux AI" once comments of both kinds exist. One filter at a time; click it again to clear.
  const AI = "\u0000ai";
  let filter = $state<string | null>(null);
  const live = $derived(c.threads.filter((t) => !t.draft));
  const tagCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const t of live) for (const tag of t.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + (t.resolved ? 0 : 1));
    // Your list's order first (Settings), then anything else a file carries.
    const order = new Map(c.tagDefs.map((d, i) => [d.name, i]));
    return [...counts].sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999) || a[0].localeCompare(b[0]));
  });
  const aiCount = $derived(live.filter((t) => !t.resolved && commentInInbox(t)).length);
  const mixed = $derived(live.some((t) => commentInInbox(t)) && live.some((t) => !commentInInbox(t)));
  const showFilters = $derived(tagCounts.length > 0 || mixed);
  // A filter whose last comment lost the tag would hide everything with nothing left to click.
  $effect(() => {
    if (filter === null) return;
    if (filter === AI ? !mixed : !tagCounts.some(([name]) => name === filter)) filter = null;
  });
  const passes = (t: (typeof c.threads)[number]) => t.draft || filter === null || (filter === AI ? commentInInbox(t) : !!t.tags?.includes(filter));

  // PAP-8: bucket by status, not by mark presence. A RESOLVED thread has no live range (its
  // mark was removed on resolve) but is NOT detached — it belongs in the main list so its
  // Reopen action is reachable. Only a thread that is unresolved, not a draft, and whose
  // anchor no longer resolves in the text is genuinely detached (delete-only).
  const anchored = $derived(c.threads.filter((t) => (t.draft || t.resolved || c.ranges.has(t.id)) && passes(t)));
  const detached = $derived(c.threads.filter((t) => !t.draft && !t.resolved && !c.ranges.has(t.id) && passes(t)));
  const resolvedCount = $derived(c.threads.filter((t) => t.resolved).length);

  // The thread you clicked in the text is brought into view here (never the other way round:
  // scrolling the pane must not move the manuscript).
  let list = $state<HTMLDivElement | undefined>(undefined);
  $effect(() => {
    const id = c.activeId;
    if (!id || !list) return;
    list.querySelector(`[data-thread-card="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  });
</script>

<div class="cv mk-pane">
  <div class="head mk-row-flex">
    <span class="count mk-grow"><b class="mk-num">{c.count}</b> open{#if resolvedCount}<span class="dot" aria-hidden="true">·</span><span class="mk-meta">{resolvedCount} resolved</span>{/if}</span>
    <button class="new mk-btn sm" onclick={() => c.onStart(false)} title="Comment on the selected text, just for you (Ctrl+Alt+M)">+ Comment</button>
    <button class="new ai mk-btn sm" onclick={() => c.onStart(true)} aria-label="Comment for Flux AI" title="Comment on the selected text for Flux AI: it goes to the AI Inbox (Ctrl+Shift+Alt+M)"><FluxAiMark still size={14} tone="live" /></button>
  </div>

  {#if showFilters}
    <div class="filters" role="group" aria-label="Show only">
      {#each tagCounts as [name, n] (name)}
        <button class="f" class:on={filter === name} aria-pressed={filter === name} data-filter-tag={name} style:--tag-c={tagColor(c.tagDefs, name) ?? "var(--c-tx-muted)"} onclick={() => (filter = filter === name ? null : name)} title={filter === name ? "Show every comment" : `Show only comments tagged #${name}`}><i aria-hidden="true"></i>#{name}<span class="n mk-num">{n}</span></button>
      {/each}
      {#if mixed}
        <button class="f ai" class:on={filter === AI} aria-pressed={filter === AI} data-filter-ai onclick={() => (filter = filter === AI ? null : AI)} title={filter === AI ? "Show every comment" : "Show only comments in the AI Inbox"}><FluxAiMark still size={11} tone="live" />Flux AI<span class="n mk-num">{aiCount}</span></button>
      {/if}
    </div>
  {/if}

  {#if c.threads.length === 0}
    <p class="mk-empty">Select text in the manuscript, then <b>+ Comment</b> to leave yourself a note on it, or the Flux AI mark to send one to the AI Inbox.</p>
  {:else if anchored.length === 0 && detached.length === 0}
    <p class="mk-empty">No comment matches this filter. <button class="linkish" onclick={() => (filter = null)}>Show them all</button></p>
  {/if}

  <div class="threads" bind:this={list}>
    {#each anchored as t (t.id)}
      <div class="card" class:active={t.id === c.activeId} class:resolved={t.resolved} data-thread-card={t.id}>
        {#if t.draft && c.cardId === t.id}
          <!-- It is being written in the card on the page: say so, do not offer a second composer. -->
          <p class="writing"><span class="mk-eyebrow">New comment</span>being written on the page, at “<span class="q">{t.anchor.quote.trim()}</span>”</p>
        {:else}
          <CommentThreadView thread={t} api={c} lead={!!t.draft} />
        {/if}
      </div>
    {/each}

    {#if detached.length}
      <div class="detached-h mk-eyebrow" title="Their text is gone from the manuscript">Detached</div>
      {#each detached as t (t.id)}
        <div class="card detached" data-thread-card={t.id}>
          {#each t.messages.slice(0, 1) as msg}
            <div class="mtext muted">{msg.body}</div>
          {/each}
          <div class="acts"><button class="del" onclick={() => c.onDelete(t.id)}>Delete</button></div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .head {
    flex: 0 0 auto;
  }
  .count {
    font-size: var(--ts-sm);
    color: var(--c-tx);
  }
  .count b {
    font-weight: 600;
    font-size: 1em;
  }
  .dot {
    margin: 0 6px;
    color: var(--c-tx-faint);
  }
  /* The second way in: the same button, wearing the mark, because this one goes to the AI Inbox. */
  .new.ai {
    display: inline-grid;
    place-items: center;
    width: calc(26px * var(--ts-scale, 1));
    padding: 0;
  }
  /* Filters: a quiet row of what is in use. The chosen one takes its tag's colour as a tint. */
  .filters {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: -2px;
  }
  .f {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: calc(20px * var(--ts-scale, 1));
    padding: 0 6px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    background: none;
    color: var(--c-tx-2);
    font: calc(10.5px * var(--ts-scale, 1)) / 1 var(--font-mono);
    cursor: var(--cursor-cross-hover);
    transition:
      background 80ms linear,
      border-color 80ms linear,
      color 80ms linear;
  }
  .f i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--tag-c);
  }
  .f .n {
    color: var(--c-tx-faint);
    font-size: 0.95em;
  }
  .f:hover {
    border-color: var(--mk-edge);
    background: var(--mk-tint);
  }
  .f.on {
    border-color: color-mix(in oklab, var(--tag-c, var(--pane-c)) 60%, transparent);
    background: color-mix(in oklab, var(--tag-c, var(--pane-c)) 13%, transparent);
    color: var(--c-tx);
    box-shadow: inset 2px 0 0 var(--tag-c, var(--pane-c));
  }
  .f.ai {
    --tag-c: var(--c-accent);
  }
  .threads {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    margin: 0 -12px -10px;
    padding: 0 0 6px;
    border-top: 1px solid var(--c-line);
    scrollbar-width: thin;
    scrollbar-color: color-mix(in oklab, var(--c-tx) 22%, transparent) transparent;
  }
  /* One thread: a band between hairlines. The thread your caret is in carries the rail. */
  .card {
    padding: 10px 12px 8px 14px;
    border-bottom: 1px solid var(--c-line);
    transition:
      background 80ms linear,
      box-shadow 80ms linear;
  }
  .card:hover {
    background: var(--mk-tint);
  }
  .card.active {
    background: var(--mk-tint);
    box-shadow: inset 2px 0 0 var(--pane-c);
  }
  /* A resolved thread keeps its place but not its length: three lines a message until you
     click it (an answered question should not push the open ones off the pane). */
  .card.resolved:not(.active) :global(.mtext) {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
  }
  .writing {
    margin: 0;
    color: var(--c-tx-muted);
    font-size: var(--ts-xs);
    font-style: italic;
    line-height: 1.45;
  }
  .writing .mk-eyebrow {
    display: block;
    margin-bottom: 3px;
    font-style: normal;
  }
  .writing .q {
    display: inline;
    color: var(--c-tx-2);
  }
  .mtext {
    color: var(--c-tx-2);
    font-size: var(--ts-sm);
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .mtext.muted {
    color: var(--c-tx-muted);
    font-style: italic;
  }
  .acts {
    display: flex;
    gap: 2px;
    margin: 6px 0 0 -6px;
  }
  .acts button {
    height: calc(22px * var(--ts-scale, 1));
    padding: 0 6px;
    border: 0;
    border-radius: var(--r-1);
    background: none;
    color: var(--c-tx-muted);
    font: var(--ts-xs) var(--font-serif);
    cursor: var(--cursor-cross-hover);
    transition:
      color 80ms linear,
      background 80ms linear;
  }
  .acts .del:hover {
    color: var(--c-danger);
    background: color-mix(in oklab, var(--c-danger) 10%, transparent);
  }
  .linkish {
    padding: 0;
    border: 0;
    background: none;
    color: var(--pane-c);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: var(--cursor-cross-hover);
  }
  .detached-h {
    padding: 10px 12px 4px 14px;
  }
  @media (prefers-reduced-motion: reduce) {
    .f,
    .card,
    .acts button {
      transition: none;
    }
  }
</style>

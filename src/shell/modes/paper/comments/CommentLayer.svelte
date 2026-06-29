<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { EditorView } from "@codemirror/view";
  import Icon from "../../../Icon.svelte";
  import { fadeRise } from "../../../../lib/motion/actions";
  import type { CommentThread } from "./comments";

  let {
    threads,
    view,
    ranges,
    activeId,
    author,
    onSubmitNew,
    onCancelNew,
    onReply,
    onResolve,
    onReopen,
    onDelete,
    onFocus,
  }: {
    threads: (CommentThread & { draft?: boolean })[];
    view: EditorView | undefined;
    ranges: Map<string, { from: number; to: number }>;
    activeId: string | null;
    author: string;
    onSubmitNew: (id: string, body: string) => void;
    onCancelNew: (id: string) => void;
    onReply: (id: string, body: string) => void;
    onResolve: (id: string) => void;
    onReopen: (id: string) => void;
    onDelete: (id: string) => void;
    onFocus: (id: string) => void;
  } = $props();

  let layerEl = $state<HTMLDivElement>();
  const cardEls: Record<string, HTMLElement> = {};
  let positions = $state<Record<string, number>>({});
  let draftText = $state("");
  let replyingId = $state<string | null>(null);
  let replyText = $state("");

  const anchored = $derived(threads.filter((t) => ranges.has(t.id)));
  const detached = $derived(threads.filter((t) => !ranges.has(t.id) && !t.draft));

  async function reflow() {
    if (!view || !layerEl) return;
    await tick();
    const layerTop = layerEl.getBoundingClientRect().top;
    const items = anchored
      .map((t) => {
        const r = ranges.get(t.id)!;
        const c = view!.coordsAtPos(r.from);
        return { id: t.id, y: c ? c.top : null };
      })
      .filter((x): x is { id: string; y: number } => x.y != null)
      .sort((a, b) => a.y - b.y);

    const pos: Record<string, number> = {};
    let prevBottom = -Infinity;
    for (const { id, y } of items) {
      const desired = y - layerTop;
      const h = cardEls[id]?.offsetHeight ?? 64;
      const top = Math.max(desired, prevBottom + 8);
      pos[id] = top;
      prevBottom = top + h;
    }
    positions = pos;
  }

  onMount(() => {
    const scroller = view?.scrollDOM;
    const onScroll = () => reflow();
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => reflow());
    if (scroller) ro.observe(scroller);
    reflow();
    return () => {
      scroller?.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  });

  // Reposition whenever the thread set, ranges, or measured heights change.
  $effect(() => {
    void threads;
    void ranges;
    void activeId;
    reflow();
  });

  function submitDraft(id: string) {
    const t = draftText.trim();
    if (t) onSubmitNew(id, t);
    else onCancelNew(id);
    draftText = "";
  }
  function submitReply(id: string) {
    const t = replyText.trim();
    if (t) onReply(id, t);
    replyText = "";
    replyingId = null;
  }
  function timeOf(iso: string): string {
    const d = new Date(iso);
    if (isNaN(+d)) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function initials(name: string): string {
    return (
      name
        .split(/\s+/)
        .map((s) => s[0])
        .filter(Boolean)
        .slice(0, 2)
        .join("")
        .toUpperCase() || "?"
    );
  }
</script>

<div class="clayer" bind:this={layerEl}>
  {#each anchored as t (t.id)}
    <div
      class="ccard"
      class:active={t.id === activeId}
      class:resolved={t.resolved}
      bind:this={cardEls[t.id]}
      style="transform:translateY({positions[t.id] ?? 0}px)"
      role="button"
      tabindex="0"
      onkeydown={(e) => e.key === "Enter" && onFocus(t.id)}
      onclick={() => onFocus(t.id)}
      transition:fadeRise={{ y: 4 }}>
      {#if t.draft}
        <div class="composer">
          <div class="who"><span class="ava">{initials(author)}</span>{author}</div>
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            bind:value={draftText}
            placeholder="Add a comment…"
            autofocus
            rows="2"
            onkeydown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitDraft(t.id);
              if (e.key === "Escape") onCancelNew(t.id);
            }}></textarea>
          <div class="actions">
            <button class="ghost" onclick={() => onCancelNew(t.id)}>Cancel</button>
            <button class="primary" onclick={() => submitDraft(t.id)}>Comment</button>
          </div>
        </div>
      {:else}
        <div class="chead">
          <span class="who"><span class="ava">{initials(t.messages[0]?.author ?? "")}</span></span>
          <div class="meta">
            <span class="nm">{t.messages[0]?.author}</span>
            <span class="tm">{timeOf(t.messages[0]?.createdAt ?? "")}</span>
          </div>
          <div class="tools">
            {#if t.resolved}
              <button class="ic" title="Reopen" aria-label="Reopen" onclick={(e) => { e.stopPropagation(); onReopen(t.id); }}>
                <Icon name="cornerUpRight" size={13} />
              </button>
            {:else}
              <button class="ic" title="Resolve" aria-label="Resolve" onclick={(e) => { e.stopPropagation(); onResolve(t.id); }}>
                <Icon name="check" size={14} />
              </button>
            {/if}
            <button class="ic" title="Delete" aria-label="Delete" onclick={(e) => { e.stopPropagation(); onDelete(t.id); }}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        </div>

        {#if !t.resolved}
          {#each t.messages as m, i (i)}
            {#if i === 0}
              <p class="body">{m.body}</p>
            {:else}
              <div class="reply">
                <span class="rwho">{m.author}</span>
                <p class="body">{m.body}</p>
              </div>
            {/if}
          {/each}

          {#if replyingId === t.id}
            <!-- svelte-ignore a11y_autofocus -->
            <textarea
              class="replybox"
              bind:value={replyText}
              placeholder="Reply…"
              autofocus
              rows="2"
              onclick={(e) => e.stopPropagation()}
              onkeydown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitReply(t.id);
                if (e.key === "Escape") replyingId = null;
              }}></textarea>
            <div class="actions">
              <button class="ghost" onclick={(e) => { e.stopPropagation(); replyingId = null; }}>Cancel</button>
              <button class="primary" onclick={(e) => { e.stopPropagation(); submitReply(t.id); }}>Reply</button>
            </div>
          {:else}
            <button class="replylink" onclick={(e) => { e.stopPropagation(); replyingId = t.id; replyText = ""; }}>
              <Icon name="reply" size={12} /> Reply
            </button>
          {/if}
        {:else}
          <p class="body resolved-line">{t.messages[0]?.body}</p>
          <span class="resolved-tag">Resolved</span>
        {/if}
      {/if}
    </div>
  {/each}

  {#if detached.length}
    <div class="detached-wrap" style="transform:translateY({Math.max(...Object.values(positions).map((p) => p + 120), 40)}px)">
      <div class="detached-head">Detached ({detached.length})</div>
      {#each detached as t (t.id)}
        <div class="ccard detached" role="button" tabindex="0" onclick={() => onFocus(t.id)} onkeydown={() => {}}>
          <div class="chead">
            <span class="who"><span class="ava">{initials(t.messages[0]?.author ?? "")}</span></span>
            <div class="meta"><span class="nm">{t.messages[0]?.author}</span></div>
            <div class="tools">
              <button class="ic" title="Delete" aria-label="Delete" onclick={(e) => { e.stopPropagation(); onDelete(t.id); }}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
          <p class="anchor-quote">“{t.anchor.quote}”</p>
          <p class="body">{t.messages[0]?.body}</p>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .clayer {
    position: relative;
    flex: 0 0 300px;
    min-width: 0;
    height: 100%;
    border-left: 1px solid var(--c-line);
    overflow: hidden;
    background: var(--c-bg);
  }
  .ccard {
    position: absolute;
    left: 12px;
    right: 12px;
    background: var(--c-surface);
    border: 1px solid var(--c-line);
    border-radius: var(--r-2);
    padding: 10px 11px;
    box-shadow: var(--elev-1);
    cursor: pointer;
    transition:
      transform 160ms var(--ease-standard, ease),
      border-color 120ms ease,
      box-shadow 120ms ease;
  }
  .ccard.active {
    border-color: var(--c-comment);
    box-shadow: var(--elev-2);
  }
  .ccard.resolved {
    opacity: 0.6;
  }
  .detached-wrap {
    position: absolute;
    left: 0;
    right: 0;
    padding: 0 12px;
  }
  .detached-head {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .detached-wrap .ccard {
    position: static;
    margin-bottom: 8px;
    border-style: dashed;
  }
  .anchor-quote {
    margin: 0 0 4px;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chead {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .who {
    flex: 0 0 auto;
  }
  .ava {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--c-comment-tint-2);
    color: var(--c-tx-hi);
    font-size: 10px;
    font-weight: 700;
    font-family: var(--font-mono);
  }
  .meta {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }
  .nm {
    font-size: var(--ts-sm);
    font-weight: 600;
    color: var(--c-tx-hi);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tm {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .tools {
    display: flex;
    gap: 1px;
    opacity: 0;
    transition: opacity 120ms ease;
  }
  .ccard:hover .tools,
  .ccard.active .tools {
    opacity: 1;
  }
  .ic {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border: none;
    background: none;
    color: var(--c-tx-muted);
    border-radius: var(--r-1);
    cursor: pointer;
  }
  .ic:hover {
    color: var(--c-tx-hi);
    background: var(--c-ui-hover);
  }
  .body {
    margin: 7px 0 0;
    font-size: var(--ts-sm);
    line-height: 1.5;
    color: var(--c-tx-2);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .reply {
    margin-top: 8px;
    padding-top: 7px;
    border-top: 1px solid var(--c-line);
  }
  .rwho {
    font-size: var(--ts-xs);
    font-weight: 600;
    color: var(--c-tx);
  }
  .reply .body {
    margin-top: 2px;
  }
  .resolved-line {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .resolved-tag {
    display: inline-block;
    margin-top: 6px;
    font-size: var(--ts-xs);
    color: var(--c-comment);
  }
  textarea {
    width: 100%;
    margin-top: 7px;
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    padding: 6px 8px;
    color: var(--c-tx);
    font: inherit;
    font-size: var(--ts-sm);
    line-height: 1.45;
    resize: vertical;
  }
  textarea:focus {
    outline: none;
    border-color: var(--c-comment);
  }
  .composer .who {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: var(--ts-sm);
    font-weight: 600;
    color: var(--c-tx-hi);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 7px;
  }
  .ghost,
  .primary {
    font: inherit;
    font-size: var(--ts-xs);
    padding: 4px 10px;
    border-radius: var(--r-1);
    cursor: pointer;
    border: 1px solid transparent;
  }
  .ghost {
    background: none;
    color: var(--c-tx-muted);
  }
  .ghost:hover {
    color: var(--c-tx);
  }
  .primary {
    background: var(--c-comment);
    color: var(--flx-black);
    font-weight: 600;
  }
  .primary:hover {
    filter: brightness(1.08);
  }
  .replylink {
    margin-top: 8px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    padding: 0;
    color: var(--c-tx-faint);
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
  }
  .replylink:hover {
    color: var(--c-comment);
  }
</style>

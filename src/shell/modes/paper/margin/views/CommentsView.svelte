<script lang="ts">
  import type { MarginHost, MarginApi } from "../types";

  let { host }: { host: MarginHost; margin: MarginApi } = $props();

  const c = $derived(host.comments);
  // PAP-8: bucket by status, not by mark presence. A RESOLVED thread has no live range (its
  // mark was removed on resolve) but is NOT detached — it belongs in the main list so its
  // Reopen action is reachable. Only a thread that is unresolved, not a draft, and whose
  // anchor no longer resolves in the text is genuinely detached (delete-only).
  const anchored = $derived(c.threads.filter((t) => t.draft || t.resolved || c.ranges.has(t.id)));
  const detached = $derived(c.threads.filter((t) => !t.draft && !t.resolved && !c.ranges.has(t.id)));

  let draftText = $state("");
  let replyingId = $state<string | null>(null);
  let replyText = $state("");

  function submitDraft(id: string) {
    const t = draftText.trim();
    if (t) c.onSubmitNew(id, t);
    else c.onCancelNew(id);
    draftText = "";
  }
  function submitReply(id: string) {
    const t = replyText.trim();
    if (t) c.onReply(id, t);
    replyText = "";
    replyingId = null;
  }
  function timeOf(iso: string): string {
    const d = new Date(iso);
    return isNaN(+d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function initials(name: string): string {
    return name.split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
  }
</script>

<div class="cv">
  <div class="head">
    <span>{c.count} open</span>
    <button class="new" onclick={c.onStart} title="Comment on the selection">+ Comment</button>
  </div>

  {#if anchored.length === 0 && detached.length === 0}
    <p class="empty">Select text in the manuscript and press <b>+ Comment</b> to leave a note.</p>
  {/if}

  {#each anchored as t (t.id)}
    <div class="card" class:active={t.id === c.activeId} class:resolved={t.resolved}>
      {#if t.draft}
        <div class="composer">
          <!-- svelte-ignore a11y_autofocus -->
          <textarea bind:value={draftText} placeholder="Add a comment…" autofocus></textarea>
          <div class="row">
            <button class="ghost" onclick={() => c.onCancelNew(t.id)}>Cancel</button>
            <button class="primary" onclick={() => submitDraft(t.id)}>Comment</button>
          </div>
        </div>
      {:else}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="msgs" onclick={() => c.onFocus(t.id)}>
          {#each t.messages as msg}
            <div class="msg">
              <span class="av">{initials(msg.author)}</span>
              <div class="mb">
                <div class="mh"><span class="who">{msg.author}</span><span class="when">{timeOf(msg.createdAt)}</span></div>
                <div class="mtext">{msg.body}</div>
              </div>
            </div>
          {/each}
        </div>
        {#if replyingId === t.id}
          <div class="composer">
            <!-- svelte-ignore a11y_autofocus -->
            <textarea bind:value={replyText} placeholder="Reply…" autofocus></textarea>
            <div class="row">
              <button class="ghost" onclick={() => (replyingId = null)}>Cancel</button>
              <button class="primary" onclick={() => submitReply(t.id)}>Reply</button>
            </div>
          </div>
        {/if}
        <div class="acts">
          {#if !t.resolved}
            <button onclick={() => (replyingId = t.id)}>Reply</button>
            <button onclick={() => c.onResolve(t.id)}>Resolve</button>
          {:else}
            <button onclick={() => c.onReopen(t.id)}>Reopen</button>
          {/if}
          <button class="del" onclick={() => c.onDelete(t.id)}>Delete</button>
        </div>
      {/if}
    </div>
  {/each}

  {#if detached.length}
    <div class="detached-h">Detached</div>
    {#each detached as t (t.id)}
      <div class="card detached">
        <div class="msgs">
          {#each t.messages.slice(0, 1) as msg}
            <div class="mtext muted">{msg.body}</div>
          {/each}
        </div>
        <div class="acts"><button class="del" onclick={() => c.onDelete(t.id)}>Delete</button></div>
      </div>
    {/each}
  {/if}
</div>

<style>
  .cv {
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    height: 100%;
    overflow: auto;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: var(--ts-sm);
    color: var(--c-tx-muted);
  }
  .new {
    font: inherit;
    font-size: var(--ts-sm);
    padding: 4px 10px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-surface);
    color: var(--c-comment);
    cursor: pointer;
    font-weight: 600;
  }
  .new:hover {
    border-color: var(--c-comment);
  }
  .empty {
    color: var(--c-tx-faint);
    font-style: italic;
    font-size: var(--ts-sm);
    line-height: 1.5;
  }
  .card {
    border: 1px solid var(--c-line);
    border-radius: var(--r-2);
    background: var(--c-surface);
    padding: var(--sp-3);
  }
  .card.active {
    border-color: var(--c-comment);
    box-shadow: 0 0 0 1px var(--c-comment-tint-2);
  }
  .card.resolved {
    opacity: 0.6;
  }
  .msg {
    display: flex;
    gap: var(--sp-2);
    margin-bottom: var(--sp-2);
  }
  .av {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--c-comment-tint-2);
    color: var(--flx-black);
    font-size: 10px;
    font-weight: 700;
    display: grid;
    place-items: center;
  }
  .mh {
    display: flex;
    gap: var(--sp-2);
    align-items: baseline;
  }
  .who {
    font-size: var(--ts-sm);
    font-weight: 600;
    color: var(--c-tx);
  }
  .when {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .mtext {
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .mtext.muted {
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .acts {
    display: flex;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .acts button {
    font: inherit;
    font-size: var(--ts-xs);
    background: none;
    border: none;
    color: var(--c-tx-muted);
    cursor: pointer;
    padding: 2px 4px;
  }
  .acts button:hover {
    color: var(--c-tx-hi);
  }
  .acts .del:hover {
    color: var(--c-danger);
  }
  .composer textarea {
    width: 100%;
    box-sizing: border-box;
    min-height: 56px;
    resize: vertical;
    padding: 8px 10px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-bg);
    color: var(--c-tx);
    font-family: var(--font-serif);
    font-size: var(--ts-sm);
    outline: none;
  }
  .composer textarea:focus {
    border-color: var(--c-comment);
  }
  .composer .row {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .composer button {
    font: inherit;
    font-size: var(--ts-sm);
    padding: 4px 12px;
    border-radius: var(--r-1);
    cursor: pointer;
    border: 1px solid transparent;
  }
  .composer .ghost {
    background: none;
    color: var(--c-tx-muted);
  }
  .composer .primary {
    background: var(--c-comment);
    color: var(--flx-black);
    font-weight: 600;
  }
  .detached-h {
    margin-top: var(--sp-2);
    font-size: var(--ts-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--c-tx-faint);
  }
</style>

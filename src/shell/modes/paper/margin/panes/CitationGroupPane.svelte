<script lang="ts">
  // The Citation Group editor — a multi-reference citation ([@a; @b; @c] or a
  // bare @key) as ONE editable object. Live: it follows activeCitationGroup
  // (the caret), lists the members IN SOURCE ORDER, removes any of them, and
  // adds more from a FluxLib∪project search — all write-THROUGH: every change
  // dispatches immediately via host.writeCites (each an undo step), the
  // watcher re-fires, and the pane re-derives from the store. Removing the
  // last member deletes the group; with no group at the caret the pane
  // degrades to insert-at-caret.
  import { onMount } from "svelte";
  import type { MarginHost, MarginApi } from "../types";
  import { runQuery } from "./refQuery";
  // WS-4.2 / dual-paper: per-editor numbering AND the caret-tracked citation
  // group come through the margin host (module imports were cross-pane singletons).

  let { host, margin }: { host: MarginHost; margin: MarginApi } = $props();
  // These STORES are created once per PaperMode mount and never swap
  // identity — capturing them off the initial host is deliberate (we want the
  // stores, not a reactive read of the host object).
  // svelte-ignore state_referenced_locally
  const citationOrdinals = host.numbering.ordinals;
  // svelte-ignore state_referenced_locally
  const citationStyle = host.numbering.style;
  // svelte-ignore state_referenced_locally
  const activeCitationGroup = host.activeCitationGroup;

  let query = $state("");
  let hl = $state(0); // one roving highlight across [members…, results…]
  let inputEl = $state<HTMLInputElement | undefined>(undefined);
  let listEl = $state<HTMLElement | undefined>(undefined);

  const group = $derived($activeCitationGroup);
  const members = $derived(group?.keys ?? []);
  const results = $derived(
    runQuery(host.libraryReferences, query)
      .filter((r) => !members.includes(r.key))
      .slice(0, 60),
  );
  const total = $derived(members.length + results.length);

  const byKey = $derived(new Map(host.libraryReferences.map((r) => [r.key, r])));
  function label(key: string): string {
    const r = byKey.get(key);
    if (!r) return key;
    const who =
      r.authors.length > 2
        ? `${r.authors[0]} et al.`
        : r.authors.join(" & ") || key;
    return r.year ? `${who}, ${r.year}` : who;
  }
  function title(key: string): string {
    return byKey.get(key)?.title ?? "";
  }
  const ordinal = $derived((key: string) =>
    $citationStyle === "numeric" ? $citationOrdinals.get(key) : undefined,
  );

  // Write-through: mutate the group in the DOCUMENT; the watcher loops the new
  // state back into `members`. writeCiteGroup refocuses the editor — reclaim
  // the input so the keyboard flow here is uninterrupted.
  function write(keys: string[]) {
    if (group) host.writeCites(keys, { from: group.from, to: group.to });
    else if (keys.length) host.writeCites(keys);
    inputEl?.focus();
  }
  function removeMember(key: string) {
    write(members.filter((k) => k !== key));
    // Stay in the member zone (repeated Backspace keeps removing members —
    // never silently drifts into the search results below).
    hl = Math.min(hl, Math.max(0, members.length - 1));
  }
  function addResult(key: string) {
    write([...members, key]);
    // The write round-trips synchronously (dispatch → watcher → store), so
    // `members` already includes the new key: highlight it.
    hl = Math.max(0, members.length - 1);
    query = "";
  }

  $effect(() => {
    if (hl > total - 1) hl = Math.max(0, total - 1);
  });
  // A fresh search should land the highlight on its first hit.
  $effect(() => {
    void query;
    if (query && results.length) hl = members.length;
  });
  $effect(() => {
    listEl
      ?.querySelector(`[data-i="${hl}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      hl = Math.min(total - 1, hl + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      hl = Math.max(0, hl - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[hl - members.length];
      if (r) addResult(r.key);
    } else if ((e.key === "Backspace" || e.key === "Delete") && !query && hl < members.length) {
      e.preventDefault();
      removeMember(members[hl]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) {
        query = "";
        hl = 0; // back to the member zone
      } else margin.closePane();
    }
  }

  onMount(() => inputEl?.focus());
</script>

<div class="cgp">
  <div class="head">
    <span class="title">
      {members.length ? `${members.length} ref${members.length === 1 ? "" : "s"} at cursor` : "New citation"}
    </span>
  </div>

  <input
    bind:this={inputEl}
    bind:value={query}
    onkeydown={onKey}
    placeholder="Search to add… (↑↓ move · ⌫ removes · Enter adds)"
    spellcheck="false"
    autocomplete="off" />

  <div class="list" bind:this={listEl}>
    {#if members.length}
      <div class="zone">In this citation</div>
      {#each members as key, i (key)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="row member" class:hl={i === hl} data-i={i} onclick={() => (hl = i)}>
          {#if ordinal(key) !== undefined}
            <span class="ord">[{ordinal(key)}]</span>
          {:else if $citationStyle === "numeric"}
            <span class="ord unresolved">[?]</span>
          {/if}
          <span class="who">{label(key)}</span>
          <span class="what" title={title(key)}>{title(key)}</span>
          <button class="rm" onclick={(e) => { e.stopPropagation(); removeMember(key); }} aria-label="Remove {key}">✕</button>
        </div>
      {/each}
    {:else}
      <div class="none">No citation at the cursor — search and press Enter to insert one.</div>
    {/if}

    {#if results.length}
      <div class="zone">{query ? "Matches" : "Library"}</div>
      {#each results as r, i (r.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class="row"
          class:hl={members.length + i === hl}
          data-i={members.length + i}
          onclick={() => addResult(r.key)}>
          <span class="add">+</span>
          <span class="who">{label(r.key)}</span>
          <span class="what" title={r.title}>{r.title}</span>
        </div>
      {/each}
    {/if}
  </div>

  <div class="foot">
    <span class="hint">Changes apply immediately · each is one undo step</span>
  </div>
</div>

<style>
  .cgp {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: var(--sp-3);
    gap: var(--sp-2);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .title {
    font-size: var(--ts-xs);
    color: var(--c-tx-muted);
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 11px;
    border: 1px solid var(--c-accent);
    border-radius: var(--r-1);
    background: var(--c-bg);
    color: var(--c-tx);
    font-family: var(--font-mono);
    font-size: var(--ts-sm);
    outline: none;
  }
  .list {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    border: 1px solid var(--c-line);
    border-radius: var(--r-2);
  }
  .zone {
    position: sticky;
    top: 0;
    padding: 4px 8px;
    background: var(--c-surface);
    color: var(--c-tx-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10px;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--c-line);
    font-size: var(--ts-xs);
    cursor: pointer;
  }
  .row.hl {
    background: var(--c-accent-tint-2);
  }
  .row.member {
    background: var(--c-accent-tint);
  }
  .row.member.hl {
    outline: 1.5px solid var(--c-accent);
    outline-offset: -1.5px;
  }
  .ord {
    font-variant-numeric: tabular-nums;
    color: var(--c-accent-bright);
    font-weight: 600;
    flex: 0 0 auto;
  }
  .ord.unresolved {
    color: var(--c-tx-faint);
  }
  .add {
    color: var(--c-tx-faint);
    flex: 0 0 auto;
  }
  .who {
    color: var(--c-tx);
    white-space: nowrap;
    flex: 0 0 auto;
  }
  .what {
    color: var(--c-tx-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
  }
  .rm {
    background: none;
    border: none;
    color: var(--c-tx-faint);
    cursor: pointer;
    font-size: 10px;
    padding: 0 2px;
    flex: 0 0 auto;
  }
  .rm:hover {
    color: var(--c-danger);
  }
  .none {
    padding: var(--sp-4);
    text-align: center;
    color: var(--c-tx-faint);
    font-style: italic;
    font-size: var(--ts-sm);
  }
  .foot {
    display: flex;
    justify-content: flex-end;
  }
  .hint {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
</style>

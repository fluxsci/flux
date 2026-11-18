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

<div class="cgp mk-pane">
  <input
    class="mk-input"
    bind:this={inputEl}
    bind:value={query}
    onkeydown={onKey}
    placeholder={members.length ? "Search to add another…" : "Search for a reference to cite…"}
    aria-label="Search references to add"
    spellcheck="false"
    autocomplete="off" />

  <div class="list mk-list" bind:this={listEl}>
    <div class="zone mk-zone">
      <span class="mk-eyebrow mk-grow">{members.length ? "In this citation" : "New citation"}</span>
      {#if members.length}<span class="mk-num mk-meta">{members.length}</span>{/if}
    </div>
    {#if members.length}
      {#each members as key, i (key)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="row member mk-item on" class:hl={i === hl} data-i={i} onclick={() => (hl = i)}>
          {#if ordinal(key) !== undefined}
            <span class="ord mk-num">[{ordinal(key)}]</span>
          {:else if $citationStyle === "numeric"}
            <span class="ord unresolved mk-num">[?]</span>
          {:else}
            <span class="ord mk-num">{i + 1}</span>
          {/if}
          <div class="main">
            <span class="who mk-clip">{label(key)}</span>
            <span class="what mk-clip" title={title(key)}>{title(key)}</span>
          </div>
          <button class="rm" onclick={(e) => { e.stopPropagation(); removeMember(key); }} aria-label="Remove {key}" title="Remove from this citation">
            <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg>
          </button>
        </div>
      {/each}
    {:else}
      <p class="mk-empty">No citation at the cursor. Search, then press Enter to insert one.</p>
    {/if}

    {#if results.length}
      <div class="zone mk-zone"><span class="mk-eyebrow">{query ? "Matches" : "Library"}</span></div>
      {#each results as r, i (r.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class="row mk-item"
          class:hl={members.length + i === hl}
          data-i={members.length + i}
          onclick={() => addResult(r.key)}>
          <span class="add" aria-hidden="true">+</span>
          <div class="main">
            <span class="who mk-clip">{label(r.key)}</span>
            <span class="what mk-clip" title={r.title}>{r.title}</span>
          </div>
        </div>
      {/each}
    {:else if query}
      <p class="mk-empty">Nothing in your library matches.</p>
    {/if}
  </div>

  <div class="mk-foot">
    <span class="mk-hint mk-grow"><kbd>↵</kbd>add<span class="sep">·</span><kbd>⌫</kbd>remove</span>
    <span class="mk-hint live">applies as you go</span>
  </div>
</div>

<style>
  .row {
    display: grid;
    grid-template-columns: calc(24px * var(--ts-scale, 1)) minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 4px;
    min-height: calc(42px * var(--ts-scale, 1));
    padding: calc(5px * var(--ts-scale, 1)) 8px;
  }
  .main {
    min-width: 0;
    display: grid;
    row-gap: calc(2px * var(--ts-scale, 1));
  }
  .ord,
  .add {
    justify-self: center;
    color: var(--pane-c);
    font-size: calc(10.5px * var(--ts-scale, 1));
    font-weight: 600;
  }
  .ord.unresolved {
    color: var(--c-tx-faint);
  }
  .add {
    font-family: var(--font-mono);
    font-size: var(--ts-sm);
    font-weight: 400;
    color: var(--c-tx-faint);
  }
  .row:hover .add,
  .row.hl .add {
    color: var(--pane-c);
  }
  .who {
    color: var(--c-tx);
    font-size: var(--ts-sm);
    font-weight: 600;
    line-height: 1.15;
  }
  .what {
    color: var(--c-tx-2);
    font-size: var(--ts-xs);
    line-height: 1.2;
  }
  .rm {
    display: inline-grid;
    place-items: center;
    width: calc(20px * var(--ts-scale, 1));
    height: calc(20px * var(--ts-scale, 1));
    padding: 0;
    border: 0;
    border-radius: var(--r-1);
    background: transparent;
    color: var(--c-tx-faint);
    cursor: var(--cursor-cross-hover);
    transition:
      color 80ms linear,
      background 80ms linear;
  }
  .rm svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  .rm:hover {
    color: var(--c-danger);
    background: color-mix(in oklab, var(--c-danger) 12%, transparent);
  }
  .live {
    font-style: italic;
  }
</style>

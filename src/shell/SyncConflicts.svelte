<script lang="ts">
  // Sync-conflict banner + resolver. Mounted at the Shell so it shows in every mode.
  //
  // The banner is deliberately NOT dismissable: a sync conflict means two machines hold
  // different versions of your work, and a warning you can wave away is a warning that
  // gets waved away. It stays until the last copy is resolved. It does not, however,
  // seize the keyboard — a conflict can land mid-sentence, and stealing focus to make a
  // filing decision is its own kind of data loss. Nag, don't hijack.
  import { fade, fly } from "svelte/transition";
  import { DUR } from "../lib/motion/tokens";
  import { currentProject } from "./shellStore";
  import {
    conflicts,
    conflictsOpen,
    refreshConflicts,
    resolveConflict,
    resolveIdentical,
    type ConflictAction,
  } from "../lib/project/conflicts";
  import type { SyncConflict } from "../lib/project/conflictRules";
  import { pushToast } from "../lib/toast";

  let busy = $state("");

  const fmtSize = (n: number): string =>
    n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

  async function act(c: SyncConflict, action: ConflictAction) {
    const root = $currentProject?.path;
    if (!root || busy) return;
    busy = c.rel;
    const err = await resolveConflict(root, c, action);
    if (err) pushToast("error", `Could not resolve ${c.base}`, { detail: err });
    await refreshConflicts(root);
    busy = "";
    if (!$conflicts.length) {
      conflictsOpen.set(false);
      pushToast("success", "All sync conflicts resolved");
    }
  }

  async function clearIdentical() {
    const root = $currentProject?.path;
    if (!root || busy) return;
    busy = "*";
    const n = await resolveIdentical(root);
    busy = "";
    if (n) pushToast("success", `Discarded ${n} identical cop${n === 1 ? "y" : "ies"}`);
    if (!$conflicts.length) conflictsOpen.set(false);
  }

  const identicalCount = $derived($conflicts.filter((c) => c.identical).length);
</script>

{#if $conflicts.length}
  <button
    class="bar"
    transition:fly={{ y: -8, duration: DUR.gentle }}
    onclick={() => conflictsOpen.update((v) => !v)}>
    <span class="dot"></span>
    <span class="txt">
      {$conflicts.length} sync conflict{$conflicts.length === 1 ? "" : "s"} — two machines edited the same
      file{$conflicts.length === 1 ? "" : "s"}. Nothing was lost.
    </span>
    <span class="cta">{$conflictsOpen ? "Hide" : "Resolve"}</span>
  </button>
{/if}

{#if $conflicts.length && $conflictsOpen}
  <div class="panel" transition:fade={{ duration: DUR.quick }}>
    <div class="head">
      <b>Resolve sync conflicts</b>
      <span class="sub">
        Your sync tool kept both versions rather than picking one. Choose which side wins; the extra
        copy is removed either way.
      </span>
      {#if identicalCount}
        <button class="bulk" disabled={!!busy} onclick={clearIdentical}>
          {identicalCount} {identicalCount === 1 ? "is" : "are"} identical — discard {identicalCount === 1
            ? "it"
            : "them"}
        </button>
      {/if}
    </div>

    <ul>
      {#each $conflicts as c (c.rel)}
        <li class:working={busy === c.rel || busy === "*"}>
          <div class="who">
            <span class="file">{c.base}</span>
            {#if c.identical}
              <span class="tag same">identical — nothing lost</span>
            {:else if !c.baseExists}
              <span class="tag gone">your copy is gone</span>
            {:else if c.mergeable}
              <span class="tag merge">append-only ledger</span>
            {/if}
          </div>
          <div class="meta">
            from device {c.device} · {c.when} · {fmtSize(c.size)}
          </div>
          <div class="acts">
            {#if c.mergeable && c.baseExists}
              <button disabled={!!busy} onclick={() => act(c, "merge")} title="Union both sets of lines">
                Merge both
              </button>
            {/if}
            <button disabled={!!busy} onclick={() => act(c, "keepMine")}>
              {c.identical || !c.baseExists ? "Discard copy" : "Keep mine"}
            </button>
            {#if c.baseExists && !c.identical}
              <button disabled={!!busy} onclick={() => act(c, "keepTheirs")}>Keep theirs</button>
            {:else if !c.baseExists}
              <button disabled={!!busy} onclick={() => act(c, "keepTheirs")}>Restore theirs</button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    padding: 0.34rem 0.7rem;
    border: 0;
    border-bottom: 1px solid var(--rule, rgba(0, 0, 0, 0.12));
    background: var(--warn-bg, #f6e7d0);
    color: var(--warn-fg, #4a3418);
    font: inherit;
    font-size: 0.78rem;
    text-align: left;
    cursor: pointer;
  }
  .bar:hover {
    filter: brightness(0.98);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warn-dot, #c07020);
    flex: 0 0 auto;
  }
  .txt {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cta {
    flex: 0 0 auto;
    font-weight: 600;
    text-decoration: underline;
  }

  .panel {
    position: absolute;
    z-index: 60;
    top: 2.1rem;
    right: 0.7rem;
    width: min(34rem, calc(100vw - 1.4rem));
    max-height: min(60vh, 34rem);
    overflow: auto;
    padding: 0.7rem 0.8rem 0.5rem;
    border: 1px solid var(--rule, rgba(0, 0, 0, 0.16));
    border-radius: 8px;
    background: var(--panel-bg, #fff);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
    font-size: 0.8rem;
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--rule, rgba(0, 0, 0, 0.1));
  }
  .sub {
    opacity: 0.72;
    line-height: 1.35;
  }
  .bulk {
    align-self: flex-start;
    margin-top: 0.15rem;
    padding: 0.2rem 0.5rem;
    font: inherit;
    font-size: 0.76rem;
    cursor: pointer;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--rule, rgba(0, 0, 0, 0.07));
  }
  li:last-child {
    border-bottom: 0;
  }
  li.working {
    opacity: 0.5;
  }
  .who {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .file {
    font-weight: 600;
    word-break: break-all;
  }
  .tag {
    font-size: 0.7rem;
    padding: 0.05rem 0.35rem;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.07);
  }
  .tag.same {
    background: rgba(60, 140, 70, 0.16);
  }
  .tag.gone {
    background: rgba(180, 60, 40, 0.16);
  }
  .meta {
    opacity: 0.6;
    font-size: 0.72rem;
    margin-top: 0.1rem;
  }
  .acts {
    display: flex;
    gap: 0.35rem;
    margin-top: 0.35rem;
    flex-wrap: wrap;
  }
  .acts button {
    padding: 0.18rem 0.5rem;
    font: inherit;
    font-size: 0.76rem;
    cursor: pointer;
  }
  .acts button:disabled {
    cursor: default;
    opacity: 0.5;
  }
</style>

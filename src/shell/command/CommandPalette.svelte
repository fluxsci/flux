<script lang="ts">
  import { popIn } from "../../lib/motion/actions";
  import type { Command } from "./commands";

  let { commands, onClose }: { commands: Command[]; onClose: () => void } = $props();

  let q = $state("");
  let sel = $state(0);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);
  let listEl = $state<HTMLUListElement | undefined>(undefined);

  const filtered = $derived.by(() => {
    const t = q.trim().toLowerCase();
    if (!t) return commands;
    return commands.filter((c) =>
      (c.title + " " + (c.keywords ?? "") + " " + (c.hint ?? "")).toLowerCase().includes(t),
    );
  });

  // Keep the selection in range as the filter narrows.
  $effect(() => {
    if (sel > filtered.length - 1) sel = Math.max(0, filtered.length - 1);
  });

  $effect(() => {
    inputEl?.focus();
  });

  // Keep the keyboard-selected row visible as it moves (43 commands overflow the list).
  $effect(() => {
    sel;
    listEl?.querySelector<HTMLElement>("li.sel")?.scrollIntoView({ block: "nearest" });
  });

  function run(c: Command | undefined) {
    if (!c) return;
    onClose();
    c.run();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = Math.min(filtered.length - 1, sel + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(0, sel - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      run(filtered[sel]);
    } else if (e.key === "Escape") {
      // Stop the Escape from also reaching PaperMode's window handler (which would
      // otherwise exit preview in the same keypress).
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="cp-scrim" onclick={onClose}></div>
<div class="cp" transition:popIn>
  <input
    bind:this={inputEl}
    bind:value={q}
    onkeydown={onKey}
    placeholder="Type a command…"
    spellcheck="false"
    autocomplete="off" />
  <ul bind:this={listEl}>
    {#each filtered as c, i (c.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <li
        class:sel={i === sel}
        onmousemove={() => (sel = i)}
        onmousedown={(e) => {
          e.preventDefault();
          run(c);
        }}>
        <span class="ct">{c.title}</span>
        {#if c.hint}<span class="ch">{c.hint}</span>{/if}
      </li>
    {/each}
    {#if filtered.length === 0}
      <li class="empty">No matching command</li>
    {/if}
  </ul>
</div>

<style>
  .cp-scrim {
    position: absolute;
    inset: 0;
    z-index: 80;
    background: color-mix(in oklab, var(--flx-black) 14%, transparent);
  }
  .cp {
    position: absolute;
    top: 14%;
    left: 50%;
    transform: translateX(-50%);
    z-index: 81;
    width: min(560px, 72%);
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-3);
    box-shadow: var(--elev-3);
    overflow: hidden;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 14px 18px;
    border: none;
    border-bottom: 1px solid var(--c-line);
    background: transparent;
    color: var(--c-tx);
    font-family: var(--font-serif);
    font-size: var(--ts-md);
    outline: none;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 6px;
    max-height: 46vh;
    overflow: auto;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
    padding: 8px 12px;
    border-radius: var(--r-1);
    cursor: pointer;
    color: var(--c-tx-2);
  }
  li.sel {
    background: var(--c-accent-tint);
    color: var(--c-tx-hi);
  }
  .ct {
    font-family: var(--font-serif);
    font-size: var(--ts-base);
  }
  .ch {
    margin-left: auto;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .empty {
    color: var(--c-tx-faint);
    font-style: italic;
    cursor: default;
  }
</style>

<script lang="ts">
  import Icon from "../../../Icon.svelte";
  import type { MarginHost, MarginApi } from "./types";
  import { searchLaunchables, routePaneForQuery } from "./registry";
  import { runQuery } from "./panes/refQuery";

  let {
    host,
    margin,
    focusReq = 0,
  }: { host: MarginHost; margin: MarginApi; focusReq?: number } = $props();

  let q = $state("");
  let sel = $state(0);
  let focused = $state(false);
  let inputEl = $state<HTMLInputElement | undefined>(undefined);

  interface Item {
    key: string;
    label: string;
    hint: string;
    run: () => void;
  }

  const items = $derived.by<Item[]>(() => {
    const out: Item[] = [];
    const text = q.trim();
    const routed = text ? routePaneForQuery(q) : undefined;
    if (routed) {
      out.push({
        key: "route",
        label: `Search: ${text}`,
        hint: "Reference Search",
        run: () => margin.openPane(routed.id, { initialQuery: q }),
      });
    }
    for (const l of searchLaunchables(q)) {
      out.push({
        key: `${l.kind}:${l.id}`,
        label: l.title,
        hint: l.kind === "pane" ? "Pane" : "View",
        run: () => (l.kind === "view" ? margin.setView(l.id) : margin.openPane(l.id)),
      });
    }
    if (text.length >= 2) {
      for (const r of runQuery(host.libraryReferences, q).slice(0, 5)) {
        out.push({
          key: `ref:${r.key}`,
          label: `${r.authors[0] ?? r.key}${r.year ? ` ${r.year}` : ""} — ${r.title}`,
          hint: "Cite",
          run: () => host.writeCites([r.key]),
        });
      }
    }
    return out;
  });

  const show = $derived(focused && q.trim().length > 0 && items.length > 0);

  $effect(() => {
    if (sel > items.length - 1) sel = Math.max(0, items.length - 1);
  });
  $effect(() => {
    void focusReq;
    if (focusReq > 0) inputEl?.focus();
  });

  function run(it: Item | undefined) {
    if (!it) return;
    it.run();
    q = "";
    inputEl?.blur();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = Math.min(items.length - 1, sel + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(0, sel - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(items[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (q) q = "";
      else inputEl?.blur();
    }
  }
</script>

<div class="omni">
  <Icon name="search" size={15} />
  <input
    bind:this={inputEl}
    bind:value={q}
    onkeydown={onKey}
    onfocus={() => (focused = true)}
    onblur={() => setTimeout(() => (focused = false), 120)}
    placeholder="alt-f to search…"
    spellcheck="false"
    autocomplete="off" />
  {#if show}
    <ul class="drop">
      {#each items as it, i (it.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <li
          class:sel={i === sel}
          onmousemove={() => (sel = i)}
          onmousedown={(e) => {
            e.preventDefault();
            run(it);
          }}>
          <span class="l">{it.label}</span>
          <span class="h">{it.hint}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .omni {
    position: relative;
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 10px;
    background: var(--c-bg);
    border: 1px solid var(--c-accent);
    border-radius: var(--r-2);
    color: var(--c-tx-muted);
  }
  input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 8px 0;
    border: none;
    background: transparent;
    color: var(--c-tx);
    font-family: var(--font-serif);
    font-style: italic;
    font-size: var(--ts-sm);
    outline: none;
  }
  .drop {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 40;
    list-style: none;
    margin: 0;
    padding: 4px;
    max-height: 320px;
    overflow: auto;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2);
    box-shadow: var(--elev-2);
  }
  .drop li {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    padding: 6px 9px;
    border-radius: var(--r-1);
    cursor: pointer;
  }
  .drop li.sel {
    background: var(--c-accent-tint);
  }
  .l {
    flex: 1 1 auto;
    min-width: 0;
    font-size: var(--ts-sm);
    color: var(--c-tx);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .h {
    flex: 0 0 auto;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--c-tx-faint);
  }
</style>

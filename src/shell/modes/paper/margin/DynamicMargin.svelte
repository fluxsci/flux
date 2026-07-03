<script lang="ts">
  // The Dynamic Margin — an outlined rounded box (same card recipe as the left
  // outline) holding, at rest, NOTHING but the always-running dynamic
  // background: something to stare into while you think. Dynamic panes are
  // summoned into it (Alt+R/T/A/F, ⌘K) as frosted-glass cards stacked in one
  // column, splitting the height equally. Pane state lives in marginPanes.ts;
  // this component renders the stack, routes focus, and keeps the feel
  // contract: every close hands focus back to the editor.
  import { tick } from "svelte";
  import { get } from "svelte/store";
  import { fadeRise } from "../../../../lib/motion/actions";
  import { settings, type Settings } from "../../../../lib/settings";
  import type { MarginHost, MarginApi } from "./types";
  import { paneById } from "./registry";
  import DynamicBackground from "./DynamicBackground.svelte";
  import MarginPaneFrame from "./MarginPaneFrame.svelte";
  import { bgSeed, rerollBgSeed } from "./bgSources";
  import {
    openPanes,
    activePaneId,
    paneFocusReq,
    summonPane,
    closePane,
    closeAllPanes,
  } from "./marginPanes";

  let { host }: { host: MarginHost } = $props();

  let rootEl = $state<HTMLElement | undefined>(undefined);

  function close(id: string) {
    closePane(id);
    host.focusEditor();
  }

  function apiFor(id: string): MarginApi {
    return {
      summon: (pid, opts) => summonPane(pid, opts),
      closePane: () => close(id),
    };
  }

  // Focus routing: a summon (fresh open or focus-if-open) bumps paneFocusReq;
  // we focus the pane's natural target after it has rendered. Requests that
  // predate this mount are stale — Alt+D reopening the margin must NOT replay
  // the last summon and steal focus from the editor.
  let lastFocusN = get(paneFocusReq).n;
  $effect(() => {
    const req = $paneFocusReq;
    if (req.n === lastFocusN) return;
    lastFocusN = req.n;
    tick().then(() => {
      const el = rootEl?.querySelector<HTMLElement>(`[data-pane-id="${req.id}"]`);
      if (!el) return;
      const desc = paneById(req.id);
      if (desc?.focus) {
        desc.focus();
        return;
      }
      (el.querySelector<HTMLElement>("input, textarea") ?? el).focus();
    });
  });

  // "Clean dynamic margin" (setting, default off): once focus settles back in
  // the editor, close every pane. Debounced — flows like the citation-group
  // write round-trip focus through the editor and reclaim it within a frame;
  // only a STAYING return to the editor clears the margin.
  $effect(() => {
    if (!$settings.paperCleanMargin) return;
    let t = 0;
    const h = (e: FocusEvent) => {
      if (!(e.target as Element | null)?.closest?.(".cm-content")) return;
      clearTimeout(t);
      t = window.setTimeout(() => {
        if (document.activeElement?.closest(".cm-content")) closeAllPanes();
      }, 180);
    };
    window.addEventListener("focusin", h);
    return () => {
      clearTimeout(t);
      window.removeEventListener("focusin", h);
    };
  });

  function trackActive(e: FocusEvent) {
    const el = (e.target as Element | null)?.closest?.("[data-pane-id]");
    const id = el?.getAttribute("data-pane-id");
    if (id) activePaneId.set(id);
  }

  // Dev hooks for the verify scripts (drive panes + backgrounds w/o reloads).
  if (import.meta.env.DEV) {
    const w = window as unknown as { __fluxMargin?: Record<string, unknown> };
    const hook = (w.__fluxMargin ??= {});
    hook.summon = summonPane;
    hook.closeAll = closeAllPanes;
    hook.panes = () => (rootEl ? [...rootEl.querySelectorAll("[data-pane-id]")].map((e) => e.getAttribute("data-pane-id")) : []);
    hook.setBg = (id: Settings["paperMarginScene"]) => settings.update((v) => ({ ...v, paperMarginScene: id }));
    hook.reroll = rerollBgSeed;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside
  class="dynmargin"
  bind:this={rootEl}
  in:fadeRise={{ y: 8 }}
  onkeydown={(e) => {
    // One consistent exit from anywhere in the margin: Escape → editor.
    // Inputs own their Escape (clear-query-first, close → focusEditor, xterm)
    // — don't race them; everything else gets the escape hatch.
    const t = e.target as Element | null;
    if (e.key === "Escape" && !t?.matches?.("input, textarea, [contenteditable]")) {
      e.preventDefault();
      host.focusEditor();
    }
  }}>
  <DynamicBackground sourceId={$settings.paperMarginScene} seed={$bgSeed} />
  {#if $openPanes.length}
    <div class="stack" onfocusin={trackActive}>
      {#each $openPanes as p (p.key)}
        {@const desc = paneById(p.id)}
        {#if desc}
          {@const Pane = desc.component}
          <MarginPaneFrame
            {desc}
            active={$activePaneId === p.id && $openPanes.length > 1}
            badge={desc.badge?.(host) ?? null}
            onClose={() => close(p.id)}>
            <Pane {host} margin={apiFor(p.id)} initialQuery={p.initialQuery} />
          </MarginPaneFrame>
        {/if}
      {/each}
    </div>
  {/if}
</aside>

<style>
  .dynmargin {
    position: relative;
    height: 100%;
    background: var(--flx-paper);
    border: 1.5px solid var(--c-edge);
    border-radius: var(--r-3);
    overflow: hidden;
  }
  .stack {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-2) var(--sp-2);
    /* gaps stay transparent to the canvas below */
    pointer-events: none;
  }
</style>

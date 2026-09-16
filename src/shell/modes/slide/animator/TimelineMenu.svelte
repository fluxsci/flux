<script lang="ts">
  // A lightweight positioned context menu for the animator (chips + beat
  // headers). Closes on outside pointerdown, Esc, or after an action.
  export interface MenuItem {
    label: string;
    /** A dimmer second line (what the item does / its chord). */
    hint?: string;
    action?: () => void;
    danger?: boolean;
    disabled?: boolean;
    /** A non-interactive section divider. */
    divider?: boolean;
  }
  let { x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void } = $props();

  let el = $state<HTMLDivElement | null>(null);
  // keep the menu on-screen (flip up/left near edges)
  const pos = $derived.by(() => {
    const w = 190, h = items.reduce((sum, it) => sum + (it.divider ? 7 : it.hint ? 40 : 25), 8);
    const px = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 9999) - w - 8);
    const py = Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 9999) - h - 8);
    return { x: Math.max(4, px), y: Math.max(4, py) };
  });
  // Own the keyboard while open: focus lands on the menu so Escape closes it
  // here instead of reaching the editor's Esc ladder (which would deselect).
  $effect(() => { el?.focus({ preventScroll: true }); });
  function onWin(e: PointerEvent) {
    if (el && !el.contains(e.target as Node)) onClose();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
  }
</script>

<!-- capture phase: a canvas gesture may stop propagation, but the menu must still close -->
<svelte:window onpointerdowncapture={onWin} onkeydown={onKey} />
<div class="menu" bind:this={el} style={`left:${pos.x}px; top:${pos.y}px`} role="menu" tabindex="-1">
  {#each items as it, i (i)}
    {#if it.divider}
      <div class="div"></div>
    {:else}
      <button role="menuitem" class:danger={it.danger} class:hinted={!!it.hint} disabled={it.disabled}
        onclick={() => { it.action?.(); onClose(); }}>{it.label}{#if it.hint}<small>{it.hint}</small>{/if}</button>
    {/if}
  {/each}
</div>

<style>
  .menu {
    position: fixed; z-index: 80; min-width: 172px; padding: 3px;
    background: var(--c-surface); border: 1px solid var(--c-line-strong);
    border-radius: var(--r-panel); box-shadow: var(--elev-2);
    display: flex; flex-direction: column; gap: 1px; outline: none;
    font: 12px/1.35 var(--font-ui); -webkit-font-smoothing: antialiased;
  }
  .menu button {
    text-align: left; border: 0; background: none; color: var(--c-tx-2);
    border-radius: var(--r-0); min-height: 24px; padding: 3px 9px; cursor: var(--cursor-cross-hover); font: 12px var(--font-ui);
  }
  .menu button:hover:not(:disabled) { background: var(--c-accent-tint); color: var(--c-tx-hi); }
  .menu button:disabled { color: var(--c-tx-faint); cursor: var(--cursor-cross); }
  .menu button.hinted { display: flex; flex-direction: column; gap: 1px; padding-block: 4px; }
  .menu button small { font-size: 10.5px; color: var(--c-tx-muted); white-space: nowrap; }
  .menu button:hover:not(:disabled) small { color: var(--c-tx-2); }
  .menu button.danger { color: var(--c-danger); }
  .menu button.danger:hover:not(:disabled) { background: color-mix(in oklab, var(--c-danger) 14%, transparent); }
  .div { height: 1px; background: var(--c-line); margin: 3px 4px; }
</style>

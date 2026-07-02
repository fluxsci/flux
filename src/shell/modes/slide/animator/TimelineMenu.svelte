<script lang="ts">
  // A lightweight positioned context menu for the animator (chips + beat
  // headers). Closes on outside pointerdown, Esc, or after an action.
  export interface MenuItem {
    label: string;
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
    const w = 190, h = items.length * 26 + 10;
    const px = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 9999) - w - 8);
    const py = Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 9999) - h - 8);
    return { x: Math.max(4, px), y: Math.max(4, py) };
  });
  function onWin(e: PointerEvent) {
    if (el && !el.contains(e.target as Node)) onClose();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
  }
</script>

<svelte:window onpointerdown={onWin} onkeydown={onKey} />
<div class="menu" bind:this={el} style={`left:${pos.x}px; top:${pos.y}px`} role="menu" tabindex="-1">
  {#each items as it, i (i)}
    {#if it.divider}
      <div class="div"></div>
    {:else}
      <button role="menuitem" class:danger={it.danger} disabled={it.disabled}
        onclick={() => { it.action?.(); onClose(); }}>{it.label}</button>
    {/if}
  {/each}
</div>

<style>
  .menu {
    position: fixed; z-index: 80; min-width: 172px;
    background: var(--c-bg-2, #1c1b1a); border: 1px solid var(--c-line-strong, #343331);
    border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); padding: 4px;
    display: flex; flex-direction: column; gap: 1px;
  }
  .menu button {
    text-align: left; border: none; background: none; color: var(--c-tx-2, #b7b5ac);
    border-radius: 4px; padding: 4px 9px; cursor: pointer; font-size: 11.5px;
  }
  .menu button:hover:not(:disabled) { background: color-mix(in oklab, var(--c-accent, #4385be) 18%, transparent); color: var(--c-tx-hi, #fff); }
  .menu button:disabled { color: var(--c-tx-faint, #6f6e69); cursor: default; }
  .menu button.danger { color: var(--c-danger, #d14d41); }
  .menu button.danger:hover { background: color-mix(in oklab, var(--c-danger, #d14d41) 16%, transparent); }
  .div { height: 1px; background: var(--c-line, #282726); margin: 3px 4px; }
</style>

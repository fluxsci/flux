<script lang="ts">
  // On-canvas heads-up display for the keyboard "Arrange mode" (Alt+G). Shows
  // the current grid shape and the home-row keys while the mode is active.
  // Driven entirely by the `arrange` store; pointer-transparent so a click on
  // the canvas underneath still commits the arrangement.
  import { arrange } from "./store";
</script>

{#if $arrange?.active}
  <div class="arrange-hud" role="status" aria-live="polite">
    <span class="ttl">Arrange</span>
    <span class="shape">{$arrange.rows} &times; {$arrange.cols}</span>
    <span class="n">{$arrange.n} items</span>
    <span class="sep"></span>
    <span class="keys">
      <kbd>a</kbd> row/col
      <kbd>g</kbd> grid
      <kbd>d</kbd>/<kbd>f</kbd> rows
      <kbd>&crarr;</kbd> apply
      <kbd>esc</kbd> cancel
    </span>
  </div>
{/if}

<style>
  .arrange-hud {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 14px;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: 10px;
    box-shadow: var(--elev-3);
    color: var(--c-tx);
    font-size: 12px;
    white-space: nowrap;
    pointer-events: none;
    user-select: none;
  }
  .ttl {
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--c-accent-bright, var(--c-accent));
  }
  .shape {
    font-weight: 600;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .n {
    opacity: 0.55;
  }
  .sep {
    width: 1px;
    align-self: stretch;
    background: var(--c-line);
  }
  .keys {
    display: flex;
    align-items: center;
    gap: 5px;
    opacity: 0.85;
  }
  kbd {
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: 4px;
    padding: 1px 5px;
    font-family: var(--font-mono, monospace);
    font-size: 10px;
  }
</style>

<script lang="ts">
  export let topology: 'row' | 'column' | 'grid';
  export let anchor: { x: 0 | .5 | 1; y: 0 | .5 | 1 };
  export let disabled = false;
  export let onchange: (x: 0 | .5 | 1, y: 0 | .5 | 1) => void;
  let host: HTMLDivElement;
  $: choices = topology === 'grid'
    ? [0, .5, 1].flatMap(y => [0, .5, 1].map(x => ({x, y, label: y === .5 && x === .5 ? 'Center' : `${y === 0 ? 'Top' : y === 1 ? 'Bottom' : 'Middle'} ${x === 0 ? 'left' : x === 1 ? 'right' : 'center'}`})))
    : [0, .5, 1].map((value, i) => ({x: topology === 'row' ? value : anchor.x, y: topology === 'column' ? value : anchor.y, label: (topology === 'row' ? ['Left', 'Center', 'Right'] : ['Top', 'Center', 'Bottom'])[i]}));
  function choose(i: number) { const c = choices[i]; onchange(c.x as 0 | .5 | 1, c.y as 0 | .5 | 1); }
  function key(e: KeyboardEvent, i: number) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? (topology === 'grid' ? 3 : 1) : e.key === 'ArrowUp' ? (topology === 'grid' ? -3 : -1) : 0;
    if (!step) return;
    e.preventDefault(); e.stopPropagation();
    const next = (i + step + choices.length) % choices.length;
    choose(next); host.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  }
</script>

<!-- Rows / columns: a segmented control. Grids: a miniature frame whose nine points sit on its
     corners, edge midpoints and centre — the point that stays put reads at a glance. -->
<div bind:this={host} class="anchor-options" class:grid={topology === 'grid'} class:column={topology === 'column'} role="radiogroup" aria-label="Keep fixed">
  {#if topology === 'grid'}<span class="frame" aria-hidden="true"></span>{/if}
  {#each choices as choice, i}
    <button class="anchor-choice" class:chosen={anchor.x === choice.x && anchor.y === choice.y} role="radio" aria-checked={anchor.x === choice.x && anchor.y === choice.y} tabindex={anchor.x === choice.x && anchor.y === choice.y ? 0 : -1} aria-label={choice.label} title={topology === 'grid' ? `Keep the ${choice.label.toLowerCase()} fixed` : `Keep the ${choice.label.toLowerCase()} fixed (${i + 1})`} {disabled} style={topology === 'grid' ? `left:${choice.x * 100}%;top:${choice.y * 100}%` : undefined} on:keydown={e => key(e, i)} on:click={() => choose(i)}>
      {#if topology === 'grid'}<span class="dot" aria-hidden="true"></span>{:else}{choice.label}{/if}
    </button>
  {/each}
</div>

<style>
  .anchor-options {display:flex;gap:2px;padding:2px;border:1px solid var(--c-line);border-radius:var(--r-ui,2px);background:var(--c-bg);min-width:0}
  button {flex:1;min-width:0;height:22px;padding:0 7px;border:0;border-radius:var(--r-ui,2px);background:transparent;color:var(--c-tx-muted);font:10.5px var(--font-ui);cursor:var(--cursor-cross-hover);transition:background-color 80ms linear,color 80ms linear}
  button:hover:not(:disabled) {color:var(--c-tx-hi);background:var(--c-surface-2)}
  button.chosen {background:var(--c-layout-gap-tint);color:var(--c-layout-gap);font-weight:600}
  button:focus-visible {outline:2px solid var(--c-layout-gap);outline-offset:1px}
  button:disabled {opacity:.35}
  /* The grid: a 56 × 40 frame; each point is a 16 px target centred on its spot. */
  .grid {position:relative;display:block;width:56px;height:40px;margin:8px;padding:0;border:0;background:transparent;flex:0 0 auto}
  .frame {position:absolute;inset:0;border:1.5px solid var(--c-line-strong);border-radius:2px;background:var(--c-bg)}
  .grid button {position:absolute;display:grid;place-items:center;width:16px;height:16px;margin:-8px 0 0 -8px;padding:0;border-radius:50%;background:transparent}
  .grid button:hover:not(:disabled) {background:var(--c-layout-gap-tint)}
  .grid button.chosen {background:transparent}
  .dot {width:4px;height:4px;border-radius:50%;background:var(--c-tx-faint);transition:transform 80ms linear}
  .grid button:hover:not(:disabled) .dot {background:var(--c-tx-hi)}
  .chosen .dot {width:8px;height:8px;background:var(--c-layout-gap);box-shadow:0 0 0 2px var(--c-surface),0 0 0 3px var(--c-layout-gap)}
  @media (prefers-reduced-motion: reduce) {button,.dot {transition:none}}
</style>

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

<div bind:this={host} class="anchor-options" class:grid={topology === 'grid'} role="radiogroup" aria-label="Keep fixed">
  {#each choices as choice, i}
    <button class="anchor-choice" class:chosen={anchor.x === choice.x && anchor.y === choice.y} role="radio" aria-checked={anchor.x === choice.x && anchor.y === choice.y} tabindex={anchor.x === choice.x && anchor.y === choice.y ? 0 : -1} aria-label={choice.label} title={topology === 'grid' ? choice.label : `${choice.label} (${i + 1})`} {disabled} on:keydown={e => key(e, i)} on:click={() => choose(i)}>
      {#if topology === 'grid'}<span class="dot" aria-hidden="true"></span>{:else}{choice.label}{/if}
    </button>
  {/each}
</div>

<style>
  .anchor-options {display:flex;gap:2px;padding:2px;border:1px solid var(--c-line-strong);border-radius:3px;background:var(--c-bg-raised);min-width:0}
  button {flex:1;min-width:0;height:26px;padding:0 7px;border:1px solid transparent;border-radius:2px;background:transparent;color:var(--c-tx-muted);font:10px var(--font-ui);cursor:var(--cursor-cross-hover)}
  button:hover:not(:disabled) {color:var(--c-tx-hi);background:var(--c-surface)}
  button.chosen {background:var(--c-bg);color:var(--c-layout-gap);border-color:var(--c-line)}
  button:focus-visible {outline:2px solid var(--c-layout-gap);outline-offset:1px}
  button:disabled {opacity:.35}
  .grid {display:grid;grid-template-columns:repeat(3,22px);width:max-content}
  .grid button {display:grid;place-items:center;width:22px;height:22px;padding:0}
  .dot {width:3px;height:3px;border-radius:50%;background:var(--c-tx-muted)}
  .chosen .dot {width:7px;height:7px;background:var(--c-layout-gap)}
</style>

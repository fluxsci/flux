<script lang="ts">
  import { onMount } from 'svelte';
  import type { Figure, Project } from '../types';
  import { familyMap, familyById, formatFamilyRef, formatCaptionLabel, type FigureFamilyDef } from '../figfamily';
  import { slugify } from '../project/types';
  import { figureFamilyIdError } from '../ops';
  import { identityOf, type MetadataChange } from './metadata';
  export let model: Project;
  export let figure: Figure;
  export let save: (change: MetadataChange) => Promise<boolean>;
  let baseline = identityOf(figure);
  let nickname = baseline.nickname;
  let family = baseline.family;
  let number = String(baseline.number);
  let staged: FigureFamilyDef | undefined;
  let creating = false, displayName = '', refTemplate = '', captionTemplate = '';
  let working = false;
  let flight: Promise<boolean> | null = null;
  let titleInput: HTMLInputElement;
  onMount(() => { titleInput?.focus(); titleInput?.select(); });
  export function isDirty() { return creating || nickname !== baseline.nickname || family !== baseline.family || number !== String(baseline.number); }
  export function reset() { nickname = baseline.nickname; family = baseline.family; number = String(baseline.number); creating = false; staged = undefined; }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && creating) { e.preventDefault(); addFamily(); return; }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault(); const i = families.findIndex(f => f.id === family);
      family = families[(i + (e.key === 'ArrowDown' ? 1 : -1) + families.length) % families.length].id; chooseFamily();
    }
  }
  $: families = [...familyMap(model.figureFamilies).values(), ...(staged && !model.figureFamilies?.some(d => d.id === staged?.id) ? [staged] : [])];
  $: max = model.figures.filter(f => f.id !== figure.id && (f.family ?? 'figure') === family).length + 1;
  $: validNumber = /^\d+$/.test(number) && +number >= 1 && +number <= max;
  $: definition = staged?.id === family ? staged : familyById(family, model.figureFamilies);
  $: familyError = figureFamilyIdError(model, slugify(displayName), true);
  $: validFamily = !!displayName.trim() && !familyError && refTemplate.includes('{num}') && captionTemplate.includes('{num}');
  // External refreshes only rebase an untouched form. Drafts never vanish.
  $: if (nickname === baseline.nickname && family === baseline.family && number === String(baseline.number) && !staged && !creating) {
    const next = identityOf(figure);
    if (JSON.stringify(next) !== JSON.stringify(baseline)) { baseline = next; nickname = next.nickname; family = next.family; number = String(next.number); }
  }
  function chooseFamily() { number = String(model.figures.filter(f => f.id !== figure.id && (f.family ?? 'figure') === family).length + 1); }
  function suggest() { refTemplate = `${displayName.trim().slice(0, 3)}. {num}{panel}`; captionTemplate = `${displayName.trim()} {num} | `; }
  function addFamily() {
    if (!validFamily) return;
    staged = { id: slugify(displayName), displayName: displayName.trim(), refTemplate: refTemplate.trim(), captionTemplate };
    family = staged.id; chooseFamily(); creating = false;
  }
  export function flush(): Promise<boolean> {
    if (!flight) flight = saveName().finally(() => { flight = null; });
    return flight;
  }
  async function saveName(): Promise<boolean> {
    working = true;
    try {
      while (true) {
        if (creating || !validNumber) return false;
        const after = { nickname: nickname.trim(), family, number: +number };
        if (JSON.stringify(after) === JSON.stringify(baseline)) return true;
        const definition = staged;
        const ok = await save({ kind:'identity', figureId:figure.id, before:baseline, after, ...(definition ? {family:definition} : {}) });
        if (!ok) return false;
        // Preserve input arriving during the write, then save its newer version.
        if (nickname.trim() === after.nickname) nickname = after.nickname;
        baseline = after;
        if (staged === definition) staged = undefined;
      }
    } finally { working = false; }
  }

</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form on:keydown={onKey} on:submit|preventDefault={() => creating ? addFamily() : flush()}>
  <label>Title<input aria-label="Figure title" bind:this={titleInput} bind:value={nickname} placeholder="e.g. Growth curves" /></label>
  <p class="hint">A descriptive name. The permanent reference stays linked to this figure.</p>
  <div class="identity-row">
    <label>Family<select aria-label="Figure family" bind:value={family} on:change={chooseFamily}>{#each families as f (f.id)}<option value={f.id}>{f.displayName}</option>{/each}</select></label>
    <label class="number">Number<input aria-label="Figure number" inputmode="numeric" bind:value={number} aria-invalid={!validNumber} /></label>
  </div>
  <p class="hint">{validNumber ? (+number < max && (family !== baseline.family || +number !== baseline.number) ? 'Inserts here; later figures in this family shift.' : 'Numbering is independent of document order.') : `Enter a whole number from 1 to ${max}.`}</p>
  <button type="button" class="new-family" on:click={() => creating = !creating}>+ New family…</button>
  {#if creating}
    <fieldset><legend>New family</legend>
      <label>Family name<input aria-label="Family name" bind:value={displayName} on:input={suggest} placeholder="Movie" /></label>
      <label>In-text template<input aria-label="In-text template" bind:value={refTemplate} /></label>
      <label>Caption template<input aria-label="Caption template" bind:value={captionTemplate} /></label>
      <p class="hint">Use {'{num}'} for the number and {'{panel}'} for a panel label.</p>
      {#if displayName && familyError}<p role="alert">{familyError}</p>{/if}
      <div class="actions"><button type="button" disabled={!validFamily} on:click={addFamily}>Add family</button><button type="button" on:click={() => creating = false}>Cancel</button></div>
    </fieldset>
  {/if}
  <div class="example"><span>In text</span><b>{formatFamilyRef(definition, validNumber ? +number : 1, 'a')}</b><span>Caption</span><b>{formatCaptionLabel(definition, validNumber ? +number : 1)}</b></div>
  <div class="actions"><button class="save" type="submit" disabled={working || creating || !validNumber}>{working ? 'Saving…' : 'Save name'}</button></div>
</form>
<style>
  /* The Name tab in the same hand as the rest of Figure-Meta: serif labels over 26 px fields. */
  form { display:flex; flex-direction:column; gap:12px; }
  label { display:flex; flex-direction:column; gap:6px; font:600 10px var(--font-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--c-tx-muted); }
  input,select { box-sizing:border-box; width:100%; min-width:0; height:28px; padding:0 9px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); background:var(--c-bg); color:var(--c-tx-hi); font:14px var(--font-serif); letter-spacing:0; text-transform:none; outline:none; transition:border-color 80ms linear, box-shadow 80ms linear; }
  select { appearance:none; -webkit-appearance:none; padding-right:26px; font:12.5px var(--font-ui); background:var(--c-bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%23878580' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 4.5 6 7.5l3-3'/%3E%3C/svg%3E") no-repeat right 8px center / 11px 11px; text-overflow:ellipsis; }
  input::placeholder { color:var(--c-tx-faint); font-style:italic; }
  input:hover,select:hover { border-color:var(--c-tx-muted); }
  input:focus,select:focus { border-color:var(--c-accent); box-shadow:0 0 0 3px var(--c-accent-tint-2); }
  input[aria-invalid="true"] { border-color:var(--c-danger); }
  .identity-row { display:flex; gap:12px; } .identity-row label { flex:1; } .identity-row .number { flex:0 0 84px; }
  .number input { font:13px var(--font-mono); font-variant-numeric:tabular-nums; }
  .hint { margin:-4px 0 0; font:11.5px/1.5 var(--font-serif); color:var(--c-tx-muted); }
  button { align-self:start; height:24px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); background:transparent; color:var(--c-tx); padding:0 10px; font:12.5px var(--font-serif); transition:background-color 80ms linear,border-color 80ms linear,color 80ms linear; }
  button:hover:not(:disabled) { background:var(--c-surface-2); border-color:var(--c-tx-muted); color:var(--c-tx-hi); } button:active:not(:disabled) { background:var(--c-accent-tint); border-color:var(--c-accent); } button:disabled { opacity:.45; }
  .new-family { border-style:dashed; color:var(--c-tx-muted); }
  .save { height:26px; padding:0 14px; color:var(--c-tx-hi); background:var(--c-accent-tint); border-color:color-mix(in oklab,var(--c-accent) 60%,transparent); font-weight:600; } .save:hover:not(:disabled) { background:color-mix(in oklab,var(--c-accent) 28%,transparent); border-color:var(--c-accent); }
  fieldset { margin:0; border:1px solid var(--c-line); border-radius:var(--r-ui); padding:12px; display:flex; flex-direction:column; gap:10px; min-width:0; } legend { padding:0 5px; font:600 10px var(--font-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--c-tx-muted); }
  p[role="alert"] { margin:0; color:var(--c-danger); font:12px var(--font-serif); }
  .actions { display:flex; gap:8px; }
  /* How the name will read, in the manuscript's serif. */
  .example { display:grid; grid-template-columns:76px minmax(0,1fr); gap:7px 10px; align-items:baseline; padding:13px 0; border-block:1px solid var(--c-line); } .example span { font:600 10px var(--font-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--c-tx-muted); } .example b { font:15px var(--font-serif); font-weight:400; color:var(--c-tx-hi); overflow-wrap:anywhere; }
  @media(prefers-reduced-motion:reduce) { button, input, select { transition:none; } }
</style>

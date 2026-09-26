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
  form { display:flex; flex-direction:column; gap:12px; }
  label { display:flex; flex-direction:column; gap:7px; font:12px var(--font-ui); color:var(--c-tx-2); }
  input,select { box-sizing:border-box; width:100%; min-width:0; height:32px; padding:5px 8px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); background:var(--c-bg); color:var(--c-tx); font:13px var(--font-ui); }
  input:focus,select:focus { outline:1px solid var(--c-accent); }
  .identity-row { display:flex; gap:12px; } .identity-row label { flex:1; } .identity-row .number { flex:0 0 80px; }
  .number input { font-family:var(--font-mono); }
  .hint { margin:0; font:11px/1.5 var(--font-ui); color:var(--c-tx-muted); }
  button { align-self:start; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); background:transparent; color:var(--c-tx); padding:6px 10px; font:12px var(--font-ui); }
  button:hover { border-color:var(--c-accent); } button:disabled { opacity:.45; } .save { color:var(--c-accent); background:var(--c-accent-tint); }
  fieldset { border:1px solid var(--c-line); padding:12px; display:flex; flex-direction:column; gap:10px; min-width:0; } legend { font:11px var(--font-mono); }
  .actions { display:flex; gap:8px; } .example { display:grid; grid-template-columns:80px minmax(0,1fr); gap:8px; padding:16px 0; border-block:1px solid var(--c-line); font-size:12px; } .example span { color:var(--c-tx-muted); } .example b { font-family:var(--font-serif); font-weight:400; overflow-wrap:anywhere; }
</style>

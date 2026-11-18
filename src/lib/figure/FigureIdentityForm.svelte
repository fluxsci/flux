<script lang="ts">
  import { tick } from 'svelte';
  import type { Figure, Project } from '../types';
  import { familyMap, familyById, formatFamilyRef, formatCaptionLabel, type FigureFamilyDef } from '../figfamily';
  import { slugify } from '../project/types';
  import { figureFamilyIdError } from '../ops';
  import { identityOf, type MetadataChange } from './metadata';
  export let model: Project;
  export let figure: Figure;
  export let save: (change: MetadataChange) => Promise<boolean>;
  let baseline = identityOf(figure);
  // Field by field, never as JSON text: `identityOf` and the form build the same three fields in a
  // different order, so their text never matched and an untouched form "saved" a change on its
  // first flush (a no-op write and an entry in the undo history, ahead of the caption you had
  // just edited, once the form sat beside the captions).
  type Identity = ReturnType<typeof identityOf>;
  const sameIdentity = (a: Identity, b: Identity) => a.nickname === b.nickname && a.family === b.family && a.number === b.number;
  let nickname = baseline.nickname;
  let family = baseline.family;
  let number = String(baseline.number);
  let staged: FigureFamilyDef | undefined;
  let creating = false, displayName = '', refTemplate = '', captionTemplate = '';
  let working = false;
  let flight: Promise<boolean> | null = null;
  let titleInput: HTMLInputElement;
  /** Put the caret in the title. The dialog asks for this when the name was asked for; the form
   *  never takes the focus by itself (it remounts for every figure you walk past). */
  export function focusTitle() { titleInput?.focus(); titleInput?.select(); }
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
    if (!sameIdentity(next, baseline)) { baseline = next; nickname = next.nickname; family = next.family; number = String(next.number); }
  }
  function chooseFamily() { number = String(model.figures.filter(f => f.id !== figure.id && (f.family ?? 'figure') === family).length + 1); }
  function suggest() { refTemplate = `${displayName.trim().slice(0, 3)}. {num}{panel}`; captionTemplate = `${displayName.trim()} {num} | `; }
  // The new-family fields go away when it is added or cancelled, and the focus with them (it fell
  // to the page, and the dialog's keys stopped answering): hand it to what comes next.
  let newFamilyButton: HTMLButtonElement, saveButton: HTMLButtonElement;
  function addFamily() {
    if (!validFamily) return;
    staged = { id: slugify(displayName), displayName: displayName.trim(), refTemplate: refTemplate.trim(), captionTemplate };
    family = staged.id; chooseFamily(); creating = false;
    void tick().then(() => saveButton?.focus());
  }
  function cancelFamily() { creating = false; void tick().then(() => newFamilyButton?.focus()); }
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
        if (sameIdentity(after, baseline)) return true;
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

<!-- The name, in one row under the preview (Figure-Meta's bottom panel; owner, 2026-11-18: "easily
     hideable/showable bottom panel … below the figure preview"): title, family, number, then how
     it will read. A new family opens a second row. Stacks when the panel is narrow. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form on:keydown={onKey} on:submit|preventDefault={() => creating ? addFamily() : flush()}>
  <div class="main">
    <label class="title-field">Title<input aria-label="Figure title" title="A descriptive name. The permanent reference stays linked to this figure." bind:this={titleInput} bind:value={nickname} placeholder="e.g. Growth curves" /></label>
    <label class="family-field">Family<select aria-label="Figure family" bind:value={family} on:change={chooseFamily}>{#each families as f (f.id)}<option value={f.id}>{f.displayName}</option>{/each}</select></label>
    <label class="number">Number<input aria-label="Figure number" inputmode="numeric" bind:value={number} aria-invalid={!validNumber} /></label>
    <div class="actions"><button type="button" class="new-family" aria-expanded={creating} bind:this={newFamilyButton} on:click={() => creating = !creating}>+ New family…</button><button class="save" type="submit" bind:this={saveButton} disabled={working || creating || !validNumber}>{working ? 'Saving…' : 'Save name'}</button></div>
  </div>
  {#if creating}
    <fieldset><legend>New family</legend>
      <label>Family name<input aria-label="Family name" bind:value={displayName} on:input={suggest} placeholder="Movie" /></label>
      <label>In-text template<input aria-label="In-text template" bind:value={refTemplate} /></label>
      <label>Caption template<input aria-label="Caption template" bind:value={captionTemplate} /></label>
      <div class="actions"><button type="button" disabled={!validFamily} on:click={addFamily}>Add family</button><button type="button" on:click={cancelFamily}>Cancel</button></div>
      <p class="hint wide">Use {'{num}'} for the number and {'{panel}'} for a panel label.{#if displayName && familyError} <span role="alert">{familyError}</span>{/if}</p>
    </fieldset>
  {/if}
  <div class="reads">
    <div class="example"><span>In text</span><b>{formatFamilyRef(definition, validNumber ? +number : 1, 'a')}</b><span>Caption</span><b>{formatCaptionLabel(definition, validNumber ? +number : 1)}</b></div>
    <p class="hint" class:bad={!validNumber}>{validNumber ? (+number < max && (family !== baseline.family || +number !== baseline.number) ? 'Inserts here; later figures in this family shift.' : 'Numbering is independent of document order.') : `Enter a whole number from 1 to ${max}.`}</p>
  </div>
</form>
<style>
  form { display:flex; flex-direction:column; gap:10px; container-type:inline-size; }
  .main { display:grid; grid-template-columns:minmax(140px,1fr) minmax(120px,190px) 76px auto; gap:10px; align-items:end; }
  label { display:flex; flex-direction:column; gap:5px; min-width:0; font:600 10px var(--font-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--c-tx-muted); }
  input,select { box-sizing:border-box; width:100%; min-width:0; height:28px; padding:0 9px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); background:var(--c-bg); color:var(--c-tx-hi); font:14px var(--font-serif); letter-spacing:0; text-transform:none; outline:none; transition:border-color 80ms linear, box-shadow 80ms linear; }
  select { appearance:none; -webkit-appearance:none; padding-right:26px; font:12.5px var(--font-ui); background:var(--c-bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%23878580' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 4.5 6 7.5l3-3'/%3E%3C/svg%3E") no-repeat right 8px center / 11px; }
  input::placeholder { color:var(--c-tx-faint); font-style:italic; }
  input:hover,select:hover { border-color:var(--c-tx-muted); }
  input:focus,select:focus { border-color:var(--c-accent); box-shadow:0 0 0 3px var(--c-accent-tint-2); }
  input[aria-invalid="true"] { border-color:var(--c-danger); }
  .number input { font:13px var(--font-mono); font-variant-numeric:tabular-nums; }
  .actions { display:flex; gap:6px; align-items:center; }
  button { height:28px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); background:transparent; color:var(--c-tx); padding:0 10px; font:12.5px var(--font-serif); white-space:nowrap; transition:background-color 80ms linear,border-color 80ms linear,color 80ms linear; }
  button:hover:not(:disabled) { background:var(--c-surface-2); border-color:var(--c-tx-muted); color:var(--c-tx-hi); } button:active:not(:disabled) { background:var(--c-accent-tint); border-color:var(--c-accent); } button:disabled { opacity:.45; }
  .new-family { border-style:dashed; color:var(--c-tx-muted); } .new-family[aria-expanded="true"] { border-style:solid; border-color:var(--c-accent); background:var(--c-accent-tint); color:var(--c-tx-hi); }
  .save { padding:0 14px; color:var(--c-tx-hi); background:var(--c-accent-tint); border-color:color-mix(in oklab,var(--c-accent) 60%,transparent); font-weight:600; } .save:hover:not(:disabled) { background:color-mix(in oklab,var(--c-accent) 28%,transparent); border-color:var(--c-accent); }
  /* A new family: its three fields in the same row rhythm, tinted so it reads as one thing being made. */
  fieldset { display:grid; grid-template-columns:minmax(120px,1fr) minmax(120px,1fr) minmax(120px,1fr) auto; gap:8px 10px; align-items:end; margin:0; min-width:0; padding:10px 12px 9px; border:1px solid color-mix(in oklab,var(--c-accent) 45%,var(--c-line)); border-radius:var(--r-ui); background:var(--c-accent-tint-2); }
  legend { padding:0 5px; font:600 10px var(--font-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--c-accent-bright); }
  .hint { margin:0; font:11.5px/1.5 var(--font-serif); color:var(--c-tx-muted); } .hint.bad, .hint [role="alert"] { color:var(--c-danger); } .hint.wide { grid-column:1 / -1; }
  /* How the name will read, in the manuscript's serif. */
  .reads { display:flex; align-items:baseline; justify-content:space-between; gap:8px 18px; flex-wrap:wrap; }
  .example { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; min-width:0; } .example span { font:600 10px var(--font-mono); letter-spacing:.08em; text-transform:uppercase; color:var(--c-tx-muted); } .example b { margin-right:12px; font:15px var(--font-serif); font-weight:400; color:var(--c-tx-hi); overflow-wrap:anywhere; }
  @container (max-width: 560px) {
    .main { grid-template-columns:minmax(0,1fr) 76px; } .title-field { grid-column:1 / -1; } .actions { grid-column:1 / -1; }
    fieldset { grid-template-columns:minmax(0,1fr); }
  }
  @media(prefers-reduced-motion:reduce) { button, input, select { transition:none; } }
</style>

<script lang="ts">
  // Document properties (the title pill's sheet, 2026-11-08): the title plus
  // the authors and affiliations as structured rows — name, affiliations,
  // corresponding, email, ORCID, equal contribution, lead contact (Cell) — the
  // exact fields the journal export prints on the title page. Saving hands the
  // rows to PaperMode, which writes them through the byte-minimal front-matter
  // patcher (documentProperties.ts): only what changed is written, every other
  // key, comment and quote stays as the user typed it.
  import { modalFocus } from "../../../lib/ui/modalFocus";
  import { untrack } from "svelte";
  import { popIn } from "../../../lib/motion/actions";
  import { orcidValid, newAffiliationId, type AffiliationRow, type AuthorRow, type DocumentProperties } from "./documentProperties";

  let {
    initial,
    onSave,
    onClose,
  }: {
    initial: DocumentProperties;
    onSave: (next: DocumentProperties) => void;
    onClose: () => void;
  } = $props();

  type Keyed<T> = T & { uid: number };
  let uid = 0;
  const seed = untrack(() => initial);
  let title = $state(seed.title);
  let authors = $state<Keyed<AuthorRow>[]>(seed.authors.map((a) => ({ ...a, affiliations: a.affiliations ? [...a.affiliations] : null, uid: ++uid })));
  let affs = $state<Keyed<AffiliationRow>[]>(seed.affiliations.map((a) => ({ ...a, uid: ++uid })));
  let tEl = $state<HTMLInputElement | undefined>(undefined);

  $effect(() => {
    tEl?.focus();
    tEl?.select();
  });

  const shortAff = (f: AffiliationRow) => f.name || f.department || f.text || f.id;

  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= authors.length) return;
    const next = [...authors];
    [next[i], next[j]] = [next[j], next[i]];
    authors = next;
  }
  function addAuthor() {
    authors = [...authors, { uid: ++uid, src: null, name: "", email: "", orcid: "", corresponding: false, equal: false, lead: false, affiliations: [], affiliationText: "" }];
    queueMicrotask(() => document.querySelector<HTMLInputElement>(`[data-author-uid="${uid}"] input`)?.focus());
  }
  function removeAuthor(i: number) {
    authors = authors.filter((_, k) => k !== i);
  }
  function toggleAff(a: Keyed<AuthorRow>, id: string) {
    if (!a.affiliations) return;
    a.affiliations = a.affiliations.includes(id) ? a.affiliations.filter((x) => x !== id) : [...a.affiliations, id];
  }
  function addAffiliation() {
    const id = newAffiliationId("aff", affs.map((f) => f.id));
    affs = [...affs, { uid: ++uid, src: null, id, explicitId: true, department: "", name: "", city: "", country: "", editable: true, text: "" }];
    queueMicrotask(() => document.querySelector<HTMLInputElement>(`[data-aff-uid="${uid}"] input`)?.focus());
  }
  function removeAffiliation(k: number) {
    const gone = affs[k].id;
    affs = affs.filter((_, i) => i !== k);
    for (const a of authors) if (a.affiliations) a.affiliations = a.affiliations.filter((x) => x !== gone);
  }

  function save() {
    // A new affiliation's provisional id becomes its institution's initials.
    const taken = affs.filter((f) => f.src !== null).map((f) => f.id);
    const rename = new Map<string, string>();
    const outAffs: AffiliationRow[] = affs
      .filter((f) => f.src !== null || f.name.trim() || f.department.trim())
      .map(({ uid: _u, ...f }) => {
        void _u;
        if (f.src !== null) return f;
        const id = newAffiliationId(f.name || f.department, taken);
        taken.push(id);
        rename.set(f.id, id);
        return { ...f, id };
      });
    const kept = new Set(outAffs.map((f) => f.id));
    const outAuthors: AuthorRow[] = authors.map(({ uid: _u, ...a }) => {
      void _u;
      return {
        ...a,
        affiliations: a.affiliations ? a.affiliations.map((x) => rename.get(x) ?? x).filter((x) => kept.has(x)) : null,
      };
    });
    onSave({ title: title.trim(), authors: outAuthors, affiliations: outAffs });
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && !e.shiftKey && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      save();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={onClose}></div>
<div class="te" use:modalFocus role="dialog" aria-modal="true" aria-label="Document properties" tabindex="-1" onkeydown={onKey} transition:popIn>
  <label class="field">
    <span class="lbl">Title</span>
    <input bind:this={tEl} bind:value={title} spellcheck="false" aria-label="Title" />
  </label>

  <section aria-label="Authors">
    <h3>Authors</h3>
    {#each authors as a, i (a.uid)}
      <div class="author" data-author-uid={a.uid}>
        <div class="line">
          <span class="num">{i + 1}</span>
          <input class="name" bind:value={a.name} placeholder="Name" spellcheck="false" aria-label={`Author ${i + 1} name`} />
          <button class="icon" type="button" title="Move up" aria-label={`Move author ${i + 1} up`} disabled={i === 0} onclick={() => move(i, -1)}>↑</button>
          <button class="icon" type="button" title="Move down" aria-label={`Move author ${i + 1} down`} disabled={i === authors.length - 1} onclick={() => move(i, 1)}>↓</button>
          <button class="icon" type="button" title="Remove author" aria-label={`Remove author ${i + 1}`} onclick={() => removeAuthor(i)}>×</button>
        </div>
        <div class="line sub">
          <input bind:value={a.email} placeholder="Email" spellcheck="false" aria-label={`Author ${i + 1} email`} />
          <input
            bind:value={a.orcid}
            class:bad={!!a.orcid.trim() && !orcidValid(a.orcid)}
            placeholder="ORCID 0000-0000-0000-0000"
            spellcheck="false"
            aria-label={`Author ${i + 1} ORCID`}
            aria-invalid={!!a.orcid.trim() && !orcidValid(a.orcid)}
            title={a.orcid.trim() && !orcidValid(a.orcid) ? "This ORCID iD fails its checksum: check for a typo" : ""} />
        </div>
        <div class="line sub flags">
          <label class="chk"><input type="checkbox" bind:checked={a.corresponding} aria-label={`Author ${i + 1} corresponding`} /> Corresponding</label>
          <label class="chk"><input type="checkbox" bind:checked={a.equal} aria-label={`Author ${i + 1} equal contribution`} /> Equal contribution</label>
          <label class="chk"><input type="checkbox" bind:checked={a.lead} aria-label={`Author ${i + 1} lead contact`} /> Lead contact</label>
        </div>
        <div class="line sub affs">
          {#if a.affiliations}
            {#each affs as f, k (f.uid)}
              <button
                class="chip"
                type="button"
                class:on={a.affiliations.includes(f.id)}
                aria-pressed={a.affiliations.includes(f.id)}
                aria-label={`Author ${i + 1} affiliation ${k + 1}`}
                title={shortAff(f)}
                onclick={() => toggleAff(a, f.id)}><b>{k + 1}</b> {shortAff(f)}</button>
            {:else}
              <span class="ro">Add an affiliation below to assign it.</span>
            {/each}
          {:else}
            <span class="ro" title="Written inline in the front matter; edit it there">{a.affiliationText}</span>
          {/if}
        </div>
      </div>
    {/each}
    <button class="add" type="button" data-add="author" onclick={addAuthor}>+ Add author</button>
  </section>

  <section aria-label="Affiliations">
    <h3>Affiliations</h3>
    {#each affs as f, k (f.uid)}
      <div class="aff" data-aff-uid={f.uid}>
        <span class="num">{k + 1}</span>
        {#if f.editable}
          <input bind:value={f.name} placeholder="Institution" spellcheck="false" aria-label={`Affiliation ${k + 1} institution`} />
          <input bind:value={f.department} placeholder="Department" spellcheck="false" aria-label={`Affiliation ${k + 1} department`} />
          <input class="short" bind:value={f.city} placeholder="City" spellcheck="false" aria-label={`Affiliation ${k + 1} city`} />
          <input class="short" bind:value={f.country} placeholder="Country" spellcheck="false" aria-label={`Affiliation ${k + 1} country`} />
        {:else}
          <span class="ro">{f.text}</span>
        {/if}
        <button
          class="icon"
          type="button"
          aria-label={`Remove affiliation ${k + 1}`}
          disabled={f.src !== null && !f.explicitId}
          title={f.src !== null && !f.explicitId ? "Authors refer to this one by its position; edit the front matter to remove it" : "Remove affiliation"}
          onclick={() => removeAffiliation(k)}>×</button>
      </div>
    {/each}
    <button class="add" type="button" data-add="affiliation" onclick={addAffiliation}>+ Add affiliation</button>
  </section>

  <div class="row">
    <button class="ghost" onclick={onClose}>Cancel</button>
    <button class="primary" onclick={save}>Save</button>
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 70;
  }
  .te {
    position: absolute;
    top: 58px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 71;
    width: min(680px, 92%);
    max-height: calc(100% - 90px);
    overflow: auto;
    padding: var(--sp-4);
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-3);
    box-shadow: var(--elev-3);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .lbl,
  h3 {
    margin: 0;
    font-size: var(--ts-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--c-tx-faint);
  }
  section {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .author,
  .aff {
    border: 1px solid var(--c-line);
    border-radius: var(--r-2);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .aff {
    flex-direction: row;
    align-items: center;
  }
  .line {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .line.sub {
    padding-left: 26px;
  }
  .flags {
    gap: 14px;
    flex-wrap: wrap;
  }
  .affs {
    flex-wrap: wrap;
  }
  .num {
    width: 20px;
    flex: none;
    text-align: center;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-variant-numeric: tabular-nums;
  }
  input:not([type="checkbox"]) {
    flex: 1 1 0;
    min-width: 0;
    box-sizing: border-box;
    padding: 6px 9px;
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    color: var(--c-tx);
    font-family: var(--font-serif);
    font-size: var(--ts-sm);
    outline: none;
  }
  .field input {
    padding: 8px 11px;
    font-size: var(--ts-base);
  }
  input.short {
    flex: 0.6 1 0;
  }
  input:focus {
    border-color: var(--c-accent);
  }
  input.bad {
    border-color: var(--c-danger, #af3029);
  }
  .chk {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
    cursor: var(--cursor-cross-hover);
  }
  .chip {
    font: inherit;
    font-size: var(--ts-xs);
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid var(--c-line-strong);
    background: none;
    color: var(--c-tx-2);
    cursor: var(--cursor-cross-hover);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip.on {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-on-accent);
  }
  .ro {
    font-size: var(--ts-sm);
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .icon {
    flex: none;
    width: 26px;
    height: 26px;
    border-radius: var(--r-1);
    border: 1px solid transparent;
    background: none;
    color: var(--c-tx-faint);
    font: inherit;
    cursor: var(--cursor-cross-hover);
  }
  .icon:hover:not(:disabled) {
    color: var(--c-tx-hi);
    border-color: var(--c-line-strong);
  }
  .icon:disabled {
    opacity: 0.35;
  }
  .add {
    align-self: flex-start;
    font: inherit;
    font-size: var(--ts-sm);
    padding: 4px 10px;
    border-radius: var(--r-1);
    border: 1px dashed var(--c-line-strong);
    background: none;
    color: var(--c-tx-2);
    cursor: var(--cursor-cross-hover);
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-top: 2px;
  }
  .row button {
    font: inherit;
    font-size: var(--ts-sm);
    padding: 6px 14px;
    border-radius: var(--r-1);
    cursor: var(--cursor-cross-hover);
    border: 1px solid transparent;
  }
  .ghost {
    background: none;
    border-color: var(--c-line-strong);
    color: var(--c-tx-2);
  }
  .ghost:hover {
    color: var(--c-tx-hi);
  }
  .primary {
    background: var(--c-accent);
    color: var(--c-on-accent);
    font-weight: 600;
  }
  .primary:hover {
    filter: brightness(1.06);
  }
</style>

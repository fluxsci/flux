<script lang="ts">
  // Figure Namer (Ctrl+R): the fast family · number · nickname popup. Opens
  // with the number pre-selected so the dominant action is three keystrokes:
  // Ctrl+R → digits → Enter. ↑/↓ cycle the family from anywhere; "+ New
  // family…" stages a custom family ("Movie" → "Mov. 3b") that is only
  // persisted on commit. One commit() = one undo entry. Store-driven
  // (store.figNamer), mounted by FigureMode inside .canvas-wrap.
  import { tick } from "svelte";
  import { figNamer, project, commit } from "./store";
  import * as ops from "./ops";
  import {
    familyMap,
    familyById,
    formatFamilyRef,
    formatCaptionLabel,
    derivedFigureName,
    DEFAULT_FAMILY,
    type FigureFamilyDef,
  } from "./figfamily";
  import { slugify } from "./project/types";
  import { panelLetters } from "./captions";
  import { popIn } from "./motion/actions";

  const fig = $derived($figNamer ? ($project.figures.find((f) => f.id === $figNamer.figId) ?? null) : null);

  let family = $state(DEFAULT_FAMILY);
  let numberText = $state("1");
  let nickname = $state("");
  let userTypedNumber = $state(false);
  let staged = $state<FigureFamilyDef | null>(null);
  // The new-family subform (null = closed). Templates auto-suggest from the
  // display name until hand-edited.
  let creating = $state<{ displayName: string; refTemplate: string; captionTemplate: string; autoRef: boolean; autoCap: boolean } | null>(null);
  let numberEl = $state<HTMLInputElement | undefined>();
  let createNameEl = $state<HTMLInputElement | undefined>();

  // Re-seed local state each time the namer opens (keyed on the target id).
  let seededFor = $state<string | null>(null);
  $effect(() => {
    const st = $figNamer;
    if (!st) {
      seededFor = null;
      staged = null;
      creating = null;
      return;
    }
    if (seededFor === st.figId) return;
    seededFor = st.figId;
    const f = $project.figures.find((x) => x.id === st.figId);
    family = f?.family ?? DEFAULT_FAMILY;
    numberText = String(f?.number ?? nextFreeIn(family));
    nickname = f?.nickname ?? "";
    userTypedNumber = false;
    staged = null;
    creating = null;
    void tick().then(() => {
      numberEl?.focus();
      numberEl?.select();
    });
  });

  const families = $derived.by(() => {
    const list = [...familyMap($project.figureFamilies).values()];
    if (staged && !list.some((d) => d.id === staged!.id)) list.push(staged);
    return list;
  });
  const selDef = $derived(
    staged && family === staged.id ? staged : familyById(family, $project.figureFamilies),
  );

  /** Members of `famId` excluding the target figure. */
  function countIn(famId: string): number {
    return $project.figures.filter((f) => f.family === famId && f.id !== fig?.id).length;
  }
  function nextFreeIn(famId: string): number {
    return countIn(famId) + 1;
  }

  const num = $derived.by(() => {
    const n = parseInt(numberText, 10);
    const max = countIn(family) + 1;
    return Number.isFinite(n) ? Math.max(1, Math.min(n, max)) : max;
  });
  const firstPanel = $derived(fig ? (panelLetters(fig)[0] ?? "") : "");
  const hint = $derived.by(() => {
    if (fig?.family === family && fig?.number === num) return `keeps number ${num}`;
    if (num > countIn(family)) return `appended as ${num}`;
    return `inserts at ${num} — later figures shift`;
  });

  function pickFamily(id: string) {
    family = id;
    if (!userTypedNumber) {
      numberText = String(fig?.family === id ? (fig.number ?? nextFreeIn(id)) : nextFreeIn(id));
    }
  }
  function cycleFamily(d: number) {
    const i = families.findIndex((f) => f.id === family);
    const next = families[(i + d + families.length) % families.length];
    if (next) pickFamily(next.id);
  }

  function openCreate() {
    creating = { displayName: "", refTemplate: "", captionTemplate: "", autoRef: true, autoCap: true };
    void tick().then(() => createNameEl?.focus());
  }
  function suggestFrom(name: string) {
    if (!creating) return;
    const n = name.trim();
    if (creating.autoRef) creating.refTemplate = n ? `${n.slice(0, 3)}. {num}{panel}` : "";
    if (creating.autoCap) creating.captionTemplate = n ? `${n} {num} | ` : "";
  }
  const createValid = $derived(
    !!creating &&
      creating.displayName.trim().length > 0 &&
      creating.refTemplate.includes("{num}") &&
      creating.captionTemplate.includes("{num}"),
  );
  function acceptCreate() {
    if (!creating || !createValid) return;
    const displayName = creating.displayName.trim();
    const id = slugify(displayName);
    staged = {
      id,
      displayName,
      refTemplate: creating.refTemplate.trim(),
      captionTemplate: creating.captionTemplate,
    };
    creating = null;
    userTypedNumber = false;
    pickFamily(id);
    void tick().then(() => {
      numberEl?.focus();
      numberEl?.select();
    });
  }

  function close() {
    figNamer.set(null);
  }
  function commitNamer() {
    const st = $figNamer;
    if (!st || !fig) return close();
    if (creating) return acceptCreate();
    commit((p) => {
      if (staged && family === staged.id) ops.defineFigureFamily(p, staged);
      ops.setFigureIdentity(p, st.figId, {
        family,
        number: num,
        nickname: nickname.trim() || null,
      });
    });
    close();
  }

  function onKey(e: KeyboardEvent) {
    e.stopPropagation(); // canvas shortcuts must not fire while naming
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      if (creating) creating = null;
      else close();
      return;
    }
    if (e.key === "Enter" || (mod && e.code === "KeyR")) {
      e.preventDefault();
      commitNamer();
      return;
    }
    if (creating) return; // subform owns the rest of its keys
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      cycleFamily(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    // Digits typed outside an input land in the number field.
    const t = e.target as HTMLElement;
    if (/^[0-9]$/.test(e.key) && t.tagName !== "INPUT") {
      e.preventDefault();
      numberText = e.key;
      userTypedNumber = true;
      numberEl?.focus();
    }
  }
</script>

{#if $figNamer && fig}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="namer-scrim" onmousedown={close}></div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="namer"
    role="dialog"
    aria-label="Name figure"
    tabindex="-1"
    transition:popIn
    onmousedown={(e) => e.stopPropagation()}
    onkeydown={onKey}>
    <div class="nrow head">
      <span class="ntitle">Name figure</span>
      <span class="ncur">{fig.name}</span>
      <button class="nico" title="Cancel (Esc)" aria-label="Cancel" onclick={close}>✕</button>
    </div>

    {#if !creating}
      <div class="nbody">
        <div class="fams" role="radiogroup" aria-label="Figure family">
          {#each families as f (f.id)}
            <button
              class="fam"
              class:on={f.id === family}
              role="radio"
              aria-checked={f.id === family}
              onclick={() => pickFamily(f.id)}>
              <span class="dot"></span>{f.displayName}{#if staged && f.id === staged.id}<span class="new">new</span>{/if}
            </button>
          {/each}
          <button class="fam add" onclick={openCreate}>+ New family…</button>
        </div>
        <div class="numcol">
          <label class="nlabel" for="fig-namer-number">Number</label>
          <input
            id="fig-namer-number"
            class="numin"
            bind:this={numberEl}
            bind:value={numberText}
            oninput={() => (userTypedNumber = true)}
            inputmode="numeric"
            spellcheck="false"
            aria-label="Figure number" />
          <span class="nhint">{hint}</span>
        </div>
      </div>
      <input
        class="nick"
        bind:value={nickname}
        placeholder="nickname (optional)"
        spellcheck="false"
        aria-label="Nickname" />
      <div class="nprev">
        <span class="pv-name">{derivedFigureName(selDef, num)}</span>
        <span class="pv-sep">·</span>
        <span class="pv-ref">{formatFamilyRef(selDef, num, firstPanel)}</span>
        <span class="pv-sep">·</span>
        <span class="pv-cap">{formatCaptionLabel(selDef, num).trimEnd()}</span>
      </div>
    {:else}
      <div class="create">
        <label class="nlabel" for="fam-create-name">Family name</label>
        <input
          id="fam-create-name"
          bind:this={createNameEl}
          bind:value={creating.displayName}
          oninput={() => suggestFrom(creating!.displayName)}
          placeholder="Movie"
          spellcheck="false" />
        <label class="nlabel" for="fam-create-ref">In-text template</label>
        <input
          id="fam-create-ref"
          bind:value={creating.refTemplate}
          oninput={() => (creating!.autoRef = false)}
          placeholder="Mov. {'{num}{panel}'}"
          spellcheck="false" />
        <label class="nlabel" for="fam-create-cap">Caption template</label>
        <input
          id="fam-create-cap"
          bind:value={creating.captionTemplate}
          oninput={() => (creating!.autoCap = false)}
          placeholder="Movie {'{num}'} | "
          spellcheck="false" />
        {#if creating.displayName.trim() && createValid}
          <div class="nprev">
            <span class="pv-ref">{formatFamilyRef({ id: "x", displayName: creating.displayName, refTemplate: creating.refTemplate, captionTemplate: creating.captionTemplate }, 3, "b")}</span>
            <span class="pv-sep">·</span>
            <span class="pv-cap">{formatCaptionLabel({ id: "x", displayName: creating.displayName, refTemplate: creating.refTemplate, captionTemplate: creating.captionTemplate }, 3).trimEnd()}</span>
          </div>
        {:else}
          <div class="nhint">templates need {"{num}"} ({"{panel}"} optional)</div>
        {/if}
        <div class="nactions">
          <button class="nbtn save" disabled={!createValid} onclick={acceptCreate}>Add (Enter)</button>
          <button class="nbtn" onclick={() => (creating = null)}>Back (Esc)</button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .namer-scrim {
    position: absolute;
    inset: 0;
    z-index: 59;
    background: transparent; /* swallows the dismissing click — no canvas marquee */
  }
  .namer {
    position: absolute;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    width: 340px;
    z-index: 60; /* above the disk-toast's 50 */
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2, 8px);
    box-shadow: var(--elev-2, 0 4px 16px rgba(0, 0, 0, 0.35));
    font-size: var(--ts-sm, 12px);
    color: var(--c-tx);
  }
  .nrow.head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .ntitle {
    font-size: var(--ts-xs);
    font-weight: 600;
    color: var(--c-tx-2);
  }
  .ncur {
    flex: 1 1 auto;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nico {
    border: none;
    background: none;
    color: var(--c-tx-faint);
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
  }
  .nico:hover {
    color: var(--c-tx-1);
  }
  .nbody {
    display: flex;
    gap: 12px;
  }
  .fams {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .fam {
    display: flex;
    align-items: center;
    gap: 7px;
    border: none;
    background: transparent;
    color: var(--c-tx);
    font: inherit;
    text-align: left;
    padding: 4px 6px;
    border-radius: var(--r-1, 4px);
    cursor: pointer;
  }
  .fam:hover {
    background: color-mix(in srgb, var(--c-accent, #4385be) 10%, transparent);
  }
  .fam.on {
    background: var(--c-accent-tint, color-mix(in srgb, var(--c-accent, #4385be) 16%, transparent));
    color: var(--c-accent);
  }
  .fam .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    border: 1px solid var(--c-tx-faint);
    flex: 0 0 auto;
  }
  .fam.on .dot {
    background: var(--c-accent);
    border-color: var(--c-accent);
  }
  .fam .new {
    margin-left: auto;
    font-size: var(--ts-xs);
    color: var(--c-accent);
    opacity: 0.8;
  }
  .fam.add {
    color: var(--c-tx-faint);
    margin-top: 2px;
  }
  .fam.add:hover {
    color: var(--c-accent);
  }
  .numcol {
    flex: 0 0 92px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .nlabel {
    font-size: var(--ts-xs);
    color: var(--c-tx-2);
  }
  .numin {
    width: 100%;
    background: var(--c-bg);
    color: var(--c-tx);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    padding: 5px 7px;
    font: inherit;
    font-size: var(--ts-md, 14px);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .numin:focus,
  .nick:focus,
  .create input:focus {
    outline: none;
    border-color: var(--c-accent);
  }
  .nhint {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    line-height: 1.3;
  }
  .nick,
  .create input {
    width: 100%;
    background: var(--c-bg);
    color: var(--c-tx);
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    padding: 4px 7px;
    font: inherit;
    font-size: var(--ts-xs);
  }
  .nprev {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--c-line);
    font-size: var(--ts-xs);
    overflow: hidden;
    white-space: nowrap;
  }
  .pv-name {
    color: var(--c-tx-2);
  }
  .pv-sep {
    color: var(--c-tx-faint);
  }
  .pv-ref {
    color: var(--c-accent);
  }
  .pv-cap {
    color: var(--c-tx-2);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .create {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .nactions {
    display: flex;
    gap: 6px;
    padding-top: 4px;
  }
  .nbtn {
    border: 1px solid var(--c-line-strong);
    background: transparent;
    color: var(--c-tx-2);
    border-radius: var(--r-1);
    padding: 3px 8px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
  }
  .nbtn:hover {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .nbtn.save {
    border-color: var(--c-accent);
    background: var(--c-accent-tint, color-mix(in srgb, var(--c-accent, #4385be) 16%, transparent));
    color: var(--c-accent);
  }
  .nbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>

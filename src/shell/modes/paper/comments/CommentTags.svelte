<script lang="ts">
  // A comment's tags: chips in each tag's colour, and "+ tag" to attach one from your list or
  // make a new one on the spot (it joins the list in Settings). There are no tags until you make
  // one. Built on the margin kit (its ancestor supplies --pane-c and the --mk-* tints).
  import { tick, type Snippet } from "svelte";
  import { normalizeTag } from "../../../../lib/project/comments";
  import { tagColor, type CommentTagDef } from "../../../../lib/project/commentTags";

  let { tags, defs, onChange, onDefine, editable = true, trailing }: {
    tags: readonly string[];
    defs: readonly CommentTagDef[];
    onChange: (tags: string[]) => void;
    /** Add a name to your tag list; returns its stored form ("" when nothing usable is left). */
    onDefine: (name: string) => string;
    editable?: boolean;
    /** Sits at the row's far end, after the chips (who the comment is for). */
    trailing?: Snippet;
  } = $props();

  let open = $state(false);
  let draft = $state("");
  let at = $state(0); // which offered row the keyboard is on
  let root = $state<HTMLElement | undefined>(undefined);
  let field = $state<HTMLInputElement | undefined>(undefined);

  const wanted = $derived(normalizeTag(draft));
  const offered = $derived(defs.filter((d) => !tags.includes(d.name) && (!wanted || d.name.includes(wanted))));
  const creatable = $derived(!!wanted && !defs.some((d) => d.name === wanted) && !tags.includes(wanted));
  $effect(() => { void offered.length; at = Math.min(at, Math.max(0, offered.length + (creatable ? 1 : 0) - 1)); });

  async function show() {
    open = true; draft = ""; at = 0;
    await tick();
    field?.focus();
  }
  function hide(refocus = false) {
    open = false;
    if (refocus) root?.querySelector<HTMLButtonElement>(".add")?.focus();
  }
  function attach(name: string) {
    if (name && !tags.includes(name)) onChange([...tags, name]);
    draft = ""; at = 0;
    field?.focus();
  }
  function create() {
    const name = onDefine(draft);
    if (name) attach(name);
  }
  function choose(index: number) {
    if (index < offered.length) attach(offered[index].name);
    else if (creatable) create();
  }
  function onKey(e: KeyboardEvent) {
    const rows = offered.length + (creatable ? 1 : 0);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hide(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); at = rows ? (at + 1) % rows : 0; }
    else if (e.key === "ArrowUp") { e.preventDefault(); at = rows ? (at - 1 + rows) % rows : 0; }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (rows) choose(at); }
    else if (e.key === "Backspace" && !draft && tags.length) { e.preventDefault(); onChange(tags.slice(0, -1)); }
  }
  function onFocusOut(e: FocusEvent) {
    if (open && !root?.contains(e.relatedTarget as Node | null)) hide();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="tags" bind:this={root} onfocusout={onFocusOut}>
  {#each tags as tag (tag)}
    <span class="tag" style:--tag-c={tagColor(defs, tag)} data-tag={tag}>
      <span class="name">#{tag}</span>{#if editable}<button class="drop" aria-label={`Remove the tag ${tag}`} title="Remove this tag" onclick={() => onChange(tags.filter((t) => t !== tag))}><svg viewBox="0 0 10 10" width="7" height="7" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg></button>{/if}
    </span>
  {/each}
  {#if editable}
    <button class="add" aria-expanded={open} aria-haspopup="listbox" title="Attach a tag" onclick={() => (open ? hide() : show())}>{tags.length ? "+" : "+ tag"}</button>
  {/if}
  {#if trailing}<span class="trail">{@render trailing()}</span>{/if}
  {#if editable}
    {#if open}
      <div class="menu">
        <input class="mk-input" bind:this={field} bind:value={draft} placeholder={defs.length ? "Find or make a tag" : "Name your first tag"} aria-label="Tag name" spellcheck="false" onkeydown={onKey} />
        {#if offered.length || creatable}
          <div class="rows" role="listbox" aria-label="Tags">
            {#each offered as def, i (def.name)}
              <button class="row" class:hl={i === at} role="option" aria-selected={i === at} style:--tag-c={def.color || undefined} onmouseenter={() => (at = i)} onclick={() => attach(def.name)}><i class="dot" aria-hidden="true"></i>#{def.name}</button>
            {/each}
            {#if creatable}
              <button class="row make" class:hl={at === offered.length} role="option" aria-selected={at === offered.length} onmouseenter={() => (at = offered.length)} onclick={create}><span class="plus" aria-hidden="true">+</span>New tag <b>#{wanted}</b></button>
            {/if}
          </div>
        {:else}
          <p class="none">{defs.length ? (wanted ? "Already on this comment." : "Every tag is already on it.") : "Type a name, then Enter."}</p>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .tags {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  /* A tag: its colour as a tint, an edge and the text (the pane's ink when it has none). */
  .tag {
    --c: var(--tag-c, var(--pane-c));
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: calc(18px * var(--ts-scale, 1));
    padding: 0 4px 0 6px;
    border: 1px solid color-mix(in oklab, var(--c) 42%, transparent);
    border-radius: var(--r-ui);
    background: color-mix(in oklab, var(--c) 11%, transparent);
    color: var(--c);
    font: 600 calc(10px * var(--ts-scale, 1)) / 1 var(--font-mono);
    white-space: nowrap;
  }
  .tag:not(:has(.drop)) {
    padding-right: 6px;
  }
  .drop {
    display: grid;
    place-items: center;
    width: 12px;
    height: 12px;
    padding: 0;
    border: 0;
    border-radius: var(--r-ui);
    background: none;
    color: inherit;
    opacity: 0.55;
    cursor: var(--cursor-cross-hover);
  }
  .drop:hover {
    opacity: 1;
    background: color-mix(in oklab, var(--c) 20%, transparent);
  }
  .drop svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }
  .add {
    height: calc(18px * var(--ts-scale, 1));
    padding: 0 6px;
    border: 1px dashed var(--c-line-strong);
    border-radius: var(--r-ui);
    background: none;
    color: var(--c-tx-muted);
    font: calc(10px * var(--ts-scale, 1)) / 1 var(--font-mono);
    cursor: var(--cursor-cross-hover);
    transition:
      border-color 80ms linear,
      color 80ms linear,
      background 80ms linear;
  }
  .add:hover,
  .add[aria-expanded="true"] {
    border-style: solid;
    border-color: var(--mk-edge);
    background: var(--mk-tint);
    color: var(--pane-c);
  }
  .trail {
    display: inline-flex;
    margin-left: auto;
  }
  /* The menu opens IN the row's flow, on its own line under the chips: whatever holds the
     comment (the card on the page, the pane's list) grows to show it. A floating one was cut
     off by both of their scrollers. */
  .menu {
    order: 9;
    flex: 1 0 100%;
    display: grid;
    gap: 4px;
    min-width: 0;
    margin-top: 2px;
    padding: 5px;
    border: 1px solid var(--mk-edge);
    border-radius: var(--r-1);
    background: var(--mk-tint);
  }
  .menu .mk-input {
    height: calc(26px * var(--ts-scale, 1));
    font-family: var(--font-mono);
    font-size: calc(11px * var(--ts-scale, 1));
  }
  .rows {
    display: grid;
    max-height: calc(5 * 24px * var(--ts-scale, 1));
    overflow: auto;
    scrollbar-width: thin;
  }
  .row {
    --c: var(--tag-c, var(--pane-c));
    display: flex;
    align-items: center;
    gap: 7px;
    height: calc(24px * var(--ts-scale, 1));
    padding: 0 6px;
    border: 0;
    border-radius: var(--r-ui);
    background: none;
    color: var(--c-tx-2);
    font: calc(11px * var(--ts-scale, 1)) var(--font-mono);
    text-align: left;
    cursor: var(--cursor-cross-hover);
  }
  .row.hl {
    background: var(--mk-tint-2);
    color: var(--c-tx);
    box-shadow: inset 2px 0 0 var(--pane-c);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: var(--c);
  }
  .row.make {
    font-family: var(--font-serif);
    font-size: var(--ts-xs);
  }
  .row.make b {
    font: 600 calc(11px * var(--ts-scale, 1)) var(--font-mono);
    color: var(--pane-c);
  }
  .plus {
    width: 8px;
    text-align: center;
    color: var(--pane-c);
  }
  .none {
    margin: 2px 4px 3px;
    color: var(--c-tx-faint);
    font: italic var(--ts-xs) var(--font-serif);
  }
  @media (prefers-reduced-motion: reduce) {
    .add {
      transition: none;
    }
  }
</style>

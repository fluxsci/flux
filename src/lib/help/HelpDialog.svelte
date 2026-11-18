<script lang="ts">
  // The keyboard reference's dialog (press ?). Loaded by Help.svelte on first use, so its
  // content stays out of Home's eager graph.
  //
  // The CONTENT lives in shortcuts.ts (pure, gated by verify-help-shortcuts): this file only
  // draws it. Each chord is drawn key by key, as the same caps the rest of Flux uses, named
  // for this platform (Ctrl or ⌘, Alt or ⌥); a gesture (click, drag, wheel) is words, never
  // a cap.
  //
  // Search is the first thing focused: type a word ("crystallize") or a chord ("alt+t") and
  // every section is searched at once, with the count each section holds beside its name.
  // Esc clears the search first, then closes.
  import { onMount } from "svelte";
  import { helpOpen } from "../settings";
  import { get } from "svelte/store";
  import { focusedMode } from "../../shell/paneStore";
  import { modalFocus } from "../ui/modalFocus";
  import Icon from "../../shell/Icon.svelte";
  import { SECTIONS, keyPieces, keyText, markRuns, queryTerms, searchShortcuts, shortcutCount, type ShortcutGroup, type ShortcutRow, type SectionId } from "./shortcuts";

  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const total = shortcutCount();

  // Open on the mode you are working in, with an empty search and the caret in it.
  const focused = get(focusedMode);
  let tab = $state<SectionId>(SECTIONS.some((s) => s.id === focused) ? (focused as SectionId) : "global");
  let query = $state("");
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  onMount(() => inputEl?.focus());

  const section = $derived(SECTIONS.find((s) => s.id === tab) ?? SECTIONS[0]);
  const terms = $derived(queryTerms(query));
  const searching = $derived(terms.length > 0);
  const hits = $derived(searching ? searchShortcuts(query, mac) : []);
  /** How many rows of each section match, shown beside the section's name while searching. */
  const hitCounts = $derived.by(() => {
    const counts = new Map<SectionId, number>();
    for (const hit of hits) counts.set(hit.section.id, (counts.get(hit.section.id) ?? 0) + 1);
    return counts;
  });
  /** What the list draws: the chosen section, or every section's matches under "Section · Group" heads. */
  type Block = { key: string; section: string; sectionId: SectionId; group: ShortcutGroup; rows: ShortcutRow[] };
  const blocks = $derived.by((): Block[] => {
    if (!searching) return section.groups.map((group) => ({ key: `${section.id}/${group.title}`, section: "", sectionId: section.id, group, rows: group.rows }));
    const out: Block[] = [];
    for (const hit of hits) {
      const key = `${hit.section.id}/${hit.group.title}`;
      const last = out.at(-1);
      if (last?.key === key) last.rows.push(hit.row);
      else out.push({ key, section: hit.section.label, sectionId: hit.section.id, group: hit.group, rows: [hit.row] });
    }
    return out;
  });
  // Two columns, each group whole, filled by "the shorter column takes the next group": it keeps
  // the reading order close to the data's and the columns close to even. (CSS multi-column cannot
  // do this inside a scrolling box: a fixed height sends the overflow sideways into a third column.)
  const columns = $derived.by(() => {
    const cols: [Block[], Block[]] = [[], []];
    const height = [0, 0];
    for (const block of blocks) {
      const at = height[1] < height[0] ? 1 : 0;
      cols[at].push(block);
      height[at] += 34 + block.rows.length * 28;
    }
    return cols;
  });

  function isTyping(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  }

  function chooseTab(id: SectionId) {
    tab = id;
    if (!searching) {
      if (listEl) listEl.scrollTop = 0;
      return;
    }
    // While searching, a section's name takes you to its matches.
    queueMicrotask(() => {
      const first = [...(listEl?.querySelectorAll<HTMLElement>(`[data-section="${id}"]`) ?? [])].sort((a, b) => a.offsetTop - b.offsetTop)[0];
      if (first && listEl) listEl.scrollTop = Math.max(0, first.offsetTop - listEl.offsetTop - 6);
    });
  }
  function stepTab(delta: 1 | -1) {
    const pool = searching ? SECTIONS.filter((s) => hitCounts.get(s.id)) : SECTIONS;
    if (!pool.length) return;
    const at = pool.findIndex((s) => s.id === tab);
    chooseTab(pool[(Math.max(at, delta > 0 ? -1 : 0) + delta + pool.length) % pool.length].id);
  }

  /** The reference's own keys. Help.svelte's window listener calls this; true = handled. */
  export function handleKey(e: KeyboardEvent): boolean {
    const own = e.target === inputEl;
    if (e.key === "Escape") {
      e.preventDefault();
      // Esc clears a search before it closes the reference.
      if (query) {
        query = "";
        inputEl?.focus();
      } else helpOpen.set(false);
      return true;
    }
    // "?" closes again, unless it is being typed into a search for the "?" key itself.
    if (own && !query && (e.key === "?" || (e.key === "/" && e.shiftKey))) {
      e.preventDefault();
      helpOpen.set(false);
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!own && isTyping(e.target)) return false;
      e.preventDefault();
      stepTab(e.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    if ((e.key === "PageDown" || e.key === "PageUp") && listEl) {
      e.preventDefault();
      listEl.scrollTop += (e.key === "PageDown" ? 1 : -1) * Math.max(80, listEl.clientHeight - 60);
      return true;
    }
    // Typing anywhere in the reference types into the search.
    if (!isTyping(e.target) && (e.key === "/" || (e.key.length === 1 && e.key !== " " && e.key !== "?"))) {
      inputEl?.focus();
      if (e.key === "/") e.preventDefault();
      return true;
    }
    return false;
  }
</script>

{#snippet keys(row: ShortcutRow)}
  <span class="keys" aria-label={keyText(row, mac)}>
    {#each keyPieces(row, mac) as piece}
      {#if piece.kind === "key"}<kbd>{piece.text}</kbd>{:else if piece.kind === "words"}<span class="g">{piece.text}</span>{:else}<span class="s" aria-hidden="true">{piece.text}</span>{/if}
    {/each}
  </span>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="backdrop" onclick={() => helpOpen.set(false)}>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label="Keyboard shortcuts"
    tabindex="-1"
    use:modalFocus
    onclick={(e) => e.stopPropagation()}>
    <div class="head">
      <span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15"><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17.5 10h.01M6.5 14h.01M17.5 14h.01M10 14h4" /></svg></span>
      <h2>Keyboard shortcuts</h2>
      <span class="vsep" aria-hidden="true"></span>
      <label class="find">
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
        <input
          bind:this={inputEl}
          bind:value={query}
          type="text"
          spellcheck="false"
          autocomplete="off"
          aria-label="Search shortcuts"
          placeholder={`Search ${total} shortcuts: a word, or a chord like alt+t`} />
        {#if searching}<span class="n" aria-live="polite">{hits.length} {hits.length === 1 ? "match" : "matches"}</span>{/if}
      </label>
      <button class="x" aria-label="Close" title="Close (Esc)" onclick={() => helpOpen.set(false)}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg></button>
    </div>

    <div class="body">
      <div class="tabs" role="tablist" aria-orientation="vertical" aria-label="Modes">
        {#each SECTIONS as s (s.id)}
          {@const count = hitCounts.get(s.id) ?? 0}
          <button
            class="tab"
            class:on={tab === s.id && !(searching && !count)}
            class:none={searching && !count}
            role="tab"
            aria-selected={tab === s.id}
            onclick={() => chooseTab(s.id)}><span class="ti" aria-hidden="true">{#if s.id === "global"}<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.2-3.8-8.5s1.2-6.1 3.8-8.5z" /></svg>{:else}<Icon name={s.id} size={16} />{/if}</span><span class="tl">{s.label}</span>{#if searching}<span class="tn">{count}</span>{/if}</button>
        {/each}
      </div>

      <div class="cols" class:searching bind:this={listEl}>
        {#each columns as column, c (c)}
          <div class="col">
            {#each column as block (block.key)}
              <div class="grp" data-section={block.sectionId}>
                <h3>{#if block.section}<span class="sec">{block.section}</span>{/if}{block.group.title}{#if block.group.when}<i>{block.group.when}</i>{/if}</h3>
                {#each block.rows as row (row.keys + row.does)}
                  <div class="row">
                    <span class="d">{#if searching}{#each markRuns(row.does, terms) as run}{#if run.hit}<mark>{run.text}</mark>{:else}{run.text}{/if}{/each}{:else}{row.does}{/if}</span>
                    {@render keys(row)}
                  </div>
                {/each}
              </div>
            {/each}
          </div>
        {/each}
        {#if searching && !hits.length}
          <div class="empty">
            <p>No shortcut matches <b>{query.trim()}</b>.</p>
            <p class="try">Try a word from what you want to do (<i>duplicate</i>, <i>zoom</i>, <i>cite</i>) or a chord as you would press it (<i>alt+t</i>, <i>shift a</i>).</p>
          </div>
        {/if}
      </div>
    </div>

    <div class="foot">
      <span class="legend">{mac ? "⌘ is Ctrl, and ⌥ is Alt, on Windows and Linux" : "On macOS, Ctrl is ⌘ and Alt is ⌥"}</span>
      <span class="hints"><kbd>↑</kbd><kbd>↓</kbd> sections <span class="dot">·</span> <kbd>Esc</kbd> {query ? "clear" : "close"}</span>
      <button class="close" onclick={() => helpOpen.set(false)}>Close</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 300;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.4);
  }
  .modal {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    width: min(980px, calc(100vw - 40px));
    height: min(700px, calc(100vh - 40px));
    overflow: hidden;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-panel);
    box-shadow: var(--elev-3);
    color: var(--c-tx);
    font: 13px/1.35 var(--font-serif);
    -webkit-font-smoothing: antialiased;
    animation: help-in 80ms linear 1;
  }
  @keyframes help-in {
    from {
      opacity: 0;
    }
  }
  .modal:focus {
    outline: none;
  }
  .modal * {
    box-sizing: border-box;
  }
  svg {
    display: block;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  button {
    margin: 0;
    font: inherit;
    cursor: var(--cursor-cross-hover);
    transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear;
  }

  /* ---- header: title │ search … close --------------------------------------- */
  .head {
    flex: 0 0 40px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 6px 0 12px;
    background: var(--c-bg-raised);
    border-bottom: 1px solid var(--c-line);
  }
  .mark {
    display: inline-flex;
    color: var(--c-tx-muted);
  }
  h2 {
    margin: 0;
    font: 600 14px var(--font-serif);
    color: var(--c-tx-hi);
    white-space: nowrap;
  }
  .vsep {
    flex: 0 0 1px;
    height: 14px;
    background: var(--c-line-strong);
  }
  .find {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    padding: 0 8px;
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    color: var(--c-tx-muted);
    cursor: text;
    transition: border-color 80ms linear;
  }
  .find:hover {
    border-color: var(--c-tx-muted);
  }
  .find:focus-within {
    border-color: var(--c-accent);
    color: var(--c-tx-2);
  }
  .find input {
    flex: 1 1 auto;
    min-width: 0;
    height: 24px;
    margin: 0;
    padding: 0;
    background: transparent;
    border: 0;
    outline: none;
    color: var(--c-tx-hi);
    font: 13px var(--font-serif);
  }
  .find input::placeholder {
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .find .n {
    flex: 0 0 auto;
    color: var(--c-tx-muted);
    font: 10.5px var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .x {
    flex: 0 0 24px;
    width: 24px;
    height: 24px;
    padding: 0;
    display: grid;
    place-items: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-ui);
    color: var(--c-tx-muted);
  }
  .x svg {
    width: 12px;
    height: 12px;
    stroke-width: 1.5;
  }
  .x:hover {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }

  /* ---- sections rail --------------------------------------------------------- */
  .body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .tabs {
    flex: 0 0 156px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px 6px;
    background: var(--c-bg-raised);
    border-right: 1px solid var(--c-line);
  }
  .tab {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 9px;
    height: 30px;
    padding: 0 8px 0 9px;
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: var(--r-ui);
    color: var(--c-tx-2);
    font: 13px var(--font-serif);
    white-space: nowrap;
  }
  .ti {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    opacity: 0.7;
  }
  .tn {
    color: var(--c-tx-muted);
    font: 10.5px var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .tab:hover {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }
  .tab:hover .ti,
  .tab.on .ti {
    opacity: 1;
  }
  .tab:active {
    background: var(--c-accent-tint);
  }
  .tab.on {
    background: var(--c-accent-tint);
    box-shadow: inset 2px 0 0 var(--c-accent);
    color: var(--c-tx-hi);
  }
  .tab.on .tn {
    color: var(--c-accent);
  }
  .tab.none {
    color: var(--c-tx-faint);
  }
  .tab.none .ti {
    opacity: 0.35;
  }
  .tab.none .tn {
    color: var(--c-tx-faint);
  }
  button:focus-visible {
    outline: 1px solid var(--c-accent);
    outline-offset: 1px;
  }

  /* ---- the list: groups flow down two columns, a group never splits ----------- */
  .cols {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding: 6px 22px 22px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-content: start;
    column-gap: 34px;
    scrollbar-gutter: stable;
  }
  .col {
    min-width: 0;
  }
  .grp {
    padding-top: 12px;
  }
  h3 {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 3px;
    padding-bottom: 5px;
    border-bottom: 1px solid var(--c-line);
    color: var(--c-tx-muted);
    font: 600 10px var(--font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  h3 .sec {
    color: var(--c-accent);
  }
  h3 .sec::after {
    content: "›";
    margin-left: 8px;
    color: var(--c-tx-faint);
  }
  h3 i {
    color: var(--c-tx-faint);
    font: italic 11.5px var(--font-serif);
    letter-spacing: 0;
    text-transform: none;
  }
  /* What it does on the left, the keys ending on the right edge. */
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: baseline;
    column-gap: 14px;
    min-height: 26px;
    margin: 0 -6px;
    padding: 4px 6px;
    border-radius: var(--r-ui);
  }
  .row:hover {
    background: var(--c-surface-2);
  }
  .d {
    min-width: 0;
    color: var(--c-tx);
    font: 12.5px/1.4 var(--font-serif);
  }
  .row:hover .d {
    color: var(--c-tx-hi);
  }
  mark {
    padding: 0 1px;
    background: var(--c-accent-tint);
    border-radius: 1px;
    box-shadow: inset 0 -1px 0 var(--c-accent);
    color: var(--c-tx-hi);
  }
  .keys {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 3px;
    max-width: 250px;
    row-gap: 3px;
  }
  kbd {
    min-width: 19px;
    height: 18px;
    padding: 0 5px;
    color: var(--c-tx-2);
    font: 500 10.5px/15px var(--font-mono);
  }
  .row:hover kbd {
    color: var(--c-tx-hi);
  }
  .g {
    color: var(--c-tx-2);
    font: italic 12px var(--font-serif);
    white-space: nowrap;
  }
  kbd + .g {
    margin-left: 2px;
  }
  .s {
    margin: 0 3px;
    color: var(--c-tx-faint);
    font: 11px var(--font-mono);
  }
  .empty {
    grid-column: 1 / -1;
    padding: 56px 20px;
    text-align: center;
    color: var(--c-tx-2);
  }
  .empty p {
    margin: 0 0 8px;
    font: 14px var(--font-serif);
  }
  .empty b {
    color: var(--c-tx-hi);
  }
  .empty .try {
    color: var(--c-tx-muted);
    font-size: 12.5px;
  }

  /* ---- footer ----------------------------------------------------------------- */
  .foot {
    flex: 0 0 38px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 8px 0 12px;
    background: var(--c-bg-raised);
    border-top: 1px solid var(--c-line);
    color: var(--c-tx-muted);
    font: 11px var(--font-ui);
  }
  .legend {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hints {
    flex: 0 0 auto;
    white-space: nowrap;
  }
  .hints kbd {
    min-width: 16px;
    height: 15px;
    margin-right: 3px;
    padding: 0 4px;
    color: var(--c-tx-muted);
    font: 500 10px/13px var(--font-mono);
  }
  .hints .dot {
    margin: 0 5px;
    color: var(--c-tx-faint);
  }
  .close {
    flex: 0 0 auto;
    height: 24px;
    padding: 0 14px;
    background: transparent;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    color: var(--c-tx);
    font: 12.5px var(--font-serif);
  }
  .close:hover {
    background: var(--c-surface-2);
    border-color: var(--c-tx-muted);
    color: var(--c-tx-hi);
  }

  @media (max-width: 760px) {
    .cols {
      grid-template-columns: minmax(0, 1fr);
      padding: 4px 14px 18px;
    }
    .tabs {
      flex-basis: 124px;
    }
    .legend {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .modal {
      animation: none;
    }
    button,
    .find {
      transition: none;
    }
  }
</style>

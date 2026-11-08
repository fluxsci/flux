<script lang="ts">
  // Manuscript Check (Alt+K) — "is this ready to send?", as a list you can act on.
  //
  // Every rule lives in the shared pure core (lib/manuscript/checks); this pane
  // only gathers the live inputs, shows the findings grouped by pack, jumps to
  // them, and applies a finding's exact fix as ONE undoable transaction (refused
  // when the text moved on since the check). flux-core's `flux check` runs the
  // same core, so the pane and the CLI never disagree.
  //
  // Never on the keystroke path (guide §6): it runs when the pane opens, on the
  // Paper idle mirror (`latestIdle`, ~150 ms after typing settles) and on
  // "Check now" — in a worker (manuscriptCheckService), so even a 20k-line
  // document costs the main thread only the message hand-off.
  import { untrack } from "svelte";
  import type { MarginApi, MarginHost } from "../types";
  import {
    PACK_TITLES,
    CHECK_PACKS,
    checkBibEntries,
    commentInputs,
    type CheckFinding,
    type CheckPackId,
    type CheckResult,
  } from "../../../../../lib/manuscript/checks/index";
  import { lightBibEntries } from "../../../../../lib/references/bibtex";
  import { bibSource } from "../../scholar/bib";
  import { runManuscriptCheck } from "../manuscriptCheckService";

  let { host, margin }: { host: MarginHost; margin: MarginApi } = $props();

  let result = $state<CheckResult | null>(null);
  let checking = $state(false);
  let notice = $state("");
  let generation = 0;

  // The project bibliography, parsed with the SAME parser flux-core uses
  // (lightBibEntries) whenever the raw library.bib is at hand — so the pane and
  // `flux check` read identical entries; the parsed store is the fallback (demo).
  let bibMemo: { text: string; entries: ReturnType<typeof checkBibEntries> } | null = null;
  function bibInput() {
    const src = $bibSource;
    if (src?.text != null) {
      if (bibMemo?.text !== src.text) bibMemo = { text: src.text, entries: checkBibEntries(lightBibEntries(src.text)) };
      return bibMemo.entries;
    }
    return checkBibEntries(host.references);
  }

  function run(text: string): void {
    const mine = ++generation;
    checking = true;
    const input = {
      doc: host.docPath,
      text,
      figures: host.figures.map((f) => ({
        label: f.label,
        family: f.family,
        number: f.number,
        display: f.display,
        caption: f.caption,
        panels: f.panels,
      })),
      bib: bibInput(),
      comments: commentInputs(
        host.commentThreads.filter((t) => !t.draft),
        text,
      ),
    };
    void runManuscriptCheck(input).then((r) => {
      if (mine !== generation) return; // a newer run owns the list
      checking = false;
      if (r) result = r.result;
    });
  }

  // Summon + every idle tick + any input change re-checks; the read set is the
  // idle mirror, the figure model, the bibliography and the comment threads.
  $effect(() => {
    const text = host.latestIdle;
    void host.figures;
    void host.references;
    void host.commentThreads; // never host.comments: its anchor ranges move per keystroke
    void $bibSource;
    untrack(() => run(text));
  });

  function checkNow(): void {
    notice = "";
    run(host.view?.state.doc.toString() ?? host.latest);
  }

  // A pack lists its first PAGE findings; the rest open on request. A 20k-line
  // draft can carry thousands of findings, and rendering them all on every
  // idle tick would put the pane's own paint on the main thread.
  const PAGE = 50;
  let expanded = $state<Partial<Record<CheckPackId, boolean>>>({});

  const groups = $derived.by(() => {
    const by = new Map<CheckPackId, CheckFinding[]>();
    for (const f of result?.findings ?? []) {
      const list = by.get(f.pack) ?? [];
      list.push(f);
      by.set(f.pack, list);
    }
    return CHECK_PACKS.filter((p) => by.has(p)).map((p) => ({ pack: p, findings: by.get(p)! }));
  });

  const summary = $derived.by(() => {
    if (!result) return "";
    const { error, warn, info } = result.counts;
    const parts: string[] = [];
    if (error) parts.push(`${error} error${error === 1 ? "" : "s"}`);
    if (warn) parts.push(`${warn} warning${warn === 1 ? "" : "s"}`);
    if (info) parts.push(`${info} note${info === 1 ? "" : "s"}`);
    return parts.join(" · ");
  });

  function jump(f: CheckFinding): void {
    const v = host.view;
    if (f.from == null || !v) return;
    const max = v.state.doc.length;
    const from = Math.min(f.from, max);
    const to = Math.min(f.to ?? f.from, max);
    v.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    v.focus();
  }

  function applyFix(f: CheckFinding): void {
    const v = host.view;
    if (!v || !f.fix) return;
    const doc = v.state.doc;
    const edits = [...f.fix.edits].sort((a, b) => a.from - b.from);
    if (edits.some((e) => e.to > doc.length || doc.sliceString(e.from, e.to) !== e.expect)) {
      notice = "The text changed since the last check; checked again.";
      checkNow();
      return;
    }
    const caret = edits[0].from + edits[0].insert.length;
    v.dispatch({
      changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
      selection: { anchor: caret },
      scrollIntoView: true,
      userEvent: "input.check-fix",
    });
    notice = "";
    v.focus();
  }
</script>

<div class="mc">
  <div class="mc-head">
    <p class="mc-summary" aria-live="polite">
      {#if !result}Checking…{:else if !result.findings.length}Nothing to fix in this document.{:else}{summary}{/if}
    </p>
    <button class="mc-now" onclick={checkNow} disabled={checking} title="Check the document now">Check now</button>
  </div>
  {#if notice}<p class="mc-notice">{notice}</p>{/if}

  {#each groups as g (g.pack)}
    <section class="mc-pack" data-pack={g.pack}>
      <h4 class="mc-pack-title">{PACK_TITLES[g.pack]} <span class="mc-n">{g.findings.length}</span></h4>
      <ul class="mc-list">
        {#each expanded[g.pack] ? g.findings : g.findings.slice(0, PAGE) as f, i (f.ruleId + ":" + (f.from ?? -1) + ":" + i)}
          <li class="mc-item sev-{f.severity}" data-rule={f.ruleId}>
            <button class="mc-msg" disabled={f.from == null} onclick={() => jump(f)}>
              {#if f.excerpt}<span class="mc-excerpt">{f.excerpt}</span>{/if}
              <span>{f.message}</span>
            </button>
            {#if f.fix}
              <button class="mc-fix" onclick={() => applyFix(f)} title="Apply this exact edit (Ctrl+Z undoes it)">{f.fix.label}</button>
            {/if}
            {#if f.ruleId === "comments.open"}
              <button class="mc-fix" onclick={() => margin.summon("comments")}>Open Comments</button>
            {/if}
          </li>
        {/each}
      </ul>
      {#if g.findings.length > PAGE && !expanded[g.pack]}
        <button class="mc-more" onclick={() => (expanded = { ...expanded, [g.pack]: true })}>
          Show {g.findings.length - PAGE} more
        </button>
      {/if}
    </section>
  {/each}

  <button class="mc-link" onclick={() => margin.summon("journal-check")}>Venue rules: Journal Check (Alt+J)</button>
</div>

<style>
  .mc {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    height: 100%;
    overflow: auto;
    font-size: var(--ts-sm);
  }
  .mc-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .mc-summary,
  .mc-notice {
    flex: 1 1 auto;
    margin: 0;
    color: var(--c-tx-2);
  }
  .mc-notice {
    color: var(--c-accent-bright);
  }
  .mc-now,
  .mc-fix,
  .mc-link {
    flex: none;
    padding: 1px 8px;
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    background: var(--c-surface);
    color: var(--c-tx-2);
    font: inherit;
    font-size: var(--ts-sm);
    cursor: var(--cursor-cross-hover);
  }
  .mc-now:hover:not(:disabled),
  .mc-fix:hover,
  .mc-link:hover {
    color: var(--c-tx-hi);
    border-color: var(--c-line-strong);
  }
  .mc-now:disabled {
    cursor: var(--cursor-cross);
    opacity: 0.6;
  }
  .mc-more {
    margin-top: 4px;
    padding: 0;
    border: none;
    background: none;
    color: var(--c-tx-2);
    font: inherit;
    font-size: var(--ts-sm);
    text-decoration: underline;
    cursor: var(--cursor-cross-hover);
  }
  .mc-more:hover {
    color: var(--c-tx-hi);
  }
  .mc-link {
    align-self: flex-start;
    margin-top: var(--sp-1);
    border-style: dashed;
  }
  .mc-pack-title {
    margin: var(--sp-1) 0 2px;
    font-size: var(--ts-sm);
    font-weight: 600;
    color: var(--c-tx-hi);
  }
  .mc-n {
    font-weight: 400;
    color: var(--c-tx-2);
    font-variant-numeric: tabular-nums;
  }
  .mc-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .mc-item {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 2px var(--sp-2);
    border-left: 2px solid var(--c-line-strong);
    padding-left: var(--sp-2);
  }
  .mc-item.sev-error {
    border-left-color: var(--c-danger);
  }
  .mc-item.sev-warn {
    border-left-color: var(--flx-yellow-600);
  }
  .mc-msg {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1 1 12em;
    min-width: 0;
    text-align: left;
    background: none;
    border: none;
    padding: 2px 0;
    color: var(--c-tx-2);
    font: inherit;
    font-size: var(--ts-sm);
    cursor: var(--cursor-cross-hover);
  }
  .mc-msg:disabled {
    cursor: var(--cursor-cross);
  }
  .mc-msg:hover:not(:disabled) {
    color: var(--c-tx-hi);
  }
  .mc-excerpt {
    font-family: var(--font-mono, monospace);
    color: var(--c-tx-hi);
    overflow-wrap: anywhere;
  }
</style>

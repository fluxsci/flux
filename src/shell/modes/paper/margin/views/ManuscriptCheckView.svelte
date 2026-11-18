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
  // A pack folds away under its heading (a long Abbreviations list should not bury the two
  // errors below it). View state only; a folded pack still counts in the summary.
  let folded = $state<Partial<Record<CheckPackId, boolean>>>({});

  const groups = $derived.by(() => {
    const by = new Map<CheckPackId, CheckFinding[]>();
    for (const f of result?.findings ?? []) {
      const list = by.get(f.pack) ?? [];
      list.push(f);
      by.set(f.pack, list);
    }
    return CHECK_PACKS.filter((p) => by.has(p)).map((p) => ({ pack: p, findings: by.get(p)! }));
  });

  // The summary reads "3 errors · 4 warnings" (one phrase per severity present), each in the
  // colour its findings carry.
  const summary = $derived.by(() => {
    if (!result) return [] as { sev: string; text: string }[];
    const { error, warn, info } = result.counts;
    const parts: { sev: string; text: string }[] = [];
    if (error) parts.push({ sev: "error", text: `${error} error${error === 1 ? "" : "s"}` });
    if (warn) parts.push({ sev: "warn", text: `${warn} warning${warn === 1 ? "" : "s"}` });
    if (info) parts.push({ sev: "info", text: `${info} note${info === 1 ? "" : "s"}` });
    return parts;
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

<div class="mc mk-pane">
  <div class="mc-head mk-row-flex">
    <p class="mc-summary mk-grow" aria-live="polite">
      {#if !result}Checking…{:else if !result.findings.length}Nothing to fix in this document.{:else}{#each summary as part, i (part.sev)}{#if i}{" · "}{/if}<span class="sev-{part.sev}">{part.text}</span>{/each}{/if}
    </p>
    <button class="mc-now mk-btn sm" onclick={checkNow} disabled={checking} title="Check the document now">{checking ? "Checking…" : "Check now"}</button>
  </div>
  {#if notice}<p class="mc-notice">{notice}</p>{/if}

  <div class="mc-packs mk-list">
    {#each groups as g (g.pack)}
      {@const shut = !!folded[g.pack]}
      <section class="mc-pack" data-pack={g.pack}>
        <h4 class="mc-pack-title mk-zone">
          <button class="mc-fold" aria-expanded={!shut} onclick={() => (folded = { ...folded, [g.pack]: !shut })}>
            <svg class="tw" class:open={!shut} viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M2.5 1.2L5.8 4 2.5 6.8" /></svg>
            <span class="mk-eyebrow">{PACK_TITLES[g.pack]}</span>
          </button>
          <span class="mc-n mk-num">{g.findings.length}</span>
        </h4>
        {#if !shut}
          <ul class="mc-list">
            {#each expanded[g.pack] ? g.findings : g.findings.slice(0, PAGE) as f, i (f.ruleId + ":" + (f.from ?? -1) + ":" + i)}
              <li class="mc-item mk-find sev-{f.severity}" data-rule={f.ruleId}>
                <button class="mc-msg mk-find-msg" disabled={f.from == null} onclick={() => jump(f)} title={f.from == null ? undefined : "Go to this place in the manuscript"}>
                  {#if f.excerpt}<span class="mc-excerpt mk-quote">{f.excerpt}</span>{/if}
                  <span>{f.message}</span>
                </button>
                {#if f.fix || f.ruleId === "comments.open"}
                  <div class="mc-actions">
                    {#if f.fix}
                      <button class="mc-fix mk-btn sm" onclick={() => applyFix(f)} title="Apply this exact edit (Ctrl+Z undoes it)">{f.fix.label}</button>
                    {/if}
                    {#if f.ruleId === "comments.open"}
                      <button class="mc-fix mk-btn sm" onclick={() => margin.summon("comments")}>Open Comments</button>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
          {#if g.findings.length > PAGE && !expanded[g.pack]}
            <button class="mc-more" onclick={() => (expanded = { ...expanded, [g.pack]: true })}>
              Show {g.findings.length - PAGE} more
            </button>
          {/if}
        {/if}
      </section>
    {/each}
  </div>

  <button class="mc-link mk-btn sm quiet" onclick={() => margin.summon("journal-check")}>Venue rules: Journal Check<kbd>Alt J</kbd></button>
</div>

<style>
  .mc-head {
    flex: 0 0 auto;
  }
  .mc-summary {
    margin: 0;
    font-size: var(--ts-sm);
    color: var(--c-tx);
  }
  .mc-summary .sev-error {
    color: var(--c-danger);
    font-weight: 600;
  }
  .mc-summary .sev-warn {
    color: var(--c-warning);
    font-weight: 600;
  }
  .mc-notice {
    flex: 0 0 auto;
    margin: 0;
    padding: 5px 9px;
    border-radius: var(--r-1);
    background: var(--mk-tint);
    color: var(--c-tx-2);
    font-size: var(--ts-xs);
  }
  .mc-packs:empty {
    display: none;
  }
  .mc-pack-title {
    margin: 0;
    padding: 0 10px 0 4px;
  }
  .mc-fold {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    height: 100%;
    padding: 0 0 0 4px;
    border: 0;
    background: none;
    text-align: left;
    cursor: var(--cursor-cross-hover);
  }
  .mc-fold:focus-visible {
    outline: 2px solid var(--pane-c);
    outline-offset: -2px;
  }
  .tw {
    flex: 0 0 auto;
    fill: none;
    stroke: var(--c-tx-faint);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 80ms linear;
  }
  .tw.open {
    transform: rotate(90deg);
  }
  .mc-fold:hover .tw {
    stroke: var(--pane-c);
  }
  .mc-fold:hover :global(.mk-eyebrow) {
    color: var(--c-tx);
  }
  .mc-n {
    color: var(--c-tx-muted);
    font-size: calc(10.5px * var(--ts-scale, 1));
  }
  .mc-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .mc-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .mc-more {
    display: block;
    width: 100%;
    height: calc(28px * var(--ts-scale, 1));
    border: 0;
    border-bottom: 1px solid var(--c-line);
    background: none;
    color: var(--pane-c);
    font: var(--ts-xs) var(--font-serif);
    cursor: var(--cursor-cross-hover);
    transition: background 80ms linear;
  }
  .mc-more:hover {
    background: var(--mk-tint);
  }
  .mc-link {
    flex: 0 0 auto;
    align-self: flex-start;
  }
</style>

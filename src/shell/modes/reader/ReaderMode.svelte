<script lang="ts">
  // FluxReader — the PDF reading mode. Loads the paper named by readerKey from
  // ~/FluxLib/items/<citekey>/ (PDF bytes + annotations) and renders it with PdfView,
  // flanked by a reference sidebar (the paper's OpenAlex referenced_works → add to
  // FluxLib) and an annotations panel (this paper's highlights → click to scroll,
  // delete). Highlights persist to items/<citekey>/annotations.json.
  import { onDestroy } from "svelte";
  import { readerKey } from "./readerStore";
  import { readerPdfBytes, writeReaderContext, clearReaderContext } from "../../../lib/references/itemsBridge";
  import { loadAnnotations, addAnnotation, deleteAnnotation } from "../../../lib/references/annotationsBridge";
  import { loadFluxLib } from "../../../lib/references/fluxlibBridge";
  import { referencedWorksByKey } from "../../../lib/references/enrichBridge";
  import { addDoiToLibrary } from "../paper/scholar/bibLoad";
  import { bareDoi } from "../../../lib/references/pdfFinder";
  import type { WorldBrief } from "../../../lib/references/openalex";
  import type { RefEntry } from "../../../lib/references/types";
  import type { Annotation, TextQuoteSelector } from "../../../lib/references/annotations";
  import type { ReaderContext } from "../../../lib/references/items";
  import PdfView from "./PdfView.svelte";
  import AgentDrawer from "./AgentDrawer.svelte";

  let { focused = true }: { focused?: boolean } = $props();

  let buffer = $state<ArrayBuffer | null>(null);
  let annotations = $state<Annotation[]>([]);
  let loading = $state(false);
  let curKey = $state<string | null>(null);
  let entry = $state<RefEntry | null>(null);
  let libDois = $state<Set<string>>(new Set());

  // Reference sidebar (the paper's referenced_works).
  let refs = $state<WorldBrief[]>([]);
  let refsState = $state<"idle" | "loading" | "done" | "error">("idle");
  let addingId = $state("");

  // Sidebar visibility + a scroll signal for the PDF (click an annotation → scroll).
  let showRefs = $state(true);
  let showAnnots = $state(true);
  let scrollTo = $state<{ id?: string; page?: number; nonce: number } | null>(null);
  let nonce = 0;

  // Agent drawer (Claude Code) + the human's live text selection (pushed to the agent).
  let agentOpen = $state(false);
  let selection = $state("");
  let selPage = $state<number | undefined>(undefined);
  let ctxTimer: ReturnType<typeof setTimeout> | undefined;

  const HL: Record<string, string> = {
    yellow: "rgba(255,221,51,0.75)",
    green: "rgba(94,189,108,0.7)",
    blue: "rgba(67,133,190,0.65)",
    pink: "rgba(225,90,140,0.65)",
    orange: "rgba(218,160,23,0.7)",
  };

  $effect(() => {
    const key = $readerKey;
    if (key === curKey) return;
    curKey = key;
    buffer = null;
    annotations = [];
    entry = null;
    refs = [];
    refsState = "idle";
    if (!key) return;
    loading = true;
    void Promise.all([readerPdfBytes(key), loadAnnotations(key), loadFluxLib()]).then(([b, af, lib]) => {
      if (curKey !== key) return;
      buffer = b;
      annotations = af.annotations;
      entry = lib.find((e) => e.key === key) ?? null;
      libDois = new Set(lib.map((e) => bareDoi(e.doi)).filter((d): d is string => !!d));
      loading = false;
    });
    // Reference list loads independently (network; needs the paper hydrated).
    refsState = "loading";
    void referencedWorksByKey(key).then((r) => {
      if (curKey !== key) return;
      refs = r;
      refsState = "done";
    }).catch(() => {
      if (curKey === key) refsState = "error";
    });
  });

  async function handleCreate(a: { page: number; anchor: TextQuoteSelector; color: string }) {
    const key = $readerKey;
    if (!key) return;
    const ann = await addAnnotation(key, { page: a.page, anchor: a.anchor, color: a.color });
    annotations = [...annotations, ann];
  }
  async function handleDelete(id: string) {
    const key = $readerKey;
    if (!key) return;
    await deleteAnnotation(key, id);
    annotations = annotations.filter((a) => a.id !== id);
  }
  function jumpTo(a: Annotation) {
    scrollTo = { id: a.id, page: a.page, nonce: ++nonce };
  }
  async function addRef(b: WorldBrief) {
    if (!b.doi || addingId) return;
    addingId = b.openalexId;
    try {
      const r = await addDoiToLibrary(b.doi);
      if (!("error" in r)) libDois = new Set(libDois).add(bareDoi(b.doi)!);
    } finally {
      addingId = "";
    }
  }

  const inLib = (b: WorldBrief) => !!(b.doi && libDois.has(bareDoi(b.doi)!));
  const title = $derived(entry?.title ?? $readerKey ?? "");
  // Annotations in reading order (page, then first-seen).
  const orderedAnns = $derived([...annotations].sort((a, b) => a.page - b.page));

  function handleSelect(text: string, page?: number) {
    selection = text;
    if (page != null) selPage = page;
  }

  // Push the live reading context to ~/FluxLib/.fluxlib/reader-context.json (debounced)
  // so the agent's get_reading_context tool can see the paper + selection + highlights.
  $effect(() => {
    const key = $readerKey;
    const sel = selection;
    const e = entry;
    const anns = annotations;
    if (!key || !buffer) return;
    clearTimeout(ctxTimer);
    const ctx: ReaderContext = {
      citekey: key,
      title: e?.title,
      authors: e?.authors,
      year: e?.year,
      doi: e?.doi,
      page: selPage,
      selection: sel || undefined,
      annotations: anns.map((a) => ({ page: a.page, color: a.color, quote: a.anchor.quote, note: a.note })),
      updatedAt: new Date().toISOString(),
    };
    ctxTimer = setTimeout(() => void writeReaderContext(ctx), 250);
  });

  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) {
      e.preventDefault();
      agentOpen = !agentOpen;
    } else if (e.key === "Escape" && agentOpen) {
      agentOpen = false;
    }
  }

  onDestroy(() => {
    clearTimeout(ctxTimer);
    void clearReaderContext();
  });
</script>

<svelte:window onkeydown={onKey} />

<div class="reader">
  {#if !$readerKey}
    <div class="empty">
      <span class="h">FluxReader</span>
      <span>Open a paper from the Library (the “Read” action) to start reading.</span>
    </div>
  {:else if loading}
    <div class="empty">Loading “{$readerKey}”…</div>
  {:else if !buffer}
    <div class="empty">
      No PDF on disk for “{$readerKey}”. Use <strong>Get PDF</strong> in the Library to fetch it first.
    </div>
  {:else}
    <div class="chrome">
      <div class="rtoolbar">
        <button class="tgl" class:on={showRefs} onclick={() => (showRefs = !showRefs)} title="Toggle references"
          >☰ References{refs.length ? ` (${refs.length})` : ""}</button>
        <span class="rtitle" title={title}>{title}</span>
        <button class="tgl" class:on={showAnnots} onclick={() => (showAnnots = !showAnnots)} title="Toggle annotations"
          >Notes ({annotations.length}) ✎</button>
        <button class="tgl agentbtn" class:on={agentOpen} onclick={() => (agentOpen = !agentOpen)}
          title="Ask Claude Code about this paper — it sees your selection + highlights (⌘/Ctrl-J)">✦ Ask Claude</button>
      </div>
      <div class="rbody">
        {#if showRefs}
          <aside class="side refs">
            <div class="shead">References</div>
            {#if refsState === "loading"}
              <div class="smsg">Loading references…</div>
            {:else if refsState === "error"}
              <div class="smsg">Couldn’t load references.</div>
            {:else if refs.length === 0}
              <div class="smsg">No reference list — <em>Enrich</em> this paper in the Library to fetch its
                <code>referenced_works</code>.</div>
            {:else}
              <ul class="reflist">
                {#each refs as b (b.openalexId)}
                  <li class="ref">
                    <div class="rmeta">
                      <span class="rauth">{b.authors.slice(0, 2).join(", ")}{b.authors.length > 2 ? " et al." : ""}{b.year ? ` · ${b.year}` : ""}</span>
                      {#if b.citedByCount != null}<span class="rcite">{b.citedByCount.toLocaleString()}×</span>{/if}
                    </div>
                    <div class="rtitle2" title={b.title}>{b.title}</div>
                    <div class="ractions">
                      {#if inLib(b)}
                        <span class="inlib">✓ in library</span>
                      {:else if b.doi}
                        <button class="addbtn" disabled={addingId === b.openalexId} onclick={() => addRef(b)}
                          >{addingId === b.openalexId ? "Adding…" : "+ FluxLib"}</button>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </aside>
        {/if}

        <div class="pdfwrap">
          <div class="pdfarea">
            {#key $readerKey}
              <PdfView {buffer} documentId={$readerKey} {annotations} {scrollTo} onCreate={handleCreate} onSelect={handleSelect} />
            {/key}
          </div>
          {#if agentOpen}
            <div class="agentpane">
              <AgentDrawer onClose={() => (agentOpen = false)} />
            </div>
          {/if}
        </div>

        {#if showAnnots}
          <aside class="side annots">
            <div class="shead">Annotations</div>
            {#if orderedAnns.length === 0}
              <div class="smsg">Select text in the PDF and pick a colour to add a highlight.</div>
            {:else}
              <ul class="annlist">
                {#each orderedAnns as a (a.id)}
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                  <li class="ann" onclick={() => jumpTo(a)}>
                    <span class="swatch" style:background={HL[a.color] ?? HL.yellow}></span>
                    <span class="aquote" title={a.anchor.quote}>{a.anchor.quote}</span>
                    <span class="apage">p{a.page}</span>
                    <button class="del" title="Delete highlight" aria-label="Delete highlight"
                      onclick={(e) => { e.stopPropagation(); handleDelete(a.id); }}>×</button>
                  </li>
                {/each}
              </ul>
            {/if}
          </aside>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .reader {
    position: absolute;
    inset: 0;
    background: var(--c-bg);
  }
  .chrome {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }
  .rtoolbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 6px 10px;
    border-bottom: 1px solid var(--c-line);
    background: var(--c-surface);
  }
  .rtitle {
    flex: 1 1 auto;
    text-align: center;
    font-family: var(--font-serif);
    font-size: var(--ts-sm);
    color: var(--c-tx-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tgl {
    flex: 0 0 auto;
    border: 1px solid var(--c-line-strong);
    background: transparent;
    color: var(--c-tx-2);
    border-radius: var(--r-1);
    padding: 3px 9px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
    white-space: nowrap;
  }
  .tgl.on {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .rbody {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .side {
    flex: 0 0 268px;
    width: 268px;
    overflow: auto;
    background: var(--c-surface);
    display: flex;
    flex-direction: column;
  }
  .side.refs {
    border-right: 1px solid var(--c-line);
  }
  .side.annots {
    border-left: 1px solid var(--c-line);
  }
  .shead {
    position: sticky;
    top: 0;
    padding: 8px 12px;
    font-size: var(--ts-xs);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--c-tx-faint);
    background: var(--c-surface);
    border-bottom: 1px solid var(--c-line);
  }
  .smsg {
    padding: 12px;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-style: italic;
    line-height: 1.5;
  }
  .pdfwrap {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .pdfarea {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }
  .agentpane {
    position: relative;
    flex: 0 0 42%;
    min-height: 140px;
    border-top: 1px solid var(--c-line-strong);
  }
  .agentbtn.on {
    border-color: var(--c-accent);
    background: var(--c-accent-tint);
    color: var(--c-accent);
  }
  .reflist,
  .annlist {
    list-style: none;
    margin: 0;
    padding: 4px 0;
  }
  .ref {
    padding: 8px 12px;
    border-bottom: 1px solid var(--c-line);
  }
  .rmeta {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .rtitle2 {
    font-size: var(--ts-sm);
    color: var(--c-tx-1);
    margin: 2px 0 5px;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .addbtn {
    border: 1px solid var(--c-accent);
    background: var(--c-accent-tint);
    color: var(--c-accent);
    border-radius: var(--r-1);
    padding: 2px 8px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
  }
  .addbtn:hover:not(:disabled) {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .inlib {
    font-size: var(--ts-xs);
    color: var(--c-accent);
  }
  .ann {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--c-line);
    cursor: pointer;
  }
  .ann:hover {
    background: var(--c-bg);
  }
  .swatch {
    flex: 0 0 auto;
    width: 9px;
    height: 9px;
    border-radius: 2px;
    align-self: center;
  }
  .aquote {
    flex: 1 1 auto;
    font-size: var(--ts-xs);
    color: var(--c-tx-1);
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .apage {
    flex: 0 0 auto;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .del {
    flex: 0 0 auto;
    border: none;
    background: none;
    color: var(--c-tx-faint);
    cursor: pointer;
    font-size: var(--ts-md);
    line-height: 1;
    padding: 0 2px;
  }
  .del:hover {
    color: var(--c-danger);
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    height: 100%;
    align-items: center;
    justify-content: center;
    color: var(--c-tx-faint);
    font-style: italic;
    font-size: var(--ts-sm);
    text-align: center;
    padding: var(--sp-5);
  }
  .empty .h {
    font-family: var(--font-serif);
    font-size: var(--ts-lg);
    color: var(--c-tx-2);
    font-style: italic;
  }
</style>

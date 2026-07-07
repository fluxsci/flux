<script lang="ts">
  // 2.4 Bulk import — a modal that ingests a .bib or .ris file into FluxLib. RIS is
  // normalized to BibTeX up front (shared ris.ts), a dedupe PREVIEW is computed from the
  // SAME planner the commit uses (addPlan.ts — so "N new · M merged" can't lie), and with
  // the user's opt-in it pulls the PDFs named in each entry's Better-BibTeX `file` field
  // (Zotero export) into items/<key>/, text-extracted for full-text search (2.3).
  import { fileBridge, joinPath } from "../../../lib/project/types";
  import { sniffFormat, risToBibtex } from "../../../lib/references/ris";
  import { planAdds, type AddPlan } from "../../../lib/references/addPlan";
  import { bibPdfAttachments } from "../../../lib/references/zoteroFiles";
  import { readLibraryBibText, addToFluxLib } from "../../../lib/references/fluxlibBridge";
  import { writePdfItem } from "../../../lib/references/itemsBridge";
  import { hydrateFluxLib } from "../../../lib/references/enrichBridge";
  import type { RefEntry } from "../../../lib/references/types";
  import { pushToast } from "../../../lib/toast";

  let {
    onClose,
    onImported,
    onEnrich,
  }: { onClose: () => void; onImported: (keys: string[]) => void; onEnrich?: () => void } = $props();

  let cardEl = $state<HTMLElement | null>(null);
  // Restore focus to whatever opened the dialog when it closes.
  const prevFocus = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
  function close() {
    prevFocus?.focus?.();
    onClose();
  }

  type Phase = "pick" | "preview" | "importing" | "done" | "error";
  let phase = $state<Phase>("pick");
  let error = $state("");
  let fileName = $state("");
  let format = $state<"bibtex" | "ris" | "unknown">("unknown");
  let bib = $state(""); // the normalized BibTeX (RIS already converted)
  let baseDir = $state(""); // the picked file's folder (for relative PDF paths)
  let plan = $state<AddPlan | null>(null);
  let pdfEntries = $state<RefEntry[]>([]); // planned-new entries that declare a PDF
  let attach = $state(true);
  let zoteroDir = $state("");

  // Progress (attach phase).
  let attachTotal = $state(0);
  let attachDone = $state(0);
  let attached = $state(0);
  let attachFailed = $state(0);
  let cancelled = $state(false);
  let importedKeys = $state<string[]>([]);

  const isAbsolute = (p: string) => /^([A-Za-z]:[\\/]|[\\/]|\\\\)/.test(p);

  async function pickFile() {
    const fb = fileBridge() as (ReturnType<typeof fileBridge> & { __importText?: string }) | null;
    // DEV/test seam: a headless harness injects text instead of driving a native dialog.
    const injected = import.meta.env?.DEV ? (window as unknown as { __fluxImportText?: { name: string; text: string } }).__fluxImportText : undefined;
    let text: string;
    if (injected) {
      fileName = injected.name;
      baseDir = "";
      text = injected.text;
    } else {
      if (!fb?.openFiles) {
        error = "File import needs the desktop app.";
        phase = "error";
        return;
      }
      const paths = await fb.openFiles([{ name: "References", extensions: ["bib", "ris", "txt"] }]);
      if (!paths?.length) {
        close();
        return;
      }
      const p = paths[0];
      fileName = p.split(/[\\/]/).pop() || p;
      baseDir = p.slice(0, p.length - fileName.length).replace(/[\\/]$/, "");
      try {
        text = await fb.readText(p);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        phase = "error";
        return;
      }
    }
    format = sniffFormat(text);
    if (format === "unknown") {
      error = "That file doesn't look like BibTeX or RIS.";
      phase = "error";
      return;
    }
    bib = format === "ris" ? risToBibtex(text) : text;
    const cur = await readLibraryBibText();
    plan = planAdds(cur, bib, "bibtex");
    pdfEntries = plan.added.filter((e) => e.raw && bibPdfAttachments(e.raw).length > 0);
    attach = pdfEntries.length > 0;
    if (!plan.counts.total) {
      error = "No references found in that file.";
      phase = "error";
      return;
    }
    phase = "preview";
  }

  async function chooseZoteroDir() {
    const fb = fileBridge();
    if (!fb?.openDirectory) return;
    const dir = await fb.openDirectory("Locate your Zotero folder (its 'storage' lives here)");
    if (dir) zoteroDir = dir;
  }

  async function resolveAndRead(p: string): Promise<Uint8Array | null> {
    const fb = fileBridge();
    if (!fb) return null;
    const candidates: string[] = [];
    if (isAbsolute(p)) candidates.push(p);
    else {
      if (baseDir) candidates.push(joinPath(baseDir, p));
      if (zoteroDir) {
        candidates.push(joinPath(zoteroDir, p));
        candidates.push(joinPath(zoteroDir, "storage", p));
      }
    }
    for (const c of candidates) {
      try {
        const buf = await fb.readFile(c);
        return new Uint8Array(buf);
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  }

  async function doImport() {
    if (!plan) return;
    phase = "importing";
    cancelled = false;
    // Metadata add first — one atomic write, one revision bump (re-plans under the lock).
    let addedEntries: RefEntry[] = [];
    try {
      const res = await addToFluxLib(bib, { source: "bibtex" });
      addedEntries = res.added;
      importedKeys = res.keys;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      phase = "error";
      return;
    }
    // Attach PDFs (opt-in). Slow (copy + text-extract each) → progress + cancel.
    if (attach) {
      const withPdf = addedEntries.filter((e) => e.raw && bibPdfAttachments(e.raw).length > 0);
      attachTotal = withPdf.length;
      attachDone = 0;
      attached = 0;
      attachFailed = 0;
      for (const e of withPdf) {
        if (cancelled) break;
        const att = bibPdfAttachments(e.raw ?? "")[0];
        const bytes = att ? await resolveAndRead(att.path) : null;
        if (bytes) {
          try {
            await writePdfItem(e.key, bytes, { source: "ingest", url: att.path });
            attached++;
          } catch {
            attachFailed++;
          }
        } else {
          attachFailed++;
        }
        attachDone++;
      }
    }
    onImported(importedKeys);
    phase = "done";
  }

  function hydrateNow() {
    // Delegate to the Library's own Enrich pipeline (its progress bar + concurrency
    // guard) when available; otherwise run a background hydrate. Either way, close
    // immediately instead of blocking the dialog on the whole (minutes-long) run.
    if (onEnrich) {
      onEnrich();
    } else {
      pushToast("info", "Enriching the imported references…");
      void hydrateFluxLib({})
        .then(() => pushToast("success", "Enrichment finished."))
        .catch((e) => pushToast("error", "Enrichment failed.", { detail: e instanceof Error ? e.message : String(e) }));
    }
    close();
  }

  // Kick off the file picker as soon as the modal mounts.
  void pickFile();

  // Move focus into the dialog when a keyboard-interactive phase renders, so Tab and
  // Enter act on the modal rather than the toolbar behind the backdrop.
  $effect(() => {
    if ((phase === "preview" || phase === "done" || phase === "error") && cardEl) {
      queueMicrotask(() => cardEl?.querySelector<HTMLButtonElement>(".if .prim, .if button")?.focus());
    }
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && phase !== "importing") {
      e.stopPropagation();
      close();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={() => phase !== "importing" && close()}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="card" role="dialog" aria-modal="true" aria-label="Import references" tabindex="-1" bind:this={cardEl} onclick={(e) => e.stopPropagation()}>
    <header class="ih">
      <span class="ihh">Import references</span>
      {#if fileName}<span class="ihf">{fileName} · {format.toUpperCase()}</span>{/if}
    </header>

    {#if phase === "pick"}
      <div class="body"><p class="muted">Choose a .bib or .ris file…</p></div>
    {:else if phase === "error"}
      <div class="body"><p class="err">{error}</p></div>
      <footer class="if"><button class="prim" onclick={close}>Close</button></footer>
    {:else if phase === "preview" && plan}
      <div class="body">
        <div class="counts">
          <span class="pill new">{plan.counts.new} new</span>
          {#if plan.counts.merged}<span class="pill merged">{plan.counts.merged} already in library</span>{/if}
          {#if plan.counts.renamed}<span class="pill renamed">{plan.counts.renamed} re-keyed</span>{/if}
          {#if pdfEntries.length}<span class="pill pdf">{pdfEntries.length} with PDFs</span>{/if}
        </div>
        <ul class="rows">
          {#each plan.planned.slice(0, 200) as p}
            <li class:merged={p.action === "merged"}>
              <span class="ra ra-{p.action}">{p.action === "merged" ? "merged" : p.renamed ? "re-keyed" : "new"}</span>
              <span class="rk">@{p.key}</span>
              <span class="rt">{p.entry.title || "(untitled)"}</span>
            </li>
          {/each}
        </ul>
        {#if plan.planned.length > 200}<p class="muted">…and {plan.planned.length - 200} more.</p>{/if}
        {#if pdfEntries.length}
          <label class="opt">
            <input type="checkbox" bind:checked={attach} />
            Attach {pdfEntries.length} PDF{pdfEntries.length === 1 ? "" : "s"} from the file's <code>file</code> fields (Zotero export)
          </label>
          {#if attach}
            <div class="zrow">
              <button class="ghost" onclick={chooseZoteroDir}>Choose Zotero folder…</button>
              <span class="ztxt">{zoteroDir || "for attachments stored relative to Zotero (absolute paths import without this)"}</span>
            </div>
          {/if}
        {/if}
      </div>
      <footer class="if">
        <button class="ghost" onclick={close}>Cancel</button>
        <button class="prim" disabled={!plan.counts.new} onclick={doImport}>
          Import {plan.counts.new} reference{plan.counts.new === 1 ? "" : "s"}
        </button>
      </footer>
    {:else if phase === "importing"}
      <div class="body">
        <p>Importing {importedKeys.length || plan?.counts.new || ""} references…</p>
        {#if attach && attachTotal}
          <div class="prog"><div class="bar" style="width:{Math.round((attachDone / attachTotal) * 100)}%"></div></div>
          <p class="muted">Attaching PDFs {attachDone}/{attachTotal} · {attached} attached{attachFailed ? ` · ${attachFailed} not found` : ""}</p>
        {/if}
      </div>
      {#if attach && attachTotal}
        <footer class="if"><button class="ghost" onclick={() => (cancelled = true)}>Stop attaching</button></footer>
      {/if}
    {:else if phase === "done"}
      <div class="body">
        <p class="ok">Imported {importedKeys.length} reference{importedKeys.length === 1 ? "" : "s"}.</p>
        {#if attach && attachTotal}
          <p class="muted">{attached} PDF{attached === 1 ? "" : "s"} attached{attachFailed ? ` · ${attachFailed} couldn't be located` : ""}{cancelled ? " · stopped early" : ""}.</p>
        {/if}
      </div>
      <footer class="if">
        <button class="ghost" onclick={close}>Close</button>
        <button class="prim" onclick={hydrateNow}>Enrich them now</button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--c-bg) 70%, transparent);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .card {
    width: min(640px, 92vw);
    max-height: 84vh;
    display: flex;
    flex-direction: column;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2, 10px);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.4);
    overflow: hidden;
  }
  .ih {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--c-line);
  }
  .ihh {
    font-weight: 600;
    color: var(--c-tx);
  }
  .ihf {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .body {
    padding: 14px 16px;
    overflow: auto;
  }
  .muted {
    color: var(--c-tx-muted);
    font-size: var(--ts-sm);
  }
  .err {
    color: var(--c-danger, #c0392b);
  }
  .ok {
    color: var(--c-tx);
    font-weight: 600;
  }
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }
  .pill {
    font-size: var(--ts-xs);
    padding: 2px 10px;
    border-radius: var(--r-pill);
    border: 1px solid var(--c-line);
    color: var(--c-tx-2);
  }
  .pill.new {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .pill.pdf {
    border-style: dashed;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    max-height: 34vh;
    overflow: auto;
  }
  .rows li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--c-line);
    font-size: var(--ts-sm);
  }
  .rows li:last-child {
    border-bottom: none;
  }
  .rows li.merged {
    opacity: 0.6;
  }
  .ra {
    flex: none;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 6px;
    border-radius: var(--r-pill);
    border: 1px solid var(--c-line);
    color: var(--c-tx-faint);
    min-width: 4.4em;
    text-align: center;
  }
  .ra-new {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .rk {
    flex: none;
    font-family: var(--font-mono, monospace);
    color: var(--c-tx-2);
  }
  .rt {
    color: var(--c-tx-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
  }
  .opt code {
    font-size: var(--ts-xs);
    background: var(--c-bg);
    padding: 0 4px;
    border-radius: 3px;
  }
  .zrow {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
  }
  .ztxt {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .prog {
    height: 6px;
    background: var(--c-bg);
    border-radius: 3px;
    overflow: hidden;
    margin: 10px 0 6px;
  }
  .bar {
    height: 100%;
    background: var(--c-accent);
    transition: width 0.15s;
  }
  .if {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--c-line);
  }
  .if button {
    padding: 6px 14px;
    border-radius: var(--r-1);
    border: 1px solid var(--c-line-strong);
    font-size: var(--ts-sm);
    cursor: pointer;
  }
  .ghost {
    background: var(--c-bg);
    color: var(--c-tx-2);
  }
  .prim {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-bg);
  }
  .prim:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>

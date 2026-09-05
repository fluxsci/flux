<script lang="ts">
  import { tick } from "svelte";
  import { project, figureCatalog, activeFigureId, activeCanvasId, embeddedProjectRoot, commit, globalRev } from "./store";
  import { figureTitle } from "./project/figureIdentity";
  import { familyById, familyRank, formatFamilyRef } from "./figfamily";
  import { figureReferenceConflicts } from "./figureReferences";
  import { panelLetters, composeCaption } from "./captions";
  import { buildFigureSvg } from "./io";
  import { sourceDetails, sourceStatuses, syncProjectSources, setFigureSourceLink } from "./project/sourceBridge";
  import type { SourceStatus } from "./plot/sourceSync";
  import { withLiveFigureUsages } from "./project/liveFigureUsages";
  import { readProjectDependencies, type ProjectDependencies, type ProjectUsage } from "./project/dependencies";
  import { fileBridge, joinPath } from "./project/types";
  import { centerOnFigure } from "./viewportNav";
  import { pushToast } from "./toast";
  import { figRevision } from "../shell/scholar/revisions";
  import { setFocusedMode } from "../shell/paneStore";
  import { requestOpenDoc, requestOpenSlide } from "../shell/command/commandBus";
  import * as ops from "./ops";
  import VirtualFixedList from "./ui/VirtualFixedList.svelte";
  import type { Figure } from "./types";

  let query = $state("");
  let pickedId = $state<string | null>(null);
  let section = $state<"details" | "numbering">("details");
  let searchEl = $state<HTMLInputElement>();
  let inspectedSources = $state<SourceStatus[]>([]);
  let dependencies = $state<ProjectDependencies | null>(null);
  let error = $state("");
  let working = $state(false);
  let preview = $state("");
  const work = { generation: 0, preview: 0, opened: false };

  const ordered = $derived([...$project.figures].sort((a, b) =>
    familyRank(a.family ?? "figure", $project.figureFamilies) - familyRank(b.family ?? "figure", $project.figureFamilies) || (a.number ?? 0) - (b.number ?? 0)));
  const filtered = $derived(ordered.filter((f) => `${figureTitle(f)} ${f.name} ${f.referenceKey ?? ""} ${canvasName(f)}`.toLowerCase().includes(query.trim().toLowerCase())));
  const picked = $derived.by(() => {
    void $globalRev;
    const f = $project.figures.find((f) => f.id === pickedId) ?? filtered[0];
    return f ? { ...f } : null;
  });
  const statuses = $derived.by(() => {
    if (!picked) return [];
    const ids = new Set(picked.elements.filter((e) => e.type === "plot").map((e) => e.assetId));
    return inspectedSources.filter((s) => ids.has(s.assetId)).map((s) => $sourceStatuses[s.assetId] ?? s);
  });
  const usages = $derived([...new Map((picked ? dependencies?.byFigure[picked.id] ?? [] : []).map((u) => [`${u.kind}:${u.path}:${u.slideId ?? ""}`, u])).values()]);
  const conflicts = $derived(figureReferenceConflicts($project.figures.map((f) => ({ label: f.referenceKey ?? "", panels: panelLetters(f) }))));
  const selectedConflicts = $derived(conflicts.filter((c) => c.label === picked?.referenceKey || c.otherLabel === picked?.referenceKey));
  const familyMembers = $derived(picked ? ordered.filter((f) => f.family === picked.family) : []);

  $effect(() => {
    const open = $figureCatalog;
    if (!open) { work.opened = false; work.generation++; work.preview++; return; }
    if (!work.opened) {
      work.opened = true;
      query = "";
      pickedId = open.figureId ?? $activeFigureId;
      section = open.section ?? "details";
      void tick().then(() => searchEl?.focus());
    }
  });
  $effect(() => {
    if (!$figureCatalog) return;
    void $figRevision;
    void inspect($embeddedProjectRoot);
  });
  $effect(() => {
    if (!$figureCatalog) return;
    void $globalRev;
    const f = picked;
    const generation = ++work.preview;
    preview = "";
    if (!f) return;
    // Let selection paint first; preview construction is a navigation workload.
    const timer = setTimeout(() => {
      if (generation !== work.preview) return;
      try { preview = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildFigureSvg(f))}`; }
      catch { preview = ""; }
    }, 0);
    return () => clearTimeout(timer);
  });

  function canvasName(f: Figure) { return $project.canvases.find((c) => c.id === f.canvasId)?.name ?? f.canvasId; }
  function designation(f: Figure) { return formatFamilyRef(familyById(f.family, $project.figureFamilies), f.number ?? 1); }
  function close() { figureCatalog.set(null); }
  async function inspect(root: string | null) {
    const generation = ++work.generation;
    if (!root || !fileBridge()) { dependencies = null; inspectedSources = []; return; }
    error = "";
    const results = await Promise.allSettled([sourceDetails(root), readProjectDependencies(root, fileBridge()!)]);
    if (generation !== work.generation) return;
    if (results[0].status === "fulfilled") inspectedSources = results[0].value;
    else error = String(results[0].reason?.message ?? results[0].reason);
    if (results[1].status === "fulfilled") dependencies = withLiveFigureUsages(results[1].value, root, $project.figures);
    else error = String(results[1].reason?.message ?? results[1].reason);
  }
  async function run(action: () => Promise<unknown>) {
    if (working) return;
    working = true; error = "";
    try { await action(); await inspect($embeddedProjectRoot); }
    catch (e) { error = (e as Error).message; }
    finally { working = false; }
  }
  async function copyKey() {
    if (!picked?.referenceKey) return;
    try { await navigator.clipboard.writeText(`@${picked.referenceKey}`); pushToast("success", "Figure reference copied"); }
    catch { error = "Select and copy the reference key below."; }
  }
  function viewFigure() {
    if (!picked) return;
    activeCanvasId.set(picked.canvasId); activeFigureId.set(picked.id);
    centerOnFigure(picked.id); close();
  }
  function moveNumber(delta: number) {
    if (!picked) return;
    const id = picked.id, number = (picked.number ?? 1) + delta;
    if (number < 1 || number > familyMembers.length) return;
    commit((p) => ops.setFigureIdentity(p, id, { number }));
  }
  async function relink(assetId: string) {
    const root = $embeddedProjectRoot, figureId = picked?.id;
    if (!root || !figureId) return;
    const paths = await fileBridge()?.openFiles([{ name: "SVG source", extensions: ["svg"] }]);
    if (paths?.[0]) await run(() => setFigureSourceLink(root, { figureId, assetId, svgPath: paths[0] }));
  }
  function freeze(assetId: string, frozen: boolean) {
    const root = $embeddedProjectRoot, figureId = picked?.id;
    if (root && figureId) void run(() => setFigureSourceLink(root, { figureId, assetId, frozen }));
  }
  function openUsage(use: ProjectUsage) {
    close();
    if (use.kind === "manuscript") { requestOpenDoc(use.path); setFocusedMode("paper"); }
    else if (use.kind === "slide" && use.deckId) { requestOpenSlide(use.deckId, use.slideId); setFocusedMode("slide"); }
  }
  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (section === "numbering" && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); moveNumber(e.key === "ArrowUp" ? -1 : 1); }
  }
</script>

{#if $figureCatalog}
  <div class="catalog-scrim">
    <button class="backdrop" aria-label="Close figure catalog" onclick={close}></button>
    <div class="catalog" role="dialog" aria-modal="true" aria-label="Project figures" tabindex="-1" onkeydown={onKey}>
      <header><div><h2>Project figures</h2><p>One figure, wherever you reference it.</p></div><button class="close" onclick={close} aria-label="Close">✕</button></header>
      <div class="catalog-body">
        <aside>
          <input class="search" bind:this={searchEl} bind:value={query} aria-label="Search project figures" placeholder="Title, number, reference, canvas…" />
          <nav aria-label="Figure catalog view"><button class:on={section === "details"} onclick={() => section = "details"}>Figures</button><button class:on={section === "numbering"} onclick={() => section = "numbering"}>Numbering</button></nav>
          <div class="figure-list">
            <VirtualFixedList items={filtered} rowHeight={70} getKey={(f) => f.id} let:item={f}>
              <li><button class="figure-row" class:selected={picked?.id === f.id} onclick={() => pickedId = f.id}>
                <span class="row-title">{figureTitle(f)}</span><span class="badge">{designation(f)}</span>
                <small>{canvasName(f)} · @{f.referenceKey}</small>
              </button></li>
            </VirtualFixedList>
            {#if !filtered.length}<p class="note">No figures match.</p>{/if}
          </div>
          <p class="count">{filtered.length} of {$project.figures.length} figures · all canvases</p>
        </aside>
        <main>
          {#if picked}
            <div class="figure-head"><div><span class="badge">{picked.name}</span><h3>{figureTitle(picked)}</h3><span class="muted">{canvasName(picked)}</span></div><button onclick={viewFigure}>Show in Figure ↗</button></div>
            {#if section === "numbering"}
              <section class="numbering"><h4>Figure numbering</h4><p>Numbers belong to Figure. Moving content in Paper never changes them.</p><p>Move this figure within {familyById(picked.family, $project.figureFamilies).displayName}. Other numbers in this family shift; references remain linked to the same figures.</p><div class="actions"><button disabled={(picked.number ?? 1) <= 1} onclick={() => moveNumber(-1)}>↑ Earlier</button><strong>{picked.number} of {familyMembers.length}</strong><button disabled={(picked.number ?? 1) >= familyMembers.length} onclick={() => moveNumber(1)}>↓ Later</button></div></section>
            {/if}
            <label class="title-field">Title<input value={picked.nickname ?? ""} placeholder={picked.name} onchange={(e) => { const id = picked!.id; commit((p) => ops.setFigureIdentity(p, id, { nickname: e.currentTarget.value })); }} /></label>
            <div class="reference"><div><b>Permanent reference</b><code>@{picked.referenceKey}</code></div><button onclick={copyKey}>Copy</button></div>
            <p class="note">Content, captions, and figure numbers stay synchronized automatically. Renaming or renumbering this figure keeps its reference.</p>
            {#each selectedConflicts as conflict}<p class="issue">{conflict.kind === "duplicate" ? `More than one figure has @${conflict.label}.` : `@${conflict.label} overlaps a panel reference of @${conflict.otherLabel}.`} Resolve the key conflict before publishing.</p>{/each}
            <div class="preview">{#if preview}<img src={preview} alt={figureTitle(picked)} />{:else}<span>Preview unavailable</span>{/if}</div>
            {#if composeCaption(picked)}<p class="caption">{composeCaption(picked)}</p>{/if}
            <section class="sources"><div class="section-head"><h4>Sources</h4><button disabled={working || !$embeddedProjectRoot} onclick={() => run(() => syncProjectSources($embeddedProjectRoot!))}>Reload sources</button></div>
              {#if statuses.length}<p class="note">Linked data updates every linked use. A frozen version stays as it is.</p>{/if}
              {#each statuses as source (source.assetId)}<div class="source"><div><b class:source-error={source.status === "error" || source.status === "missing"}>{source.status === "frozen" ? "Frozen version" : source.status === "current" ? "Linked · current" : source.status === "updating" ? "Updating" : source.status === "missing" ? "Source missing" : "Update failed"}</b><code>{source.path}</code>{#if source.detail}<p class="note">{source.detail}</p>{/if}</div><div class="actions"><button disabled={working} onclick={() => relink(source.assetId)}>Relink…</button><button disabled={working} onclick={() => freeze(source.assetId, source.status !== "frozen")}>{source.status === "frozen" ? "Resume updates" : "Freeze"}</button>{#if fileBridge()?.revealPath}<button onclick={() => fileBridge()?.revealPath?.(/^(?:\/|[A-Za-z]:[\\/])/.test(source.path) ? source.path : joinPath($embeddedProjectRoot!, source.path))}>Reveal</button>{/if}</div></div>{/each}
              {#if !statuses.length}<p class="note">{!$embeddedProjectRoot ? "Save this project to inspect source links." : "No linked plot sources in this figure."}</p>{/if}
            </section>
            <section><h4>Used in</h4>{#each usages as use, i (`${use.path}:${use.slideId ?? ""}:${i}`)}<button class="usage" onclick={() => openUsage(use)}><span>{use.kind === "slide" ? "Slide" : "Paper"}</span><b>{use.label}</b><span>↗</span></button>{/each}{#if !usages.length}<p class="note">No saved manuscript references or shared slide sources found.</p>{/if}{#if dependencies && !dependencies.complete}<p class="issue">Some usages could not be inspected. {dependencies.diagnostics.join(" · ")}</p>{/if}<p class="note">Slides share source data; their copied layout remains independently editable.</p></section>
          {/if}
          {#if error}<p class="issue" role="alert">{error}</p>{/if}
        </main>
      </div>
    </div>
  </div>
{/if}

<style>
  .catalog-scrim { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; }
  .backdrop { position: absolute; inset: 0; border: 0; background: #0005; }
  .catalog { position: relative; width: min(960px, calc(100% - 24px)); height: min(780px, calc(100% - 24px)); display: flex; flex-direction: column; background: var(--c-surface); color: var(--c-tx); border: 1px solid var(--c-line-strong); border-radius: 12px; box-shadow: var(--elev-3); font-size: 12px; overflow: hidden; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--c-line); }
  h2 { font-size: 18px; margin: 0; } header p { margin: 4px 0 0; color: var(--c-tx-2); }
  h3 { font-size: 22px; margin: 7px 0; } h4 { font-size: 12px; margin: 0 0 10px; }
  button { font: inherit; background: var(--c-bg); color: var(--c-tx); border: 1px solid var(--c-line-strong); border-radius: 5px; padding: 6px 9px; cursor: pointer; }
  button:hover { border-color: var(--c-accent); } button:disabled { opacity: .45; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 1px; }
  .close { border: 0; background: transparent; }
  .catalog-body { display: grid; grid-template-columns: minmax(200px, 32%) minmax(0, 1fr); flex: 1; min-height: 0; }
  aside { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--c-line); }
  input { font: inherit; color: var(--c-tx); background: var(--c-bg); border: 1px solid var(--c-line-strong); border-radius: 5px; padding: 8px 10px; min-width: 0; }
  .search { margin: 12px; } nav { display: flex; gap: 4px; margin: 0 12px 8px; } nav button { flex: 1; } nav .on { color: var(--c-accent); border-color: var(--c-accent); }
  .figure-list { overflow: auto; min-height: 0; flex: 1; padding: 0 6px; }
  .figure-list :global(ul) { padding: 0; margin: 0; list-style: none; }
  .figure-row { width: 100%; height: 66px; margin: 2px 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 8px; text-align: left; border: 1px solid transparent; background: transparent; padding: 10px; }
  .figure-row.selected { background: var(--c-accent-tint); border-color: var(--c-accent); }
  .row-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
  .figure-row small { grid-column: 1 / -1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx-2); font-size: 10px; }
  .badge { font-size: 11px; color: var(--c-accent); white-space: nowrap; } .count { margin: 0; padding: 10px 12px; color: var(--c-tx-faint); border-top: 1px solid var(--c-line); font-size: 11px; }
  main { padding: 20px; overflow: auto; min-height: 0; } main section { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--c-line); }
  .figure-head { display: flex; justify-content: space-between; align-items: start; gap: 12px; } .figure-head button { flex-shrink: 0; }
  .muted, .note { color: var(--c-tx-2); } .note { font-size: 11px; line-height: 1.55; margin: 8px 0; }
  .title-field { display: flex; flex-direction: column; gap: 6px; margin-top: 20px; }
  .reference { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 16px; }
  code { display: block; margin-top: 5px; overflow-wrap: anywhere; font: 11px var(--font-mono, monospace); user-select: text; }
  .preview { background: #fff; border: 1px solid var(--c-line); border-radius: 6px; min-height: 100px; max-height: 260px; margin-top: 16px; padding: 12px; display: flex; justify-content: center; color: #777; }
  .preview img { display: block; width: 100%; max-height: 236px; object-fit: contain; }
  .caption { white-space: pre-wrap; line-height: 1.6; font-size: 11px; }
  .section-head { display: flex; justify-content: space-between; align-items: center; } .section-head h4 { margin: 0; }
  .source { border: 1px solid var(--c-line); border-radius: 6px; padding: 10px; margin-top: 8px; } .source b { font-size: 11px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
  .issue, .source-error { color: var(--c-danger, #d14d41); } .issue { font-size: 11px; line-height: 1.5; }
  .usage { width: 100%; display: flex; gap: 10px; align-items: center; text-align: left; margin-top: 6px; } .usage b { flex: 1; overflow-wrap: anywhere; font-weight: 500; } .usage span { color: var(--c-tx-2); }
  .numbering p { line-height: 1.55; } .numbering { border: 1px solid var(--c-line); border-radius: 6px; padding: 12px; }
  @media (max-width: 740px) { .catalog-body { grid-template-columns: 190px minmax(0, 1fr); } main { padding: 12px; } h3 { font-size: 18px; } .figure-head { flex-direction: column; } }
</style>

<script lang="ts">
  // The Artifacts part of Paper's Files rail: the project's HTML pages, under the documents and
  // set the same way. It is rendered INSIDE DocumentPicker's scroll (its `extra` snippet), so it
  // shares that list's scrollbar, its row height and its arrow-key walk: an artifact row is a
  // `dp-item` like a document row, and a head or group is an `a-label`, which the picker walks as
  // a folder. (Not `folder-label` inside `[data-folder]`: that is a place documents are dropped.)
  import { artifactRows, artifactAge, artifactAgeWords, sharedTitles } from "../../../../lib/artifacts/tree";
  import type { ArtifactListing, ArtifactRoot } from "../../../../lib/artifacts/types";

  let { listing, activeId = null, needle = "", storageKey = "", canLink = false, onOpen, onLink }: {
    listing: ArtifactListing | null;
    /** The artifact the pane shows, or null while it shows a document. */
    activeId?: string | null;
    /** The rail's filter, lower-cased; "" shows the tree. */
    needle?: string;
    storageKey?: string;
    canLink?: boolean;
    onOpen: (id: string) => void;
    onLink?: () => void;
  } = $props();

  let collapsed = $state<string[]>([]);
  let savedKey: string | null = null;
  $effect(() => {
    if (savedKey === storageKey) return;
    savedKey = storageKey;
    try { collapsed = JSON.parse(localStorage.getItem(`flux.paper.artifactFolders:${storageKey}`) || "[]"); } catch { collapsed = []; }
  });
  function toggle(key: string) {
    collapsed = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    try { localStorage.setItem(`flux.paper.artifactFolders:${storageKey}`, JSON.stringify(collapsed)); } catch { /* private mode */ }
  }
  const folded = $derived(new Set(collapsed));
  const headKey = (root: ArtifactRoot) => `head:${root.dir}`;
  // Ages are read against the moment the list arrived: a rail that re-rendered every minute
  // to say "13 min ago" would be working for nothing.
  const now = $derived.by(() => { void listing; return Date.now(); });
  const roots = $derived(listing?.roots ?? []);
  const shared = $derived(sharedTitles(listing));
  const leaf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);
  const matches = $derived(needle ? roots.flatMap((r) => r.artifacts).filter((a) => a.title.toLowerCase().includes(needle) || a.rel.toLowerCase().includes(needle)) : []);
</script>

{#snippet glyph(kind: "folder" | "file")}
  {#if kind === "folder"}
    <svg class="a-icon" width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="M2.5 7.500h15M6 11l2 1.8-2 1.800M10.5 14.600h3.5" /></svg>
  {:else}
    <svg class="a-icon" width="14" height="16" viewBox="0 0 18 20" aria-hidden="true"><path d="M3 1h8l4 4v14H3zM10 1v5h5M7.5 10.500l-2 2 2 2M10.5 10.500l2 2-2 2" /></svg>
  {/if}
{/snippet}

{#snippet artifactRow(a: ArtifactRoot["artifacts"][number], depth: number)}
  <div class="a-row" style={`--depth:${depth}`}>
    <button class="dp-item" class:active={a.id === activeId} aria-current={a.id === activeId ? "page" : undefined} data-depth={depth + 1} data-artifact-row={a.id} title={`${a.ref}\n${artifactAgeWords(a.mtimeMs, now)}`} onclick={() => onOpen(a.id)}>
      {@render glyph(a.kind)}
      <span class="a-title">{a.title}</span>
      {#if shared.has(a.title) && leaf(a.rel)}<span class="a-file">{leaf(a.rel)}</span>{/if}
      {#if a.pages.length > 1}<span class="a-pages" title={`${a.pages.length} pages`}>{a.pages.length}</span>{/if}
      <span class="a-age">{artifactAge(a.mtimeMs, now)}</span>
    </button>
  </div>
{/snippet}

{#if needle}
  {#if matches.length}
    <div class="a-head flat"><span class="a-eyebrow">Artifacts</span></div>
    <ul aria-label="Matching artifacts">
      {#each matches.slice(0, 100) as a (a.id)}<li>{@render artifactRow(a, 0)}</li>{/each}
    </ul>
  {/if}
{:else if listing}
  {#each roots as root (root.dir)}
    {@const open = !folded.has(headKey(root))}
    <div class="a-head" data-artifact-root={root.linked ? "linked" : "project"}>
      <button class="a-label" aria-expanded={open} data-depth="0" title={root.dir} onclick={() => toggle(headKey(root))}>
        <svg class="chev" class:open width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <span class="a-eyebrow">Artifacts</span>
        {#if root.linked}<span class="a-from" title={`Linked folder: ${root.dir}`}><svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.8 9.200a2.6 2.6 0 0 0 3.7 0l2.2-2.200a2.6 2.6 0 0 0-3.7-3.700l-.9.900M9.2 6.800a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.700l.9-.9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>{root.label}</span>{/if}
      </button>
      {#if canLink && onLink && (root.linked || !listing.linkedDir)}
        <button class="a-action" title={root.linked ? "Link a different folder…" : "Link a folder of artifacts…"} aria-label={root.linked ? "Link a different folder" : "Link a folder of artifacts"} onclick={onLink}>
          <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /><path d="M8.6 13.400l2.8-2.800M9 10.200h2.800V13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      {/if}
    </div>
    {#if open}
      {#if root.missing}
        <p class="a-empty">This folder is not there: <span class="a-path">{root.dir}</span></p>
      {:else if !root.artifacts.length}
        <p class="a-empty">No pages here yet. An agent's HTML page saved in this folder shows up in this list.</p>
      {:else}
        <ul aria-label={root.linked ? `Artifacts in ${root.label}` : "Artifacts"}>
          {#each artifactRows(root, folded) as row (row.key)}
            <li>
              {#if row.kind === "group"}
                <div class="a-group" style={`--depth:${row.depth}`}>
                  <button class="a-label" aria-expanded={!folded.has(row.key)} data-depth={row.depth + 1} title={row.path} onclick={() => toggle(row.key)}>
                    <svg class="chev" class:open={!folded.has(row.key)} width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
                    <svg class="fold" width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg>
                    <span class="a-name">{row.name}</span>
                    {#if folded.has(row.key)}<span class="a-pages">{row.count}</span>{/if}
                  </button>
                </div>
              {:else}
                {@render artifactRow(row.artifact, row.depth)}
              {/if}
            </li>
          {/each}
        </ul>
        {#if root.truncated}<p class="a-empty">This folder is large: only its first pages are listed.</p>{/if}
      {/if}
    {/if}
  {/each}
  {#if !roots.length}
    <div class="a-head" data-artifact-root="none">
      <span class="folder-static"><span class="a-eyebrow">Artifacts</span></span>
      {#if canLink && onLink}
        <button class="a-action" title="Link a folder of artifacts…" aria-label="Link a folder of artifacts" onclick={onLink}>
          <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h6l2 2h8v10H2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /><path d="M8.6 13.400l2.8-2.800M9 10.200h2.800V13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      {/if}
    </div>
    <p class="a-empty">HTML pages an agent made for you: explorers, reports. Keep them in the project's <span class="a-path">artifacts</span> folder{#if canLink}, or link the folder they are in{/if}.</p>
  {/if}
{/if}

<style>
  ul { list-style: none; padding: 0; margin: 0; }
  li { margin: 0; }
  button { font: inherit; cursor: var(--cursor-cross-hover); border: 0; background: transparent; color: var(--c-tx-2); border-radius: var(--r-1); transition: background 70ms linear, color 70ms linear, box-shadow 70ms linear; }
  button:focus-visible { outline: 2px solid var(--c-accent); outline-offset: -2px; }
  button:hover { background: var(--c-accent-tint-2); color: var(--c-tx-hi); }
  button:active { background: var(--c-accent-tint); }

  /* The section head: a mono eyebrow like Documents and Context above it. */
  .a-head { display: flex; align-items: center; margin-top: 10px; border-bottom: 1px solid var(--c-line); }
  .a-head.flat { height: var(--dp-row); padding: 0 5px; }
  .a-eyebrow { font: 600 calc(10px * var(--ts-scale, 1))/1.2 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--c-tx-muted); }
  .a-label, .folder-static { display: flex; gap: 6px; align-items: center; flex: 1; min-width: 0; text-align: left; height: var(--dp-row); padding: 0 5px; font-size: var(--ts-sm); }
  .a-label svg { flex: none; color: var(--c-tx-faint); }
  .a-label:hover svg { color: var(--c-accent); }
  .chev { transition: transform 80ms linear; }
  .chev.open { transform: rotate(90deg); }
  .a-from { display: inline-flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: calc(10px * var(--ts-scale, 1))/1.2 var(--font-mono); color: var(--c-tx-faint); }
  .a-action { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; flex: none; color: var(--c-tx-muted); }

  /* Rows: the picker's own measures, so documents and artifacts read as one list. */
  .a-row, .a-group {
    display: flex; align-items: center; min-width: 0;
    background-image: repeating-linear-gradient(to right, transparent 0 calc(var(--dp-step) * .86), var(--c-line-strong) calc(var(--dp-step) * .86) calc(var(--dp-step) * .86 + 1px), transparent calc(var(--dp-step) * .86 + 1px) var(--dp-step));
    background-size: calc(var(--depth) * var(--dp-step)) 100%; background-repeat: no-repeat; background-position: 2px 0;
  }
  .a-row { padding-left: calc(16px + var(--depth) * var(--dp-step)); }
  .a-group { padding-left: calc(var(--depth) * var(--dp-step)); border-radius: var(--r-1); }
  .a-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dp-item { display: flex; align-items: center; flex: 1; min-width: 0; gap: 7px; text-align: left; height: var(--dp-row); padding: 4px 6px; font-size: var(--ts-sm); }
  .a-icon { flex: none; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linecap: round; stroke-linejoin: round; color: var(--c-tx-faint); }
  .dp-item.active, .dp-item.active:hover { background: var(--c-accent-tint); color: var(--c-accent); font-weight: 600; box-shadow: inset 2px 0 0 var(--c-accent); }
  .dp-item.active .a-icon { color: var(--c-accent); }
  .a-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Two artifacts with one title: each also says its file. The title gives way first. */
  .a-title:has(+ .a-file) { flex: 1 1 0; }
  .a-file { flex: 0 1 auto; min-width: 3ch; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: calc(10px * var(--ts-scale, 1))/1.2 var(--font-mono); color: var(--c-tx-faint); }
  .a-pages { flex: none; padding: 0 5px; border: 1px solid var(--c-line-strong); border-radius: var(--r-pill); font: 600 calc(9px * var(--ts-scale, 1))/1.5 var(--font-mono); color: var(--c-tx-muted); }
  .a-age { flex: none; font: calc(9.500px * var(--ts-scale, 1))/1.2 var(--font-mono); font-variant-numeric: tabular-nums; color: var(--c-tx-faint); }
  .dp-item.active .a-age { color: color-mix(in oklab, var(--c-accent) 70%, transparent); }
  .a-empty { margin: 8px 10px 14px; color: var(--c-tx-faint); font-size: var(--ts-xs); font-style: italic; line-height: 1.45; }
  .a-path { font: normal .95em var(--font-mono); color: var(--c-tx-muted); overflow-wrap: anywhere; }
</style>

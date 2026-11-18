<script lang="ts">
  import { fadeRise } from "../../../../lib/motion/actions";
  import { prefersReducedMotion } from "../../../../lib/motion/motion";
  import { buildTree, type OutlineItem, type OutlineNode } from "./outline";

  let {
    items,
    title = "",
    activeFrom = -1,
    collapsed,
    counts,
    onJump,
    onToggleCollapse,
  }: {
    items: OutlineItem[];
    /** Prose words per section (subsections included), keyed by the heading
     *  line's offset — from the idle-tick word analysis (wordCounts.svelte.ts). */
    counts?: ReadonlyMap<number, number>;
    title?: string;
    activeFrom?: number;
    /** Folded sections, by the node's `key` (its heading chain), for THIS document. */
    collapsed: Set<string>;
    onJump: (from: number) => void;
    onToggleCollapse: (key: string) => void;
  } = $props();

  const tree = $derived(buildTree(items));

  // Path of the node under the cursor, and its ancestor paths (kept open so the
  // active section is always visible even inside a collapsed branch).
  const activePath = $derived.by(() => {
    const find = (nodes: OutlineNode[]): string | null => {
      for (const n of nodes) {
        if (n.item.from === activeFrom) return n.path;
        const c = find(n.children);
        if (c) return c;
      }
      return null;
    };
    return find(tree);
  });
  const activeAncestors = $derived.by(() => {
    const s = new Set<string>();
    if (activePath) {
      const parts = activePath.split("/");
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/"));
    }
    return s;
  });
  function isOpen(node: OutlineNode): boolean {
    return !collapsed.has(node.key) || activeAncestors.has(node.path);
  }

  // Unfolding: the rows a click just revealed arrive with a short fade (and a 3 px rise where
  // motion is allowed). Layout itself never animates: the rows are simply there.
  let unfolding = $state("");
  let unfoldTimer: ReturnType<typeof setTimeout> | undefined;
  function toggle(node: OutlineNode) {
    const opening = !isOpen(node);
    onToggleCollapse(node.key);
    clearTimeout(unfoldTimer);
    unfolding = opening ? node.path : "";
    if (opening) unfoldTimer = setTimeout(() => (unfolding = ""), 260);
  }

  // The outline is a tree you can walk: ↑/↓ between the rows on show, → opens a section or
  // steps into it, ← folds it or steps out to its parent, Home/End, Enter jumps (the row's own
  // click). Focus stays in the outline until you jump.
  function treeKey(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const rows = [...(listEl?.querySelectorAll<HTMLElement>(".oitem") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const row = rows[at], depth = Number(row.dataset.depth), kids = row.dataset.kids === "1", open = row.dataset.open === "1";
    const go = (i: number) => {
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(rows.length - 1);
    else if (e.key === "ArrowRight") {
      if (kids && !open) {
        e.preventDefault();
        (row.previousElementSibling as HTMLElement | null)?.click();
      } else if (kids) go(at + 1);
    } else if (e.key === "ArrowLeft") {
      if (kids && open) {
        e.preventDefault();
        (row.previousElementSibling as HTMLElement | null)?.click();
      } else {
        for (let i = at - 1; i >= 0; i--) if (Number(rows[i].dataset.depth) < depth) return go(i);
      }
    }
  }

  let listEl = $state<HTMLElement | undefined>(undefined);
  // Scroll the active row into view within the rail when the cursor moves.
  $effect(() => {
    void activePath;
    if (!listEl) return;
    const el = listEl.querySelector(".oitem.active") as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  });
</script>

{#snippet row(node: OutlineNode)}
  {@const hasKids = node.children.length > 0}
  {@const open = isOpen(node)}
  {@const depth = node.path.split("/").length - 1}
  <div class="orow" class:unfold={!!unfolding && node.path.startsWith(unfolding + "/")} class:top={depth === 0} style="--depth:{depth}">
    {#if hasKids}
      <button
        class="caret"
        class:open
        title={open ? "Fold this section" : "Unfold this section"}
        aria-label={open ? "Collapse section" : "Expand section"}
        aria-expanded={open}
        tabindex="-1"
        onclick={() => toggle(node)}>
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    {:else}
      <span class="caret spacer"></span>
    {/if}
    <button
      class="oitem"
      class:active={node.item.from === activeFrom}
      aria-current={node.item.from === activeFrom ? "location" : undefined}
      data-depth={depth}
      data-kids={hasKids ? "1" : "0"}
      data-open={open ? "1" : "0"}
      title={node.item.text}
      onclick={() => onJump(node.item.from)}>
      {node.item.text}
    </button>
    {#if counts?.has(node.item.from)}
      <span class="ocount" data-words={counts.get(node.item.from)} title="Words in this section (subsections included)">{counts.get(node.item.from)!.toLocaleString("en-US")}</span>
    {/if}
  </div>
  {#if hasKids && open}
    {#each node.children as child (child.path)}
      {@render row(child)}
    {/each}
  {/if}
{/snippet}

<aside class="outline" in:fadeRise={{ y: 6 }}>
  <div class="ohead" title={title || "Untitled"}>{title || "Untitled"}</div>
  {#if items.length === 0}
    <p class="empty">No headings yet. A line that starts with <code>#</code> becomes a section here.</p>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <nav class="olist" aria-label="Document outline" bind:this={listEl} onkeydown={treeKey}>
      {#each tree as node (node.path)}
        {@render row(node)}
      {/each}
    </nav>
  {/if}
</aside>

<style>
  .outline {
    --row: calc(26px * var(--ts-scale, 1));
    --step: calc(13px * var(--ts-scale, 1));
    flex: 1 1 0;
    width: 100%;
    min-width: 0;
    height: 100%;
    box-sizing: border-box;
    overflow: auto;
    border: 1.5px solid var(--c-edge);
    border-radius: var(--r-3);
    background: var(--flx-paper);
    padding: var(--sp-4) var(--sp-3);
    scrollbar-width: thin;
    scrollbar-color: color-mix(in oklab, var(--c-tx) 22%, transparent) transparent;
  }
  /* the manuscript title, heading the outline (matches the spec) */
  .ohead {
    padding: 0 var(--sp-1) var(--sp-3);
    margin-bottom: var(--sp-2);
    border-bottom: 1px solid var(--c-line-strong);
    font-family: var(--font-serif);
    font-size: var(--ts-base);
    font-weight: 600;
    line-height: 1.3;
    color: var(--c-tx-hi);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    margin: 0;
    padding: var(--sp-2);
    font-size: var(--ts-sm);
    line-height: 1.5;
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .empty code {
    font: normal 0.95em var(--font-mono);
    color: var(--c-tx-muted);
  }
  .olist {
    display: flex;
    flex-direction: column;
  }
  /* One row. Its indent carries a hairline per level, so a section's extent can be read down
     the rail (the spec's guide lines) without a box around anything. */
  .orow {
    display: flex;
    align-items: center;
    gap: 1px;
    min-height: var(--row);
    padding-left: calc(var(--depth) * var(--step));
    background-image: repeating-linear-gradient(
      to right,
      transparent 0 calc(var(--step) * 0.62),
      var(--c-line-strong) calc(var(--step) * 0.62) calc(var(--step) * 0.62 + 1px),
      transparent calc(var(--step) * 0.62 + 1px) var(--step)
    );
    background-size: calc(var(--depth) * var(--step)) 100%;
    background-repeat: no-repeat;
  }
  .orow.unfold {
    animation:
      outline-fade var(--dur-fade) linear both,
      outline-rise var(--dur-instant) var(--ease-enter) both;
  }
  @keyframes outline-fade {
    from {
      opacity: 0;
    }
  }
  @keyframes outline-rise {
    from {
      transform: translateY(-3px);
    }
  }
  /* Per-section word count — faint mono, right-aligned, outside .oitem so the
     row's label text stays exactly the heading. */
  .ocount {
    flex: 0 0 auto;
    padding: 0 var(--sp-1) 0 5px;
    font-family: var(--font-mono);
    font-size: calc(10.5px * var(--ts-scale, 1));
    color: var(--c-tx-faint);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  .caret {
    flex: 0 0 auto;
    width: calc(17px * var(--ts-scale, 1));
    height: calc(22px * var(--ts-scale, 1));
    padding: 0;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--c-tx-faint);
    cursor: var(--cursor-cross-hover);
    border-radius: var(--r-1);
    transition:
      transform 80ms linear,
      color 80ms linear,
      background 80ms linear;
  }
  .caret.open {
    transform: rotate(90deg);
  }
  .caret:not(.spacer):hover {
    color: var(--c-accent);
    background: var(--c-accent-tint-2);
  }
  .caret:not(.spacer):active {
    background: var(--c-accent-tint);
  }
  .caret.spacer {
    cursor: var(--cursor-cross);
  }
  .oitem {
    flex: 1 1 auto;
    min-width: 0;
    text-align: left;
    border: none;
    background: transparent;
    color: var(--c-tx-2);
    font-family: var(--font-serif);
    font-size: var(--ts-sm);
    line-height: 1.35;
    padding: calc(4px * var(--ts-scale, 1)) var(--sp-2);
    cursor: var(--cursor-cross-hover);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-radius: var(--r-1);
    transition:
      background 70ms linear,
      color 70ms linear,
      box-shadow 70ms linear;
  }
  .orow.top > .oitem {
    color: var(--c-tx);
    font-weight: 600;
  }
  .oitem:hover {
    background: var(--c-accent-tint-2);
    color: var(--c-tx-hi);
  }
  .oitem:active {
    background: var(--c-accent-tint);
  }
  .oitem:focus-visible {
    outline: 2px solid var(--c-accent);
    outline-offset: -2px;
  }
  /* The caret's section: a tint and a rail in the accent, the same "this one" as the open
     document above it (a solid blue block shouted over everything else in the rail). */
  .oitem.active,
  .oitem.active:hover {
    background: var(--c-accent-tint);
    color: var(--c-accent);
    box-shadow: inset 2px 0 0 var(--c-accent);
  }
  .oitem.active + .ocount {
    color: var(--c-accent);
  }
</style>

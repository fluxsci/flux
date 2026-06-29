<script lang="ts">
  import { fadeRise } from "../../../../lib/motion/actions";
  import { prefersReducedMotion } from "../../../../lib/motion/motion";
  import { buildTree, type OutlineItem, type OutlineNode } from "./outline";

  let {
    items,
    title = "",
    activeFrom = -1,
    collapsed,
    onJump,
    onToggleCollapse,
  }: {
    items: OutlineItem[];
    title?: string;
    activeFrom?: number;
    collapsed: Set<string>;
    onJump: (from: number) => void;
    onToggleCollapse: (path: string) => void;
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
  function isOpen(path: string): boolean {
    return !collapsed.has(path) || activeAncestors.has(path);
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
  {@const open = isOpen(node.path)}
  {@const depth = node.path.split("/").length - 1}
  <div class="orow" style="--depth:{depth}">
    {#if hasKids}
      <button
        class="caret"
        class:open
        title={open ? "Collapse" : "Expand"}
        aria-label={open ? "Collapse section" : "Expand section"}
        onclick={() => onToggleCollapse(node.path)}>
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
      title={node.item.text}
      onclick={() => onJump(node.item.from)}>
      {node.item.text}
    </button>
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
    <p class="empty">No headings yet.</p>
  {:else}
    <nav class="olist" bind:this={listEl}>
      {#each tree as node (node.path)}
        {@render row(node)}
      {/each}
    </nav>
  {/if}
</aside>

<style>
  .outline {
    flex: 0 0 224px;
    width: 224px;
    height: 100%;
    overflow: auto;
    border: 1.5px solid var(--c-edge);
    border-radius: var(--r-3);
    background: var(--flx-paper);
    padding: var(--sp-4) var(--sp-3);
  }
  /* the manuscript title, heading the outline (matches the spec) */
  .ohead {
    padding: 0 var(--sp-1) var(--sp-3);
    margin-bottom: var(--sp-2);
    border-bottom: 1px solid var(--c-line);
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
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .olist {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .orow {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-left: calc(var(--depth) * 13px);
  }
  .caret {
    flex: 0 0 auto;
    width: 17px;
    height: 22px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--c-tx-faint);
    cursor: pointer;
    border-radius: var(--r-1);
    transition: transform var(--dur-instant) var(--ease-standard);
  }
  .caret.open {
    transform: rotate(90deg);
  }
  .caret:hover {
    color: var(--c-tx);
  }
  .caret.spacer {
    cursor: default;
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
    padding: 4px var(--sp-2);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-radius: var(--r-1);
    transition:
      background var(--dur-instant) var(--ease-standard),
      color var(--dur-instant) var(--ease-standard);
  }
  .oitem:hover {
    background: var(--c-surface);
    color: var(--c-tx-hi);
  }
  /* the cursor's section — a solid blue rectangle (matches the mockup) */
  .oitem.active {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .oitem.active:hover {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
</style>

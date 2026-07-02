<script lang="ts">
  // The slide-mode plot X-ray (Alt+P) — the figure X-ray's granular per-part
  // STYLE control, beamed into slides: left = the parts tree with visibility
  // eyes, right = the per-part editor (opacity, stroke/fill colour, stroke
  // width, font size/family/weight) branching on the part's kind. Writes merge
  // into the element's overrides via the pure setPartStyle op (undoable,
  // coalesced per part) — the same overrides the renderer AND the export
  // already apply, so styling here is styling everywhere.
  import { deck as deckStore, activeSlideId, commitDeck, sealHistory } from "../../../lib/slide/store";
  import { slideById, setPartStyle } from "../../../lib/slide/ops";
  import { buildPartTree, type XrayNode } from "../../../lib/plot/tree";
  import { plotManifests } from "../../../lib/plot/store";
  import { slideXrayOpen } from "./animator/animatorState";
  import type { PartOverride } from "../../../lib/types";

  const open = $derived($slideXrayOpen);
  const deck = $derived($deckStore);
  const slide = $derived(deck && $activeSlideId ? slideById(deck, $activeSlideId) : null);
  const plotEl = $derived.by(() => {
    if (!open || !slide) return null;
    const el = slide.elements.find((e) => e.id === open.elId);
    return el && el.type === "plot" ? el : null;
  });
  const manifest = $derived(plotEl ? $plotManifests[plotEl.assetId] : undefined);
  const tree = $derived(plotEl ? buildPartTree(manifest) : null);

  let selectedId = $state<string | null>(null);
  let expanded = $state(new Set<string>());
  let query = $state("");
  // adopt the caller's requested part focus whenever the cockpit (re)opens
  $effect(() => {
    if (open) {
      selectedId = open.part ?? tree?.id ?? null;
      if (open.part && tree) {
        // expand ancestors of the focused part so its row is visible
        const next = new Set(expanded);
        const walk = (n: XrayNode, path: string[]): boolean => {
          if (n.id === open.part) { for (const p of path) next.add(p); return true; }
          return n.children.some((c) => walk(c, [...path, n.id]));
        };
        walk(tree, []);
        expanded = next;
      }
    }
  });

  interface Row { node: XrayNode; depth: number }
  const rows = $derived.by(() => {
    const out: Row[] = [];
    if (!tree) return out;
    const q = query.trim().toLowerCase();
    if (q) {
      const walk = (n: XrayNode) => {
        if (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) out.push({ node: n, depth: 0 });
        n.children.forEach(walk);
      };
      walk(tree);
    } else {
      const walk = (n: XrayNode, depth: number) => {
        out.push({ node: n, depth });
        if (n.children.length && (depth === 0 || expanded.has(n.id))) for (const c of n.children) walk(c, depth + 1);
      };
      walk(tree, 0);
    }
    return out;
  });
  function findNode(n: XrayNode | null, id: string | null): XrayNode | null {
    if (!n || !id) return null;
    if (n.id === id) return n;
    for (const c of n.children) {
      const r = findNode(c, id);
      if (r) return r;
    }
    return null;
  }
  const selNode = $derived(findNode(tree, selectedId));
  const ov = $derived(((plotEl && selectedId ? (plotEl.overrides as Record<string, PartOverride> | undefined)?.[selectedId] : undefined) ?? {}) as PartOverride);

  const TEXT = new Set(["axis-title", "title", "subtitle", "tick-label", "legend-label", "annotation"]);
  const LINEY = new Set(["line", "reference-line", "gridline", "spine", "errorbar", "tick", "axis"]);
  const CONTAINER = new Set(["series", "plot-area", "figure", "legend", "legend-entry"]);
  const kind = $derived(
    !selNode ? "none"
    : TEXT.has(selNode.role) ? "text"
    : CONTAINER.has(selNode.role) ? "container"
    : LINEY.has(selNode.role) ? "line"
    : "shape",
  );

  /** A style patch — null deletes that override key (setPartStyle's contract). */
  type StylePatch = Record<string, string | number | boolean | null | undefined>;
  function patch(p: StylePatch) {
    const el = plotEl;
    const pid = selectedId;
    if (!el || !pid) return;
    commitDeck((d) => setPartStyle(d, el.id, pid, p), { coalesce: `style:${el.id}:${pid}` });
  }
  function isHidden(n: XrayNode): boolean {
    return Boolean((plotEl?.overrides as Record<string, PartOverride> | undefined)?.[n.id]?.hidden);
  }
  function toggleHidden(n: XrayNode) {
    const el = plotEl;
    if (!el) return;
    commitDeck((d) => setPartStyle(d, el.id, n.id, { hidden: !isHidden(n) || null }));
  }
  function select(n: XrayNode) {
    if (selectedId !== n.id) sealHistory(); // a new part = a new undo step for its edits
    selectedId = n.id;
  }
  function toggleExpand(n: XrayNode) {
    if (!n.children.length) return;
    const s = new Set(expanded);
    if (s.has(n.id)) s.delete(n.id); else s.add(n.id);
    expanded = s;
  }
  function close() {
    sealHistory();
    slideXrayOpen.set(null);
  }
  function numOr(v: unknown, fallback: string | number = ""): string | number {
    return typeof v === "number" ? v : fallback;
  }

  // Flexoki swatches + a native picker — the v1 colour path.
  const SWATCHES = ["#4385be", "#d14d41", "#879a39", "#d0a215", "#3aa99f", "#8b7ec8", "#ce5d97", "#bc5215", "#6f6e69", "#100f0f", "#fffcf0"];
  const FONTS = ["Lato", "Gelasio", "Latin Modern Roman", "Arial", "Helvetica", "Georgia", "Times New Roman", "DejaVu Sans"];
  const asHex = (v: unknown) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : "#4385be");

  function onWin(e: KeyboardEvent) {
    if (!open) return;
    const tgt = e.target as HTMLElement;
    const inField = tgt && (tgt.tagName === "INPUT" || tgt.tagName === "SELECT");
    if (e.key === "Escape" || (e.altKey && e.code === "KeyP")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (inField) (tgt as HTMLInputElement).blur();
      else close();
      return;
    }
    if (inField) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = rows.findIndex((r) => r.node.id === selectedId);
      const ni = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      if (rows[ni]) select(rows[ni].node);
    } else if (e.key === "ArrowRight" && selNode) {
      const s = new Set(expanded); s.add(selNode.id); expanded = s;
    } else if (e.key === "ArrowLeft" && selNode) {
      const s = new Set(expanded); s.delete(selNode.id); expanded = s;
    } else if (e.key.toLowerCase() === "x" && selNode) {
      e.preventDefault();
      toggleHidden(selNode);
    }
  }
</script>

<svelte:window onkeydown={onWin} />
{#if open && plotEl}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onpointerdown={close}></div>
  <div class="panel" role="dialog" aria-label="Plot part styles">
    <div class="head">
      <strong>Plot X-ray</strong>
      <span class="sub">{plotEl.assetId}</span>
      <input class="q" placeholder="search parts…" bind:value={query} />
      <button class="x" onclick={close} title="Close (Esc / Alt+P)">✕</button>
    </div>
    {#if tree}
      <div class="cols">
        <div class="tree">
          {#each rows as r (r.node.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="row" class:sel={r.node.id === selectedId} style={`padding-left:${r.depth * 11 + 4}px`}
              onclick={() => select(r.node)}>
              {#if r.node.children.length}
                <button class="tw" onclick={(e) => { e.stopPropagation(); toggleExpand(r.node); }}>{expanded.has(r.node.id) || r.depth === 0 ? "▾" : "▸"}</button>
              {:else}<span class="tw"></span>{/if}
              <span class="lb" class:hid={isHidden(r.node)}>{r.node.label}</span>
              {#if r.node.isGroup && r.node.targets.length > 1}<span class="count">{r.node.targets.length}</span>{/if}
              <button class="eye" title="Toggle visibility (x)" onclick={(e) => { e.stopPropagation(); toggleHidden(r.node); }}>{isHidden(r.node) ? "◡" : "👁"}</button>
            </div>
          {/each}
        </div>
        <div class="props">
          {#if selNode}
            <div class="ph">{selNode.label}<span class="role">{selNode.role}</span></div>
            <div class="field">
              <span class="lab">visible</span>
              <button class="toggle" class:on={!ov.hidden} onclick={() => patch({ hidden: ov.hidden ? null : true })}>{ov.hidden ? "hidden" : "shown"}</button>
            </div>
            <div class="field">
              <span class="lab">opacity</span>
              <input class="nin" type="number" min="0" max="1" step="0.05" value={numOr(ov.opacity, 1)}
                onchange={(e) => patch({ opacity: Number(e.currentTarget.value) })} />
            </div>
            {#if kind === "text"}
              <div class="field"><span class="lab">font size</span>
                <input class="nin" type="number" min="1" step="1" value={numOr(ov.fontSize)} placeholder="—"
                  onchange={(e) => patch({ fontSize: Number(e.currentTarget.value) })} /></div>
              <div class="field"><span class="lab">font</span>
                <select value={String(ov.fontFamily ?? "")} onchange={(e) => patch({ fontFamily: e.currentTarget.value })}>
                  <option value="">— default —</option>
                  {#each FONTS as f (f)}<option value={f}>{f}</option>{/each}
                </select></div>
              <div class="field"><span class="lab">weight</span>
                <select value={String(ov.fontWeight ?? "")} onchange={(e) => patch({ fontWeight: Number(e.currentTarget.value) })}>
                  <option value="">—</option><option value="400">Regular</option><option value="700">Bold</option>
                </select></div>
              {@render colorField("text colour", "fill")}
            {:else if kind === "line"}
              {@render colorField("stroke", "stroke")}
              <div class="field"><span class="lab">stroke width</span>
                <input class="nin" type="number" min="0" step="0.25" value={numOr(ov.strokeWidth)} placeholder="—"
                  onchange={(e) => patch({ strokeWidth: Number(e.currentTarget.value) })} /></div>
            {:else if kind === "shape"}
              {@render colorField("fill", "fill")}
              {@render colorField("stroke", "stroke")}
              <div class="field"><span class="lab">stroke width</span>
                <input class="nin" type="number" min="0" step="0.25" value={numOr(ov.strokeWidth)} placeholder="—"
                  onchange={(e) => patch({ strokeWidth: Number(e.currentTarget.value) })} /></div>
            {:else}
              <div class="note">A container — hide/opacity cascade to everything inside.</div>
            {/if}
            {#if plotEl.overrides?.[selectedId ?? ""]}
              <button class="reset" onclick={() => { const keys = Object.keys(plotEl.overrides?.[selectedId ?? ""] ?? {}); patch(Object.fromEntries(keys.map((k) => [k, null]))); }}>reset overrides</button>
            {/if}
          {:else}
            <div class="note">Select a part on the left.</div>
          {/if}
        </div>
      </div>
    {:else}
      <div class="note pad">This plot has no parts manifest — per-part styling needs a semantic FluxPlot.</div>
    {/if}
    <div class="foot"><b>↑↓</b> navigate · <b>x</b> hide · <b>esc</b> close — styles apply everywhere: editor, present, export</div>
  </div>
{/if}

{#snippet colorField(label: string, prop: "fill" | "stroke")}
  <div class="field">
    <span class="lab">{label}</span>
    <input class="cin" type="color" value={asHex(ov[prop])} onchange={(e) => patch({ [prop]: e.currentTarget.value })} />
    <span class="swatches">
      {#each SWATCHES as c (c)}
        <button class="sw" style={`background:${c}`} title={c} onclick={() => patch({ [prop]: c })} aria-label={`set ${label} ${c}`}></button>
      {/each}
      <button class="sw clear" title="clear override" onclick={() => patch({ [prop]: null })}>∅</button>
    </span>
  </div>
{/snippet}

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.18); z-index: 300; }
  .panel {
    position: fixed; z-index: 301; right: 24px; top: 60px; bottom: 60px; width: 460px;
    display: flex; flex-direction: column;
    background: var(--c-bg, #100f0f); border: 1px solid var(--c-line-strong, #343331);
    border-radius: 10px; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
  }
  .head {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    border-bottom: 1px solid var(--c-line, #282726);
  }
  .head strong { font-size: 12px; color: var(--c-tx-hi, #cecdc3); }
  .sub { font-size: 10px; color: var(--c-tx-3, #6f6e69); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .q {
    font-size: 11px; width: 110px; color: var(--c-tx, #cecdc3); background: var(--c-bg-2, #1c1b1a);
    border: 1px solid var(--c-line-strong, #343331); border-radius: 4px; padding: 2px 6px;
  }
  .x { border: none; background: none; color: var(--c-tx-3, #6f6e69); cursor: pointer; }
  .cols { display: flex; flex: 1; min-height: 0; }
  .tree { flex: 1; overflow-y: auto; padding: 6px; border-right: 1px solid var(--c-line, #282726); }
  .row { display: flex; align-items: center; gap: 4px; height: 21px; border-radius: 4px; font-size: 11px; cursor: default; }
  .row:hover { background: color-mix(in oklab, var(--c-tx, #cecdc3) 6%, transparent); }
  .row.sel { background: color-mix(in oklab, var(--c-accent, #4385be) 20%, transparent); }
  .tw { width: 12px; flex: 0 0 auto; background: none; border: none; color: var(--c-tx-3, #6f6e69); cursor: pointer; font-size: 8px; padding: 0; }
  .lb { flex: 1; color: var(--c-tx, #cecdc3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lb.hid { opacity: 0.4; text-decoration: line-through; }
  .count { font-size: 9px; color: var(--c-tx-3, #6f6e69); }
  .eye { border: none; background: none; font-size: 9px; opacity: 0; cursor: pointer; padding: 0 3px; }
  .row:hover .eye { opacity: 0.8; }
  .props { flex: 0 0 190px; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .ph { font-size: 12px; font-weight: 600; color: var(--c-tx-hi, #cecdc3); display: flex; align-items: baseline; gap: 6px; }
  .role { font-size: 9px; color: var(--c-tx-3, #6f6e69); text-transform: uppercase; letter-spacing: 0.05em; }
  .field { display: flex; align-items: center; gap: 6px; font-size: 11px; flex-wrap: wrap; }
  .lab { color: var(--c-tx-3, #878580); flex: 0 0 66px; }
  .nin, select {
    font-size: 11px; color: var(--c-tx, #cecdc3); background: var(--c-bg-2, #1c1b1a);
    border: 1px solid var(--c-line-strong, #343331); border-radius: 4px; padding: 2px 5px; width: 64px;
  }
  select { width: auto; max-width: 110px; }
  .toggle {
    font-size: 10px; padding: 2px 8px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--c-line-strong, #343331); background: var(--c-bg-2, #1c1b1a); color: var(--c-tx-3, #878580);
  }
  .toggle.on { color: var(--c-accent, #4385be); border-color: var(--c-accent, #4385be); }
  .cin { width: 30px; height: 22px; padding: 0; border: 1px solid var(--c-line-strong, #343331); border-radius: 4px; background: none; cursor: pointer; }
  .swatches { display: inline-flex; gap: 3px; flex-wrap: wrap; }
  .sw { width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--c-line-strong, #343331); cursor: pointer; padding: 0; }
  .sw:hover { outline: 1px solid var(--c-accent, #4385be); }
  .sw.clear { background: none; color: var(--c-tx-3, #6f6e69); font-size: 9px; line-height: 1; }
  .note { font-size: 10.5px; color: var(--c-tx-3, #6f6e69); font-style: italic; }
  .note.pad { padding: 14px; }
  .reset {
    margin-top: 6px; font-size: 10px; color: var(--c-tx-3, #878580); background: none;
    border: 1px solid var(--c-line, #403e3c); border-radius: 4px; padding: 2px 8px; cursor: pointer; align-self: flex-start;
  }
  .reset:hover { color: var(--c-danger, #d14d41); border-color: var(--c-danger, #d14d41); }
  .foot {
    font-size: 9.5px; color: var(--c-tx-3, #6f6e69); padding: 6px 10px;
    border-top: 1px solid var(--c-line, #282726);
  }
  .foot b { color: var(--c-tx-2, #878580); }
</style>

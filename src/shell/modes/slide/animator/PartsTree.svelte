<script lang="ts">
  // The animator's tree of EVERYTHING on the slide — no longer plot-parts-only.
  // Top level = every element in z-order (¶ text, ▭ shapes, ∑ math, ▤ plots…);
  // a plot expands into its X-ray parts tree (S/A/M tri-state per part, 🎨 opens
  // the style cockpit), a text box expands into its blocks. Every element row
  // has one-click "animate in / animate out" quick actions — the fix for
  // "text boxes and shapes can't be animated at all". Rows multi-select
  // (ctrl/shift + range) with a bulk S/A/M bar, and the S/A/M buttons PAINT:
  // press one and sweep down the column to set a whole run of parts at once
  // (one undo step).
  import { selection, activeBeat, commitDeck, sealHistory, focusedPart, selTrackIds } from "../../../../lib/slide/store";
  import { setPartVisibility } from "../../../../lib/slide/ops";
  import { animatePart, animateElement } from "../../../../lib/slide/autobuild";
  import { buildPartTree, type XrayNode } from "../../../../lib/plot/tree";
  import type { Slide, SlideElement } from "../../../../lib/slide/types";
  import type { FluxPlotManifest } from "../../../../lib/plot/types";
  import { EL_GLYPH } from "./shared";
  import { slideXrayOpen } from "./animatorState";

  let { slide, manifests, plotTags }: {
    slide: Slide;
    manifests: Record<string, FluxPlotManifest>;
    plotTags: Map<string, string>;
  } = $props();

  const sid = $derived(slide.id);

  type Vis = "show" | "animate" | "mask";
  interface Row {
    key: string; // element id, or `${elId}|${partId}`, or `${elId}#${blockId}`
    kind: "element" | "part" | "block";
    depth: number;
    label: string;
    glyph?: string;
    elId: string;
    el?: SlideElement;
    node?: XrayNode;
    blockId?: string;
    expandable: boolean;
  }

  let collapsed = $state(new Set<string>());
  let initializedEls = $state(new Set<string>());
  let filter = $state("");

  function elLabel(el: SlideElement): string {
    if (el.type === "textBox") return el.blocks[0]?.text.replace(/\*/g, "").slice(0, 22) || "Text";
    if (el.type === "math") return el.tex.slice(0, 20) || "Math";
    if (el.type === "plot") {
      const m = manifests[el.assetId];
      return [plotTags.get(el.id), m?.plotType ? `plot · ${m.plotType}` : "plot"].filter(Boolean).join(" ");
    }
    if (el.type === "embedFigure") return `figure · ${el.figureId}`;
    return el.type;
  }

  // pre-collapse a plot's deep groups the first time it renders (100+ part trees)
  function ensureInit(elId: string, tree: XrayNode | null) {
    if (!tree || initializedEls.has(elId)) return;
    const next = new Set(collapsed);
    const walk = (n: XrayNode, depth: number) => {
      if (depth >= 2 && n.children.length) next.add(`${elId}|${n.id}`);
      for (const c of n.children) walk(c, depth + 1);
    };
    walk(tree, 0);
    const ini = new Set(initializedEls);
    ini.add(elId);
    initializedEls = ini;
    collapsed = next;
  }

  const rows = $derived.by(() => {
    const out: Row[] = [];
    const q = filter.trim().toLowerCase();
    for (const el of slide.elements) {
      const isPlot = el.type === "plot";
      const tree = isPlot ? buildPartTree(manifests[(el as { assetId: string }).assetId]) : null;
      const blocks = el.type === "textBox" ? el.blocks : null;
      const expandable = !!tree || (!!blocks && blocks.length > 1);
      out.push({ key: el.id, kind: "element", depth: 0, label: elLabel(el), glyph: EL_GLYPH[el.type] ?? "▫", elId: el.id, el, expandable });
      const open = q ? true : !collapsed.has(el.id);
      if (!open || !expandable) continue;
      if (tree) {
        ensureInit(el.id, tree);
        const walk = (n: XrayNode, depth: number) => {
          out.push({ key: `${el.id}|${n.id}`, kind: "part", depth, label: n.label, elId: el.id, el, node: n, expandable: n.children.length > 0 });
          if (n.children.length && (q || !collapsed.has(`${el.id}|${n.id}`))) for (const c of n.children) walk(c, depth + 1);
        };
        walk(tree, 1);
      } else if (blocks) {
        blocks.forEach((b, i) => {
          out.push({ key: `${el.id}#${b.id}`, kind: "block", depth: 1, label: b.text.replace(/\*/g, "").slice(0, 24) || `line ${i + 1}`, elId: el.id, el, blockId: b.id, expandable: false });
        });
      }
    }
    return q ? out.filter((r) => r.kind === "element" || r.label.toLowerCase().includes(q) || r.key.toLowerCase().includes(q)) : out;
  });

  function toggleCollapse(key: string) {
    const s = new Set(collapsed);
    if (s.has(key)) s.delete(key); else s.add(key);
    collapsed = s;
  }

  // --- row selection (multi, with shift ranges over the visible rows) -----------
  let selRows = $state<string[]>([]);
  let anchor = $state<string | null>(null);
  function clickRow(e: MouseEvent, r: Row) {
    if (e.shiftKey && anchor) {
      const keys = rows.map((x) => x.key);
      const a = keys.indexOf(anchor), b = keys.indexOf(r.key);
      if (a >= 0 && b >= 0) selRows = keys.slice(Math.min(a, b), Math.max(a, b) + 1);
    } else if (e.metaKey || e.ctrlKey) {
      selRows = selRows.includes(r.key) ? selRows.filter((k) => k !== r.key) : [...selRows, r.key];
      anchor = r.key;
    } else {
      selRows = [r.key];
      anchor = r.key;
      if (r.kind === "element") selection.set([r.elId]); // stage follows
    }
  }
  const selPartRows = $derived(rows.filter((r) => r.kind === "part" && selRows.includes(r.key)));

  // --- tri-state ------------------------------------------------------------------
  function partStateFor(el: SlideElement, part: string): Vis {
    const ov = (el as { overrides?: Record<string, { hidden?: boolean }> }).overrides;
    if (ov?.[part]?.hidden) return "mask";
    if (slide.beats.some((b) => b.tracks.some((t) => t.target === el.id && t.part === part && !t.disabled))) return "animate";
    return "show";
  }
  function applyVis(elId: string, assetId: string, part: string, mode: Vis, coalesce?: string) {
    commitDeck((d) => {
      if (mode === "animate") animatePart(d, sid, elId, part, manifests[assetId], $activeBeat);
      else setPartVisibility(d, elId, part, mode);
    }, coalesce ? { coalesce } : undefined);
  }
  function setVis(r: Row, mode: Vis) {
    if (!r.node || !r.el) return;
    const assetId = (r.el as { assetId: string }).assetId;
    // multi-select bulk: clicking a tri button of ANY selected row applies to all
    const targets = selRows.includes(r.key) && selPartRows.length > 1 ? selPartRows : [r];
    commitDeck((d) => {
      for (const t of targets) {
        if (!t.node || !t.el) continue;
        const aid = (t.el as { assetId: string }).assetId;
        if (mode === "animate") animatePart(d, sid, t.elId, t.node.id, manifests[aid], $activeBeat);
        else setPartVisibility(d, t.elId, t.node.id, mode);
      }
    });
    void assetId;
  }

  // --- the S/A/M PAINT gesture -------------------------------------------------------
  let painting = $state<Vis | null>(null);
  let painted = new Set<string>();
  function paintStart(e: PointerEvent, r: Row, mode: Vis) {
    e.preventDefault();
    e.stopPropagation();
    painting = mode;
    painted = new Set([r.key]);
    setVisPaint(r, mode);
    window.addEventListener("pointermove", paintMove);
    window.addEventListener("pointerup", paintEnd);
  }
  function setVisPaint(r: Row, mode: Vis) {
    if (!r.node || !r.el) return;
    applyVis(r.elId, (r.el as { assetId: string }).assetId, r.node.id, mode, "paint-vis");
  }
  function paintMove(e: PointerEvent) {
    if (!painting) return;
    const rowEl = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-rowkey]") as HTMLElement | null;
    const key = rowEl?.dataset.rowkey;
    if (!key || painted.has(key)) return;
    const r = rows.find((x) => x.key === key);
    if (!r || r.kind !== "part") return;
    painted.add(key);
    setVisPaint(r, painting);
  }
  function paintEnd() {
    painting = null;
    painted = new Set();
    sealHistory();
    window.removeEventListener("pointermove", paintMove);
    window.removeEventListener("pointerup", paintEnd);
  }

  // --- element quick actions: animate in / out ----------------------------------------
  function quickAnimate(r: Row, exit: boolean) {
    let trackId: string | null = null;
    let bi = -1;
    commitDeck((d) => {
      const res = animateElement(d, sid, r.elId, {
        exit,
        beatIndex: $activeBeat > 0 ? $activeBeat : undefined,
        ...(r.kind === "block" && r.blockId ? { blocks: [r.blockId] } : {}),
      });
      if (res) { trackId = res.trackId; bi = res.beatIndex; }
    });
    if (trackId) {
      selTrackIds.set([trackId]);
      if (bi > 0) activeBeat.set(bi);
    }
  }

  function openXray(r: Row) {
    slideXrayOpen.set({ elId: r.elId, part: r.node?.id });
  }

  // stage → tree: a part clicked on the stage highlights + reveals its row
  const focusKey = $derived($focusedPart ? `${$focusedPart.elId}|${$focusedPart.part}` : null);
</script>

<div class="parts">
  <div class="ph">
    Slide contents
    <input class="filter" placeholder="filter…" bind:value={filter} title="Filter parts by name" />
  </div>
  {#if selPartRows.length > 1}
    <div class="bulk">
      <span>{selPartRows.length} parts</span>
      <span class="tri">
        <button title="Show all selected from the start" onclick={() => { for (const r of selPartRows) setVis(r, "show"); }}>S</button>
        <button title="Animate all selected in on the current beat" onclick={() => setVis(selPartRows[0], "animate")}>A</button>
        <button title="Mask all selected" onclick={() => setVis(selPartRows[0], "mask")}>M</button>
      </span>
    </div>
  {/if}
  <div class="tree">
    {#each rows as r (r.key)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="row" class:elrow={r.kind === "element"}
        class:selrow={selRows.includes(r.key)}
        class:focus={focusKey === r.key}
        data-rowkey={r.key} data-part={r.node?.id}
        style={`padding-left:${r.depth * 11 + 2}px`}
        onclick={(e) => clickRow(e, r)}>
        {#if r.expandable}
          <button class="tw" onclick={(e) => { e.stopPropagation(); toggleCollapse(r.kind === "element" ? r.elId : r.key); }} aria-label="collapse">
            {collapsed.has(r.kind === "element" ? r.elId : r.key) ? "▸" : "▾"}
          </button>
        {:else}<span class="tw"></span>{/if}
        {#if r.glyph}<span class="gl">{r.glyph}</span>{/if}
        <span class="pl" title={r.node?.id ?? r.key}>{r.label}</span>
        {#if r.kind === "part" && r.node && r.el}
          {@const st = partStateFor(r.el, r.node.id)}
          <button class="paint" title="Edit this part's style (color, width, opacity) — Alt+P" onclick={(e) => { e.stopPropagation(); openXray(r); }}>🎨</button>
          <span class="tri">
            <button class:on={st === "show"} title="Show from the start (press + sweep to paint many)" onpointerdown={(e) => paintStart(e, r, "show")}>S</button>
            <button class:on={st === "animate"} title="Animate in on the current beat (press + sweep to paint many)" onpointerdown={(e) => paintStart(e, r, "animate")}>A</button>
            <button class:on={st === "mask"} title="Mask — hide entirely (press + sweep to paint many)" onpointerdown={(e) => paintStart(e, r, "mask")}>M</button>
          </span>
        {:else if r.kind === "element" || r.kind === "block"}
          <span class="qa">
            <button title="Animate IN on the current beat" onclick={(e) => { e.stopPropagation(); quickAnimate(r, false); }}>⊕ in</button>
            <button title="Animate OUT (disappear) on the current beat" onclick={(e) => { e.stopPropagation(); quickAnimate(r, true); }}>⊖ out</button>
            {#if r.kind === "element" && r.el?.type === "plot"}
              <button title="Open the plot X-ray (per-part styles) — Alt+P" onclick={(e) => { e.stopPropagation(); openXray(r); }}>🎨</button>
            {/if}
          </span>
        {/if}
      </div>
    {/each}
    {#if !rows.length}
      <div class="empty">Nothing on this slide yet — add text, shapes, or insert a plot.</div>
    {/if}
  </div>
</div>

<style>
  .parts {
    flex: 0 0 250px; display: flex; flex-direction: column; min-height: 0;
    border: 1px solid var(--c-line, #282726); border-radius: 6px; overflow: hidden;
  }
  .ph {
    font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--c-tx-3, #878580);
    padding: 4px 8px; background: var(--c-bg-3, #1c1b1a); border-bottom: 1px solid var(--c-line, #282726);
    display: flex; justify-content: space-between; align-items: center; gap: 6px;
  }
  .filter {
    font-size: 10px; width: 84px; color: var(--c-tx, #cecdc3); background: var(--c-bg, #100f0f);
    border: 1px solid var(--c-line-strong, #343331); border-radius: 3px; padding: 1px 5px;
    text-transform: none; letter-spacing: 0;
  }
  .bulk {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
    font-size: 10px; color: var(--c-accent, #4385be); padding: 3px 8px;
    background: color-mix(in oklab, var(--c-accent, #4385be) 10%, transparent);
    border-bottom: 1px solid var(--c-line, #282726);
  }
  .tree { overflow-y: auto; padding: 4px; display: flex; flex-direction: column; gap: 1px; }
  .row { display: flex; align-items: center; gap: 4px; font-size: 11px; height: 20px; flex: 0 0 auto; border-radius: 3px; cursor: default; }
  .row.elrow { font-weight: 600; }
  .row:hover { background: color-mix(in oklab, var(--c-tx, #cecdc3) 6%, transparent); }
  .row.selrow { background: color-mix(in oklab, var(--c-accent, #4385be) 16%, transparent); }
  .row.focus { background: color-mix(in oklab, var(--c-accent, #4385be) 22%, transparent); outline: 1px solid var(--c-accent, #4385be); }
  .tw {
    width: 12px; flex: 0 0 auto; background: none; border: none; color: var(--c-tx-3, #6f6e69);
    cursor: pointer; font-size: 8px; padding: 0; line-height: 1;
  }
  .gl { flex: 0 0 auto; font-size: 10px; color: var(--c-tx-3, #878580); width: 13px; text-align: center; }
  .pl { flex: 1; color: var(--c-tx, #cecdc3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .tri { display: inline-flex; gap: 2px; flex: 0 0 auto; }
  .tri button {
    width: 17px; height: 16px; font-size: 9px; font-weight: 600; padding: 0; cursor: pointer;
    border: 1px solid var(--c-line-strong, #343331); background: var(--c-bg-2, #1c1b1a);
    color: var(--c-tx-3, #6f6e69); border-radius: 3px;
  }
  .tri button:hover { color: var(--c-tx-hi, #fff); border-color: var(--c-accent, #4385be); }
  .tri button.on { background: var(--c-accent, #4385be); color: var(--c-bg, #100f0f); border-color: var(--c-accent, #4385be); }
  .paint {
    flex: 0 0 auto; border: none; background: none; font-size: 9px; padding: 0 1px;
    cursor: pointer; opacity: 0; filter: grayscale(0.4);
  }
  .row:hover .paint { opacity: 0.85; }
  .paint:hover { opacity: 1 !important; filter: none; }
  .qa { display: none; gap: 2px; flex: 0 0 auto; }
  .row:hover .qa { display: inline-flex; }
  .qa button {
    font-size: 9px; padding: 0 4px; height: 16px; cursor: pointer;
    border: 1px solid var(--c-line-strong, #343331); background: var(--c-bg-2, #1c1b1a);
    color: var(--c-tx-2, #b7b5ac); border-radius: 3px;
  }
  .qa button:hover { border-color: var(--c-accent, #4385be); color: var(--c-tx-hi, #fff); }
  .empty { font-size: 10.5px; color: var(--c-tx-3, #6f6e69); font-style: italic; padding: 8px; }
</style>

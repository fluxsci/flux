<script lang="ts">
  // The animator's tree of EVERYTHING on the slide. Slides-are-figures: the
  // rows come from the FIGURE model — registered groups (the same derived
  // render tree the figure editor's Layers/X-ray use, top-z first) wrap their
  // member elements, and a semantic plot expands into its manifest part tree
  // (S/A/M tri-state per part, 🎨 opens the shared figure X-ray). Every
  // element/group row has one-click "animate in / animate out" quick actions;
  // a group row fans out to one track per member (one undo step). The S/A/M
  // buttons PAINT: press one and sweep down the column to set a whole run of
  // parts at once (one undo step, coalesced).
  import { activeBeat, commitDeckLive, sealHistory, selTrackIds } from "../../../../lib/slide/store";
  import { selection, partSelection, xrayOpen, xrayRoot, activeFigureId } from "../../../../lib/store";
  import { setPartVisibility } from "../../../../lib/slide/ops";
  import { animatePart, animateElement } from "../../../../lib/slide/autobuild";
  import { buildPartTree, type XrayNode } from "../../../../lib/plot/tree";
  import { buildRenderTree, membersDeep, type RenderNode } from "../../../../lib/groups";
  import type { Element } from "../../../../lib/types";
  import type { Slide } from "../../../../lib/slide/types";
  import type { FluxPlotManifest } from "../../../../lib/plot/types";
  import { EL_GLYPH } from "./shared";

  let { slide, manifests, plotTags }: {
    slide: Slide;
    manifests: Record<string, FluxPlotManifest>;
    plotTags: Map<string, string>;
  } = $props();

  const sid = $derived(slide.id);

  type Vis = "show" | "animate" | "mask";
  interface Row {
    key: string; // element id, `grp:<gid>`, or `${elId}|${partId}`
    kind: "element" | "part" | "group";
    depth: number;
    label: string;
    glyph?: string;
    elId: string;
    el?: Element;
    node?: XrayNode;
    groupId?: string;
    expandable: boolean;
    /** the collapse key + its EFFECTIVE state (user toggle over the default) */
    ckey: string;
    collapsed: boolean;
  }

  // Collapse = user toggles OVER defaults (elements/groups open; part groups at
  // depth ≥2 closed, so 100+ part trees start compact).
  let toggled = $state(new Map<string, boolean>());
  let filter = $state("");
  const isCollapsed = (ckey: string, def: boolean) => toggled.get(ckey) ?? def;

  function elLabel(el: Element): string {
    if (el.name) return el.name;
    if (el.type === "text") return el.text.split("\n")[0]?.slice(0, 22) || "Text";
    if (el.type === "plot") {
      const m = manifests[el.assetId];
      return [plotTags.get(el.id), m?.plotType ? `plot · ${m.plotType}` : "plot"].filter(Boolean).join(" ");
    }
    return el.type;
  }

  // The slide viewed as a figure for the shared group tree (buildRenderTree
  // only reads elements/groups).
  const figView = $derived({
    id: sid, name: "", canvasId: "deck", x: 0, y: 0, width: 1, height: 1,
    background: "", elements: slide.elements, ...(slide.groups ? { groups: slide.groups } : {}),
  });

  const rows = $derived.by(() => {
    const out: Row[] = [];
    const q = filter.trim().toLowerCase();
    const pushEl = (el: Element, depth: number) => {
      const isPlot = el.type === "plot";
      const tree = isPlot ? buildPartTree(manifests[(el as { assetId: string }).assetId]) : null;
      const expandable = !!tree && tree.children.length > 0;
      const elCollapsed = isCollapsed(el.id, false);
      out.push({ key: el.id, kind: "element", depth, label: elLabel(el), glyph: EL_GLYPH[el.type] ?? "▫", elId: el.id, el, expandable, ckey: el.id, collapsed: elCollapsed });
      const open = q ? true : !elCollapsed;
      if (!open || !tree) return;
      const walk = (n: XrayNode, d: number) => {
        const ckey = `${el.id}|${n.id}`;
        const def = d >= depth + 2 && n.children.length > 0; // deep groups start compact
        const col = isCollapsed(ckey, def);
        out.push({ key: ckey, kind: "part", depth: d, label: n.label, elId: el.id, el, node: n, expandable: n.children.length > 0, ckey, collapsed: col });
        if (n.children.length && (q || !col)) for (const c of n.children) walk(c, d + 1);
      };
      for (const c of tree.children) walk(c, depth + 1);
    };
    const walkNode = (n: RenderNode, depth: number) => {
      if (n.kind === "element") {
        pushEl(n.el, depth);
        return;
      }
      const ckey = `grp:${n.def.id}`;
      const col = isCollapsed(ckey, false);
      // anchor group rows on their first member for selection/animation fan-out
      const first = membersDeep(figView, n.def.id)[0];
      out.push({ key: ckey, kind: "group", depth, label: n.def.name, glyph: "❖", elId: first?.id ?? "", groupId: n.def.id, expandable: n.children.length > 0, ckey, collapsed: col });
      if (q || !col) for (const c of n.children) walkNode(c, depth + 1);
    };
    for (const n of buildRenderTree(figView)) walkNode(n, 0);
    return q ? out.filter((r) => r.kind === "element" || r.kind === "group" || r.label.toLowerCase().includes(q) || r.key.toLowerCase().includes(q)) : out;
  });

  function toggleCollapse(r: Row) {
    const m = new Map(toggled);
    m.set(r.ckey, !r.collapsed);
    toggled = m;
  }

  // --- row selection (multi, with shift ranges over the visible rows) ---------
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
      // the stage follows: an element row selects it; a group row its members
      if (r.kind === "element") selection.set(new Set([r.elId]));
      else if (r.kind === "group" && r.groupId) selection.set(new Set(membersDeep(figView, r.groupId).map((m) => m.id)));
    }
  }
  const selPartRows = $derived(rows.filter((r) => r.kind === "part" && selRows.includes(r.key)));

  // --- tri-state -----------------------------------------------------------
  function partStateFor(el: Element, part: string): Vis {
    const ov = (el as { overrides?: Record<string, { hidden?: boolean }> }).overrides;
    if (ov?.[part]?.hidden) return "mask";
    if (slide.beats.some((b) => b.tracks.some((t) => t.target === el.id && t.part === part && !t.disabled))) return "animate";
    return "show";
  }
  function applyVis(elId: string, assetId: string, part: string, mode: Vis, coalesce?: string) {
    commitDeckLive((d) => {
      if (mode === "animate") animatePart(d, sid, elId, part, manifests[assetId], $activeBeat);
      else setPartVisibility(d, elId, part, mode);
    }, coalesce ? { coalesce } : undefined);
  }
  function setVis(r: Row, mode: Vis) {
    if (!r.node || !r.el) return;
    // multi-select bulk: clicking a tri button of ANY selected row applies to all
    const targets = selRows.includes(r.key) && selPartRows.length > 1 ? selPartRows : [r];
    commitDeckLive((d) => {
      for (const t of targets) {
        if (!t.node || !t.el) continue;
        const aid = (t.el as { assetId: string }).assetId;
        if (mode === "animate") animatePart(d, sid, t.elId, t.node.id, manifests[aid], $activeBeat);
        else setPartVisibility(d, t.elId, t.node.id, mode);
      }
    });
  }

  // --- the S/A/M PAINT gesture ----------------------------------------------
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

  // --- element/group quick actions: animate in / out -------------------------
  // A group row fans out to one track per member element (one undo step).
  function quickAnimate(r: Row, exit: boolean) {
    let trackId: string | null = null;
    let bi = -1;
    const memberIds =
      r.kind === "group" && r.groupId ? membersDeep(figView, r.groupId).map((m) => m.id) : [r.elId];
    commitDeckLive((d) => {
      for (const mid of memberIds) {
        const res = animateElement(d, sid, mid, {
          exit,
          beatIndex: $activeBeat > 0 ? $activeBeat : undefined,
        });
        if (res) {
          trackId = trackId ?? res.trackId;
          bi = res.beatIndex;
        }
      }
    });
    if (trackId) {
      selTrackIds.set([trackId]);
      if (bi > 0) activeBeat.set(bi);
    }
  }

  // 🎨 opens the SHARED figure X-ray rooted on the plot (Alt+P parity); a part
  // row also drills the part selection so the FluxFig menu targets it.
  function openXray(r: Row) {
    const fid = $activeFigureId;
    if (!fid) return;
    if (r.node) partSelection.set({ elementId: r.elId, partId: r.node.id });
    xrayRoot.set({ kind: "element", figId: fid, elementId: r.elId });
    xrayOpen.set(true);
  }

  // stage → tree: a part drilled on the canvas highlights + reveals its row
  const focusKey = $derived($partSelection ? `${$partSelection.elementId}|${$partSelection.partId}` : null);
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
      <div class="row" class:elrow={r.kind === "element" || r.kind === "group"}
        class:selrow={selRows.includes(r.key)}
        class:focus={focusKey === r.key}
        data-rowkey={r.key} data-part={r.node?.id}
        style={`padding-left:${r.depth * 11 + 2}px`}
        onclick={(e) => clickRow(e, r)}>
        {#if r.expandable}
          <button class="tw" onclick={(e) => { e.stopPropagation(); toggleCollapse(r); }} aria-label="collapse">
            {r.collapsed ? "▸" : "▾"}
          </button>
        {:else}<span class="tw"></span>{/if}
        {#if r.glyph}<span class="gl" class:grp={r.kind === "group"}>{r.glyph}</span>{/if}
        <span class="pl" title={r.kind === "group" ? `group:${r.groupId}` : r.node?.id ?? r.key}>{r.label}</span>
        {#if r.kind === "group"}<span class="badge">group</span>{/if}
        {#if r.kind === "part" && r.node && r.el}
          {@const st = partStateFor(r.el, r.node.id)}
          <button class="paint" title="Edit this part's style (color, width, opacity) — Alt+P" onclick={(e) => { e.stopPropagation(); openXray(r); }}>🎨</button>
          <span class="tri">
            <button class:on={st === "show"} title="Show from the start (press + sweep to paint many)" onpointerdown={(e) => paintStart(e, r, "show")}>S</button>
            <button class:on={st === "animate"} title="Animate in on the current beat (press + sweep to paint many)" onpointerdown={(e) => paintStart(e, r, "animate")}>A</button>
            <button class:on={st === "mask"} title="Mask — hide entirely (press + sweep to paint many)" onpointerdown={(e) => paintStart(e, r, "mask")}>M</button>
          </span>
        {:else if r.kind === "element" || r.kind === "group"}
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
      <div class="empty">Nothing on this slide yet — draw shapes, add text, or insert a plot (Alt+I).</div>
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
  .gl.grp { color: var(--c-accent, #4385be); }
  .badge {
    flex: 0 0 auto; font-size: 8px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--c-accent, #4385be); border: 1px solid color-mix(in oklab, var(--c-accent, #4385be) 45%, transparent);
    border-radius: 3px; padding: 0 3px; line-height: 1.3;
  }
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

<script lang="ts">
  // flux-slide — the Animator dock (Phase 2). The dedicated animation editor the
  // pillar is really about: a one-click ✨ Auto-animate that turns a plot's own
  // build hints into a beat sequence, and a real multi-track TIMELINE (beats as
  // columns, each showing the animations that fire on it) you scrub by clicking.
  // Replaces the thin numbered beat strip. The X-ray tri-state (2.2) and per-track
  // editing (2.3) layer onto this shell.
  import { deck as deckStore, activeSlideId, activeBeat, selection, commitDeck } from "../../../lib/slide/store";
  import { slideById, addBeat as addBeatOp, setPartVisibility } from "../../../lib/slide/ops";
  import { applyAutoAnimation, animatePart } from "../../../lib/slide/autobuild";
  import { buildPartTree, type XrayNode } from "../../../lib/plot/tree";
  import { plotManifests } from "../../../lib/plot/store";
  import type { Track } from "../../../lib/slide/types";

  const deck = $derived($deckStore);
  const slide = $derived(deck && $activeSlideId ? slideById(deck, $activeSlideId) : deck?.slides[0] ?? null);
  const sel = $derived($selection);
  const manifests = $derived($plotManifests);
  const selPlot = $derived.by(() => {
    if (sel.length !== 1 || !slide) return null;
    const el = slide.elements.find((e) => e.id === sel[0]);
    return el && el.type === "plot" ? el : null;
  });
  const selManifest = $derived(selPlot ? manifests[selPlot.assetId] : undefined);

  // --- X-ray parts tree: per-part show / animate / mask (the figure X-ray, here) ---
  let collapsed = $state(new Set<string>());
  const xrayTree = $derived(selManifest ? buildPartTree(selManifest) : null);
  const xrayRows = $derived.by(() => {
    const rows: { node: XrayNode; depth: number }[] = [];
    const walk = (n: XrayNode, depth: number) => {
      rows.push({ node: n, depth });
      if (n.children.length && !collapsed.has(n.id)) for (const c of n.children) walk(c, depth + 1);
    };
    if (xrayTree) walk(xrayTree, 0);
    return rows;
  });
  function toggleCollapse(id: string) {
    const s = new Set(collapsed);
    if (s.has(id)) s.delete(id); else s.add(id);
    collapsed = s;
  }
  /** A part's resting state: masked (override hidden) → animated (has a track) → shown. */
  function partState(part: string): "show" | "animate" | "mask" {
    const plot = selPlot;
    if (!plot || !slide) return "show";
    if ((plot.overrides as Record<string, { hidden?: boolean }> | undefined)?.[part]?.hidden) return "mask";
    if (slide.beats.some((b) => b.tracks.some((t) => t.target === plot.id && t.part === part))) return "animate";
    return "show";
  }
  function setVis(part: string, mode: "show" | "animate" | "mask") {
    const plot = selPlot;
    const sid = slide?.id;
    if (!plot || !sid) return;
    commitDeck((d) => {
      if (mode === "animate") animatePart(d, sid, plot.id, part, manifests[plot.assetId], $activeBeat);
      else setPartVisibility(d, plot.id, part, mode);
    });
  }

  function autoAnimate() {
    const sid = slide?.id;
    const plot = selPlot;
    if (!sid || !plot) return;
    const manifest = manifests[plot.assetId];
    let added = 0;
    commitDeck((d) => { added = applyAutoAnimation(d, sid, plot.id, manifest); });
    if (added) activeBeat.set(1);
  }

  function addBeat() {
    const sid = slide?.id;
    if (!sid) return;
    let idx = 0;
    commitDeck((d) => {
      const s = slideById(d, sid);
      const n = s?.beats.length ?? 1;
      addBeatOp(d, sid, { label: `Beat ${n}`, advance: "click" });
      idx = (slideById(d, sid)?.beats.length ?? 1) - 1;
    });
    if (idx > 0) activeBeat.set(idx);
  }

  // a compact label for a track on the timeline
  function chip(t: Track): string {
    if (t.target.startsWith("@")) return t.target.slice(1);
    if (t.part) return t.part.split(".").slice(-2).join(".");
    if (t.selector?.blocks) return "bullets";
    const el = slide?.elements.find((e) => e.id === t.target);
    return el?.type ?? "elem";
  }

  const PRESET_COLOR: Record<string, string> = {
    drawOn: "#4385be", fade: "#879a39", fadeRise: "#879a39", stagger: "#d14d41",
    growBaseline: "#d0a215", popIn: "#8b7ec8", writeOn: "#3aa99f", highlight: "#d0a215",
    dim: "#6f6e69", move: "#4385be", scale: "#4385be", rotate: "#4385be", morph: "#ce5d97", camera: "#a02f6f",
  };
</script>

{#if slide}
  <div class="animator">
    <div class="bar">
      <strong class="ttl">Animation</strong>
      {#if selPlot}
        <button class="magic" onclick={autoAnimate} disabled={!selManifest}
          title={selManifest ? "Build a beat sequence from this plot's own animation hints" : "This plot has no build manifest to auto-animate"}>✨ Auto-animate</button>
      {/if}
      <button class="b" onclick={addBeat} title="Add a beat">+ Beat</button>
      <span class="spacer"></span>
      {#if selPlot}<span class="tag">plot selected — try ✨</span>{:else}<span class="tag dim">select a plot to auto-animate</span>{/if}
    </div>

    <div class="dock-body">
      {#if xrayTree}
        <div class="parts">
          <div class="ph">Parts <span class="ph-hint">show · animate · mask</span></div>
          <div class="tree">
            {#each xrayRows as { node, depth } (node.id)}
              {@const st = partState(node.id)}
              <div class="row" style={`padding-left:${depth * 11 + 2}px`}>
                {#if node.children.length}
                  <button class="tw" onclick={() => toggleCollapse(node.id)} aria-label="collapse">{collapsed.has(node.id) ? "▸" : "▾"}</button>
                {:else}<span class="tw"></span>{/if}
                <span class="pl" title={node.id}>{node.label}</span>
                <span class="tri">
                  <button class:on={st === "show"} title="Show from the start" onclick={() => setVis(node.id, "show")}>S</button>
                  <button class:on={st === "animate"} title="Animate in (add a reveal track)" onclick={() => setVis(node.id, "animate")}>A</button>
                  <button class:on={st === "mask"} title="Mask (hide entirely)" onclick={() => setVis(node.id, "mask")}>M</button>
                </span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
      <div class="timeline">
      {#each slide.beats as b, bi (b.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="col" class:cur={bi === $activeBeat} onclick={() => activeBeat.set(bi)}>
          <div class="head">
            <span class="bi">{bi === 0 ? "Start" : bi}</span>
            {#if b.label && bi > 0}<span class="lab">{b.label}</span>{/if}
          </div>
          <div class="body">
            {#if bi === 0}
              <div class="rest">resting state</div>
            {:else if !b.tracks.length}
              <div class="rest">no animations</div>
            {:else}
              {#each b.tracks as t, ti (ti)}
                <div class="trk" style={`--pc:${PRESET_COLOR[t.preset ?? "fade"] ?? "#888"}`}>
                  <span class="dot"></span>
                  <span class="nm" title={t.part ?? t.target}>{chip(t)}</span>
                  <span class="ps">{t.preset ?? "fade"}</span>
                </div>
              {/each}
            {/if}
          </div>
        </div>
      {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .animator {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid var(--c-line, #282726);
    padding: 8px 10px 10px;
    background: var(--c-bg, #100f0f);
    max-height: 240px;
  }
  .bar { display: flex; align-items: center; gap: 8px; }
  .ttl { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--c-tx-3, #878580); }
  .spacer { flex: 1; }
  .tag { font-size: 11px; color: var(--c-accent, #4385be); }
  .tag.dim { color: var(--c-tx-3, #6f6e69); }
  .magic {
    font-size: 12px; font-weight: 600;
    color: var(--c-bg, #100f0f); background: var(--c-accent, #4385be);
    border: none; border-radius: 5px; padding: 5px 11px; cursor: pointer;
  }
  .magic:hover:not(:disabled) { background: var(--c-accent-bright, #5a96c9); }
  .magic:disabled { opacity: 0.4; cursor: default; }
  .b {
    font-size: 12px; color: var(--c-tx-2, #b7b5ac);
    background: var(--c-bg-2, #1c1b1a); border: 1px solid var(--c-line-strong, #343331);
    border-radius: 5px; padding: 5px 10px; cursor: pointer;
  }
  .b:hover { border-color: var(--c-accent, #4385be); color: var(--c-tx-hi, #fff); }

  .dock-body { display: flex; gap: 10px; min-height: 0; flex: 1; }
  .parts {
    flex: 0 0 234px; display: flex; flex-direction: column; min-height: 0;
    border: 1px solid var(--c-line, #282726); border-radius: 6px; overflow: hidden;
  }
  .ph {
    font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--c-tx-3, #878580);
    padding: 4px 8px; background: var(--c-bg-3, #1c1b1a); border-bottom: 1px solid var(--c-line, #282726);
    display: flex; justify-content: space-between; align-items: baseline;
  }
  .ph-hint { font-size: 9px; text-transform: none; letter-spacing: 0; opacity: 0.6; }
  .tree { overflow-y: auto; padding: 4px; display: flex; flex-direction: column; gap: 1px; }
  .row { display: flex; align-items: center; gap: 4px; font-size: 11px; height: 20px; flex: 0 0 auto; }
  .tw {
    width: 12px; flex: 0 0 auto; background: none; border: none; color: var(--c-tx-3, #6f6e69);
    cursor: pointer; font-size: 8px; padding: 0; line-height: 1;
  }
  .pl { flex: 1; color: var(--c-tx, #cecdc3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tri { display: inline-flex; gap: 2px; flex: 0 0 auto; }
  .tri button {
    width: 17px; height: 16px; font-size: 9px; font-weight: 600; padding: 0; cursor: pointer;
    border: 1px solid var(--c-line-strong, #343331); background: var(--c-bg-2, #1c1b1a);
    color: var(--c-tx-3, #6f6e69); border-radius: 3px;
  }
  .tri button:hover { color: var(--c-tx-hi, #fff); border-color: var(--c-accent, #4385be); }
  .tri button.on { background: var(--c-accent, #4385be); color: var(--c-bg, #100f0f); border-color: var(--c-accent, #4385be); }
  .timeline {
    flex: 1; min-width: 0;
    display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px;
    align-items: stretch; min-height: 96px;
  }
  .col {
    flex: 0 0 auto; min-width: 124px; max-width: 200px;
    border: 1px solid var(--c-line, #282726); border-radius: 6px;
    background: var(--c-bg-2, #16100f00); cursor: pointer; overflow: hidden;
    display: flex; flex-direction: column;
  }
  .col:hover { border-color: var(--c-line-strong, #343331); }
  .col.cur { border-color: var(--c-accent, #4385be); box-shadow: inset 0 0 0 1px var(--c-accent, #4385be); }
  .head {
    display: flex; align-items: baseline; gap: 6px; padding: 4px 8px;
    background: var(--c-bg-3, #1c1b1a); border-bottom: 1px solid var(--c-line, #282726);
  }
  .bi { font-size: 12px; font-weight: 700; color: var(--c-tx-hi, #cecdc3); }
  .lab { font-size: 10px; color: var(--c-tx-3, #878580); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .body { display: flex; flex-direction: column; gap: 3px; padding: 6px; }
  .rest { font-size: 10px; color: var(--c-tx-3, #6f6e69); font-style: italic; padding: 2px; }
  .trk {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; padding: 2px 4px; border-radius: 4px;
    background: color-mix(in oklab, var(--pc) 12%, transparent);
  }
  .dot { width: 7px; height: 7px; border-radius: 2px; background: var(--pc); flex: 0 0 auto; }
  .nm { color: var(--c-tx, #cecdc3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .ps { color: var(--c-tx-3, #878580); font-size: 10px; flex: 0 0 auto; }
</style>

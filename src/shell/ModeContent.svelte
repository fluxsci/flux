<script lang="ts">
  // W16 (SHL-5): mode keep-alive. Instead of `{#key mode}` — which tore down and
  // rebuilt the whole mode on every switch (CodeMirror re-created, fig/ re-read,
  // plots remounted) — every visited mode stays MOUNTED and we just toggle which
  // one is visible. Switching back is instant and preserves live state: the editor
  // doc + scroll + selection, the canvas viewport, the deck cursor.
  //
  // Hidden panes use `visibility:hidden` + `inert` (NOT display:none): the box keeps
  // its dimensions, so CodeMirror / ResizeObserver geometry stays valid and no
  // re-measure is needed on reveal. Only the active mode is `focused` (so keyboard
  // handlers stay exclusive) and `active` (so background work — the slide preview
  // player — pauses while hidden).
  //
  // W15 still applies: modes load on demand from the registry. A visited mode is
  // already in the sync cache (it was active once) so it renders with no flash.
  import { loadMode, cachedMode } from "./modeRegistry";
  import { isDirtyById } from "./lifecycle";
  import { evictRequest } from "./paneStore";
  import { pushToast, errMsg } from "../lib/toast";
  import { fadeRise } from "../lib/motion/actions";
  import { DUR } from "../lib/motion/tokens";
  import type { ModeId } from "./shellStore";

  // paneId threads through to the mode component so multi-instance modes (reader
  // split panes) can key per-pane state; modes that don't declare it ignore it.
  let { mode, focused = false, paneId = "" }: { mode: ModeId; focused?: boolean; paneId?: string } = $props();

  // Cap kept-alive modes per pane. Beyond this, evict the least-recently-used mode
  // that is CLEAN (never a dirty one — its unsaved edits would be lost) — its
  // onDestroy flushes as a no-op. Library/Reader (no registered flushable) count as
  // clean, so they're reclaimed first.
  const MAX_KEPT = 3;

  // Visited modes in MRU order (least-recent first, active last).
  let visited = $state<ModeId[]>([]);
  // Components this pane actually activated. The registry cache is not reactive:
  // a cold import can finish after the user switches away. Adopt it explicitly
  // on the next activation, while keeping previously mounted modes alive.
  let components = $state<Partial<Record<ModeId, ReturnType<typeof cachedMode>>>>({});

  // Keep `mode` at the front-of-mind (end) of the MRU list, evicting clean modes
  // over the cap. Runs whenever the active mode changes.
  $effect(() => {
    const m = mode;
    if (visited[visited.length - 1] === m) return; // already active + last
    const next = visited.filter((x) => x !== m);
    next.push(m);
    // Evict least-recent CLEAN modes (scan from the front) until within cap.
    while (next.length > MAX_KEPT) {
      const victim = next.findIndex((x) => x !== m && !isDirtyById(x));
      if (victim < 0) break; // everything else is dirty — keep them all mounted
      next.splice(victim, 1);
    }
    visited = next;
  });

  // Slide-migration §3.2.1: explicit eviction — figure and slide mode share
  // the app-global figure store, so entering one force-unmounts a kept-alive
  // other (its autosave was flushed by the requester first; the onDestroy
  // flush is then a clean no-op). Never evicts this pane's ACTIVE mode — the
  // pane-level exclusivity denies that configuration up front.
  $effect(() => {
    const req = $evictRequest;
    if (!req.mode || req.mode === mode) return;
    if (visited.includes(req.mode)) visited = visited.filter((m) => m !== req.mode);
  });

  // Only activate the requested mode. A stale import still warms the registry,
  // but must not mount a hidden Figure/Slide and claim their shared editor store.
  $effect(() => {
    const m = mode;
    const cached = cachedMode(m);
    if (cached) {
      components[m] = cached;
      return;
    }
    let alive = true;
    loadMode(m)
      .then((component) => {
        if (alive) components[m] = component;
      })
      .catch((e) => {
        if (alive) pushToast("error", `Couldn't open ${m} mode`, { detail: errMsg(e) });
      });
    return () => {
      alive = false;
    };
  });

</script>

{#each visited as m (m)}
  {@const Comp = components[m]}
  {#if Comp}
    <!-- First-mount-only intro: the keyed block persists across switches, so
         revealing an already-visited mode is a cheap visibility flip, not a replay. -->
    <div class="mc" class:hidden={m !== mode} inert={m !== mode} in:fadeRise={{ duration: DUR.gentle, y: 10 }}>
      <Comp focused={focused && m === mode} active={m === mode} {paneId} />
    </div>
  {/if}
{/each}

<style>
  .mc {
    position: absolute;
    inset: 0;
  }
  /* visibility:hidden (not display:none) keeps the box laid out so CodeMirror /
     ResizeObserver geometry survives; inert (in the markup) blocks focus + input. */
  .mc.hidden {
    visibility: hidden;
  }
  /* A hidden mode's inline SVGs still participate in document-wide url(#id)
     resolution, and Chromium composes clip geometry from RENDERED children
     only — visibility:hidden children make a referenced clipPath EMPTY, so any
     visible element that loses an id race to a hidden twin paints nothing
     (2026-08-13 blank-plots regression; pixel repro in verify-clip-collision).
     Clip shapes are never painted directly, so forcing them visible changes
     nothing in the hidden pane — it only keeps the geometry valid for whoever
     resolves to it. Paper renders are also id-NAMESPACED (scholar/figures.ts
     PAPER_SVG_NS) so the race shouldn't happen; this rule is the second layer,
     covering any future hidden twin of the SAME surface. */
  .mc.hidden :global(clipPath *) {
    visibility: visible;
  }
</style>

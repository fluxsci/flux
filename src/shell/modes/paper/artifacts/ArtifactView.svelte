<script lang="ts">
  // One artifact in Paper's centre card: a strip that says what the page is and holds its few
  // keys, and under it the page itself in a frame of its own origin and its own process. Nothing
  // of the page runs in Flux; what the app knows of it (where the reader is, the outline, the
  // selected words) arrives as messages and is parsed as untrusted data (frameProtocol.ts).
  import { onDestroy, untrack } from "svelte";
  import { fileBridge } from "../../../../lib/project/types";
  import { artifactChange } from "../../../../lib/artifacts/artifactStore";
  import { changeTouches, pageRef } from "../../../../lib/artifacts/tree";
  import { parseFrameMessage, appChord, relOfFramePath, type OutlineEntry } from "../../../../lib/artifacts/frameProtocol";
  import type { Artifact, ArtifactRoot } from "../../../../lib/artifacts/types";
  import { boundsOf, registerTargetResolver } from "../../../../lib/bridge/targetResolvers";
  import { describeTarget, type TargetRef } from "../../../../lib/project/targets";

  export interface ArtifactPlace {
    /** The page, below the artifact's root. */
    page: string;
    /** The page's own address tail: where in it the reader is (`#n=3`). */
    view: string;
    title: string;
    scrollY: number;
    /** Index into the outline of the heading the reader is at, or -1. */
    heading: number;
    selection: string;
  }

  let {
    artifact,
    root,
    projectRoot,
    start,
    focused = true,
    onPlace,
    onOutline,
    onFocus,
    onClose,
    onNetwork,
  }: {
    artifact: Artifact;
    root: ArtifactRoot;
    projectRoot: string;
    /** Where to open: the page and view the reader left, or the one a link asked for. `n` re-asks. */
    start: { page?: string; view?: string; scrollY?: number; n: number };
    focused?: boolean;
    onPlace?: (place: ArtifactPlace) => void;
    onOutline?: (items: OutlineEntry[]) => void;
    onFocus?: () => void;
    onClose: () => void;
    /** The reader allowed or withdrew the network for this artifact's folder. */
    onNetwork?: (allow: boolean) => void;
  } = $props();

  const encRel = (rel: string) => rel.split("/").map(encodeURIComponent).join("/");
  /** The root's address, ending in "/": every page's URL is this plus its path below the root. */
  const rootUrl = $derived((artifact.pages[0]?.url ?? "").slice(0, (artifact.pages[0]?.url ?? "").length - encRel(artifact.pages[0]?.rel ?? "").length));
  const urlOf = (page: string) => artifact.pages.find((p) => p.rel === page)?.url ?? rootUrl + encRel(page);

  let viewEl = $state<HTMLDivElement | undefined>(undefined);
  // Frames. A page is loaded into a NEW frame every time (assigning the same address to a frame
  // only moves within the page). The reader sees `shownKey`. A reload loads its frame UNDER the
  // one on screen and takes its place once the page has answered and scrolled to where the
  // reader was, so a page an agent keeps rewriting does not blink or jump.
  interface Frame { key: number; src: string }
  let frames = $state<Frame[]>([]);
  let shownKey = $state(0);
  let nextKey = 0;
  const frameEls = new Map<number, HTMLIFrameElement>();
  const track = (el: HTMLIFrameElement, key: number) => { frameEls.set(key, el); return { destroy() { frameEls.delete(key); } }; };
  const shownFrame = () => frameEls.get(shownKey);
  interface Incoming { key: number; y: number; ready: boolean; cap: ReturnType<typeof setTimeout>; settle?: ReturnType<typeof setTimeout>; page?: string; view?: string; title?: string; scrollY?: number; heading?: number; outline?: OutlineEntry[]; blocked: { count: number; first: string } }
  let incoming: Incoming | null = null;
  let place = $state<ArtifactPlace>({ page: "", view: "", title: "", scrollY: 0, heading: -1, selection: "" });
  let outline = $state<OutlineEntry[]>([]);
  let answered = $state(false);
  let restoreY = 0;
  let live = $state(true);
  let stale = $state(false);
  let pulse = $state(false);
  let blocked = $state<{ count: number; first: string }>({ count: 0, first: "" });
  let shielded = $state(false);
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  function dropIncoming() {
    if (!incoming) return;
    clearTimeout(incoming.cap);
    clearTimeout(incoming.settle);
    incoming = null;
  }
  /** Go to a page: nothing of the old one is worth keeping on screen. */
  function load(page: string, view: string, scrollY = 0) {
    dropIncoming();
    restoreY = scrollY;
    answered = false;
    blocked = { count: 0, first: "" };
    stale = false;
    outline = [];
    place = { page, view, title: "", scrollY, heading: -1, selection: "" };
    const key = ++nextKey;
    frames = [{ key, src: urlOf(page) + view }];
    shownKey = key;
  }
  /** Read the page again from disk, and come back to the same place in it. */
  export function reload() {
    const page = place.page || artifact.entry;
    const shown = frames.find((f) => f.key === shownKey);
    if (!answered || !shown) return load(page, place.view, place.scrollY);
    dropIncoming();
    stale = false;
    const key = ++nextKey;
    // However the new page behaves, the reader gets it within four seconds.
    incoming = { key, y: place.scrollY, ready: false, cap: setTimeout(() => swap(key), 4000), blocked: { count: 0, first: "" } };
    frames = [shown, { key, src: urlOf(page) + place.view }];
  }
  /** The reloaded page takes the place of the one on screen. */
  function swap(key: number) {
    const next = incoming;
    if (!next || next.key !== key) return;
    const hadKeyboard = document.activeElement === shownFrame();
    dropIncoming();
    shownKey = key;
    frames = frames.filter((f) => f.key === key);
    blocked = next.blocked;
    outline = next.outline ?? [];
    place = { page: next.page ?? place.page, view: next.view ?? place.view, title: next.title ?? place.title, scrollY: next.scrollY ?? next.y, heading: next.heading ?? -1, selection: "" };
    onOutline?.(outline);
    onPlace?.(place);
    if (hadKeyboard) queueMicrotask(() => shownFrame()?.focus());
  }
  export function jump(index: number) {
    shownFrame()?.contentWindow?.postMessage({ fluxArtifact: 1, type: "jump", index }, "*");
  }
  export function focusFrame() {
    shownFrame()?.focus();
  }

  // A start (first mount, or a link into this artifact) loads; the page's own reports never do.
  let seenStart = -1;
  $effect(() => {
    const s = start;
    if (s.n === seenStart) return;
    seenStart = s.n;
    untrack(() => load(s.page && (artifact.kind === "folder" || s.page === artifact.entry) ? s.page : artifact.entry, s.view ?? "", s.scrollY ?? 0));
  });

  // The frame gets an origin of its own in the app. In the dev fixture a page is same-site with
  // the app, so there it is sandboxed into an opaque origin instead.
  const ownOrigin = $derived.by(() => {
    try { return new URL(rootUrl, location.href).origin !== location.origin; } catch { return false; }
  });
  const sandbox = $derived(`allow-scripts allow-forms allow-downloads allow-pointer-lock${ownOrigin ? " allow-same-origin" : ""}`);

  /** What the page being reloaded says while it is still under the one on screen. */
  function onIncoming(m: NonNullable<ReturnType<typeof parseFrameMessage>>, next: Incoming, frame: HTMLIFrameElement) {
    if (m.type === "ready" || m.type === "state") {
      next.page = relOfFramePath(rootUrl, m.path, location.href) ?? next.page;
      next.view = m.view;
      next.title = m.title;
      if (m.type === "ready") {
        next.ready = true;
        if (next.y > 0) frame.contentWindow?.postMessage({ fluxArtifact: 1, type: "scroll", y: next.y }, "*");
        // A page still filling itself in may not be tall enough yet: wait for it, but not long.
        clearTimeout(next.settle);
        next.settle = setTimeout(() => swap(next.key), next.y > 0 ? 1500 : 60);
        return;
      }
      next.scrollY = m.scrollY;
      next.heading = m.heading;
      if (next.ready && next.y > 0 && Math.abs(m.scrollY - next.y) <= 2) { clearTimeout(next.settle); next.settle = setTimeout(() => swap(next.key), 40); }
    } else if (m.type === "outline") next.outline = m.items;
    else if (m.type === "blocked") next.blocked = { count: next.blocked.count + 1, first: next.blocked.first || blockedHost(m.uri) };
  }
  const blockedHost = (uri: string) => { try { return new URL(uri).host || uri; } catch { return uri; /* a scheme only ("data", "eval"): say that */ } };

  function onMessage(e: MessageEvent) {
    const frameEl = shownFrame();
    const under = incoming ? frameEls.get(incoming.key) : undefined;
    if (incoming && under && e.source === under.contentWindow) {
      const m = parseFrameMessage(e.data);
      if (m) onIncoming(m, incoming, under);
      return;
    }
    if (!frameEl || e.source !== frameEl.contentWindow) return;
    const m = parseFrameMessage(e.data);
    if (!m) return;
    if (m.type === "ready" || m.type === "state") {
      const page = relOfFramePath(rootUrl, m.path, location.href) ?? place.page;
      const next: ArtifactPlace = { ...place, page, view: m.view, title: m.title };
      if (m.type === "state") { next.scrollY = m.scrollY; next.heading = m.heading; }
      if (m.type === "ready") {
        answered = true;
        if (page !== place.page) { next.selection = ""; next.heading = -1; }
        if (restoreY > 0) frameEl.contentWindow?.postMessage({ fluxArtifact: 1, type: "scroll", y: restoreY }, "*");
        restoreY = 0;
      }
      place = next;
      onPlace?.(next);
    } else if (m.type === "outline") {
      outline = m.items;
      onOutline?.(m.items);
    } else if (m.type === "selection") {
      place = { ...place, selection: m.text };
      onPlace?.(place);
    } else if (m.type === "key") {
      // The page has the keyboard, and the app's chords still work: the frame hands them over.
      if (appChord(m)) frameEl.dispatchEvent(new KeyboardEvent("keydown", { key: m.key, code: m.code, ctrlKey: m.ctrlKey, metaKey: m.metaKey, altKey: m.altKey, shiftKey: m.shiftKey, repeat: m.repeat, bubbles: true, cancelable: true }));
    } else if (m.type === "pointer") {
      onFocus?.();
      // A press in the page is a press outside every menu and card of the app.
      frameEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    } else if (m.type === "open") {
      void fileBridge()?.openExternal?.(m.url);
    } else if (m.type === "blocked") {
      blocked = { count: blocked.count + 1, first: blocked.first || blockedHost(m.uri) };
    }
  }

  // Files of this artifact changed on disk: read the page again once the writing has stopped.
  let seenChange = -1;
  $effect(() => {
    const change = $artifactChange;
    if (!change || change.n === seenChange) return;
    seenChange = change.n;
    if (!changeTouches(artifact, change.paths)) return;
    untrack(() => {
      if (!live) { stale = true; return; }
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        reload();
        pulse = true;
        clearTimeout(pulseTimer);
        pulseTimer = setTimeout(() => (pulse = false), 1400);
      }, 500);
    });
  });

  // While the pointer drags something of the app's (a panel edge), the frame must not swallow it.
  function shield(e: PointerEvent) {
    if (e.target instanceof HTMLIFrameElement && viewEl?.contains(e.target)) return;
    shielded = true;
  }
  const unshield = () => (shielded = false);

  function target(): TargetRef {
    const page = place.page || artifact.entry;
    return {
      kind: "artifact", path: pageRef(artifact, page), ...(place.view ? { view: place.view } : {}), title: place.title || artifact.title,
      ...(outline[place.heading]?.text ? { heading: outline[place.heading].text } : {}), ...(place.selection ? { quote: place.selection } : {}),
    };
  }
  const unregister = registerTargetResolver({
    surface: "paper",
    root: () => viewEl ?? null,
    revision: () => [place.page, place.view, place.scrollY, place.selection, shownKey],
    current: () => (focused ? [target()] : []),
    at: () => { const ref = target(), frame = shownFrame(); return frame ? [{ ref, bounds: boundsOf(frame), label: describeTarget(ref) }] : []; },
    within: (rect) => { const ref = target(); return [{ ref, bounds: rect, label: describeTarget(ref) }]; },
  });
  onDestroy(() => { unregister(); dropIncoming(); clearTimeout(settleTimer); clearTimeout(pulseTimer); });

  const pagePath = $derived(artifact.pages.find((p) => p.rel === place.page)?.path ?? artifact.pages[0]?.path ?? "");
  const pageName = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1).replace(/\.html?$/i, "");
  const where = $derived(pageRef(artifact, place.page || artifact.entry));
  function toggleNetwork() {
    const allow = !root.network;
    void fileBridge()?.artifactsSetNetwork?.(projectRoot, root.dir, allow).then(() => { onNetwork?.(allow); reload(); });
  }
</script>

<svelte:window onmessage={onMessage} onpointerdowncapture={shield} onpointerup={unshield} onpointercancel={unshield} onblur={unshield} />

<div class="aview" bind:this={viewEl} data-artifact={artifact.id} data-artifact-page={place.page} data-artifact-view={place.view} data-artifact-ready={answered} data-artifact-load={shownKey}>
  <header class="strip">
    <span class="glyph" aria-hidden="true">
      <svg viewBox="0 0 20 20" width="16" height="16"><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="M2.5 7.5h15" /><path d="M6 11.5l2.2 2-2.2 2M10.5 15.5h3.5" transform="translate(0 -2.2)" /></svg>
    </span>
    <span class="title" title={where}>{place.title || artifact.title}</span>
    {#if artifact.pages.length > 1}
      <span class="pages" role="tablist" aria-label="Pages of this artifact">
        {#each artifact.pages as p (p.rel)}
          <button class="page" class:on={p.rel === place.page} role="tab" aria-selected={p.rel === place.page} title={p.rel} onclick={() => load(p.rel, "")}>{pageName(p.rel)}</button>
        {/each}
      </span>
    {/if}
    {#if place.view}<span class="viewchip" title="Where in the page you are: the page's own address. A comment made here says it.">{place.view.length > 34 ? place.view.slice(0, 33) + "…" : place.view}</span>{/if}
    <span class="grow"></span>
    {#if blocked.count && !root.network}
      <button class="notice" title={`This page asked for ${blocked.count === 1 ? "something" : `${blocked.count} things`} it may not load (${blocked.first}). Artifacts are kept off the network; click to allow it for this folder.`} onclick={toggleNetwork}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="8" r="5.6" /><path d="M4 12L12 4" /></svg>{blocked.count} blocked
      </button>
    {/if}
    <span class="keys">
      {#if root.network}
        <button class="key lit" aria-pressed="true" aria-label="Network allowed for this folder" title="Pages of this folder may reach the network. Click to keep them off it again." onclick={toggleNetwork}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.6" /><path d="M2.4 8h11.2M8 2.4c2 2 2 9.2 0 11.2M8 2.4c-2 2-2 9.2 0 11.2" /></svg>
        </button>
      {/if}
      <button class="key" class:lit={live} class:pulse aria-pressed={live} aria-label="Follow changes on disk" title={live ? "Following the files: the page reloads when they change, and stays where you are. Click to hold it still." : "Held still. Click to follow the files again."} onclick={() => { live = !live; if (live && stale) reload(); }}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle class="dot" cx="8" cy="8" r="2.2" /><path d="M4.6 4.6a4.8 4.8 0 0 0 0 6.8M11.4 4.6a4.8 4.8 0 0 1 0 6.8" /></svg>
      </button>
      <button class="key" class:due={stale} aria-label="Reload the page" title={stale ? "The files changed. Reload" : "Reload from disk"} onclick={reload}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M12.6 8a4.6 4.6 0 1 1-1.4-3.3M12.8 2.6v2.6h-2.6" /></svg>
      </button>
      {#if fileBridge()?.artifactsOpenInBrowser}
        <button class="key" aria-label="Open in the browser" title="Open this page in your browser" onclick={() => void fileBridge()?.artifactsOpenInBrowser?.(projectRoot, pagePath)}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.500a1 1 0 0 1 1-1h2.5" /></svg>
        </button>
        <button class="key" aria-label="Show the folder" title={`Show in the file manager: ${artifact.dir}`} onclick={() => void fileBridge()?.artifactsReveal?.(projectRoot, pagePath)}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 4.500h4l1.4 1.500H14v6.500H2z" /></svg>
        </button>
      {/if}
      <button class="key close" aria-label="Back to the document" title="Back to the document (Alt+H)" onclick={onClose}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
    </span>
  </header>
  <div class="stage" class:shielded>
    {#each frames as f (f.key)}
      <iframe use:track={f.key} class:under={f.key !== shownKey} title={artifact.title} src={f.src} {sandbox} allow="clipboard-write; fullscreen" referrerpolicy="no-referrer"></iframe>
    {/each}
  </div>
</div>

<style>
  .aview { position: absolute; inset: 0; display: flex; flex-direction: column; min-width: 0; border-radius: inherit; overflow: hidden; background: var(--flx-paper); color: var(--c-tx); }
  /* The strip: what the page is, set like the document's title; its keys at the far end. */
  .strip { flex: none; display: flex; align-items: center; gap: 10px; height: 38px; padding: 0 8px 0 14px; border-bottom: 1px solid var(--c-line-strong); background: var(--flx-paper); min-width: 0; }
  .glyph { flex: none; display: grid; place-items: center; color: var(--c-accent); }
  .glyph svg, .key svg, .notice svg { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
  .title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: italic 600 15px/1.3 var(--font-serif); color: var(--c-tx-hi); }
  .pages { flex: none; display: flex; gap: 2px; padding: 2px; border: 1px solid var(--c-line-strong); border-radius: var(--r-2); }
  .page { height: 22px; padding: 0 9px; border: 0; border-radius: var(--r-1); background: transparent; color: var(--c-tx-muted); font: 600 11px/1 var(--font-mono); letter-spacing: .02em; cursor: var(--cursor-cross-hover); transition: background 70ms linear, color 70ms linear; }
  .page:hover { background: var(--c-accent-tint-2); color: var(--c-tx-hi); }
  .page.on { background: var(--c-accent-tint); color: var(--c-accent); }
  .viewchip { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 7px; border-radius: var(--r-pill); background: color-mix(in oklab, var(--c-tx) 6%, transparent); color: var(--c-tx-muted); font: 11px/1.4 var(--font-mono); }
  .grow { flex: 1 1 0; }
  .notice { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border: 1px solid color-mix(in oklab, var(--c-warning) 55%, transparent); border-radius: var(--r-pill); background: color-mix(in oklab, var(--c-warning) 9%, transparent); color: var(--c-warning); font: 600 11px/1 var(--font-mono); cursor: var(--cursor-cross-hover); }
  .notice:hover { background: color-mix(in oklab, var(--c-warning) 17%, transparent); }
  /* Small paper keys: a mark each, lit when on. */
  .keys { flex: none; display: flex; gap: 3px; }
  .key { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 1px solid transparent; border-radius: var(--r-1); background: transparent; color: var(--c-tx-muted); cursor: var(--cursor-cross-hover); transition: background 70ms linear, color 70ms linear, border-color 70ms linear; }
  .key:hover { background: var(--c-accent-tint-2); color: var(--c-tx-hi); border-color: var(--c-line-strong); }
  .key:active { background: var(--c-accent-tint); }
  .key.lit { color: var(--c-accent); }
  .key.lit .dot { fill: currentColor; stroke: none; }
  .key .dot { fill: none; }
  .key.pulse { background: var(--c-accent-tint); border-color: color-mix(in oklab, var(--c-accent) 55%, transparent); }
  .key.due { color: var(--c-warning); border-color: color-mix(in oklab, var(--c-warning) 55%, transparent); }
  .key.close:hover { color: var(--c-danger); background: color-mix(in oklab, var(--c-danger) 9%, transparent); }
  .key:focus-visible, .page:focus-visible, .notice:focus-visible { outline: 2px solid var(--c-accent); outline-offset: -2px; }
  .stage { position: relative; flex: 1 1 auto; min-height: 0; background: #fff; }
  .stage.shielded iframe { pointer-events: none; }
  iframe { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; border: 0; display: block; background: #fff; }
  /* A reloading page waits under the one on screen: in view (so it lays out and paints), unseen. */
  iframe.under { z-index: 0; }
</style>

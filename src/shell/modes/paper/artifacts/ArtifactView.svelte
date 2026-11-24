<script lang="ts">
  // One artifact in Paper's centre card: a strip that says what the page is and holds its few
  // keys, and under it the page itself in a frame of its own origin and its own process. Nothing
  // of the page runs in Flux; what the app knows of it (where the reader is, the outline, the
  // selected words) arrives as messages and is parsed as untrusted data (frameProtocol.ts).
  import { onDestroy, untrack } from "svelte";
  import { fileBridge } from "../../../../lib/project/types";
  import { artifactChange } from "../../../../lib/artifacts/artifactStore";
  import { changeTouches, pageRef } from "../../../../lib/artifacts/tree";
  import { parseFrameMessage, appChord, relOfFramePath, type FrameRect, type OutlineEntry } from "../../../../lib/artifacts/frameProtocol";
  import { artifactThreads, commentTarget, linkedPage, markRect, pageAnchors, anchorOf, threadPlace, type ArtifactTarget, type ArtifactThread } from "../../../../lib/artifacts/comments";
  import { inboxItems, initInboxStore, refreshInbox, changeInboxItem } from "../../../inbox/inboxStore";
  import { requestInbox } from "../../../inbox/inboxState";
  import { addAnnotation, rememberRoute } from "../../../agent/annotationStore";
  import { describeRoute, type Route } from "../../../../lib/project/annotations";
  import type { FeedbackSnapshot } from "../../../../lib/project/annotationCapture";
  import { buildContextStamp } from "../../../../lib/bridge/contextStamp";
  import { settings } from "../../../../lib/settings";
  import { pushToast, errMsg } from "../../../../lib/toast";
  import FluxAiMark from "../../../agent/FluxAiMark.svelte";
  import ArtifactCard from "./ArtifactCard.svelte";
  import ArtifactThreadView from "./ArtifactThreadView.svelte";
  import ArtifactCommentsRail from "./ArtifactCommentsRail.svelte";
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
    card = null; draft = null; selection = null; picking = false; found = new Map(); asked = "";
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
  /** Read the page again from disk, and come back to the same place in it (on `view`, when one is asked for). */
  export function reload(view: string = place.view) {
    const page = place.page || artifact.entry;
    const shown = frames.find((f) => f.key === shownKey);
    if (!answered || !shown) return load(page, view, place.scrollY);
    dropIncoming();
    stale = false;
    const key = ++nextKey;
    // However the new page behaves, the reader gets it within four seconds.
    incoming = { key, y: place.scrollY, ready: false, cap: setTimeout(() => swap(key), 4000), blocked: { count: 0, first: "" } };
    frames = [shown, { key, src: urlOf(page) + view }];
  }
  /** Take the artifact to a page and a view of it: another page loads; another view of this one swaps in. */
  function go(page: string, view: string) {
    closeCard();
    if (page !== place.page || !answered) load(page, view);
    else if (view !== place.view) reload(view);
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
    // A new copy of the page: nothing is selected in it, and it has not yet said where the comments are.
    selection = null; picking = false; found = new Map();
    if (card) { revealing = card.id; card = null; }
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
      selection = m.text && m.rect ? { text: m.text, rect: m.rect, prefix: m.prefix, suffix: m.suffix, heading: m.heading } : null;
      onPlace?.(place);
    } else if (m.type === "anchors") {
      found = new Map(m.items.map((a) => [a.id, a.found]));
      // A comment the reader asked to be shown: now that the page has found it, go to it.
      if (revealing && found.get(revealing)) post({ type: "active", id: revealing, reveal: true });
    } else if (m.type === "anchor") {
      onAnchor(m.id, m.how, m.rect);
    } else if (m.type === "pick") {
      picking = false;
      if (!m.cancel) void beginDraft(commentTarget(base(), { selector: m.selector, tag: m.tag, plot: m.plot, label: m.label, text: m.text, heading: m.heading, point: m.point }), m.rect);
    } else if (m.type === "key") {
      // The page has the keyboard, and the app's chords still work: the frame hands them over.
      // (A page cannot hold a key down faster than a person: more than that is not a person.)
      const now = performance.now();
      chordTimes = chordTimes.filter((t) => now - t < 1000);
      if (chordTimes.length >= 24) return;
      chordTimes.push(now);
      if (commentChord(m)) return startComment();
      if (appChord(m)) frameEl.dispatchEvent(new KeyboardEvent("keydown", { key: m.key, code: m.code, ctrlKey: m.ctrlKey, metaKey: m.metaKey, altKey: m.altKey, shiftKey: m.shiftKey, repeat: m.repeat, bubbles: true, cancelable: true }));
    } else if (m.type === "pointer") {
      onFocus?.();
      // A press in the page is a press outside every menu and card of the app.
      frameEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      // …and outside an open comment card, unless the press is on that comment's own mark (the
      // page says so a moment later).
      if (card?.pinned) closeSoon(160);
    } else if (m.type === "open") {
      // A page may ask for a link to open in the browser; whether it does is the reader's call
      // unless they already let this folder onto the network. (A page is a program: it could
      // ask without anyone having clicked anything.)
      if (root.network) void fileBridge()?.openExternal?.(m.url);
      else { asked = m.url; clearTimeout(askedTimer); askedTimer = setTimeout(() => (asked = ""), 15000); }
    } else if (m.type === "blocked") {
      blocked = { count: blocked.count + 1, first: blocked.first || blockedHost(m.uri) };
    }
  }

  // ---- comments on the page ------------------------------------------------------------------
  // A comment is an Inbox item whose target is this page (lib/artifacts/comments.ts): the Inbox
  // store is the one source, so an agent's claim, answer or resolve shows here the moment the
  // ledger changes. The page finds each comment's passage or element and draws it; the cards and
  // the rail are the app's.
  let stageEl = $state<HTMLDivElement | undefined>(undefined);
  let selection = $state<{ text: string; rect: FrameRect; prefix?: string; suffix?: string; heading?: string } | null>(null);
  let found = $state<Map<string, boolean>>(new Map());
  let card = $state<{ id: string; rect: FrameRect; pinned: boolean } | null>(null);
  let draft = $state<{ target: ArtifactTarget; rect: FrameRect; png: Uint8Array | null; snapshot: FeedbackSnapshot | null } | null>(null);
  let picking = $state(false);
  let busy = $state(false);
  let revealing = "";
  let asked = $state("");
  let askedTimer: ReturnType<typeof setTimeout> | undefined;
  let chordTimes: number[] = [];
  const RAIL_KEY = "flux.paper.artifactComments";
  let railOpen = $state((() => { try { return localStorage.getItem(RAIL_KEY) === "1"; } catch { return false; } })());
  const DRAFT = "draft";
  // The Inbox store refreshes itself whenever the ledger changes; nothing here polls it. (Holding
  // it as the open Inbox does would re-read every comment of the project every five seconds for
  // as long as a page is on screen.)
  initInboxStore();
  void refreshInbox();
  const threads = $derived(artifactThreads($inboxItems, artifact));
  const openCount = $derived(threads.filter((t) => !t.resolved).length);
  const cardThread = $derived(card ? threads.find((t) => t.id === card!.id) ?? null : null);
  const post = (message: Record<string, unknown>) => shownFrame()?.contentWindow?.postMessage({ fluxArtifact: 1, ...message }, "*");
  const base = () => ({ path: pageRef(artifact, place.page || artifact.entry), view: place.view, title: place.title || artifact.title });

  // What the page should mark: the open comments of the page on screen, and the one being written.
  const anchors = $derived([...pageAnchors(threads, place.page), ...(draft ? [anchorOf({ id: DRAFT, target: draft.target })].flatMap((a) => a ?? []) : [])]);
  $effect(() => {
    const items = anchors, color = $settings.paperCommentColor;
    void shownKey;
    if (!answered) return;
    untrack(() => post({ type: "anchors", items, color }));
  });

  export function toggleComments() {
    railOpen = !railOpen;
    try { localStorage.setItem(RAIL_KEY, railOpen ? "1" : "0"); } catch { /* private mode */ }
  }
  /** Start a comment on the words selected in the page (the bubble's button, or Ctrl+Alt+M). */
  export function startComment() {
    const sel = selection;
    if (!sel || draft) { if (!draft) pushToast("info", "Select words in the page to comment on them", { detail: "For a plot or a figure, use the comment key in the strip and click it." }); return; }
    void beginDraft(commentTarget(base(), { quote: sel.text, prefix: sel.prefix, suffix: sel.suffix, heading: sel.heading }), sel.rect);
  }
  export function togglePick() {
    picking = !picking;
    if (picking) { closeCard(); shownFrame()?.focus(); }
    post({ type: "pick", on: picking });
  }
  /** The picture a comment carries: the page as it is when the comment is begun, its subject boxed. */
  async function picture(target: ArtifactTarget, rect: FrameRect): Promise<{ png: Uint8Array | null; snapshot: FeedbackSnapshot | null }> {
    const fb = fileBridge(), stage = stageEl;
    if (!fb?.captureWindow || !stage) return { png: null, snapshot: null };
    try {
      const box = stage.getBoundingClientRect();
      // Two frames: the bubble that was clicked is gone from the window before it is pictured.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const shot = await fb.captureWindow({ x: box.left, y: box.top, width: box.width, height: box.height });
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(shot.png)], { type: "image/png" }));
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return { png: null, snapshot: null };
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const mark = markRect(rect, { x: box.left, y: box.top }, { w: box.width, h: box.height });
      if (mark) {
        const k = canvas.width / box.width;
        const x = (mark.x - box.left) * k - 4, y = (mark.y - box.top) * k - 4, w = mark.w * k + 8, h = mark.h * k + 8;
        for (const [color, width] of [["rgba(255,255,255,0.92)", 5], ["#ff2bd6", 2.5]] as const) {
          ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.roundRect(x, y, w, h, 5); ctx.stroke();
        }
      }
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) return { png: null, snapshot: null };
      const window_ = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
      const crop = { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) };
      return { png: new Uint8Array(await blob.arrayBuffer()), snapshot: { image: null, rect: crop, window: window_, marks: mark ? [{ kind: "box", n: 1, points: [[mark.x, mark.y], [mark.x + mark.w, mark.y + mark.h]], targets: [target] }] : [] } };
    } catch { return { png: null, snapshot: null }; }
  }
  async function beginDraft(target: ArtifactTarget, rect: FrameRect) {
    if (draft || busy) return;
    busy = true;
    closeCard();
    selection = null;
    const key = shownKey;
    const shot = await picture(target, rect);
    busy = false;
    if (key !== shownKey) return; // the page was replaced while it was being pictured
    draft = { target, rect, ...shot };
    post({ type: "unselect" });
  }
  async function sendDraft(text: string, route: Route) {
    const d = draft;
    if (!d || !text.trim()) return;
    draft = null;
    try {
      // Plain copies: what is saved goes through structuredClone, which refuses a reactive proxy.
      const target = $state.snapshot(d.target) as ArtifactTarget, snapshot = $state.snapshot(d.snapshot) as FeedbackSnapshot | null;
      const context = buildContextStamp({ targets: [target] });
      context.surface = "paper";
      delete context.doc;
      context.artifact = { path: target.path, view: target.view ?? "", title: target.title ?? artifact.title, ...(target.heading ? { heading: target.heading } : {}), ...(target.quote ? { quote: target.quote } : {}) };
      context.snapshot = snapshot;
      await addAnnotation(text, context, $state.snapshot(route) as Route, { png: d.png });
      rememberRoute(route);
      const to = describeRoute(route);
      pushToast("success", typeof route === "object" && "background" in route ? `${to.replace(/^New /, "")} is starting on it` : to === "Inbox" ? "Comment added to the Inbox" : `Comment sent to ${to}`, { action: { label: "Open", run: () => requestInbox() } });
    } catch (e) {
      draft = d;
      pushToast("error", "The comment was not saved", { detail: errMsg(e) });
    }
  }
  function act(thread: ArtifactThread, action: "reply" | "resolve" | "reopen" | "withdraw" | "archive", text = "") {
    void changeInboxItem(thread.item, action, text).catch((e) => pushToast("error", "That did not go through", { detail: errMsg(e) }));
    if (action === "withdraw" || action === "archive") closeCard();
  }
  // A comment's card: it opens when the pointer rests on the comment's mark, stays while the
  // pointer is on the mark or in the card, and stays put once it is clicked or worked in.
  let cardHover = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  function closeCard() {
    clearTimeout(closeTimer);
    if (!card) return;
    card = null;
    revealing = "";
    post({ type: "active", id: "" });
  }
  function closeSoon(ms = 240) {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!cardHover || !card?.pinned) closeCard(); }, ms);
  }
  function onAnchor(id: string, how: "hover" | "click" | "move" | "leave", rect?: FrameRect) {
    if (how === "leave") { if (card && !card.pinned && !cardHover) closeSoon(); return; }
    if (!rect) return;
    if (id === DRAFT) { if (draft && how === "move") draft = { ...draft, rect }; return; }
    if (how === "move") {
      if (card?.id === id) card = { ...card, rect };
      else if (revealing === id) { revealing = ""; card = { id, rect, pinned: true }; }
      return;
    }
    if (draft || !threads.some((t) => t.id === id)) return;
    clearTimeout(closeTimer);
    if (how === "hover" && card?.pinned) return;
    card = { id, rect, pinned: how === "click" || (card?.id === id && card.pinned) };
    post({ type: "active", id });
  }
  /** Take the page to a comment: its page, then its view, then its passage, and open its card there. */
  function show(thread: ArtifactThread) {
    closeCard();
    revealing = thread.id;
    if (thread.page !== place.page) load(thread.page, thread.view);
    else if (!found.get(thread.id) && thread.view !== place.view) reload(thread.view);
    else post({ type: "active", id: thread.id, reveal: true });
  }
  function outsidePress(e: MouseEvent) {
    const t = e.target;
    if (!(t instanceof Element) || t.closest(".artifact-card, .arail, .sel-bubble") || t instanceof HTMLIFrameElement) return;
    if (card?.pinned) closeCard();
  }
  const bubbleAt = $derived.by(() => {
    const sel = selection, stage = stageEl;
    if (!sel || !stage || draft || picking || busy) return null;
    const box = stage.getBoundingClientRect();
    if (sel.rect.y + sel.rect.h < 0 || sel.rect.y > box.height) return null;
    const above = sel.rect.y > 44;
    return { x: Math.round(box.left + Math.min(box.width - 60, Math.max(60, sel.rect.x + sel.rect.w / 2))), y: Math.round(box.top + (above ? Math.max(0, sel.rect.y) - 8 : Math.min(box.height, sel.rect.y + sel.rect.h) + 8)), above };
  });
  const placeOf = (t: ArtifactThread) => threadPlace(t, place.page, place.view, found);
  /** Ctrl+Alt+M (and with Shift): Paper's "comment on the selection", here on the page's. */
  const commentChord = (e: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) => e.code === "KeyM" && e.altKey && (e.ctrlKey || e.metaKey);
  const askedHost = $derived.by(() => { try { return new URL(asked).host || asked; } catch { return asked; } });

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
  onDestroy(() => { unregister(); dropIncoming(); clearTimeout(settleTimer); clearTimeout(pulseTimer); clearTimeout(closeTimer); clearTimeout(askedTimer); });

  const pagePath = $derived(artifact.pages.find((p) => p.rel === place.page)?.path ?? artifact.pages[0]?.path ?? "");
  const pageName = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1).replace(/\.html?$/i, "");
  const where = $derived(pageRef(artifact, place.page || artifact.entry));
  function toggleNetwork() {
    const allow = !root.network;
    void fileBridge()?.artifactsSetNetwork?.(projectRoot, root.dir, allow).then(() => { onNetwork?.(allow); reload(); });
  }
</script>

<svelte:window onmessage={onMessage} onmousedown={outsidePress} onpointerdowncapture={shield} onpointerup={unshield} onpointercancel={unshield} onblur={unshield} />

{#snippet threadRow(t: ArtifactThread, where: import("../../../../lib/artifacts/comments").ThreadPlace, inRail: boolean = true)}
  <ArtifactThreadView thread={t} place={where} {inRail}
    onReply={(text) => act(t, "reply", text)} onResolve={() => act(t, "resolve")} onReopen={() => act(t, "reopen")}
    onDelete={() => act(t, t.item.thread[0]?.kind === "human" ? "withdraw" : "archive")}
    onGo={() => show(t)} onLink={(view, page) => go(linkedPage(t.page, page), view)} onInbox={() => requestInbox(t.id)} onFocus={() => { if (where === "here") post({ type: "active", id: t.id, reveal: true }); }} />
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="aview" bind:this={viewEl} onkeydown={(e) => { if (commentChord(e)) { e.preventDefault(); e.stopPropagation(); startComment(); } }} data-artifact={artifact.id} data-artifact-page={place.page} data-artifact-view={place.view} data-artifact-ready={answered} data-artifact-load={shownKey} data-artifact-comments={openCount} data-artifact-found={[...found].filter(([, ok]) => ok).length}>
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
    {#if asked}
      <span class="ask">
        <button class="notice link" title={`This page wants to open ${asked} in your browser. Click to open it.`} onclick={() => { void fileBridge()?.openExternal?.(asked); asked = ""; }}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5" /></svg>Open {askedHost.length > 28 ? askedHost.slice(0, 27) + "…" : askedHost}
        </button>
      </span>
    {/if}
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
      <button class="key wide" class:lit={railOpen} aria-pressed={railOpen} aria-label="Comments on this artifact" title={`Comments on this artifact (Alt+A)${openCount ? `: ${openCount} open` : ""}`} onclick={toggleComments}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 3.5h11v7.5H7l-3 2.500V11H2.500z" /></svg>{#if openCount}<span class="n">{openCount}</span>{/if}
      </button>
      <button class="key" class:lit={picking} aria-pressed={picking} aria-label="Comment on a part of the page" title={picking ? "Click a plot, a figure or any part of the page to comment on it (Esc to stop)" : "Comment on a plot, a figure or any part of the page: click this, then click it. For words, select them."} onclick={togglePick}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.500v3M8 11.500v3M1.500 8h3M11.500 8h3" /><circle cx="8" cy="8" r="2.600" /></svg>
      </button>
      <span class="ksep" aria-hidden="true"></span>
      <button class="key" class:lit={live} class:pulse aria-pressed={live} aria-label="Follow changes on disk" title={live ? "Following the files: the page reloads when they change, and stays where you are. Click to hold it still." : "Held still. Click to follow the files again."} onclick={() => { live = !live; if (live && stale) reload(); }}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle class="dot" cx="8" cy="8" r="2.2" /><path d="M4.6 4.6a4.8 4.8 0 0 0 0 6.8M11.4 4.6a4.8 4.8 0 0 1 0 6.8" /></svg>
      </button>
      <button class="key" class:due={stale} aria-label="Reload the page" title={stale ? "The files changed. Reload" : "Reload from disk"} onclick={() => reload()}>
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
  <div class="body">
    <div class="stage" class:shielded bind:this={stageEl}>
      {#each frames as f (f.key)}
        <iframe use:track={f.key} class:under={f.key !== shownKey} title={artifact.title} src={f.src} {sandbox} allow="clipboard-write; fullscreen" referrerpolicy="no-referrer"></iframe>
      {/each}
    </div>
    {#if railOpen}
      <ArtifactCommentsRail {threads} {placeOf} activeId={card?.id ?? ""} row={threadRow} onPick={togglePick} onClose={toggleComments} />
    {/if}
  </div>
  {#if bubbleAt}
    <div class="sel-bubble" class:below={!bubbleAt.above} data-selected={selection?.text.slice(0, 60)} style:left={`${bubbleAt.x}px`} style:top={`${bubbleAt.y}px`}>
      <button onmousedown={(e) => { e.preventDefault(); startComment(); }} title="Comment on these words: it goes to the AI Inbox (Ctrl+Alt+M)"><FluxAiMark still size={13} tone="live" /><span>Comment</span></button>
    </div>
  {/if}
  {#if draft && stageEl}
    <ArtifactCard rect={draft.rect} stage={stageEl} pinned id={DRAFT} onClose={() => (draft = null)}>
      <ArtifactThreadView draft={draft.target} lead onSend={(text, route) => void sendDraft(text, route)} onCancel={() => (draft = null)} />
    </ArtifactCard>
  {:else if card && cardThread && stageEl}
    {#key card.id}
      <ArtifactCard rect={card.rect} stage={stageEl} pinned={card.pinned} id={card.id} onenter={() => { cardHover = true; clearTimeout(closeTimer); }} onleave={() => { cardHover = false; if (card && !card.pinned) closeSoon(); }}
        onpin={() => { if (card && !card.pinned) card = { ...card, pinned: true }; }} onClose={closeCard}>
        {@render threadRow(cardThread, placeOf(cardThread), false)}
      </ArtifactCard>
    {/key}
  {/if}
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
  .body { flex: 1 1 auto; min-height: 0; display: flex; }
  .stage { position: relative; flex: 1 1 auto; min-width: 0; background: #fff; }
  /* The comment key carries how many are open; a hairline parts the comment keys from the page's. */
  .key.wide { width: auto; min-width: 26px; padding: 0 5px; grid-auto-flow: column; gap: 4px; }
  .key .n { font: 600 10px/1 var(--font-mono); font-variant-numeric: tabular-nums; }
  .ksep { width: 1px; margin: 5px 3px; background: var(--c-line-strong); }
  .notice.link { border-color: color-mix(in oklab, var(--c-accent) 50%, transparent); background: color-mix(in oklab, var(--c-accent) 8%, transparent); color: var(--c-accent); font-family: var(--font-serif); font-weight: 600; }
  .notice.link:hover { background: color-mix(in oklab, var(--c-accent) 16%, transparent); }
  .ask { flex: none; display: flex; }
  /* On selected words: one small key, the selection toolbar's make. */
  .sel-bubble { position: fixed; z-index: 60; transform: translate(-50%, -100%); padding: 3px; border: 1px solid var(--c-line-strong); border-radius: var(--r-2); background: var(--c-surface-2); box-shadow: var(--elev-2); }
  .sel-bubble.below { transform: translate(-50%, 0); }
  .sel-bubble button { display: inline-flex; align-items: center; gap: 6px; height: 27px; padding: 0 10px 0 7px; border: 0; border-radius: var(--r-1); background: transparent; color: var(--c-tx-2); font: 600 12px/1 var(--font-serif); cursor: var(--cursor-cross-hover); transition: background 70ms linear, color 70ms linear; }
  .sel-bubble button:hover { background: var(--c-ui-hover); color: var(--c-tx-hi); }
  .stage.shielded iframe { pointer-events: none; }
  iframe { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; border: 0; display: block; background: #fff; }
  /* A reloading page waits under the one on screen: in view (so it lays out and paints), unseen. */
  iframe.under { z-index: 0; }
</style>

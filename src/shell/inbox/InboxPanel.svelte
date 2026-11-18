<script lang="ts">
  // The Inbox: what needs you, what is moving, what is done — with proof. One list
  // of annotations and margin comments (virtualised above 200 rows), one detail
  // pane that reads as a conversation: the original note in the manuscript's
  // serif with its marked picture, replies rendered through the shared inert
  // Markdown renderer, agents marked by their seed, "Waiting for you" in the
  // annotation gold, a background run's live card in the thread, and one action
  // bar. Filters, status folds, sorting and packets stay in the pure cores.
  //
  // 2026-11-18 refinement (owner: "an even better, even more pleasant and visually
  // more refined part of flux"): the Flux AI header with the turning mark; rows
  // that show two lines of the note; a picture shown whole; the keys drawn on the
  // buttons they press; tags that filter; state as colour, with nothing breathing.
  import { fullscreenPortal } from "../../lib/ui/portal";
  import { onDestroy, onMount, tick } from "svelte";
  import { get } from "svelte/store";
  import { currentProject } from "../shellStore";
  import { inboxOpen, inboxDetached, inboxSelection, inboxQuery, inboxDrafts, inboxCloseRequest, inboxFocusRequest, isInboxChord } from "./inboxState";
  import { inboxItems, inboxDocuments, inboxSessionIds, inboxError, inboxLoaded, changeInboxItem, refreshInbox } from "./inboxStore";
  import { annotationOpen, requestAnnotation, isAnnotateChord } from "../agent/annotateChord";
  import { parseInboxQuery, describeFilter, resolveInboxFilter, filterInbox, sortForInbox, toPacket, type InboxItem } from "../../lib/project/inbox";
  import { describeTarget, shortTarget } from "../../lib/project/targets";
  import { navigateToStamp } from "../navigation";
  import { openUtilityWindow } from "../../lib/plot/galleryWindow";
  import { modalFocus } from "../../lib/ui/modalFocus";
  import { registerFlushable } from "../lifecycle";
  import { inboxImages } from "./images";
  import { figRevision } from "../scholar/revisions";
  import BackgroundRun from "./BackgroundRun.svelte";
  import Logomark from "../Logomark.svelte";
  import Icon from "../Icon.svelte";
  import RecipientList from "../agent/RecipientList.svelte";
  import AgentMark from "../agent/AgentMark.svelte";
  import FluxAiMark from "../agent/FluxAiMark.svelte";
  import { markdown } from "../agent/markdown";
  import { retainPresence, assignAnnotation, unassignAnnotation, releaseAnnotation } from "../agent/annotationStore";
  import type { Route } from "../../lib/project/annotations";

  const root = get(currentProject)?.path ?? "";
  const images = inboxImages(root);
  const image = images.bind;
  let wrap: HTMLDivElement, list: HTMLDivElement, reply: HTMLTextAreaElement;
  let detached = false, alive = true, zoom = false;
  let scroll = 0, height = 500, draft = "", draftId = "";
  let busy = false, saveFailed = false, error = "", notice = "", filterError = "";
  let resolvedOpen = false, withdrawnOpen = false;
  let assignOpen = false, helpOpen = false, copiedId = false;
  let figures: { id: string; name: string; nickname?: string; referenceKey?: string }[] = [];
  let figureLoad = 0;
  let pending: Promise<boolean> = Promise.resolve(true);
  let popup: ReturnType<typeof openUtilityWindow> | undefined;
  let reconnect = () => {};
  const restoreFocus = document.activeElement as HTMLElement | null;
  const ROW = 72, HEADER = 28, OVERSCAN = 3;
  type Row = { key: string; top: number; height: number; item?: InboxItem; group?: string; count?: number };
  $: parsed = parseInboxQuery($inboxQuery, { docs: $inboxDocuments });
  $: chips = describeFilter(parsed);
  $: result = filterRows($inboxItems, parsed, $inboxDocuments, figures);
  $: filtered = result.items;
  $: filterError = result.error;
  // Resolved items are present but folded on an unfiltered inbox; explicit status searches expand them.
  $: rows = layout(filtered, resolvedOpen || !!parsed.status, withdrawnOpen || !!parsed.status);
  $: total = rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0;
  $: windowed = filtered.length > 200;
  $: shown = windowed ? rows.filter(r => r.top + r.height > scroll - ROW * OVERSCAN && r.top < scroll + height + ROW * OVERSCAN) : rows;
  $: selected = filtered.find(i => i.id === $inboxSelection) ?? filtered.find(i => i.status !== "resolved" && i.status !== "withdrawn") ?? null;
  $: if (selected?.id !== draftId) { draftId = selected?.id ?? ""; draft = inboxDrafts.get(draftId) ?? ""; zoom = false; assignOpen = false; notice = ""; copiedId = false; }
  $: { $inboxQuery; scroll = 0; if (list) list.scrollTop = 0; }
  $: { $figRevision; void loadFigures(); }
  $: if (($currentProject?.path ?? "") !== root) inboxOpen.set(false);
  $: needsYou = $inboxItems.filter(i => i.status === "needs-input" && !i.archived).length;
  $: openCount = $inboxItems.filter(i => !i.archived && !["resolved", "withdrawn"].includes(i.status)).length;
  // The header mark's colour is the Inbox's state: gold while something waits for you, blue while
  // a connected agent holds an item, the bloom's own colours otherwise.
  $: agentAtWork = $inboxItems.some(i => !i.archived && i.status === "claimed" && !!i.claimedBy && $inboxSessionIds.has(i.claimedBy.id));
  $: tone = (needsYou ? "wait" : agentAtWork ? "live" : "ready") as "wait" | "live" | "ready";
  $: holder = selected?.claimedBy?.name ?? selected?.assignedTo?.name ?? selected?.lastHolder?.name ?? "";
  $: lastAgentIndex = selected ? selected.thread.map(m => m.kind).lastIndexOf("agent") : -1;

  function filterRows(items: InboxItem[], filter: ReturnType<typeof parseInboxQuery>, docs: string[], figs: typeof figures) {
    try {
      const resolved = resolveInboxFilter(filter, docs, figs);
      return { items: sortForInbox(filterInbox(items, { ...resolved.filter, status: resolved.filter.status ?? ["needs-input", "open", "queued", "claimed", "resolved"] }, resolved.context)), error: "" };
    } catch (e) { return { items: [], error: (e as Error).message }; }
  }
  function layout(items: InboxItem[], resolved: boolean, withdrawn: boolean): Row[] {
    const out: Row[] = []; let top = 0;
    for (const [group, statuses] of [["Needs input", ["needs-input"]], ["Open", ["open", "queued"]], ["Claimed", ["claimed"]], ["Resolved", ["resolved"]], ["Withdrawn", ["withdrawn"]]] as const) {
      const members = items.filter(i => (statuses as readonly string[]).includes(i.status));
      if (!members.length) continue;
      out.push({ key: group, group, count: members.length, top, height: HEADER }); top += HEADER;
      if (group === "Resolved" && !resolved || group === "Withdrawn" && !withdrawn) continue;
      for (const item of members) { out.push({ key: `${item.doc ?? ""}:${item.id}`, item, top, height: ROW }); top += ROW; }
    }
    return out;
  }
  async function loadFigures() {
    const generation = ++figureLoad;
    try {
      const { readMetadataProject } = await import("../../lib/figure/metadataBridge");
      const model = await readMetadataProject(root);
      if (alive && generation === figureLoad) figures = model.figures;
    } catch { if (alive && generation === figureLoad) figures = []; }
  }
  function measure(node: HTMLDivElement) {
    let observer: ResizeObserver;
    reconnect = () => {
      observer?.disconnect();
      const win = node.ownerDocument.defaultView as Window & typeof globalThis;
      observer = new win.ResizeObserver(() => height = node.clientHeight);
      observer.observe(node); height = node.clientHeight;
    };
    reconnect(); return { destroy() { observer.disconnect(); reconnect = () => {}; } };
  }
  function moved() { reconnect(); }
  function pin() {
    try {
      popup = openUtilityWindow(wrap, () => void close(), moved, { page: "inbox.html", frame: "flux-inbox", title: "Inbox", focus: ".inbox-search" });
      detached = true; inboxDetached.set(true);
    } catch (e) { error = (e as Error).message; }
  }
  function dock() { popup?.close(); popup = undefined; detached = false; inboxDetached.set(false); void tick().then(() => { if (alive) wrap.querySelector<HTMLInputElement>(".inbox-search")?.focus(); }); }
  async function close() {
    if (!await pending) { if (detached) dock(); return; }
    inboxOpen.set(false);
  }
  function editDraft(value: string) { draft = value; if (draftId) { if (value) inboxDrafts.set(draftId, value); else inboxDrafts.delete(draftId); } }
  async function act(action: "reply" | "archive" | "reopen" | "withdraw") {
    if (!selected || busy || action === "reply" && !draft.trim()) return;
    const item = selected, body = draft;
    busy = true; saveFailed = false; error = ""; notice = "";
    pending = (async () => {
      try {
        await changeInboxItem(item, action, body);
        if (action === "reply" && inboxDrafts.get(item.id) === body) {
          inboxDrafts.delete(item.id); if (draftId === item.id) draft = "";
        }
        notice = action === "reply" ? "Reply saved" : "Saved";
        return true;
      } catch (e) { saveFailed = true; error = (e as Error).message; return false; }
      finally { busy = false; }
    })();
    await pending;
  }
  async function routeItem(action: "assign" | "unassign" | "release", route: Route = "none") {
    if (!selected || busy) return;
    const item = selected;
    busy = true; saveFailed = false; error = ""; notice = "";
    pending = (async () => {
      try {
        if (action === "assign") await assignAnnotation(item.id, route);
        else if (action === "unassign") await unassignAnnotation(item.id);
        else await releaseAnnotation(item.id);
        await refreshInbox();
        assignOpen = false; notice = "Saved";
        return true;
      } catch (e) { saveFailed = true; error = (e as Error).message; return false; }
      finally { busy = false; }
    })();
    await pending;
  }
  async function toggleAssign() {
    assignOpen = !assignOpen;
    if (assignOpen) { await tick(); wrap.querySelector<HTMLButtonElement>('[aria-label="Assign recipient"] button')?.focus(); }
  }
  async function jump() {
    if (!selected) return;
    try {
      const stamp = selected.context ?? { surface: selected.surface, targets: selected.targets };
      await navigateToStamp(stamp);
      if (!detached) void close(); else window.focus();
    } catch (e) { error = (e as Error).message; }
  }
  async function editAnnotation() {
    if (!selected || busy) return;
    const { editAnnotationRequest } = await import("../agent/annotationStore");
    editAnnotationRequest.set(selected);
    requestAnnotation();
  }
  async function copyPrompt() {
    if (!selected) return;
    const packet = toPacket(selected);
    try { await navigator.clipboard.writeText(`Address inbox item ${packet.id}${packet.doc ? ` in ${packet.doc}` : ""}. Read its full packet and current targets with flux inbox before making changes.`); notice = "Agent prompt copied"; }
    catch (e) { error = `Could not copy the prompt: ${(e as Error).message}`; }
  }
  async function copyId() {
    if (!selected) return;
    try { await navigator.clipboard.writeText(selected.id); copiedId = true; setTimeout(() => { copiedId = false; }, 1200); }
    catch (e) { error = `Could not copy the id: ${(e as Error).message}`; }
  }
  function age(ts: string) {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(ts)) / 60000));
    return !Number.isFinite(minutes) ? "" : minutes < 1 ? "now" : minutes < 60 ? `${minutes} m` : minutes < 1440 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 1440)} d`;
  }
  const when = (ts: string) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? ts : d.toLocaleString(); };
  /** Where the item points, in words: the first target's short label, else the shared `where`. */
  function place(item: InboxItem): string {
    const t = item.context?.targets?.[0] ?? item.targets[0];
    if (t) return `${item.surface} · ${shortTarget(t)}${(item.context?.targets?.length ?? item.targets.length) > 1 ? ` +${(item.context?.targets?.length ?? item.targets.length) - 1}` : ""}`;
    if (item.context?.doc?.path) return `${item.surface} · ${item.context.doc.path.split("/").pop()}`;
    if (item.context?.activeFigureName) return `${item.surface} · figure “${item.context.activeFigureName}”`;
    return item.where;
  }
  const surfaceIcon: Record<string, string> = { figure: "figure", paper: "paper", slide: "slide", present: "slide", reader: "reader", library: "library", home: "home" };
  function choose(id: string) { inboxSelection.set(id); }
  async function step(direction: number) {
    const available = rows.filter(r => r.item);
    if (!available.length) return;
    const current = available.findIndex(r => r.item!.id === selected?.id);
    const row = available[Math.max(0, Math.min(available.length - 1, current + direction))];
    choose(row.item!.id);
    if (row.top < scroll) list.scrollTop = row.top;
    else if (row.top + ROW > scroll + height) list.scrollTop = row.top + ROW - height;
    await tick();
    wrap.querySelector<HTMLButtonElement>(`[data-inbox-row][data-item-id="${CSS.escape(row.item!.id)}"]`)?.focus();
  }
  function onKey(e: KeyboardEvent) {
    if ($annotationOpen || isAnnotateChord(e)) return;
    if (isInboxChord(e)) { e.preventDefault(); void close(); return; }
    // Stop editor/window owners even when this key belongs to a text field.
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); if (assignOpen) { assignOpen = false; wrap.querySelector<HTMLButtonElement>('.assign-button')?.focus(); } else if (helpOpen) helpOpen = false; else if (zoom) zoom = false; else void close(); return; }
    if (e.target === reply && e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); void act("reply"); return; }
    const target = e.target as HTMLElement;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (target.matches(".inbox-search") && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); void step(e.key === "ArrowDown" ? 1 : -1); return; }
    if (target.matches("input,textarea,select,[contenteditable=true]")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); void step(e.key === "ArrowDown" ? 1 : -1); }
    else if (e.key === "Enter" && target.closest("[data-inbox-row]")) { e.preventDefault(); void jump(); }
    else if (e.code === "KeyR") { e.preventDefault(); reply?.focus(); }
    else if (e.code === "KeyA" && selected && !["resolved", "withdrawn"].includes(selected.status)) { e.preventDefault(); void toggleAssign(); }
    else if (e.code === "KeyE") { e.preventDefault(); void act("archive"); }
    else if (e.key === "?") { e.preventDefault(); helpOpen = !helpOpen; }
  }
  onMount(() => {
    const releasePresence = retainPresence();
    wrap.querySelector<HTMLInputElement>(".inbox-search")?.focus();
    let first = true;
    const offClose = inboxCloseRequest.subscribe(() => { if (first) first = false; else void close(); });
    const offFocus = inboxFocusRequest.subscribe(() => {
      if (detached) popup?.focus(); else wrap.querySelector<HTMLInputElement>(".inbox-search")?.focus();
    });
    return () => { offClose(); offFocus(); releasePresence(); };
  });
  onDestroy(registerFlushable({ id: "inbox", isDirty: () => busy || saveFailed, flush: async () => { if (!await pending) throw new Error(error); } }));
  onDestroy(() => { alive = false; popup?.close(); images.dispose(); inboxDetached.set(false); if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true }); });
</script>

<div class="inbox-wrap agent-surface" class:detached bind:this={wrap} use:fullscreenPortal>
  {#if !detached}<button class="backdrop" aria-label="Close Inbox" on:click={close}></button>{/if}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="inbox-panel" role="dialog" aria-label="Inbox" aria-modal={!detached} tabindex="-1" use:modalFocus on:keydown={onKey}>
    <header class="surface-head">
      <FluxAiMark size={16} {tone} />
      <span class="brand">Flux AI</span>
      <span class="vsep"></span>
      <strong class="ttl">Inbox</strong>
      <span class="vsep"></span>
      <span class="ctx">{#if needsYou}<span class="needs-you">{needsYou} need{needsYou === 1 ? "s" : ""} you</span> · {/if}{openCount} open</span>
      <span class="chord" aria-hidden="true"><kbd>Alt</kbd><kbd>Q</kbd></span>
      <button class="hbtn" on:click={() => detached ? dock() : pin()}>{detached ? "Dock" : "Pin open"} ↗</button>
      <button class="xbtn" aria-label="Close Inbox" on:click={close}></button>
    </header>
    <div class="inbox-body">
      <aside>
        <div class="filters">
          <div class="search-row">
            <label class="find">
              <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
              <input class="inbox-search" aria-label="Filter inbox" placeholder="Search, or doc: figure: #tag status: @agent" bind:value={$inboxQuery} />
              {#if $inboxQuery}<span class="found">{filtered.length}</span>{/if}
            </label>
            <button class="help-btn" aria-label="Filter grammar" aria-expanded={helpOpen} title="How to filter, and the Inbox keys" on:click={() => helpOpen = !helpOpen}>?</button>
          </div>
          {#if helpOpen}
            <div class="filter-help arrive">
              <div class="grammar">
                {#each [["kind:comment", "margin comments"], ["doc:", "one document"], ["figure:", "one figure"], ["deck:", "one deck"], ["#tag", "a tag"], ["status:", "a state"], ["@agent", "an agent"], ["words", "in the text"]] as [token, means]}<span><code>{token}</code>{means}</span>{/each}
              </div>
              <div class="keys"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> jump to it</span><span><kbd>R</kbd> reply</span><span><kbd>A</kbd> assign</span><span><kbd>E</kbd> archive</span><span><kbd>Esc</kbd> close</span></div>
            </div>
          {/if}
          {#if chips.length}<div class="chips" aria-label="Inbox filters">{#each chips as chip}<span>{chip}</span>{/each}<button aria-label="Clear inbox filters" on:click={() => inboxQuery.set("")}>Clear</button></div>{/if}
        </div>
        {#if filterError}<p class="error" role="alert">{filterError}</p>{/if}
        <div class="inbox-list" aria-label="Inbox items" role="list" bind:this={list} use:measure on:scroll={e => scroll = e.currentTarget.scrollTop} data-window={Math.ceil(height / ROW)} data-overscan={OVERSCAN * 2 + 2}>
          <div style={`height:${total}px;position:relative`}>
            {#each shown as row (row.key)}
              {#if row.item}
                {@const item = row.item}
                <button class="inbox-row" data-inbox-row data-item-id={item.id} data-status={item.status} class:selected={selected?.id === item.id} aria-current={selected?.id === item.id ? "true" : undefined} style={`top:${row.top}px;height:${ROW}px`} on:click={() => choose(item.id)}>
                  <span class="lead">{#if item.image}<img class="thumbnail" use:image={item.image} alt="" />{:else}<span class="kind-icon"><Icon name={surfaceIcon[item.surface] ?? "inbox"} size={18} /></span>{/if}</span>
                  <span class="row-body">
                    <b>{item.text.split("\n")[0]}</b>
                    <span class="row-meta"><span class="status-chip" data-status={item.status} data-live={item.claimedBy ? $inboxSessionIds.has(item.claimedBy.id) : undefined} title={item.claimedBy ? ($inboxSessionIds.has(item.claimedBy.id) ? "Agent is active" : "Agent is offline") : undefined}>{item.chip}</span><span class="where" title={item.where}>{place(item)}</span><time title={when(item.createdAt)} datetime={item.createdAt}>{age(item.createdAt)}</time></span>
                  </span>
                </button>
              {:else}
                {@const foldable = row.group === "Resolved" || row.group === "Withdrawn"}
                {@const open = row.group === "Resolved" ? resolvedOpen || !!parsed.status : row.group === "Withdrawn" ? withdrawnOpen || !!parsed.status : true}
                <button class="group" class:foldable data-group={row.group} style={`top:${row.top}px;height:${HEADER}px`} aria-expanded={foldable ? open : undefined} disabled={!foldable} on:click={() => { if (row.group === "Resolved") resolvedOpen = !resolvedOpen; if (row.group === "Withdrawn") withdrawnOpen = !withdrawnOpen; }}>
                  {#if foldable}<span class="chev" class:open aria-hidden="true"></span>{/if}{row.group} <span>{row.count}</span>
                </button>
              {/if}
            {/each}
          </div>
          {#if !$inboxLoaded}<p class="empty" role="status">Loading Inbox…</p>{/if}
          {#if !filtered.length && $inboxLoaded && !filterError}<div class="empty"><Logomark size={36} />{#if $inboxQuery}<b>No items match these filters.</b><p>Try another document, tag, or status, or clear the filters.</p>{:else}<b>Nothing waiting.</b><p>Point at anything with <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>M</kbd> and say what should change. Paper margin comments land here too.</p>{/if}<button on:click={() => $inboxQuery ? inboxQuery.set("") : requestAnnotation()}>{$inboxQuery ? "Clear filters" : "Annotate…"}</button></div>{/if}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> jump</span><span class="grow"></span><span><kbd>?</kbd> filters and keys</span></footer>
      </aside>
      <section class="detail" aria-label="Inbox detail">
        {#if selected}
          {@const origin = selected.thread[0]}
          <div class="detail-heading">
            <div class="line1"><span class="status-chip big" data-status={selected.status} data-live={selected.claimedBy ? $inboxSessionIds.has(selected.claimedBy.id) : undefined}>{selected.chip}</span><span class="grow"></span><button class="id mono" title={copiedId ? "Copied" : `${selected.kind} · ${selected.id} — click to copy the id`} on:click={copyId}>{copiedId ? "copied" : `#${selected.id.slice(-6)}`}</button></div>
            <p class="place" title={selected.where}><span class="place-icon" aria-hidden="true"><Icon name={surfaceIcon[selected.surface] ?? "inbox"} size={14} /></span><span>{place(selected)}</span></p>
            {#if selected.tags.length}<div class="tagrow" aria-label="Tags">{#each selected.tags as tag}<button class="tagchip" title={`Show everything tagged #${tag}`} on:click={() => inboxQuery.set(`#${tag}`)}>#{tag}</button>{/each}</div>{/if}
          </div>
          <div class="detail-scroll">
            <div class="origin" class:agent={origin?.kind === "agent"}>
              <div class="byline">{#if origin?.kind === "agent"}<AgentMark size={12} seed={origin.author} />{/if}<span class="who">{origin?.author ?? "You"}</span><span class="faint">{origin ? age(origin.ts) : age(selected.createdAt)} · {selected.kind === "comment" ? "margin comment" : "annotation"}</span></div>
              <div class="full-text agent-prose" use:markdown={{ text: selected.text }}></div>
              {#if selected.image}{#key selected.image}<button class="picture" class:zoom aria-label={zoom ? "Fit annotation image" : "Zoom annotation image"} title={zoom ? "Click to fit" : "Click to see it at full size"} on:click={() => zoom = !zoom}><img use:image={selected.image} alt="Annotated view with numbered marks" /></button>{/key}{/if}
              {#if selected.context?.snapshot?.marks.length}<ol class="anchors">{#each selected.context.snapshot.marks as mark}<li value={mark.n}><span class="n">{mark.n}</span><span title={mark.targets?.map(describeTarget).join(" · ")}>{mark.targets?.map(shortTarget).join(" · ") || mark.anchor?.path || `${mark.kind} in the saved view`}</span></li>{/each}</ol>{/if}
              {#if selected.anchor}<blockquote>{selected.anchor.quote}</blockquote>{/if}
            </div>
            <div class="thread" aria-label="Item thread">{#each selected.thread.slice(1) as message, i (`${selected.id}:${i}`)}
              {@const waiting = selected.status === "needs-input" && message.kind === "agent" && i + 1 === lastAgentIndex}
              <article class:human={message.kind === "human"} class:agent={message.kind === "agent"} class:waiting>
                <div class="gutter">{#if message.kind === "agent"}<AgentMark size={13} seed={message.author} state={waiting ? "idle" : "done"} />{:else}<span class="you-dot" aria-hidden="true"></span>{/if}</div>
                <div class="body"><div class="byline"><b>{message.author}</b><span class="faint mono" title={when(message.ts)}>{message.kind === "human" ? "you" : "agent"} · {age(message.ts)}</span>{#if waiting}<span class="wait">Waiting for you</span>{/if}</div><div class="agent-prose compact" class:you={message.kind === "human"} use:markdown={{ text: message.text }}></div></div>
              </article>
            {/each}</div>
            <BackgroundRun item={selected} />
          </div>
          <div class="actions" class:routing-actions={selected.status !== "resolved" && selected.status !== "withdrawn"}>
            <button class="primary" data-key="↵" title="Go to where this note points (Enter on its row)" on:click={jump}>Jump to ↗</button>
            {#if selected.status !== "resolved" && selected.status !== "withdrawn"}
              <button class="assign-button" data-key="A" disabled={busy} aria-expanded={assignOpen} on:click={toggleAssign}>Assign ▾</button>
              {#if selected.route !== "none" || selected.assignedTo}<button disabled={busy} on:click={() => routeItem("unassign")}>Unassign</button>{/if}
              {#if selected.claimedBy}<button disabled={busy} on:click={() => routeItem("release")}>Release claim</button>{/if}
            {/if}
            <span class="grow"></span>
            <button data-key="E" disabled={busy} on:click={() => act("archive")}>{selected.archived ? "Unarchive" : "Archive"}</button>
            {#if selected.status === "resolved"}<button disabled={busy} on:click={() => act("reopen")}>Reopen</button>{/if}
            {#if selected.kind === "annotation" && selected.status !== "withdrawn" && selected.thread[0]?.kind === "human"}<button disabled={busy} on:click={editAnnotation}>Edit</button><button disabled={busy} on:click={() => act("withdraw")}>Withdraw</button>{/if}
            <button class="quiet" on:click={copyPrompt} title="Copy a one-line prompt that points an agent at this item">Copy agent prompt</button>
          </div>
          {#if assignOpen}<div class="assign-pop arrive"><RecipientList label="Assign recipient" disabled={busy} choose={route => void routeItem("assign", route)} /></div>{/if}
          {#if selected.status !== "resolved" && selected.status !== "withdrawn"}
            <div class="reply flux-composer" class:waiting={selected.status === "needs-input"}>
              <textarea aria-label="Reply to inbox item" placeholder={selected.status === "needs-input" && holder ? `Answer ${holder}…` : holder ? `Reply to ${holder}…` : "Reply…"} bind:this={reply} value={draft} on:input={e => editDraft(e.currentTarget.value)} rows="2"></textarea>
              <div class="composer-bar"><span class="hint">{selected.status === "needs-input" && holder ? `${holder} is waiting · Enter sends` : "Enter sends · Shift+Enter newline"}</span><kbd title="R puts the caret here">R</kbd><button class="primary" disabled={busy || !draft.trim()} on:click={() => act("reply")}>{busy ? "Saving…" : "Reply"}</button></div>
            </div>
          {/if}
        {:else}<div class="empty detail-empty"><b>Select an item to read its thread.</b><p>Annotations and margin comments share one Inbox.</p><div class="keys"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> jump to it</span><span><kbd>R</kbd> reply</span><span><kbd>A</kbd> assign</span><span><kbd>E</kbd> archive</span><span><kbd>Esc</kbd> close</span></div></div>{/if}
        {#if error || $inboxError}<div class="error" role="alert">{error || $inboxError}<button on:click={() => { error = ""; saveFailed = false; pending = Promise.resolve(true); void refreshInbox(); }}>Dismiss / refresh</button></div>{/if}
        {#if notice}<div class="notice arrive" role="status">{notice}</div>{/if}
      </section>
    </div>
  </div>
</div>

<style>
  /* The Inbox in the house vocabulary: serif words, mono eyebrows and values, hairlines, tint +
     inset rail for the open item. The list sits on the raised ground and the thread on the
     surface, so what you read is the lighter sheet. State is colour, never motion: gold is
     "waiting for you", blue is "an agent has it" (a ring when that agent is live). */
  .inbox-wrap { position:fixed;inset:0;z-index:1900;display:grid;place-items:center;color:var(--c-tx);font:13px/1.35 var(--font-serif); }
  /* The dim layer is a button (a click closes the Inbox); the generic button hover must not repaint it opaque. */
  .backdrop { position:absolute;inset:0;border:0;background:rgba(0,0,0,.3); }
  .inbox-panel { position:relative;display:flex;flex-direction:column;width:min(1120px,96vw);height:min(780px,92vh);background:var(--c-surface);border:1px solid var(--c-line-strong);border-radius:var(--r-panel);box-shadow:var(--elev-3);overflow:hidden;animation:inbox-enter var(--dur-instant) var(--ease-enter) both; }
  @keyframes inbox-enter { from { opacity:0; transform:scale(.99); } to { opacity:1; transform:none; } }
  @media (prefers-reduced-motion: reduce) { .inbox-panel { animation-name: flux-arrive; } }
  .detached .inbox-panel { width:100%;height:100%;border:0;border-radius:0;box-shadow:none;animation:none; }
  header.surface-head { gap:10px; }
  header .ctx { font: 11px var(--font-mono); font-variant-numeric: tabular-nums; }
  .needs-you { color: var(--c-comment); font-weight: 600; }
  .chord { display:inline-flex; gap:3px; margin-left:auto; }
  .grow { flex:1; }
  svg { display:block; flex-shrink:0; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
  button { background:transparent;border:1px solid transparent;border-radius:var(--r-ui);color:inherit;padding:5px 8px;font:inherit;transition:background-color 80ms linear,border-color 80ms linear,color 80ms linear; }
  button:not(.backdrop):not(.inbox-row):not(.group):not(.xbtn):not(.picture):hover { background:var(--c-surface-2); } button:disabled { opacity:.45; } button:focus-visible,textarea:focus-visible { outline:1px solid var(--c-accent);outline-offset:-1px; }
  .inbox-body { display:flex;flex:1;min-height:0; }

  /* ---- the list ------------------------------------------------------------------------ */
  aside { display:flex;flex-direction:column;flex:0 0 41%;min-width:230px;max-width:470px;background:var(--c-bg-raised);border-right:1px solid var(--c-line); }
  .filters { padding:10px 10px 9px;display:grid;gap:8px;border-bottom:1px solid var(--c-line); }
  .search-row { display:flex; gap:6px; align-items:center; }
  .find { flex:1;min-width:0;display:flex;align-items:center;gap:7px;height:28px;padding:0 8px;background:var(--c-bg);border:1px solid var(--c-line-strong);border-radius:var(--r-ui);color:var(--c-tx-muted);cursor:text;transition:border-color 80ms linear; }
  .find:hover { border-color:var(--c-tx-muted); } .find:focus-within { border-color:var(--c-accent);color:var(--c-tx-2); }
  input { flex:1;min-width:0;box-sizing:border-box;height:26px;margin:0;padding:0;background:transparent;border:0;outline:none;color:var(--c-tx-hi);font:13px var(--font-serif); }
  input::placeholder { color: var(--c-tx-faint); font-style: italic; }
  .found { color:var(--c-tx-muted);font:10.5px var(--font-mono);font-variant-numeric:tabular-nums; }
  .help-btn { width:28px;height:28px;padding:0;flex-shrink:0;color:var(--c-tx-muted);border-color:var(--c-line-strong);font:11px var(--font-mono); }
  .help-btn[aria-expanded="true"] { background:var(--c-accent-tint);border-color:var(--c-accent);color:var(--c-tx-hi); }
  .filter-help { display:grid;gap:9px;padding:2px 2px 1px;color:var(--c-tx-muted);font:11.5px/1.4 var(--font-serif); }
  .grammar { display:grid;grid-template-columns:1fr 1fr;gap:4px 12px; } .grammar span { display:flex;align-items:baseline;gap:7px;min-width:0;white-space:nowrap; }
  code { padding:0 4px;background:var(--c-surface-2);border-radius:var(--r-ui);color:var(--c-tx-2);font:10.5px var(--font-mono); }
  .chips { display:flex;flex-wrap:wrap;gap:4px;align-items:center; } .chips span { background:var(--c-accent-tint);border:1px solid color-mix(in oklab,var(--c-accent) 45%,transparent);padding:1px 6px;border-radius:var(--r-ui);color:var(--c-tx-hi);font:10px var(--font-mono); } .chips button { padding:1px 6px;font:11.5px var(--font-serif);color:var(--c-tx-muted); }
  .inbox-list { flex:1;min-height:0;overflow:auto;contain:layout paint;scrollbar-gutter:stable; }
  .inbox-row { position:absolute;left:0;right:0;width:100%;display:grid;grid-template-columns:44px minmax(0,1fr);column-gap:11px;align-items:start;text-align:left;padding:10px 10px 0 12px;border:0;border-bottom:1px solid var(--c-line);border-radius:0;overflow:hidden; }
  .inbox-row:hover { background:var(--c-surface-2); }
  .inbox-row:active { background:var(--c-accent-tint); }
  .inbox-row[data-status="needs-input"] { box-shadow:inset 2px 0 var(--c-comment); }
  .inbox-row.selected { background:var(--c-accent-tint);box-shadow:inset 2px 0 var(--c-accent); }
  .lead { width:44px; height:44px; display:grid; place-items:center; }
  .thumbnail { width:44px;height:44px;object-fit:cover;border:1px solid var(--c-line-strong);border-radius:var(--r-ui);background:var(--flx-paper); }
  .kind-icon { display:grid; place-items:center; width:44px; height:44px; border:1px solid var(--c-line); border-radius:var(--r-ui); background:var(--c-bg); color:var(--c-tx-muted); }
  .row-body { display:flex;flex-direction:column;gap:4px;min-width:0; }
  /* Two lines of the note itself: the row says what was asked, not just that something was. */
  .row-body b { display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;min-height:34px;font:13px/17px var(--font-serif);font-weight:400;color:var(--c-tx); }
  .inbox-row[data-status="needs-input"] .row-body b, .inbox-row.selected .row-body b, .inbox-row:hover .row-body b { color:var(--c-tx-hi); }
  .inbox-row[data-status="resolved"] .row-body b, .inbox-row[data-status="withdrawn"] .row-body b { color:var(--c-tx-2); }
  .row-meta { display:flex;gap:8px;align-items:center;white-space:nowrap;min-width:0;font:10px var(--font-mono);color:var(--c-tx-muted); }
  .where { flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--c-tx-faint); }
  time { flex-shrink:0;color:var(--c-tx-faint);font:10px var(--font-mono);font-variant-numeric:tabular-nums; }
  .status-chip { display:inline-flex;align-items:center;gap:5px;flex-shrink:0;max-width:62%;overflow:hidden;text-overflow:ellipsis;font:10.5px var(--font-ui);color:var(--c-tx-muted); }
  .status-chip::before { content:"";width:7px;height:7px;border-radius:50%;flex-shrink:0;border:1px solid var(--c-tx-faint);box-sizing:border-box; }
  .status-chip[data-status="needs-input"] { color:var(--c-comment); font-weight:600; } .status-chip[data-status="needs-input"]::before { background:var(--c-comment);border-color:var(--c-comment); }
  .status-chip[data-status="claimed"] { color:var(--c-accent-bright); } .status-chip[data-status="claimed"]::before { border-color:var(--c-accent); }
  /* Live = the agent holding it is connected now: a filled dot inside a ring. Still, not breathing. */
  .status-chip[data-status="claimed"][data-live="true"]::before { background:var(--c-accent);box-shadow:0 0 0 2px var(--c-accent-tint); }
  .status-chip[data-status="resolved"]::before { background:var(--c-success);border-color:var(--c-success);opacity:.8; }
  .status-chip[data-status="withdrawn"]::before { border-style:dashed; }
  .status-chip.big { max-width:none;font:600 13px var(--font-serif); } .status-chip.big::before { width:8px;height:8px; }
  .group { position:absolute;left:0;width:100%;text-align:left;padding:0 12px;background:var(--c-bg-raised);font:600 10px var(--font-mono);text-transform:uppercase;letter-spacing:.08em;color:var(--c-tx-muted);border:0;border-bottom:1px solid var(--c-line);border-radius:0;display:flex;align-items:center;gap:6px;opacity:1; }
  .group:disabled { opacity:1; }
  .group.foldable:hover { color:var(--c-tx-hi);background:var(--c-surface-2); }
  .group span:last-child { margin-left:auto; font-weight:400; font-variant-numeric:tabular-nums; }
  .group[data-group="Needs input"] { color:var(--c-comment); }
  .chev { width:8px;height:8px;background:currentColor;opacity:.6;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 6 6 6-6 6'/%3E%3C/svg%3E") center / contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 6 6 6-6 6'/%3E%3C/svg%3E") center / contain no-repeat;transition:rotate var(--dur-instant) var(--ease-standard); }
  .chev.open { rotate:90deg; }
  footer { display:flex;gap:12px;align-items:center;height:30px;padding:0 12px;border-top:1px solid var(--c-line);color:var(--c-tx-muted);font:11px var(--font-ui);white-space:nowrap;overflow:hidden; }
  footer kbd, .keys kbd { margin-right:3px; }

  /* ---- the thread ---------------------------------------------------------------------- */
  .detail { position:relative;display:flex;flex:1;flex-direction:column;min-width:0;overflow:hidden; }
  .detail-heading { padding:12px 18px 11px;border-bottom:1px solid var(--c-line); }
  .line1 { display:flex;align-items:center;gap:8px;min-height:20px; }
  .id { padding:1px 5px;font-size:10px;color:var(--c-tx-faint);border-color:transparent; } .id:hover { color:var(--c-tx-hi); }
  .place { display:flex;align-items:center;gap:7px;margin:7px 0 0;color:var(--c-tx-2);font:12px/1.4 var(--font-serif);overflow-wrap:anywhere; }
  .place-icon { display:grid;place-items:center;flex-shrink:0;opacity:.9; }
  .tagrow { display:flex;flex-wrap:wrap;gap:4px;margin-top:8px; }
  .tagchip { height:18px;padding:0 6px;border-color:var(--c-line);color:var(--c-accent-bright);font:10px var(--font-mono); } .tagchip:hover { border-color:var(--c-accent);color:var(--c-tx-hi); }
  .detail-scroll { flex:1;min-height:0;overflow:auto;padding:14px 18px 14px;scrollbar-gutter:stable;display:flex;flex-direction:column;gap:16px; }
  .origin { display:flex;flex-direction:column;gap:9px; }
  .byline { display:flex;align-items:baseline;gap:7px;color:var(--c-tx-muted);font:10.5px var(--font-mono); } .byline .who, .byline b { color:var(--c-tx-hi);font:600 12.5px var(--font-serif); }
  .full-text { font-size:15px; line-height:1.55; }
  /* The whole picture, fitted; a click shows it at its real size. */
  .picture { display:block;align-self:flex-start;max-width:100%;max-height:340px;overflow:hidden;padding:0;border:1px solid var(--c-line-strong);border-radius:var(--r-ui);background:var(--c-bg);cursor:zoom-in; }
  .picture:hover { border-color:var(--c-tx-muted); }
  .picture img { display:block;max-width:100%;max-height:338px;object-fit:contain; }
  .picture.zoom { align-self:stretch;max-height:62vh;overflow:auto;cursor:zoom-out; } .picture.zoom img { max-width:none;max-height:none; }
  .anchors { margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;color:var(--c-tx-2);font:12px/1.45 var(--font-serif); }
  .anchors li { display:flex;align-items:baseline;gap:8px; }
  .anchors .n { display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;background:var(--c-ink-mark);color:#fff;font:700 10px var(--font-ui);flex-shrink:0;align-self:center; }
  blockquote { margin:0;padding-left:10px;border-left:2px solid var(--c-line-strong);font:italic 13px/1.5 var(--font-serif);color:var(--c-tx-2); }
  /* Replies hang off one line down the gutter, each on its mark. */
  .thread { position:relative;display:flex;flex-direction:column;gap:16px; }
  .thread:empty { display:none; }
  .thread::before { content:"";position:absolute;left:7.5px;top:6px;bottom:6px;width:1px;background:var(--c-line); }
  article { position:relative;display:grid;grid-template-columns:16px 1fr;gap:0 10px;align-items:start; }
  article .gutter { padding-top:2px;display:grid;place-items:center;background:var(--c-surface); }
  .you-dot { width:7px;height:7px;border-radius:50%;background:var(--c-tx-muted);margin:5px 0; }
  article .body { display:flex;flex-direction:column;gap:4px;min-width:0; }
  article.waiting .body { padding:8px 10px 9px;margin:-4px 0 0 -4px;background:var(--c-comment-tint);border-radius:var(--r-ui);box-shadow:inset 2px 0 var(--c-comment); }
  .wait { margin-left:auto;color:var(--c-comment);font:600 10px var(--font-mono);letter-spacing:.06em;text-transform:uppercase; }
  /* One action bar. The keys that act on the open item are drawn on their buttons (as content, so
     a button's text stays its name). */
  .actions { display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px;border-top:1px solid var(--c-line);align-items:center;background:var(--c-bg-raised); }
  .actions button { display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-color:var(--c-line);color:var(--c-tx);font:12px var(--font-serif);white-space:nowrap; }
  .actions button:hover:not(:disabled) { border-color:var(--c-line-strong);color:var(--c-tx-hi); }
  .actions button:active:not(:disabled) { background:var(--c-accent-tint);border-color:var(--c-accent); }
  .actions button[data-key]::before { content:attr(data-key);display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:16px;height:15px;padding:0 4px;border:1px solid color-mix(in oklab,currentColor 45%,transparent);border-bottom-width:2px;border-radius:var(--r-ui);color:var(--c-tx-muted);font:500 10px/12px var(--font-mono); }
  .actions button.primary { background:var(--c-accent-tint);border-color:color-mix(in oklab,var(--c-accent) 60%,transparent);color:var(--c-tx-hi); }
  .actions button.primary:hover { background:color-mix(in oklab,var(--c-accent) 28%,transparent);border-color:var(--c-accent); }
  .actions button.primary::before { color:var(--c-accent-bright); }
  .actions button.quiet { border-color:transparent;color:var(--c-tx-muted); }
  .actions button[aria-expanded="true"] { background:var(--c-accent-tint);border-color:var(--c-accent); }
  .assign-pop { padding:0 12px 8px;background:var(--c-bg-raised); }
  .reply { margin:0 12px 12px; }
  .detail > .reply { margin-top:0; }
  .actions + .reply, .assign-pop + .reply { box-shadow:0 -12px 0 0 var(--c-bg-raised); }
  .reply.waiting { border-color:color-mix(in srgb,var(--c-comment) 55%,var(--c-line-strong)); }
  .reply textarea { font:13.5px/1.5 var(--font-serif); }
  .reply kbd { color:var(--c-tx-faint); }
  .empty { padding:28px 24px;color:var(--c-tx-muted);line-height:1.6;display:flex;flex-direction:column;gap:6px;align-items:flex-start; } .empty b { color:var(--c-tx-hi);font:600 14px var(--font-serif); } .empty p { margin:0; } .empty button { border-color:var(--c-line-strong);margin-top:6px; }
  .detail-empty { padding:44px 36px; }
  .keys { display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;margin-top:10px;color:var(--c-tx-muted);font:11px var(--font-ui); }
  .filter-help .keys { margin-top:0;grid-template-columns:1fr 1fr 1fr;gap:5px 10px; }
  .error { padding:10px 12px;color:var(--c-danger);overflow-wrap:anywhere;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px; } .error button { border-color:var(--c-line); }
  .notice { position:absolute;right:16px;top:40px;padding:2px 8px;background:var(--c-surface-2);border:1px solid var(--c-line);border-radius:var(--r-ui);color:var(--c-tx-2);font:10.5px var(--font-mono);pointer-events:none; }
  .mono { font-family:var(--font-mono);font-variant-numeric:tabular-nums; } .faint { color:var(--c-tx-faint); }
  @media(max-width:640px) { aside { flex-basis:45%;min-width:190px; } .inbox-row { grid-template-columns:minmax(0,1fr); } .lead { display:none; } footer { font-size:9px; } .grammar { grid-template-columns:1fr; } }
  @media (prefers-reduced-motion: reduce) { button, .find { transition:none; } }
</style>

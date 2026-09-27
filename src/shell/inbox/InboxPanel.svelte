<script lang="ts">
  import { fullscreenPortal } from "../../lib/ui/portal";
  import { onDestroy, onMount, tick } from "svelte";
  import { get } from "svelte/store";
  import { currentProject } from "../shellStore";
  import { inboxOpen, inboxDetached, inboxSelection, inboxQuery, inboxDrafts, inboxCloseRequest, inboxFocusRequest, isInboxChord } from "./inboxState";
  import { inboxItems, inboxDocuments, inboxSessionIds, inboxError, inboxLoaded, changeInboxItem, refreshInbox } from "./inboxStore";
  import { annotationOpen, requestAnnotation, isAnnotateChord } from "../agent/annotateChord";
  import { parseInboxQuery, describeFilter, resolveInboxFilter, filterInbox, sortForInbox, toPacket, type InboxItem } from "../../lib/project/inbox";
  import { describeTarget } from "../../lib/project/targets";
  import { navigateToStamp } from "../navigation";
  import { openUtilityWindow } from "../../lib/plot/galleryWindow";
  import { modalFocus } from "../../lib/ui/modalFocus";
  import { registerFlushable } from "../lifecycle";
  import { inboxImages } from "./images";
  import { figRevision } from "../scholar/revisions";
  import Logomark from "../Logomark.svelte";

  const root = get(currentProject)?.path ?? "";
  const images = inboxImages(root);
  const image = images.bind;
  let wrap: HTMLDivElement, list: HTMLDivElement, reply: HTMLTextAreaElement;
  let detached = false, alive = true, zoom = false;
  let scroll = 0, height = 500, draft = "", draftId = "";
  let busy = false, saveFailed = false, error = "", notice = "", filterError = "";
  let resolvedOpen = false, withdrawnOpen = false;
  let figures: { id: string; name: string; nickname?: string; referenceKey?: string }[] = [];
  let figureLoad = 0;
  let pending: Promise<boolean> = Promise.resolve(true);
  let popup: ReturnType<typeof openUtilityWindow> | undefined;
  let reconnect = () => {};
  const restoreFocus = document.activeElement as HTMLElement | null;
  const ROW = 100, HEADER = 30, OVERSCAN = 3;
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
  $: if (selected?.id !== draftId) { draftId = selected?.id ?? ""; draft = inboxDrafts.get(draftId) ?? ""; zoom = false; notice = ""; }
  $: { $inboxQuery; scroll = 0; if (list) list.scrollTop = 0; }
  $: { $figRevision; void loadFigures(); }
  $: if (($currentProject?.path ?? "") !== root) inboxOpen.set(false);

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
  function age(ts: string) {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(ts)) / 60000));
    return !Number.isFinite(minutes) ? "" : minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
  }
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
    if (e.key === "Escape") { e.preventDefault(); if (zoom) zoom = false; else void close(); return; }
    if (e.target === reply && e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); void act("reply"); return; }
    const target = e.target as HTMLElement;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (target.matches(".inbox-search") && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); void step(e.key === "ArrowDown" ? 1 : -1); return; }
    if (target.matches("input,textarea,select,[contenteditable=true]")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); void step(e.key === "ArrowDown" ? 1 : -1); }
    else if (e.key === "Enter" && target.closest("[data-inbox-row]")) { e.preventDefault(); void jump(); }
    else if (e.code === "KeyR") { e.preventDefault(); reply?.focus(); }
    else if (e.code === "KeyE") { e.preventDefault(); void act("archive"); }
  }
  onMount(() => {
    wrap.querySelector<HTMLInputElement>(".inbox-search")?.focus();
    let first = true;
    const offClose = inboxCloseRequest.subscribe(() => { if (first) first = false; else void close(); });
    const offFocus = inboxFocusRequest.subscribe(() => {
      if (detached) popup?.focus(); else wrap.querySelector<HTMLInputElement>(".inbox-search")?.focus();
    });
    return () => { offClose(); offFocus(); };
  });
  onDestroy(registerFlushable({ id: "inbox", isDirty: () => busy || saveFailed, flush: async () => { if (!await pending) throw new Error(error); } }));
  onDestroy(() => { alive = false; popup?.close(); images.dispose(); inboxDetached.set(false); if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true }); });
</script>

<div class="inbox-wrap" class:detached bind:this={wrap} use:fullscreenPortal>
  {#if !detached}<button class="backdrop" aria-label="Close Inbox" on:click={close}></button>{/if}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="inbox-panel" role="dialog" aria-label="Inbox" aria-modal={!detached} tabindex="-1" use:modalFocus on:keydown={onKey}>
    <header><Logomark size={25} /><strong>Inbox</strong><kbd>Alt Q</kbd><span class="spacer"></span><button on:click={() => detached ? dock() : pin()}>{detached ? "Dock" : "Pin open"} ↗</button><button aria-label="Close Inbox" on:click={close}>×</button></header>
    <div class="inbox-body">
      <aside>
        <div class="filters">
          <input class="inbox-search" aria-label="Filter inbox" placeholder="Search · draft_1 #claude figure" bind:value={$inboxQuery} />
          <div class="filter-help">kind:comment · doc: · figure: · deck: · #tag · status: · text</div>
          {#if chips.length}<div class="chips" aria-label="Inbox filters">{#each chips as chip}<span>{chip}</span>{/each}<button aria-label="Clear inbox filters" on:click={() => inboxQuery.set("")}>Clear</button></div>{/if}
        </div>
        {#if filterError}<p class="error" role="alert">{filterError}</p>{/if}
        <div class="inbox-list" aria-label="Inbox items" role="list" bind:this={list} use:measure on:scroll={e => scroll = e.currentTarget.scrollTop} data-window={Math.ceil(height / ROW)} data-overscan={OVERSCAN * 2 + 2}>
          <div style={`height:${total}px;position:relative`}>
            {#each shown as row (row.key)}
              {#if row.item}
                {@const item = row.item}
                <button class="inbox-row" data-inbox-row data-item-id={item.id} data-status={item.status} class:selected={selected?.id === item.id} aria-current={selected?.id === item.id ? "true" : undefined} style={`top:${row.top}px;height:${ROW}px`} on:click={() => choose(item.id)}>
                  {#if item.image}<img class="thumbnail" use:image={item.image} alt="Annotated view" />{:else}<span class="quote">{item.anchor?.quote ?? item.context?.doc?.quote ?? item.surface}</span>{/if}
                  <span class="row-body"><b>{item.text.split("\n")[0]}</b><span class="where" title={item.where}>{item.where}</span><span class="row-tags">{#each item.tags as tag}<span class="tag">#{tag}</span>{/each}</span><span class="row-meta"><span class="status-chip" data-status={item.status}>{item.chip}</span>{#if item.claimedBy}<span title={ $inboxSessionIds.has(item.claimedBy.id) ? "Agent is active" : "Agent is offline"}><i class:live={$inboxSessionIds.has(item.claimedBy.id)}></i>{item.claimedBy.name}</span>{/if}<time title={item.createdAt}>{age(item.createdAt)}</time></span></span>
                </button>
              {:else}
                <button class="group" style={`top:${row.top}px;height:${HEADER}px`} aria-expanded={row.group === "Resolved" ? resolvedOpen || !!parsed.status : row.group === "Withdrawn" ? withdrawnOpen || !!parsed.status : true} on:click={() => { if (row.group === "Resolved") resolvedOpen = !resolvedOpen; if (row.group === "Withdrawn") withdrawnOpen = !withdrawnOpen; }}>
                  {row.group === "Resolved" ? (resolvedOpen || parsed.status ? "▾" : "▸") : row.group === "Withdrawn" ? (withdrawnOpen || parsed.status ? "▾" : "▸") : ""} {row.group} <span>{row.count}</span>
                </button>
              {/if}
            {/each}
          </div>
          {#if !$inboxLoaded}<p class="empty" role="status">Loading Inbox…</p>{/if}
          {#if !filtered.length && $inboxLoaded && !filterError}<div class="empty"><b>{$inboxQuery ? "No items match these filters." : "No open annotations."}</b><p>{$inboxQuery ? "Try another document, tag, or status, or clear the filters." : "Press Ctrl+Shift+M anywhere to make one. Paper margin comments appear here too."}</p><button on:click={() => $inboxQuery ? inboxQuery.set("") : requestAnnotation()}>{$inboxQuery ? "Clear filters" : "Annotate…"}</button></div>{/if}
        </div>
        <footer>↑ ↓ move · Enter jump · R reply · E archive</footer>
      </aside>
      <section class="detail" aria-label="Inbox detail">
        {#if selected}
          <div class="detail-heading"><span class="status-chip" data-status={selected.status}>{selected.chip}</span><small>{selected.kind} · {selected.id}</small><p>{selected.where}</p></div>
          <div class="detail-scroll">
            <div class="origin" class:agent={selected.thread[0]?.kind === "agent"}>{selected.thread[0]?.author ?? "You"} · {selected.thread[0]?.kind === "agent" ? "Agent" : "Human"}</div>
            <p class="full-text">{selected.text}</p>
            {#if selected.image}{#key selected.image}<button class="picture" class:zoom aria-label={zoom ? "Fit annotation image" : "Zoom annotation image"} on:click={() => zoom = !zoom}><img use:image={selected.image} alt="Annotated view with numbered marks" /></button>{/key}{/if}
            {#if selected.context?.snapshot?.marks.length}<ol class="anchors">{#each selected.context.snapshot.marks as mark}<li value={mark.n}>{mark.targets?.map(describeTarget).join(" · ") || mark.anchor?.path || `${mark.kind} in the saved view`}</li>{/each}</ol>{/if}
            {#if selected.anchor}<blockquote>{selected.anchor.quote}</blockquote>{/if}
            <div class="thread" aria-label="Item thread">{#each selected.thread.slice(1) as message, i (`${selected.id}:${i}`)}<article class:human={message.kind === "human"} class:agent={message.kind === "agent"}><div><b>{message.author}</b><small>{message.kind === "human" ? "You" : "Agent"} · {age(message.ts)}</small></div><p>{message.text}</p></article>{/each}</div>
          </div>
          <div class="actions"><button on:click={jump}>Jump to ↗</button><button disabled={busy} on:click={() => act("archive")}>{selected.archived ? "Unarchive" : "Archive"}</button>{#if selected.status === "resolved"}<button disabled={busy} on:click={() => act("reopen")}>Reopen</button>{/if}{#if selected.kind === "annotation" && selected.status !== "withdrawn" && selected.thread[0]?.kind === "human"}<button disabled={busy} on:click={editAnnotation}>Edit</button><button disabled={busy} on:click={() => act("withdraw")}>Withdraw</button>{/if}<button on:click={copyPrompt}>Copy agent prompt</button></div>
          {#if selected.status !== "resolved" && selected.status !== "withdrawn"}<div class="reply"><textarea aria-label="Reply to inbox item" placeholder="Reply… Enter to send · Shift+Enter for a new line" bind:this={reply} value={draft} on:input={e => editDraft(e.currentTarget.value)} rows="3"></textarea><button disabled={busy || !draft.trim()} on:click={() => act("reply")}>{busy ? "Saving…" : "Reply"}</button></div>{/if}
        {:else}<div class="empty"><b>Select an item to read its thread.</b><p>Annotations and margin comments share one Inbox.</p></div>{/if}
        {#if error || $inboxError}<div class="error" role="alert">{error || $inboxError}<button on:click={() => { error = ""; saveFailed = false; pending = Promise.resolve(true); void refreshInbox(); }}>Dismiss / refresh</button></div>{/if}
        {#if notice}<div class="notice" role="status">{notice}</div>{/if}
      </section>
    </div>
  </div>
</div>

<style>
  .inbox-wrap { position:fixed;inset:0;z-index:1900;display:grid;place-items:center;color:var(--c-tx);font:12px var(--font-ui); }
  .backdrop { position:absolute;inset:0;border:0;background:rgba(0,0,0,.3); }
  .inbox-panel { position:relative;display:flex;flex-direction:column;width:min(1100px,96vw);height:min(780px,92vh);background:var(--c-bg);border:1px solid var(--c-line-strong);border-radius:var(--r-panel);box-shadow:var(--elev-2);overflow:hidden; }
  .detached .inbox-panel { width:100%;height:100%;border:0;border-radius:0;box-shadow:none; }
  header { display:flex;align-items:center;gap:12px;min-height:42px;padding:0 12px;border-bottom:1px solid var(--c-line);background:var(--c-bg-raised); }
  header strong { font:600 17px var(--font-serif); } kbd,small,.filter-help,footer { color:var(--c-tx-muted);font:10px var(--font-mono); } .spacer { flex:1; }
  button { background:transparent;border:1px solid transparent;border-radius:var(--r-ui);color:inherit;padding:5px 8px;cursor:var(--cursor-cross-hover);font:inherit; }
  button:hover { background:var(--c-ui-hover); } button:disabled { opacity:.45; } button:focus-visible,input:focus-visible,textarea:focus-visible { outline:1px solid var(--c-accent);outline-offset:-1px; }
  .inbox-body { display:flex;flex:1;min-height:0; } aside { display:flex;flex-direction:column;flex:0 0 44%;min-width:230px;border-right:1px solid var(--c-line); }
  .filters { padding:10px;display:grid;gap:7px;border-bottom:1px solid var(--c-line); } input,textarea { box-sizing:border-box;width:100%;background:var(--c-bg-raised);border:1px solid var(--c-line-strong);border-radius:var(--r-ui);padding:8px;color:var(--c-tx);font:12px/1.5 var(--font-ui); } .filter-help { line-height:1.6; }
  .chips { display:flex;flex-wrap:wrap;gap:4px;align-items:center; } .chips span { background:var(--c-bg-raised);border:1px solid var(--c-line);padding:3px 5px;border-radius:var(--r-ui);font:10px var(--font-mono); }
  .inbox-list { flex:1;min-height:0;overflow:auto;contain:layout paint; } .inbox-row { position:absolute;left:0;right:0;width:100%;display:flex;gap:9px;text-align:left;padding:8px 10px;border-bottom:1px solid var(--c-line);border-radius:0;overflow:hidden; }
  .inbox-row.selected { background:color-mix(in srgb,var(--c-accent) 12%,transparent);box-shadow:inset 2px 0 var(--c-accent); }
  .thumbnail,.quote { width:56px;height:64px;flex:0 0 56px;object-fit:contain;overflow:hidden;background:var(--c-bg-raised);font:10px/1.4 var(--font-serif);overflow-wrap:anywhere; }
  .row-body { display:flex;flex-direction:column;gap:4px;min-width:0;flex:1; } .row-body b,.where,.row-tags { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; } .row-body b { font-weight:550; } .where,.row-tags { font-size:10px;color:var(--c-tx-muted); }
  .row-tags { display:flex;gap:4px;min-height:13px; } .tag { padding:1px 4px;background:var(--c-accent-tint);border-radius:var(--r-ui);font:9px var(--font-mono); }
  .origin { margin-top:14px;font:10px var(--font-mono);color:var(--c-tx-muted); } .origin.agent { color:var(--c-accent); }
  .row-meta { display:flex;gap:6px;align-items:center;white-space:nowrap;font-size:10px;min-width:0; } .row-meta>span { overflow:hidden;text-overflow:ellipsis; } time { margin-left:auto;color:var(--c-tx-muted); } i { display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--c-tx-faint);margin-right:3px; } i.live { background:var(--c-accent); }
  .status-chip { font:10px var(--font-mono);color:var(--c-tx-muted); } .status-chip[data-status="needs-input"] { color:var(--c-warning); } .status-chip[data-status="claimed"] { color:var(--c-accent); }
  .group { position:absolute;left:0;width:100%;text-align:left;padding:6px 10px;background:var(--c-bg-raised);font:10px var(--font-mono);text-transform:uppercase;letter-spacing:.06em; } .group span { float:right; }
  footer { padding:9px;border-top:1px solid var(--c-line);font-size:9px; }
  .detail { display:flex;flex:1;flex-direction:column;min-width:0;overflow:hidden; } .detail-heading { padding:14px 16px 10px;border-bottom:1px solid var(--c-line); } .detail-heading small { float:right; } .detail-heading p { color:var(--c-tx-muted);margin:8px 0 0;overflow-wrap:anywhere;line-height:1.5; }
  .detail-scroll { flex:1;min-height:0;overflow:auto;padding:0 16px 12px; } .full-text { white-space:pre-wrap;font:15px/1.6 var(--font-serif);overflow-wrap:anywhere; } .picture { display:block;max-width:100%;max-height:320px;overflow:auto;padding:0;border:1px solid var(--c-line); } .picture img { display:block;max-width:100%;height:auto; } .picture.zoom { max-height:60vh; } .picture.zoom img { max-width:none; }
  .anchors { padding-left:22px;font-size:11px;line-height:1.6;color:var(--c-tx-muted); } blockquote { margin:12px 0;padding-left:10px;border-left:2px solid var(--c-line-strong);font-family:var(--font-serif); }
  article { margin-top:12px;padding:10px;border:1px solid var(--c-line);border-left:2px solid var(--c-accent);border-radius:var(--r-ui); } article.human { border-left-color:var(--c-tx-muted);margin-left:18px; } article small { float:right; } article p { white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;margin:8px 0 0; }
  .actions { display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px;border-top:1px solid var(--c-line); } .reply { display:flex;align-items:flex-end;gap:6px;padding:0 12px 12px; } textarea { resize:vertical;min-height:60px;max-height:160px; } .reply button { border-color:var(--c-line-strong); }
  .empty { padding:24px;color:var(--c-tx-muted);line-height:1.6; } .empty b { color:var(--c-tx);font-weight:500; } .empty button { border-color:var(--c-line); } .error { padding:10px;color:var(--c-danger);overflow-wrap:anywhere; } .notice { padding:4px 12px 8px;color:var(--c-tx-muted);font-size:10px; }
  @media(max-width:640px) { aside { flex-basis:45%;min-width:190px; } .thumbnail,.quote { display:none; } .detail-heading small { display:block;float:none;margin-top:5px; } footer { font-size:8px; } }
</style>

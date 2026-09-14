<script lang="ts">
  import { nativeClick, nativeError } from "../ui/nativeEvents";
  import { tick } from "svelte";
  import DissectGrid from "../dissect/DissectGrid.svelte";
  import DissectDetail from "../dissect/DissectDetail.svelte";
  import { listDissections, clearDissectCache, type DissectListing, type DissectFile } from "../dissect/loader";
  import { dissectionsRevision } from "../../shell/scholar/revisions";
  import { galleryDissectionKey, isGalleryVideo, openGalleryVideo, type GalleryPreviewFile } from "./galleryExpanded";

  let { file, root, refreshKey = 0, initialAutoplay = false, onClose, onSimilar, onPrevious, onNext }: {
    file: GalleryPreviewFile;
    root: string;
    refreshKey?: number;
    initialAutoplay?: boolean;
    onClose: () => void;
    onSimilar?: (file: GalleryPreviewFile) => void;
    onPrevious?: () => void;
    onNext?: () => void;
  } = $props();
  let host = $state<HTMLDivElement>();
  let tab = $state<"preview" | "dissections">("preview");
  let listing = $state<DissectListing | null>(null);
  let listingError = $state("");
  let groupIndex = $state(0), selectedIndex = $state(0), detailIndex = $state<number | null>(null);
  let mediaUrl = $state(""), mediaError = $state("");
  let detail = $state<{ zoomBy: (factor: number) => void; resetZoom: () => void; toggleFit: () => void }>();
  const video = $derived(isGalleryVideo(file));
  const key = $derived(galleryDissectionKey(file, root));
  const groups = $derived(listing?.groups ?? []);
  const group = $derived(groups[groupIndex]);
  const files = $derived(group?.files ?? []);
  const detailFile = $derived(detailIndex === null ? null : files[detailIndex]);
  const sourceFile = $derived<DissectFile>({ abs: file.abs, name: file.name, kind: "image" });
  const showingImage = $derived(tab === "preview" ? !video : detailFile?.kind === "image");

  $effect(() => {
    file.abs; root; refreshKey;
    listing = null; listingError = ""; groupIndex = 0; selectedIndex = 0; detailIndex = null;
  });
  $effect(() => {
    const requestedKey = key, requestedRoot = root, revision = refreshKey;
    const watchRevision = $dissectionsRevision;
    if (tab !== "dissections" || !requestedKey) return;
    let cancelled = false;
    listing = null; listingError = "";
    // Reads only: the viewer never creates a dissection folder or changes the
    // editor's global selection/Dissect target while browsing source material.
    clearDissectCache();
    void listDissections(requestedRoot, requestedKey).then(value => { if (!cancelled) listing = value; }).catch(error => { if (!cancelled) listingError = error instanceof Error ? error.message : "Could not read dissections."; });
    void revision; void watchRevision;
    return () => { cancelled = true; };
  });
  $effect(() => {
    const target = file, projectRoot = root, revision = refreshKey;
    const enabled = video && tab === "preview";
    mediaUrl = ""; mediaError = "";
    if (!enabled) return;
    let cancelled = false, media: Awaited<ReturnType<typeof openGalleryVideo>> | undefined;
    void openGalleryVideo(projectRoot, target).then(value => {
      if (cancelled) { value.release(); return; }
      media = value; mediaUrl = value.url;
    }).catch(error => { if (!cancelled) mediaError = error instanceof Error ? error.message : "Could not open this recording."; });
    void revision;
    return () => { cancelled = true; media?.release(); };
  });

  function videoLifetime(node: HTMLVideoElement) {
    const owner = node.ownerDocument;
    const pauseHidden = () => { if (owner.hidden) node.pause(); };
    owner.addEventListener("visibilitychange", pauseHidden);
    return { destroy() { owner.removeEventListener("visibilitychange", pauseHidden); node.pause(); node.removeAttribute("src"); node.load(); } };
  }
  function switchTab(value: "preview" | "dissections") { tab = value; detailIndex = null; void tick().then(() => host?.focus()); }
  function openDetail(index: number) { selectedIndex = index; detailIndex = index; void tick().then(() => host?.focus()); }
  function back() { detailIndex = null; void tick().then(() => host?.focus()); }
  function onKey(event: KeyboardEvent) {
    // The preview lives inside the importer, including in a pinned window.
    // Handle keys on its actual DOM host, then stop the importer's shortcuts.
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); detailIndex !== null ? back() : onClose(); return; }
    if (event.key === "Tab" && host) {
      const candidates = [...host.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, video[controls], [tabindex="0"]')].filter(node => node.getClientRects().length);
      if (!candidates.length) { event.preventDefault(); host.focus(); return; }
      const first = candidates[0], last = candidates[candidates.length - 1], active = host.ownerDocument.activeElement;
      if (event.shiftKey && (active === first || active === host)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || active === host)) { event.preventDefault(); first.focus(); }
      return;
    }
    const target = event.target as HTMLElement;
    if (target.matches("input,textarea,select") || target.isContentEditable || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.toLowerCase() === "d") { event.preventDefault(); switchTab(tab === "preview" ? "dissections" : "preview"); return; }
    if (target.tagName === "VIDEO") return; // native playback controls own arrows and Space
    if (tab === "preview") {
      if (event.key === "ArrowLeft" && onPrevious) { event.preventDefault(); onPrevious(); }
      if (event.key === "ArrowRight" && onNext) { event.preventDefault(); onNext(); }
    } else if (detailIndex !== null) {
      if (event.key === "ArrowLeft") { event.preventDefault(); openDetail(Math.max(0, detailIndex - 1)); }
      if (event.key === "ArrowRight") { event.preventDefault(); openDetail(Math.min(files.length - 1, detailIndex + 1)); }
    } else if (files.length) {
      if (event.key === "ArrowLeft") selectedIndex = Math.max(0, selectedIndex - 1);
      else if (event.key === "ArrowRight") selectedIndex = Math.min(files.length - 1, selectedIndex + 1);
      else if (event.key === "ArrowUp") selectedIndex = Math.max(0, selectedIndex - 4);
      else if (event.key === "ArrowDown") selectedIndex = Math.min(files.length - 1, selectedIndex + 4);
      else if (event.key === "Enter") openDetail(selectedIndex);
      else return;
      event.preventDefault();
    }
    if (showingImage) {
      if (event.key === "+" || event.key === "=") { event.preventDefault(); detail?.zoomBy(1.25); }
      else if (event.key === "-") { event.preventDefault(); detail?.zoomBy(.8); }
      else if (event.key === "0") { event.preventDefault(); detail?.resetZoom(); }
    }
  }
  function modal(node: HTMLDivElement) {
    const previous = node.ownerDocument.activeElement as HTMLElement | null;
    node.addEventListener("keydown", onKey);
    const swallow = (event: KeyboardEvent) => event.stopPropagation();
    node.addEventListener("keyup", swallow);
    node.focus();
    return { destroy() { node.removeEventListener("keydown", onKey); node.removeEventListener("keyup", swallow); if (previous?.isConnected) previous.focus(); } };
  }
</script>

<div class="expanded-preview" role="dialog" aria-modal="true" aria-label="Expanded plot preview" tabindex="-1" bind:this={host} use:modal>
  <header>
    <div class="identity"><span class="eyebrow">{video ? "Recording preview" : "Plot preview"}</span><h2 title={file.rel || file.abs}>{file.name}</h2></div>
    <div class="header-actions">
      {#if onSimilar}<button aria-label="Find similar names" use:nativeClick={() => onSimilar?.(file)} title="Find related files by name">Similar names</button>{/if}
      <button class="close" aria-label="Close preview" title="Close preview (Esc)" use:nativeClick={onClose}>×</button>
    </div>
  </header>
  <nav aria-label="Preview views">
    <button class:chosen={tab === "preview"} aria-pressed={tab === "preview"} use:nativeClick={() => switchTab("preview")}>Preview</button>
    <button class:chosen={tab === "dissections"} aria-pressed={tab === "dissections"} aria-label="Dissections" disabled={!key} title="Show companion material (D)" use:nativeClick={() => switchTab("dissections")}>Dissections{listing ? ` (${listing.total})` : ""}<kbd>D</kbd></button>
    <span class="grow"></span>
    {#if showingImage}<button aria-label="Zoom out" use:nativeClick={() => detail?.zoomBy(.8)}>−</button><button aria-label="Fit preview" use:nativeClick={() => detail?.resetZoom()}>Fit</button><button aria-label="Zoom in" use:nativeClick={() => detail?.zoomBy(1.25)}>+</button>{/if}
    {#if tab === "preview" && (onPrevious || onNext)}<button aria-label="Previous preview" disabled={!onPrevious} use:nativeClick={onPrevious}>←</button><button aria-label="Next preview" disabled={!onNext} use:nativeClick={onNext}>→</button>{/if}
  </nav>
  {#if tab === "preview"}
    <main class="media">
      {#if video}
        {#if mediaError}<div class="empty"><strong>Preview unavailable</strong><p>{mediaError}</p></div>
        {:else if mediaUrl}
          <!-- svelte-ignore a11y_media_has_caption (the user's source video has no caption track) -->
          <video data-gallery-preview-media src={mediaUrl} controls playsinline preload="metadata" autoplay={initialAutoplay} use:videoLifetime use:nativeError={() => { mediaError = "This recording could not be played. Its video or audio codec may not be supported."; }}></video>
        {:else}<div class="empty">Opening recording…</div>{/if}
      {:else}
        <div class="image-detail" data-gallery-preview-media><DissectDetail file={sourceFile} pos={0} count={1} groupName="" onClose={() => {}} keyboardTarget={host} bind:this={detail}/></div>
      {/if}
    </main>
  {:else}
    {#if groups.length && detailIndex === null}<div class="groups" aria-label="Dissection groups">{#each groups as value, i}<button class:chosen={groupIndex === i} use:nativeClick={() => { groupIndex = i; selectedIndex = 0; }}>{value.name || "Overview"}<span>{value.files.length}</span></button>{/each}</div>{/if}
    <main class="dissections">
      {#if listingError}<div class="empty"><strong>Could not read dissections</strong><p>{listingError}</p></div>
      {:else if !key}<div class="empty">This file has no companion dissection folder.</div>
      {:else if !listing}<div class="empty">Loading dissections…</div>
      {:else if !listing.total}<div class="empty"><strong>No dissections yet</strong><p>Companion images and tables for this plot appear here.</p><code>plots/_dissections/{key}/</code></div>
      {:else if detailFile}
        <button class="back" use:nativeClick={back}>← Back to dissections</button>
        <div class="dissection-detail"><DissectDetail file={detailFile} pos={detailIndex ?? 0} count={files.length} groupName={group?.name || ""} onClose={back} keyboardTarget={host} bind:this={detail}/></div>
      {:else}<DissectGrid {files} cols={4} selectedIdx={selectedIndex} onSelect={(i) => selectedIndex = i} onOpen={openDetail}/>{/if}
    </main>
  {/if}
  <footer><span>{file.rel || file.name}</span><span>{tab === "dissections" && detailIndex !== null ? "Esc · back" : "Esc · close"}{!video && showingImage ? "   ·   + / − · zoom   ·   Space + drag · pan" : ""}</span></footer>
</div>

<style>
  .expanded-preview { position:fixed; inset:0; z-index:100; display:flex; flex-direction:column; min-width:0; min-height:0; background:var(--c-bg); color:var(--c-tx); outline:none; pointer-events:auto; }
  header { display:flex; align-items:center; gap:20px; padding:18px 24px 14px; border-bottom:1px solid var(--c-line); }
  .identity { flex:1; min-width:0; }.eyebrow { display:block; margin-bottom:5px; color:var(--c-tx-muted); font-size:10px; text-transform:uppercase; letter-spacing:1.3px; }
  h2 { margin:0; font-size:19px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.header-actions { display:flex; align-items:center; gap:14px; }
  button { color:var(--c-tx-2); background:var(--c-bg-raised); border:1px solid var(--c-line); border-radius:5px; padding:6px 11px; font:inherit; font-size:12px; cursor:pointer; }
  button:hover { color:var(--c-tx); border-color:var(--c-line-strong); }button:focus-visible { outline:2px solid var(--c-accent); outline-offset:2px; }button:disabled { opacity:.35; cursor:default; }.close { font-size:25px; line-height:24px; width:36px; padding:3px; }
  nav { display:flex; align-items:center; gap:7px; padding:9px 24px; border-bottom:1px solid var(--c-line); }kbd { font:inherit; opacity:.5; font-size:10px; padding-left:8px; }.chosen { background:var(--c-accent-tint); color:var(--c-accent-bright); border-color:var(--c-accent); }.grow { flex:1; }
  .media,.dissections { flex:1; min-width:0; min-height:0; position:relative; display:flex; flex-direction:column; overflow:hidden; }.media { background:color-mix(in oklab,var(--c-bg) 94%,black); }video { width:100%; height:100%; min-height:0; object-fit:contain; background:#000; }.image-detail,.dissection-detail { flex:1; min-height:0; position:relative; }
  .empty { display:flex; flex:1; min-height:0; align-items:center; justify-content:center; flex-direction:column; gap:8px; padding:24px; color:var(--c-tx-muted); text-align:center; }.empty strong { color:var(--c-tx-2); font-size:18px; font-weight:500; }.empty p { margin:0; }.empty code { margin-top:8px; max-width:100%; overflow-wrap:anywhere; font-size:11px; }
  .groups { display:flex; gap:8px; padding:10px 24px; overflow-x:auto; }.groups button { white-space:nowrap; }.groups span { margin-left:10px; opacity:.55; font-size:11px; }.back { align-self:flex-start; margin:10px 16px 0; }
  footer { display:flex; justify-content:space-between; gap:20px; padding:9px 24px; border-top:1px solid var(--c-line); font-size:11px; color:var(--c-tx-muted); }footer span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
</style>

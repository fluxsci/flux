<script lang="ts">
  // Present mode — a fullscreen overlay that runs the ONE player (createPlayer)
  // over the deck, scaled-to-fit (letterboxed) on any screen. Clicker-friendly
  // keymap (§6.1). The stage IS the player; Esc exits. The same player powers the
  // exported HTML (P4), so what you present is what you ship.
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { createPlayer, renderStaticAt, type Player, type PlayerState, type PlayerOpts } from "../../../lib/slide/player/player";
  import { plotManifests } from "../../../lib/plot/store";
  import { figureMembers } from "../../../lib/slide/store";
  import type { Deck, DeckTheme } from "../../../lib/slide/types";

  let {
    deck,
    theme,
    assetUrl,
    figureSvg,
    start = { slide: 0, beat: 0 },
    onClose,
  }: {
    deck: Deck;
    theme: DeckTheme;
    assetUrl?: (id: string) => string | undefined;
    figureSvg?: (id: string, groupId?: string) => string | undefined;
    start?: { slide: number; beat: number };
    onClose: () => void;
  } = $props();

  let root = $state<HTMLElement>();
  let mount = $state<HTMLElement>();
  let nextMount = $state<HTMLElement>();
  let vw = $state(0);
  let vh = $state(0);
  let player: Player | undefined;
  let st = $state<PlayerState>({ slide: 0, beat: 0, totalBeats: 1, totalSlides: 1 });
  let blank = $state<"" | "black" | "white">("");
  let showNotes = $state(false);
  let elapsed = $state(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  let digits = $state("");
  // Present defaults to motion ON — a talk is meant to animate. The OS
  // reduce-motion setting no longer silently kills every build (B1); toggle with M.
  let reducedMotion = $state(false);
  let idle = $state(false);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  // Screen wake lock so the display never sleeps mid-talk (B18).
  let wakeLock: { release: () => Promise<void> } | null = null;

  const scale = $derived(vw > 0 && vh > 0 ? Math.min(vw / deck.stage.width, vh / deck.stage.height) : 1);
  const notes = $derived(deck.slides[st.slide]?.notes ?? "");
  const clock = $derived(`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`);
  const nextIdx = $derived(st.slide + 1 < deck.slides.length ? st.slide + 1 : -1);
  // preview scale for the presenter panel's next-slide thumbnail
  const NEXT_W = 300;
  const nextScale = $derived(NEXT_W / deck.stage.width);

  function playerOpts(): PlayerOpts {
    return { mode: "present", theme, assetUrl, figureSvg, plotManifest: (id) => get(plotManifests)[id], figureMember: (fid, mid) => get(figureMembers)[fid]?.[mid], reducedMotion };
  }
  function buildPlayer(at: { slide: number; beat: number }) {
    if (!mount) return;
    player?.destroy();
    player = createPlayer(mount, deck, playerOpts());
    player.on("change", (s) => { st = s; renderNext(); });
    player.goTo(at.slide, at.beat);
    st = player.state();
    renderNext();
  }
  /** Render the NEXT slide (fully built) into the presenter panel's thumbnail. */
  function renderNext() {
    if (!nextMount) return;
    nextMount.replaceChildren();
    if (nextIdx < 0) return;
    const s = deck.slides[nextIdx];
    const host = document.createElement("div");
    host.style.cssText = `position:relative;width:${deck.stage.width}px;height:${deck.stage.height}px;background:${s.background ?? theme.background};`;
    nextMount.appendChild(host);
    try {
      renderStaticAt(host, s, deck.stage, Math.max(0, s.beats.length - 1), {
        mode: "present", theme, assetUrl, figureSvg, plotManifest: (id) => get(plotManifests)[id],
        figureMember: (fid, mid) => get(figureMembers)[fid]?.[mid],
      });
    } catch { /* a missing asset preview is non-fatal */ }
  }

  onMount(() => {
    buildPlayer(start);
    timer = setInterval(() => (elapsed += 1), 1000);
    root?.focus();
    void enterFullscreen(); // B5: fill the screen on launch
    void requestWake(); // B18
    bumpIdle();
  });
  onDestroy(() => {
    player?.destroy();
    if (timer) clearInterval(timer);
    if (idleTimer) clearTimeout(idleTimer);
    void wakeLock?.release().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); // B23
  });

  async function enterFullscreen() {
    try { if (!document.fullscreenElement) await root?.requestFullscreen?.(); } catch { /* needs a gesture; F retries */ }
  }
  async function requestWake() {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      if (wl) wakeLock = await wl.request("screen");
    } catch { /* unsupported / denied — harmless */ }
  }
  function toggleReducedMotion() {
    reducedMotion = !reducedMotion;
    buildPlayer({ slide: st.slide, beat: st.beat }); // rebuild honoring the new setting
  }

  // Cursor auto-hides after inactivity (B21); any move brings it (and the HUD) back.
  function bumpIdle() {
    idle = false;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (idle = true), 2500);
  }

  // Blank/away pauses videos so audio doesn't play to a black screen (B15).
  $effect(() => { player?.setMediaPaused(!!blank); });

  // Render the next-slide preview whenever the panel opens or the position moves
  // (the panel — hence nextMount — only exists while showNotes is true).
  $effect(() => {
    void showNotes; void nextIdx;
    if (showNotes && nextMount) renderNext();
  });

  function onKey(e: KeyboardEvent) {
    if (!player) return;
    bumpIdle();
    const k = e.key;
    if (k === "Escape") { onClose(); return; }
    if (blank && k !== "b" && k !== "B" && k !== "w" && k !== "W") blank = "";
    if (/^[0-9]$/.test(k)) { digits += k; return; }
    if (k === "Enter" && digits) { player.goTo(Math.max(0, Math.min(deck.slides.length - 1, parseInt(digits, 10) - 1)), 0); digits = ""; return; }
    if (k !== "Shift" && k !== "Meta" && k !== "Control" && k !== "Alt") digits = "";
    switch (k) {
      case "ArrowRight": case " ": case "PageDown": e.preventDefault(); e.shiftKey ? player.nextSlide() : player.next(); break;
      case "ArrowLeft": case "Backspace": case "PageUp": e.preventDefault(); e.shiftKey ? player.prevSlide() : player.prev(); break;
      case "ArrowDown": e.preventDefault(); player.nextSlide(); break;
      case "ArrowUp": e.preventDefault(); player.prevSlide(); break;
      case "Home": player.goTo(0, 0); break;
      case "End": player.goTo(deck.slides.length - 1, 0); break;
      case "b": case "B": blank = blank === "black" ? "" : "black"; break;
      case "w": case "W": blank = blank === "white" ? "" : "white"; break;
      case "f": case "F": toggleFullscreen(); break;
      case "s": case "S": showNotes = !showNotes; break;
      case "r": case "R": elapsed = 0; break;
      case "m": case "M": toggleReducedMotion(); break;
    }
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else root?.requestFullscreen?.().catch(() => {});
  }
  function onClick(e: MouseEvent) {
    if (!player) return;
    bumpIdle();
    // ignore clicks on interactive video controls / the presenter panel (B4).
    const t = e.target as HTMLElement;
    if (t.closest("video") || t.closest(".notes") || t.closest(".hud")) return;
    // left quarter = back, rest = forward (clicker-like)
    if (e.clientX < vw * 0.25) player.prev();
    else player.next();
  }
</script>

<svelte:window onkeydown={onKey} onmousemove={bumpIdle} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  class="present"
  class:idle
  bind:this={root}
  bind:clientWidth={vw}
  bind:clientHeight={vh}
  tabindex="0"
  onclick={onClick}>
  <div class="fit" style={`width:${deck.stage.width}px;height:${deck.stage.height}px;transform:translate(-50%,-50%) scale(${scale})`}>
    <div class="mount" bind:this={mount}></div>
  </div>

  {#if blank}<div class="blank" style={`background:${blank === "black" ? "#000" : "#fff"}`}></div>{/if}

  {#if digits}<div class="jump">→ slide {digits}</div>{/if}

  {#if showNotes}
    <!-- Presenter panel: timer, position, next-slide preview, notes (B3). -->
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <div class="notes" onclick={(e) => e.stopPropagation()}>
      <div class="notes-top">
        <span class="clock">{clock}</span>
        <span class="pos">slide {st.slide + 1}/{st.totalSlides} · beat {st.beat + 1}/{st.totalBeats}</span>
      </div>
      <div class="next">
        <div class="next-label">{nextIdx >= 0 ? "Next" : "End of deck"}</div>
        {#if nextIdx >= 0}
          <div class="next-frame" style={`width:${NEXT_W}px;height:${deck.stage.height * nextScale}px`}>
            <div class="next-scaled" bind:this={nextMount}
              style={`width:${deck.stage.width}px;height:${deck.stage.height}px;transform:scale(${nextScale});transform-origin:0 0`}></div>
          </div>
        {/if}
      </div>
      <div class="notes-body">{notes || "No notes for this slide."}</div>
      <div class="notes-hint">S notes · M motion {reducedMotion ? "off" : "on"} · B/W blank · R reset · F full</div>
    </div>
  {/if}

  <div class="hud">
    <span>{st.slide + 1} / {st.totalSlides}</span>
    <span class="beats">{#each Array(st.totalBeats) as _, i (i)}<span class="dot" class:on={i <= st.beat}></span>{/each}</span>
    <button class="x" onclick={(e) => { e.stopPropagation(); onClose(); }} title="Exit (Esc)">Esc</button>
  </div>
</div>

<style>
  .present {
    position: fixed; inset: 0; z-index: 1000; background: #000; outline: none; cursor: default;
    overflow: hidden;
  }
  .present.idle { cursor: none; }
  .fit { position: absolute; top: 50%; left: 50%; transform-origin: center center; }
  .mount { position: absolute; inset: 0; }
  .blank { position: absolute; inset: 0; z-index: 5; }
  .jump {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 14;
    font: 600 40px ui-monospace, monospace; color: rgba(255, 255, 255, 0.92);
    background: rgba(0, 0, 0, 0.55); border-radius: 12px; padding: 14px 28px; letter-spacing: 0.04em;
  }
  .hud {
    position: absolute; bottom: 14px; left: 0; right: 0; z-index: 10;
    display: flex; align-items: center; justify-content: center; gap: 16px;
    font-size: 12px; color: rgba(255, 255, 255, 0.5); opacity: 0; transition: opacity 0.2s; pointer-events: none;
  }
  .present:hover .hud { opacity: 1; }
  .present.idle .hud { opacity: 0; }
  .hud .beats { display: flex; gap: 5px; }
  .hud .dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(255, 255, 255, 0.25); }
  .hud .dot.on { background: #4385be; }
  .hud .x { pointer-events: all; border: 1px solid rgba(255, 255, 255, 0.3); background: transparent; color: rgba(255, 255, 255, 0.7); border-radius: 5px; padding: 2px 8px; cursor: pointer; font-size: 11px; }
  .hud .x:hover { color: #fff; border-color: #fff; }
  .notes {
    position: absolute; top: 18px; right: 18px; z-index: 12; width: 340px; max-height: 92vh;
    display: flex; flex-direction: column; gap: 10px; padding: 14px 16px;
    background: rgba(16, 16, 18, 0.9); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 10px;
    backdrop-filter: blur(6px); color: rgba(255, 255, 255, 0.82); cursor: default;
  }
  .notes-top { display: flex; align-items: baseline; justify-content: space-between; }
  .notes .clock { font: 600 22px ui-monospace, monospace; color: #fff; font-variant-numeric: tabular-nums; }
  .notes .pos { font-size: 11px; color: rgba(255, 255, 255, 0.45); }
  .next { display: flex; flex-direction: column; gap: 5px; }
  .next-label { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255, 255, 255, 0.4); }
  .next-frame { position: relative; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 6px; }
  .next-scaled { position: absolute; top: 0; left: 0; }
  .notes-body { font: 15px/1.5 Georgia, serif; white-space: pre-wrap; overflow-y: auto; }
  .notes-hint { font-size: 10px; color: rgba(255, 255, 255, 0.35); letter-spacing: 0.03em; }
</style>

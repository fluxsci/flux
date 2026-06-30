<script lang="ts">
  // Present mode — a fullscreen overlay that runs the ONE player (createPlayer)
  // over the deck, scaled-to-fit (letterboxed) on any screen. Clicker-friendly
  // keymap (§6.1). The stage IS the player; Esc exits. The same player powers the
  // exported HTML (P4), so what you present is what you ship.
  import { onMount, onDestroy } from "svelte";
  import { createPlayer, type Player, type PlayerState, type PlayerOpts } from "../../../lib/slide/player/player";
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
    figureSvg?: (id: string) => string | undefined;
    start?: { slide: number; beat: number };
    onClose: () => void;
  } = $props();

  let root = $state<HTMLElement>();
  let mount = $state<HTMLElement>();
  let vw = $state(0);
  let vh = $state(0);
  let player: Player | undefined;
  let st = $state<PlayerState>({ slide: 0, beat: 0, totalBeats: 1, totalSlides: 1 });
  let blank = $state<"" | "black" | "white">("");
  let digits = "";

  const scale = $derived(vw > 0 && vh > 0 ? Math.min(vw / deck.stage.width, vh / deck.stage.height) : 1);

  onMount(() => {
    if (!mount) return;
    const opts: PlayerOpts = { mode: "present", theme, assetUrl, figureSvg };
    player = createPlayer(mount, deck, opts);
    player.on("change", (s) => (st = s));
    player.goTo(start.slide, start.beat);
    st = player.state();
    root?.focus();
  });
  onDestroy(() => player?.destroy());

  function onKey(e: KeyboardEvent) {
    if (!player) return;
    const k = e.key;
    if (k === "Escape") { onClose(); return; }
    if (blank && k !== "b" && k !== "B" && k !== "w" && k !== "W") blank = "";
    if (/^[0-9]$/.test(k)) { digits += k; return; }
    if (k === "Enter" && digits) { player.goTo(Math.max(0, Math.min(deck.slides.length - 1, parseInt(digits, 10) - 1)), 0); digits = ""; return; }
    digits = "";
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
    }
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else root?.requestFullscreen?.().catch(() => {});
  }
  function onClick(e: MouseEvent) {
    if (!player) return;
    // left third = back, rest = forward (clicker-like)
    if (e.clientX < vw * 0.25) player.prev();
    else player.next();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  class="present"
  bind:this={root}
  bind:clientWidth={vw}
  bind:clientHeight={vh}
  tabindex="0"
  onkeydown={onKey}
  onclick={onClick}>
  <div class="fit" style={`width:${deck.stage.width}px;height:${deck.stage.height}px;transform:translate(-50%,-50%) scale(${scale})`}>
    <div class="mount" bind:this={mount}></div>
  </div>

  {#if blank}<div class="blank" style={`background:${blank === "black" ? "#000" : "#fff"}`}></div>{/if}

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
  .fit { position: absolute; top: 50%; left: 50%; transform-origin: center center; }
  .mount { position: absolute; inset: 0; }
  .blank { position: absolute; inset: 0; z-index: 5; }
  .hud {
    position: absolute; bottom: 14px; left: 0; right: 0; z-index: 10;
    display: flex; align-items: center; justify-content: center; gap: 16px;
    font-size: 12px; color: rgba(255, 255, 255, 0.5); opacity: 0; transition: opacity 0.2s; pointer-events: none;
  }
  .present:hover .hud { opacity: 1; }
  .hud .beats { display: flex; gap: 5px; }
  .hud .dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(255, 255, 255, 0.25); }
  .hud .dot.on { background: #4385be; }
  .hud .x { pointer-events: all; border: 1px solid rgba(255, 255, 255, 0.3); background: transparent; color: rgba(255, 255, 255, 0.7); border-radius: 5px; padding: 2px 8px; cursor: pointer; font-size: 11px; }
  .hud .x:hover { color: #fff; border-color: #fff; }
</style>

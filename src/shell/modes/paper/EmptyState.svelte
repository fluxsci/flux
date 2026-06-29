<script lang="ts">
  import { fade } from "svelte/transition";

  let {
    title,
    onStart,
  }: { title: string; onStart: (seed: string) => void } = $props();

  const OUTLINE =
    "# Introduction\n\n\n# Methods\n\n\n# Results\n\n\n# Discussion\n\n\n";
</script>

<div class="empty" transition:fade={{ duration: 160 }}>
  <div class="inner">
    <span class="rule" aria-hidden="true"></span>
    <h1 class="t">{title}</h1>
    <p class="sub">A blank page. Begin writing — or start from a structure.</p>
    <div class="acts">
      <button class="primary" onclick={() => onStart("")}>Start writing</button>
      <button class="ghost" onclick={() => onStart(OUTLINE)}>Outline a paper</button>
    </div>
  </div>
</div>

<style>
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background-color: var(--c-bg);
    background-image: radial-gradient(var(--c-dot) 1px, transparent 1.6px);
    background-size: 26px 26px;
    background-position: center;
    z-index: 4;
  }
  .inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-3);
    max-width: 440px;
    text-align: center;
    padding-bottom: 8vh;
  }
  .rule {
    display: block;
    width: 64px;
    height: 1px;
    background: var(--c-accent);
    transform-origin: center;
    animation: draw var(--dur-deliberate) var(--ease-enter) both;
  }
  @keyframes draw {
    from {
      transform: scaleX(0);
      opacity: 0.4;
    }
    to {
      transform: scaleX(1);
      opacity: 1;
    }
  }
  .t {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 600;
    font-size: clamp(28px, 4vw, 40px);
    letter-spacing: var(--tracking-tight);
    color: var(--c-tx-hi);
  }
  .sub {
    margin: 0;
    font-size: var(--ts-md);
    color: var(--c-tx-muted);
  }
  .acts {
    display: flex;
    gap: var(--sp-3);
    margin-top: var(--sp-3);
  }
  .acts button {
    font-family: var(--font-serif);
    font-size: var(--ts-base);
    border-radius: var(--r-2);
    padding: 9px 22px;
    cursor: pointer;
    transition:
      background var(--dur-instant) var(--ease-standard),
      color var(--dur-instant) var(--ease-standard),
      border-color var(--dur-instant) var(--ease-standard);
  }
  .primary {
    background: transparent;
    color: var(--c-accent);
    border: 1px solid var(--c-accent);
  }
  .primary:hover {
    background: var(--c-accent-tint);
    color: var(--c-accent-bright);
  }
  .ghost {
    background: none;
    border: 1px solid transparent;
    color: var(--c-tx-2);
  }
  .ghost:hover {
    color: var(--c-tx-hi);
    border-color: var(--c-line);
  }
  @media (prefers-reduced-motion: reduce) {
    .rule {
      animation: none;
      transform: none;
      opacity: 1;
    }
  }
</style>

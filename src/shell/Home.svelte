<script lang="ts">
  import Logomark from "./Logomark.svelte";
  import Icon from "./Icon.svelte";
  import {
    recents,
    newProject,
    openProject,
    openRecent,
    projectError,
    type RecentProject,
  } from "./shellStore";
  import { prefersReducedMotion } from "../lib/motion/motion";

  const animate = !prefersReducedMotion();

  function rel(ts: number): string {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function recentSubtitle(r: RecentProject): string {
    return r.path ?? "unsaved";
  }
</script>

<div class="home">
  <div class="hero" class:animate>
    <div class="brandblock">
      <Logomark size={132} animated={animate} />
      <h1 class="wordmark">Flux</h1>
    </div>

    <div class="spacer"></div>

    <div class="actions">
      <button class="new" onclick={newProject}>New</button>
      <button class="open" onclick={openProject}>Open</button>
      {#if $projectError}
        <p class="error" role="alert">{$projectError}</p>
      {/if}
    </div>

    <div class="spacer"></div>

    {#if $recents.length}
      <div class="recents">
        <h2 class="recents-title">Recent</h2>
        <ul class="recents-list">
          {#each $recents as r (r.path ?? r.name)}
            <li>
              <button class="recent" onclick={() => openRecent(r)}>
                <span class="ricon"><Icon name="folder" size={16} stroke={1.6} /></span>
                <span class="rmeta">
                  <span class="rname">{r.name}</span>
                  <span class="rpath">{recentSubtitle(r)}</span>
                </span>
                <span class="rtime">
                  <Icon name="clock" size={12} stroke={1.6} />
                  {rel(r.openedAt)}
                </span>
                <span class="rgo"><Icon name="arrow" size={15} stroke={1.7} /></span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
</div>

<style>
  .home {
    position: relative;
    height: 100%;
    overflow: auto;
    display: flex;
    justify-content: center;
    /* Engineering-paper dot grid on the near-black app background. */
    background-color: var(--c-bg);
    background-image: radial-gradient(var(--c-dot) 1px, transparent 1.6px);
    background-size: 26px 26px;
    background-position: center;
  }

  .hero {
    position: relative;
    width: min(520px, 88vw);
    min-height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: clamp(56px, 15vh, 150px) 0 var(--sp-7);
  }

  .brandblock {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .wordmark {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 600;
    font-size: clamp(44px, 6vw, 62px);
    line-height: var(--lh-tight);
    letter-spacing: var(--tracking-tight);
    color: var(--c-tx-hi);
  }

  /* The big breathing gap: actions float in the lower-middle, recents anchor low. */
  .spacer {
    flex: 1 1 8vh;
    min-height: var(--sp-7);
  }

  .actions {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-4);
  }
  .new {
    background: transparent;
    color: var(--c-accent);
    border: 1px solid var(--c-accent);
    border-radius: var(--r-2);
    padding: 10px 30px;
    font-family: var(--font-serif);
    font-size: var(--ts-md);
    cursor: pointer;
    transition:
      background var(--dur-instant) var(--ease-standard),
      color var(--dur-instant) var(--ease-standard),
      transform var(--dur-instant) var(--ease-standard);
  }
  .new:hover {
    background: var(--c-accent-tint);
    color: var(--c-accent-bright);
  }
  .new:active {
    transform: translateY(1px) scale(0.99);
  }
  .open {
    background: none;
    border: none;
    color: var(--c-tx);
    font-family: var(--font-serif);
    font-size: var(--ts-md);
    cursor: pointer;
    transition: color var(--dur-instant) var(--ease-standard);
  }
  .open:hover {
    color: var(--c-tx-hi);
  }

  .error {
    margin: var(--sp-2) 0 0;
    padding: var(--sp-2) var(--sp-4);
    font-size: var(--ts-sm);
    color: #f89a8a; /* flexoki red-200 */
    background: color-mix(in oklab, #d14d41 12%, transparent);
    border: 1px solid color-mix(in oklab, #d14d41 28%, transparent);
    border-radius: var(--r-2);
    text-align: center;
  }

  .recents {
    width: 100%;
    max-width: 460px;
  }
  .recents-title {
    margin: 0 0 var(--sp-3);
    font-family: var(--font-serif);
    font-size: var(--ts-sm);
    font-weight: 600;
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--c-tx-faint);
    text-align: center;
  }
  .recents-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .recent {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-2);
    cursor: pointer;
    text-align: left;
    transition:
      background var(--dur-instant) var(--ease-standard),
      border-color var(--dur-instant) var(--ease-standard);
  }
  .recent:hover {
    background: var(--c-surface);
    border-color: var(--c-line);
  }
  .ricon {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    flex: 0 0 auto;
    color: var(--c-accent-bright);
    background: var(--c-accent-tint-2);
    border-radius: var(--r-1);
  }
  .rmeta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1 1 auto;
  }
  .rname {
    font-size: var(--ts-md);
    color: var(--c-tx);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rpath {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-family: var(--font-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rtime {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: 0 0 auto;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .rgo {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    color: var(--c-tx-faint);
    opacity: 0;
    transform: translateX(-4px);
    transition:
      opacity var(--dur-instant) var(--ease-standard),
      transform var(--dur-instant) var(--ease-standard);
  }
  .recent:hover .rgo {
    opacity: 1;
    transform: translateX(0);
    color: var(--c-accent-bright);
  }

  /* ---- Staggered reveal (applied only when motion is allowed) ----------- */
  /* The mark draws itself first (Logomark), then text + actions rise in. */
  .hero.animate .wordmark {
    animation: reveal var(--dur-gentle) var(--ease-enter) both;
    animation-delay: 720ms;
  }
  .hero.animate .actions {
    animation: reveal var(--dur-gentle) var(--ease-enter) both;
    animation-delay: 900ms;
  }
  .hero.animate .recents {
    animation: reveal var(--dur-gentle) var(--ease-enter) both;
    animation-delay: 1040ms;
  }

  @keyframes reveal {
    from {
      opacity: 0;
      transform: translate3d(0, 12px, 0);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
</style>

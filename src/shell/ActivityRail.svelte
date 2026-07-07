<script lang="ts">
  import Icon from "./Icon.svelte";
  import { goHome, type ModeId } from "./shellStore";
  import { focusedMode, setFocusedMode, splitWith } from "./paneStore";
  import { helpOpen, settingsOpen } from "../lib/settings";

  const modes: { id: ModeId; label: string; icon: string }[] = [
    { id: "figure", label: "Figure", icon: "figure" },
    { id: "paper", label: "Paper", icon: "paper" },
    { id: "slide", label: "Slide", icon: "slide" },
    { id: "library", label: "Library", icon: "bookOpen" },
    { id: "reader", label: "Reader", icon: "fileText" },
  ];

  const activeIndex = $derived(modes.findIndex((m) => m.id === $focusedMode));

  function pick(e: MouseEvent, mode: ModeId) {
    if (e.altKey || e.metaKey) splitWith(mode);
    else setFocusedMode(mode);
  }
</script>

<nav class="rail">
  <button class="item home" onclick={goHome} title="Home">
    <Icon name="home" size={19} />
  </button>

  <span class="sep" aria-hidden="true"></span>

  <div class="modes" style="--ai:{activeIndex}">
    <span class="indicator" class:hidden={activeIndex < 0} aria-hidden="true"></span>
    {#each modes as m (m.id)}
      <button
        class="item"
        class:active={$focusedMode === m.id}
        title={`${m.label}  (Alt-click to split)`}
        aria-label={m.label}
        aria-current={$focusedMode === m.id}
        onclick={(e) => pick(e, m.id)}>
        <Icon name={m.icon} size={20} />
      </button>
    {/each}
  </div>

  <span class="grow" aria-hidden="true"></span>

  <button class="item foot" title="Settings" aria-label="Settings" onclick={() => settingsOpen.set(true)}>
    <Icon name="settings" size={19} />
  </button>
  <button class="item foot" title="Keyboard shortcuts  (?)" aria-label="Keyboard shortcuts" onclick={() => helpOpen.set(true)}>
    <span class="qmark">?</span>
  </button>
</nav>

<style>
  .rail {
    flex: 0 0 var(--rail-w);
    width: var(--rail-w);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--sp-3) 0;
    gap: var(--sp-1);
    background: var(--c-bg-raised);
    border-right: 1px solid var(--c-line);
  }

  .sep {
    width: 24px;
    height: 1px;
    background: var(--c-line-strong);
    margin: var(--sp-2) 0;
  }

  .grow {
    flex: 1 1 auto;
  }
  .item.foot {
    width: 40px;
    height: 40px;
    color: var(--c-tx-faint);
  }
  .qmark {
    font-family: var(--font-serif);
    font-size: 18px;
    font-weight: 600;
    line-height: 1;
  }

  .modes {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .item {
    width: 44px;
    height: 44px;
    margin: 2px 0;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--c-tx-muted);
    border-radius: var(--r-2);
    cursor: pointer;
    transition:
      background var(--dur-instant) var(--ease-standard),
      color var(--dur-instant) var(--ease-standard),
      transform var(--dur-instant) var(--ease-standard);
  }
  .item:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx);
  }
  .item:active {
    transform: scale(0.92);
  }
  .item.active {
    color: var(--c-accent-bright);
    background: var(--c-accent-tint-2);
  }

  /* Sliding accent marker — Tier-1 transform (style_principles.md P5). */
  .indicator {
    position: absolute;
    left: -12px;
    top: 0;
    width: 3px;
    height: 22px;
    border-radius: var(--r-pill);
    background: var(--c-accent);
    box-shadow: 0 0 10px var(--c-accent-glow);
    /* item stride = 44 height + 4 margin = 48; center within: (48-22)/2 = 13 */
    transform: translateY(calc(var(--ai) * 48px + 13px));
    transition: transform var(--dur-quick) var(--ease-standard);
  }
  .indicator.hidden {
    opacity: 0;
  }
</style>

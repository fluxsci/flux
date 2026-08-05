<script lang="ts">
  import { fade } from "svelte/transition";
  import type { EditorView } from "@codemirror/view";
  import Icon from "../../../Icon.svelte";
  import { bubble } from "./selectionState";
  import {
    insertLink,
    setHeading,
    setTextColor,
    toggleBulletList,
    toggleQuote,
    toggleWrap,
    type Command,
  } from "../editing/commands";
  import { openLocalWordTools } from "../editing/localWordTools";

  let { view, onComment }: { view: EditorView | undefined; onComment?: () => void } =
    $props();

  const btns: { name: string; title: string; run: Command }[] = [
    { name: "bold", title: "Bold  ⌘B", run: toggleWrap("**") },
    { name: "italic", title: "Italic  ⌘I", run: toggleWrap("*") },
    { name: "codeInline", title: "Code  ⌘E", run: toggleWrap("`") },
    { name: "link", title: "Link  ⌘K", run: insertLink },
    { name: "heading", title: "Heading", run: setHeading(2) },
    { name: "quote", title: "Quote", run: toggleQuote },
    { name: "listBullet", title: "Bullet list", run: toggleBulletList },
    { name: "bookText", title: "Word tools  ⌘⌥L", run: (v) => openLocalWordTools(v) },
  ];

  // Flexoki 600s — the text-grade inks tokens.css already uses on the cream
  // paper, and equally legible on the white journal page in Preview/exports.
  const SPAN_COLORS = [
    { name: "Red", hex: "#af3029" },
    { name: "Orange", hex: "#bc5215" },
    { name: "Yellow", hex: "#ad8301" },
    { name: "Green", hex: "#66800b" },
    { name: "Cyan", hex: "#24837b" },
    { name: "Blue", hex: "#205ea6" },
    { name: "Purple", hex: "#5e409d" },
    { name: "Magenta", hex: "#a02f6f" },
  ];

  let colorsOpen = $state(false);
  $effect(() => {
    if (!$bubble.visible) colorsOpen = false;
  });

  function act(e: MouseEvent, run: Command) {
    e.preventDefault();
    e.stopPropagation();
    if (view) run(view);
  }
</script>

{#if $bubble.visible}
  <div
    class="bubble"
    style="left:{$bubble.cx}px; top:{$bubble.top}px"
    transition:fade={{ duration: 110 }}>
    {#each btns as b (b.name)}
      <button class="bbtn" title={b.title} onmousedown={(e) => act(e, b.run)}>
        <Icon name={b.name} size={16} stroke={1.9} />
      </button>
    {/each}
    <button
      class="bbtn"
      class:open={colorsOpen}
      title="Text color"
      onmousedown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        colorsOpen = !colorsOpen;
      }}>
      <Icon name="textColor" size={16} stroke={1.9} />
    </button>
    {#if colorsOpen}
      <span class="bsep"></span>
      {#each SPAN_COLORS as c (c.hex)}
        <button
          class="swatch"
          title={c.name}
          style="--swatch:{c.hex}"
          onmousedown={(e) => {
            act(e, setTextColor(c.hex));
            colorsOpen = false;
          }}></button>
      {/each}
      <button
        class="swatch clear"
        title="Clear color"
        onmousedown={(e) => {
          act(e, setTextColor(null));
          colorsOpen = false;
        }}></button>
    {/if}
    {#if onComment}
      <span class="bsep"></span>
      <button
        class="bbtn"
        title="Comment"
        onmousedown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onComment?.();
        }}>
        <Icon name="message" size={15} stroke={1.9} />
      </button>
    {/if}
  </div>
{/if}

<style>
  .bubble {
    position: fixed;
    z-index: 60;
    transform: translate(-50%, calc(-100% - 9px));
    display: flex;
    gap: 1px;
    padding: 3px;
    background: var(--c-surface-2);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2);
    box-shadow: var(--elev-2);
  }
  .bbtn {
    width: 30px;
    height: 27px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--c-tx-2);
    border-radius: var(--r-1);
    cursor: pointer;
    transition:
      background var(--dur-instant) var(--ease-standard),
      color var(--dur-instant) var(--ease-standard);
  }
  .bbtn:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx-hi);
  }
  .bbtn.open {
    background: var(--c-ui-active);
    color: var(--c-tx-hi);
  }
  .swatch {
    width: 16px;
    height: 16px;
    align-self: center;
    margin: 0 2px;
    padding: 0;
    border: 1px solid var(--c-line-strong);
    border-radius: 50%;
    background: var(--swatch);
    cursor: pointer;
    transition: transform var(--dur-instant) var(--ease-standard);
  }
  .swatch:hover {
    transform: scale(1.2);
    border-color: var(--c-tx-2);
  }
  .swatch.clear {
    position: relative;
    background: transparent;
  }
  .swatch.clear::after {
    content: "";
    position: absolute;
    left: 2px;
    right: 2px;
    top: 50%;
    height: 1.5px;
    background: var(--c-danger);
    transform: rotate(-45deg);
  }
  .bsep {
    width: 1px;
    align-self: stretch;
    margin: 2px 2px;
    background: var(--c-line-strong);
  }
</style>

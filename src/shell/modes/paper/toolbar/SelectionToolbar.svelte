<script lang="ts">
  import { fade } from "svelte/transition";
  import type { EditorView } from "@codemirror/view";
  import Icon from "../../../Icon.svelte";
  import { bubble } from "./selectionState";
  import {
    insertLink,
    setHeading,
    toggleBulletList,
    toggleQuote,
    toggleWrap,
    type Command,
  } from "../editing/commands";

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
  ];

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
  .bsep {
    width: 1px;
    align-self: stretch;
    margin: 2px 2px;
    background: var(--c-line-strong);
  }
</style>

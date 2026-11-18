<script lang="ts">
  import { yieldsToShellModal, isAnnotateChord } from "../shell/agent/annotationVisibility";

  // Shell-global keyboard reference. Mounted once (Shell — so `?` works on Home
  // too); opened with `?` from anywhere or the title-bar help button (the
  // `helpOpen` store).
  //
  // This file is the eager part and is deliberately tiny: the `?` key and a lazy
  // mount. The dialog and its content (help/HelpDialog.svelte, help/shortcuts.ts,
  // some 300 rows) load on first use, and are warmed when the app is idle so the
  // first `?` opens at once; none of it is in Home's eager graph.
  import { onMount } from "svelte";
  import { helpOpen } from "./settings";

  type Dialog = typeof import("./help/HelpDialog.svelte").default;
  let HelpDialog = $state<Dialog | null>(null);
  let dialog = $state<{ handleKey(e: KeyboardEvent): boolean } | null>(null);
  let loading: Promise<unknown> | null = null;
  const load = () => (loading ??= import("./help/HelpDialog.svelte").then((m) => (HelpDialog = m.default)));
  $effect(() => {
    if ($helpOpen) void load();
  });
  onMount(() => {
    const idle = (window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1200)))(() => void load());
    return () => (window.cancelIdleCallback ?? window.clearTimeout)(idle as number);
  });

  // Focus goes back to wherever it was when the reference opened.
  let prevFocus: HTMLElement | null = null;
  $effect(() => {
    if ($helpOpen) prevFocus = document.activeElement as HTMLElement | null;
    else if (prevFocus) {
      prevFocus.focus?.();
      prevFocus = null;
    }
  });

  function isTyping(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return (
      !!el &&
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
    );
  }

  function onKey(e: KeyboardEvent) {
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    if ($helpOpen) {
      // The open reference owns its keys (search, sections, Esc clears before it closes).
      if (dialog?.handleKey(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        helpOpen.set(false);
        return;
      }
    }
    if (isTyping(e.target)) return; // never hijack "?" typed into an editor/field
    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      helpOpen.set(!$helpOpen);
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if $helpOpen && HelpDialog}<HelpDialog bind:this={dialog} />{/if}

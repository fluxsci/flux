<script lang="ts">
  import { fade } from "svelte/transition";
  import TitleBar from "./TitleBar.svelte";
  import Home from "./Home.svelte";
  import Workspace from "./Workspace.svelte";
  import { view } from "./shellStore";
  import { DUR } from "../lib/motion/tokens";
</script>

<div class="shell">
  <TitleBar />
  <div class="shell-body">
    {#if $view === "home"}
      <div
        class="surface"
        in:fade={{ duration: DUR.gentle }}
        out:fade={{ duration: DUR.quick }}>
        <Home />
      </div>
    {:else}
      <div
        class="surface"
        in:fade={{ duration: DUR.gentle }}
        out:fade={{ duration: DUR.quick }}>
        <Workspace />
      </div>
    {/if}
  </div>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    background: var(--c-bg);
  }
  .shell-body {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }
  .surface {
    position: absolute;
    inset: 0;
  }
</style>

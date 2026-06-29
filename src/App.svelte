<script lang="ts">
  import { onMount } from "svelte";
  import Toolbar from "./lib/Toolbar.svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import Canvas from "./lib/Canvas.svelte";
  import Inspector from "./lib/Inspector.svelte";
  import Help from "./lib/Help.svelte";
  import Forgery from "./lib/Forgery.svelte";
  import Settings from "./lib/Settings.svelte";
  import PlotXray from "./lib/PlotXray.svelte";
  import PlotImporter from "./lib/PlotImporter.svelte";
  import { handleKey } from "./lib/keyboard";

  onMount(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });
</script>

<div class="app">
  <Toolbar />
  <div class="body">
    <Sidebar />
    <main class="canvas-wrap"><Canvas /><Help /></main>
    <Inspector />
  </div>
  <Forgery />
  <Settings />
  <PlotXray />
  <PlotImporter />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    color: #e3e5e8;
    font-family: Georgia, "Times New Roman", serif;
    overflow: hidden;
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .canvas-wrap {
    flex: 1;
    min-width: 0;
    position: relative;
  }
</style>

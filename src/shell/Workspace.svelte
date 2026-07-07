<script lang="ts">
  import ActivityRail from "./ActivityRail.svelte";
  import PaneArea from "./PaneArea.svelte";
  import Help from "../lib/Help.svelte";
  import Settings from "../lib/Settings.svelte";
</script>

<div class="workspace">
  <ActivityRail />
  <PaneArea />
  <!-- Shell-global overlays (available in every mode). -->
  <Help />
  <Settings />
</div>

<style>
  .workspace {
    display: flex;
    height: 100%;
    width: 100%;
  }
</style>

<script lang="ts">
  import ActivityRail from "./ActivityRail.svelte";
  import PaneArea from "./PaneArea.svelte";
</script>

<div class="workspace">
  <ActivityRail />
  <PaneArea />
</div>

<style>
  .workspace {
    display: flex;
    height: 100%;
    width: 100%;
  }
</style>

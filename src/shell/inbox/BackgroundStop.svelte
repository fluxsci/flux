<script lang="ts">
  import { backgroundRuns } from "./backgroundState";
  import { stopBackgroundRun } from "./backgroundStore";
  export let sessionId: string;
  let error = "";
  $: run = [...$backgroundRuns.values()].find(r => r.runId === sessionId && r.state !== "cancelled");
  async function stop() { if (run) try { await stopBackgroundRun(run.runId); } catch (e) { error = (e as Error).message; } }
</script>
{#if run}<button on:click={stop}>Stop</button>{/if}
{#if error}<p role="alert">{error}</p>{/if}

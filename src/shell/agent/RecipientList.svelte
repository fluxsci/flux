<script lang="ts">
  import { sessions } from "./sessionState";
  import { backgroundAvailable } from "./backgroundAvailability";
  import { recipientOptions } from "../../lib/project/agentRouting";
  import type { Route } from "../../lib/project/annotations";

  export let label = "Annotation recipient";
  export let choose: (route: Route) => void;
  export let disabled = false;
  $: options = recipientOptions($sessions, $backgroundAvailable);
</script>

<div class="routes" role="group" aria-label={label}>
  {#each options as option (option.key)}
    <button type="button" data-recipient={option.key} class:muted={option.muted} {disabled} on:click={() => choose(option.route)}>
      <span>{option.label}{#if option.live}<span class="pairing">Pairing</span>{/if}</span><small>{option.detail}</small>
    </button>
  {/each}
</div>

<style>
  .routes { width:100%;border:1px solid var(--c-line);max-height:200px;overflow:auto;box-sizing:border-box;background:var(--c-bg-raised); }
  button { width:100%;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 9px;border:0;background:transparent;color:var(--c-tx);font:12px var(--font-ui);cursor:var(--cursor-cross-hover); }
  button:hover { background:var(--c-ui-hover); } button:focus-visible { outline:1px solid var(--c-accent);outline-offset:-1px; } button:disabled { opacity:.45; }
  small,.muted { color:var(--c-tx-muted); } small { font-size:10px;text-align:right; }
  .pairing { margin-left:6px;color:var(--c-accent);border:1px solid var(--c-line);border-radius:var(--r-ui);padding:1px 4px;font-size:10px; }
</style>

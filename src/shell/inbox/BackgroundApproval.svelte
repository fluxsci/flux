<script lang="ts">
  import { backgroundPermissions } from "./backgroundState";
  import { respondBackground } from "./backgroundStore";
  import { modalFocus } from "../../lib/ui/modalFocus";
  import { fullscreenPortal } from "../../lib/ui/portal";
  let busy = false, error = "";
  $: permission = $backgroundPermissions[0];
  async function decide(option: "allow" | "deny") {
    if (!permission || busy) return;
    const request = permission; busy = true; error = "";
    try { await respondBackground(request.runId, request.permissionId, option); }
    catch (e) { error = (e as Error).message; }
    finally { busy = false; }
  }
  function key(e: KeyboardEvent) { if (permission) { if (e.key === "Escape") { e.preventDefault(); void decide("deny"); } e.stopImmediatePropagation(); } }
</script>
{#if permission}
<div class="approval-layer" use:fullscreenPortal>
  <div class="approval-panel" role="dialog" aria-modal="true" aria-label="Background agent permission" tabindex="-1" use:modalFocus on:keydown={key}>
    <h2>Allow {permission.title}?</h2><p>The background agent is requesting this exact tool input:</p>
    <pre data-permission-input>{permission.detail}</pre>
    <div class="actions"><button disabled={busy} on:click={() => decide("deny")}>Deny</button><button disabled={busy} on:click={() => decide("allow")}>Allow once</button></div>
    {#if error}<p role="alert">{error}</p>{/if}
  </div>
</div>
{/if}
<style>
  .approval-layer { position: fixed; inset: 0; z-index: 3000; display: grid; place-items: center; background: #0006; }
  .approval-panel { width: min(640px, 90vw); max-height: 85vh; overflow: auto; padding: 20px; border: 1px solid var(--c-line); border-radius: var(--r-panel); background: var(--c-bg); color: var(--c-tx); font: var(--ts-sm) var(--font-ui); }
  h2 { font-size: var(--ts-md); } pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 50vh; overflow: auto; padding: 10px; border: 1px solid var(--c-line); }
  .actions { display: flex; gap: 10px; justify-content: end; } button { font: inherit; color: inherit; background: var(--c-bg); padding: 6px 12px; border: 1px solid var(--c-line); border-radius: var(--r-ui); }
</style>

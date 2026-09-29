<script lang="ts">
  import { onMount } from "svelte";
  import { sessions, annotationState, retainPresence, stopWatching } from "./annotationStore";
  import { inboxItems, retainInbox } from "../inbox/inboxStore";
  import { requestSessionInbox } from "../inbox/inboxState";
  import { sessionWork } from "../../lib/project/agentRouting";
  import type { PresenceSession } from "../../lib/project/presence";
  import BackgroundStop from "../inbox/BackgroundStop.svelte";

  export let onshow = () => {};
  let busy = new Set<string>(), error = "", notice = "";
  $: rows = $sessions.map(session => ({ session, ...sessionWork($inboxItems, session.id) }));
  async function act(session: PresenceSession, action: "stop" | "copy" | "show") {
    if (busy.has(session.id)) return;
    busy = new Set(busy).add(session.id); error = ""; notice = "";
    try {
      if (action === "stop") { await stopWatching(session); notice = `${session.name} stopped watching`; }
      else if (action === "copy") { await navigator.clipboard.writeText(session.name); notice = `${session.name} copied`; }
      else { await requestSessionInbox(session); onshow(); }
    } catch (e) { error = (e as Error).message; }
    finally { busy = new Set([...busy].filter(id => id !== session.id)); }
  }
  onMount(() => {
    const releaseInbox = retainInbox(), releasePresence = retainPresence();
    return () => { releaseInbox(); releasePresence(); };
  });
</script>

<div class="session-rows">
  {#each rows as { session, queued, claims } (session.id)}
    <article data-session={session.id}>
      <div class="heading"><strong>{session.name}</strong><span>{session.product} · {session.surface}</span></div>
      <div class="state">
        <span>{session.watching ? `👁 Watching · ${session.watchMode ?? "annotations"}` : $annotationState.stoppedSessions.has(session.id) ? "Stopped" : "Connected"}</span>
        {#if session.live}<span title="Pairing with the live window">🖥 Live</span>{/if}
        <span class="queue-count">{queued.length} queued</span>
      </div>
      <p class="connected">Connected since <time datetime={session.startedAt}>{new Date(session.startedAt).toLocaleString()}</time></p>
      <p class="claims">Current claim: {claims.map(i => i.text).join("; ") || "None"}</p>
      <div class="actions">
        {#if session.background}<BackgroundStop sessionId={session.id} />{/if}
        {#if session.watching}<button disabled={busy.has(session.id)} on:click={() => act(session, "stop")}>Stop watching</button>{/if}
        <button disabled={busy.has(session.id)} on:click={() => act(session, "copy")}>Copy name</button>
        <button disabled={busy.has(session.id)} on:click={() => act(session, "show")}>Show its items</button>
      </div>
    </article>
  {/each}
  {#if !$sessions.length}<p class="empty">No connected sessions on this project.</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
</div>

<style>
  article { padding:12px 0;border-bottom:1px solid var(--c-line); } article:last-of-type { border-bottom:0; }
  .heading,.state,.actions { display:flex;gap:8px;align-items:center;flex-wrap:wrap; }
  .heading strong { color:var(--c-tx);font-weight:600; } .heading span,.connected,.empty,.notice { color:var(--c-tx-muted); }
  .state { margin-top:6px;font:10px var(--font-mono); } .queue-count { margin-left:auto; }
  p { font-size:11px;line-height:1.5;margin:8px 0;overflow-wrap:anywhere; } .claims { max-height:90px;overflow:auto; }
  button { background:transparent;color:inherit;border:1px solid var(--c-line);border-radius:var(--r-ui);padding:5px 7px;font:11px var(--font-ui);cursor:var(--cursor-cross-hover); }
  button:hover { background:var(--c-ui-hover); } button:disabled { opacity:.45; } button:focus-visible { outline:1px solid var(--c-accent); } .error { color:var(--c-danger); }
</style>

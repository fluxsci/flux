<script lang="ts">
  // An agent's mark: the Flux AI mark in that agent's own colouring and pose, both taken from
  // its name, so heron and wren are told apart at a glance and hamerkop always looks like
  // hamerkop. It marks every agent utterance and run; you (the human) are unmarked. At rest it
  // is a still picture (a thread can hold dozens). While the agent works it is alive; when a
  // turn finishes it settles with one small bloom; on error it is red.
  // (Until 2026-11-19 this was a separate 13-dot seed: the owner asked for ONE mark everywhere.)
  import FluxAiMark from "./FluxAiMark.svelte";
  let { size = 14, state = "idle", seed = "", class: klass = "", activity = null }: { size?: number; state?: "idle" | "working" | "done" | "error"; seed?: string; class?: string; activity?: "thinking" | "writing" | "tool" | null } = $props();
</script>

<FluxAiMark {size} agent={seed || undefined} tone={state === "error" ? "error" : "ready"} still={state !== "working"} status={state} {activity} class={`agent-mark ${klass}`} />

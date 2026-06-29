<script lang="ts">
  import { onDestroy } from "svelte";

  const WORK = 25 * 60;
  const BREAK = 5 * 60;

  let mode = $state<"work" | "break">("work");
  let secs = $state(WORK);
  let running = $state(false);
  let completed = $state(0);
  let timer: ReturnType<typeof setInterval> | undefined;

  const mmss = $derived(
    `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`,
  );
  const progress = $derived(1 - secs / (mode === "work" ? WORK : BREAK));

  function tick() {
    secs -= 1;
    if (secs <= 0) {
      if (mode === "work") completed += 1;
      mode = mode === "work" ? "break" : "work";
      secs = mode === "work" ? WORK : BREAK;
    }
  }
  function toggle() {
    running = !running;
    clearInterval(timer);
    if (running) timer = setInterval(tick, 1000);
  }
  function reset() {
    running = false;
    clearInterval(timer);
    secs = mode === "work" ? WORK : BREAK;
  }
  function switchMode(m: "work" | "break") {
    mode = m;
    reset();
  }
  onDestroy(() => clearInterval(timer));
</script>

<div class="pomo">
  <div class="modes">
    <button class:on={mode === "work"} onclick={() => switchMode("work")}>Focus</button>
    <button class:on={mode === "break"} onclick={() => switchMode("break")}>Break</button>
  </div>
  <div class="dial" style="--p:{progress}">
    <span class="time">{mmss}</span>
  </div>
  <div class="ctrls">
    <button class="primary" onclick={toggle}>{running ? "Pause" : "Start"}</button>
    <button class="ghost" onclick={reset}>Reset</button>
  </div>
  <div class="done">{completed} focus session{completed === 1 ? "" : "s"} today</div>
</div>

<style>
  .pomo {
    padding: var(--sp-5) var(--sp-4);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-4);
  }
  .modes {
    display: flex;
    gap: 4px;
    padding: 3px;
    background: var(--c-ui);
    border-radius: var(--r-pill);
  }
  .modes button {
    font: inherit;
    font-size: var(--ts-sm);
    padding: 4px 14px;
    border: none;
    border-radius: var(--r-pill);
    background: transparent;
    color: var(--c-tx-muted);
    cursor: pointer;
  }
  .modes button.on {
    background: var(--c-bg);
    color: var(--c-tx-hi);
    box-shadow: var(--elev-1);
  }
  .dial {
    width: 180px;
    height: 180px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background:
      conic-gradient(var(--c-accent) calc(var(--p) * 360deg), var(--c-line) 0);
    -webkit-mask: radial-gradient(transparent 64%, #000 65%);
    mask: radial-gradient(transparent 64%, #000 65%);
  }
  .dial .time {
    font-family: var(--font-serif);
    font-size: 38px;
    font-weight: 700;
    color: var(--c-tx-hi);
    font-variant-numeric: tabular-nums;
  }
  .ctrls {
    display: flex;
    gap: var(--sp-2);
  }
  .ctrls button {
    font: inherit;
    font-size: var(--ts-base);
    padding: 7px 20px;
    border-radius: var(--r-1);
    cursor: pointer;
    border: 1px solid transparent;
  }
  .primary {
    background: var(--c-accent);
    color: var(--c-on-accent);
    font-weight: 600;
  }
  .ghost {
    background: none;
    border-color: var(--c-line-strong);
    color: var(--c-tx-2);
  }
  .done {
    font-size: var(--ts-sm);
    color: var(--c-tx-muted);
  }
</style>

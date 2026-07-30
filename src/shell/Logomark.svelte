<script lang="ts" module>
  // The Flux mark (2026-07 redesign): a phyllotaxis bloom — 88 dots placed by
  // the golden angle, coloured through the full Flexoki accent wheel from the
  // centre outward. Order out of flow: one simple rule, every classic Flux
  // colour, and a natural spiral motion baked into the geometry. This is the
  // ONE place the full brand palette lives; the rest of the UI stays
  // monochrome blue. Canonical asset: brand/flux-mark-phyllotaxis.svg
  // (regenerate app icons with scripts/gen-app-icons.mjs after editing).
  const WHEEL = [
    "#d14d41", // red
    "#da702c", // orange
    "#d0a215", // yellow
    "#35ab49", // green
    "#3aa99f", // cyan
    "#4385be", // blue
    "#8b7ec8", // purple
    "#ce5d97", // magenta
  ];
  const GOLDEN = 137.508; // degrees
  const N = 88;

  export interface LogoDot {
    x: number;
    y: number;
    r: number;
    fill: string;
  }

  /** The mark's dots in a 0–100 viewBox — exported so the asset/icon
   *  generator (scripts/gen-app-icons.mjs) renders the identical geometry. */
  export function logoDots(): LogoDot[] {
    const dots: LogoDot[] = [];
    for (let i = 1; i <= N; i++) {
      const a = (i * GOLDEN * Math.PI) / 180;
      const r = 4.15 * Math.sqrt(i);
      dots.push({
        x: +(50 + r * Math.cos(a)).toFixed(2),
        y: +(50 + r * Math.sin(a)).toFixed(2),
        r: +(1.35 + i * 0.036).toFixed(2),
        fill: WHEEL[Math.min(7, Math.floor((r / 39.5) * 8))],
      });
    }
    return dots;
  }

  const DOTS = logoDots();
</script>

<script lang="ts">
  let {
    size = 120, // square, px
    animated = false,
  }: { size?: number; animated?: boolean } = $props();
</script>

<!-- The bloom animation runs on literal durations, deliberately NOT gated on
     prefers-reduced-motion: Linux desktops (incl. the owner's) report `reduce`
     via GTK while animations are enabled, which would silently kill this
     signature moment (engineering guide §9; same policy as the dynamic-margin
     canvas). It is a one-shot CSS animation — no loop, no rAF, nothing after
     ~1.2s. -->
<svg
  class="logomark"
  class:animated
  width={size}
  height={size}
  viewBox="0 0 100 100"
  aria-hidden="true">
  {#each DOTS as d, i (i)}
    <circle cx={d.x} cy={d.y} r={d.r} fill={d.fill} style="--i:{i}" />
  {/each}
</svg>

<style>
  .logomark {
    display: block;
    overflow: visible;
  }
  .logomark.animated {
    animation: logo-settle 950ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .logomark.animated circle {
    transform-box: fill-box;
    transform-origin: center;
    animation: logo-bloom 420ms cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: calc(var(--i) * 8ms);
  }
  @keyframes logo-settle {
    from {
      transform: rotate(-26deg) scale(0.82);
    }
    to {
      transform: none;
    }
  }
  @keyframes logo-bloom {
    from {
      opacity: 0;
      transform: scale(0);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
</style>

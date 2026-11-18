// The Flux mark's geometry: a phyllotaxis bloom, 88 dots placed by the golden angle and
// coloured through the full Flexoki accent wheel from the centre outward. Plain TypeScript so
// anything can draw the same dots: Logomark.svelte (the mark), the Flux AI mark's seed
// (agent/fluxAiMark.ts, which Ask's synchronous bootstrap and pure gates both load), and the
// asset generator's twin (scripts/gen-app-icons.mjs keeps the same formula).
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

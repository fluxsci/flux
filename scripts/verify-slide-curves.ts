// M1: exercise the public curve core and its headless re-exports.
import { harness } from "./lib/harness.mjs";
import { resolveCurve, springFn, bezierFn, stepsFn, parseCurve, formatCurve, catalogMatch, springStats,
  CURVE_CATALOG, EASING_TOKENS, SPRING_SETTLE, type Curve } from "../src/lib/slide/curves";
import { defaultEasingFor, PRESET_CATALOG } from "../src/lib/slide/presetCatalog";
import * as core from "../flux-core/index";

import { cubicBezierFn } from "../src/lib/motion/tokens";
import { TestProcessScope } from "./lib/testProcess.mjs";
import { fileURLToPath } from "node:url";

// Each sampler gets a monomorphic call site. A shared polymorphic benchmark
// boxes every floating-point return in V8 even when the fn allocates no objects.
if (process.argv[2] === "--heap-case") {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(1));
  const { spec, channel, allocate, legacy } = JSON.parse(process.argv[3]);
  const held: number[][] = [], resolved = resolveCurve({ curve: spec });
  const oldBezier = legacy ? cubicBezierFn(spec.p) : null;
  const baseline = oldBezier && (channel === "fn" ? oldBezier : (t: number) => Math.max(0, Math.min(1, oldBezier(t))));
  const f = allocate ? (t: number) => { held.push([t]); return t; } : baseline ?? resolved[channel as "fn" | "clamped"];
  const loop = (n: number) => { let sum = 0; for (let i = 0; i < n; i++) sum += f((i % 1000) / 1000); return sum; };
  // Collect before warming: a forced GC after warming invalidates weak V8
  // optimization dependencies and would charge their recompile to the loop.
  globalThis.gc!();
  let warm = 0;
  for (let i = 0; i < 100; i++) warm += loop(10000);
  const start = process.memoryUsage().heapUsed;
  const sum = loop(10000);
  const delta = process.memoryUsage().heapUsed - start;
  console.log(JSON.stringify({ delta, sum, warm, retained: held.length }));
  process.exit(0);
}

const h = harness("verify-slide-curves");
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const bounces = [-0.3, 0, 0.2, 0.35, 0.5, 0.7, 0.8];

// Independent oscillator oracle: hyperbolic/trigonometric solution with an
// arithmetic frequency search. Compare the PUBLIC fn, not private coefficients.
function oscillator(b: number, w: number, v: number, t: number): [number, number] {
  const z = b >= 0 ? 1 - b : 1 / (1 + b), a = z * w;
  let q: number, dq: number;
  if (z === 1) { q = -1 + (v - w) * t; dq = v - w; }
  else if (z < 1) {
    const d = w * Math.sqrt(1 - z * z), c = Math.cos(d * t), s = Math.sin(d * t);
    q = -c + (v - a) / d * s; dq = d * s + (v - a) * c;
  } else {
    const d = w * Math.sqrt(z * z - 1), c = Math.cosh(d * t), s = Math.sinh(d * t);
    q = -c + (v - a) / d * s; dq = -d * s + (v - a) * c;
  }
  const e = Math.exp(-a * t);
  return [e * q, e * (dq - a * q)];
}
function fitted(b: number, v: number) {
  const energy = (w: number) => { const [y, dy] = oscillator(b, w, v, 1); return Math.hypot(y, dy / w); };
  let lo = 0.1, hi = 64;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (energy(mid) > SPRING_SETTLE) lo = mid; else hi = mid; }
  return { w: hi, residual: oscillator(b, hi, v, 1)[0], energy: energy(hi) };
}

h.section("springs: endpoints, physical shape, energy and readout");
for (const bounce of bounces) {
  const f = springFn(bounce), stats = springStats(bounce, 0), r = resolveCurve({ curve: { kind: "spring", bounce } });
  h.eq([f(0), f(1), r.fn(0), r.fn(1)], [0, 1, 0, 1], `${bounce}: f(0)=0 and f(1)=1 exactly`);
  h.ok(near(f(1 - 1e-10), 1, 1e-9), `${bounce}: f(1)=1 is the continuous limit (residual spread)`);
  let monotone = true, max = 1, first90 = 1, first98 = 1, crossings = 0, sign = -1, prev = 0;
  for (let i = 1; i <= 10000; i++) {
    const t = i / 10000, y = f(t);
    if (y < prev - 1e-12) monotone = false;
    max = Math.max(max, y);
    if (y >= 0.9 && first90 === 1) first90 = t;
    if (y >= 0.98 && first98 === 1) first98 = t;
    if (i < 10000 && y !== 1) { const next = y > 1 ? 1 : -1; if (next !== sign) crossings++; sign = next; }
    prev = y;
  }
  if (bounce <= 0) h.ok(monotone && max === 1, `${bounce}: nonpositive bounce is monotone from rest`);
  if ([0.2, 0.35, 0.5].includes(bounce)) {
    const z = 1 - bounce, analytic = Math.exp(-Math.PI * z / Math.sqrt(1 - z * z));
    h.ok(near(max - 1, analytic, 0.003), `${bounce}: first peak is within 0.3 percentage points of analytic overshoot`);
  }
  h.ok(near(stats.overshoot, max - 1, 0.0001) && near(stats.arrival90, first90, 0.001) && near(stats.arrival98, first98, 0.001) && stats.crossings === crossings,
    `${bounce}: stats agree with an independent dense probe`);
  h.ok(near(r.arrival, stats.arrival90) && r.overshoots === (max > 1), `${bounce}: resolved arrival and overshoot agree with readout`);
  for (const velocity of [0, 3]) {
    const fn = springFn(bounce, velocity), model = fitted(bounce, velocity);
    h.ok(model.energy <= SPRING_SETTLE, `${bounce}/${velocity}: fitted R(omega) <= SPRING_SETTLE`);
    let error = 0;
    for (let i = 1; i < 1000; i++) { const t = i / 1000; error = Math.max(error, Math.abs(fn(t) - (1 + oscillator(bounce, model.w, velocity, t)[0] - t * model.residual))); }
    h.ok(error < 1e-10, `${bounce}/${velocity}: public fn uses the energy-fitted oscillator`);
    if (velocity === 3) {
      // Appendix A clamps t<0. Centre at h, inside its domain, then h -> 0.
      const dt = 1e-7, derivative = (fn(2 * dt) - fn(0)) / (2 * dt);
      h.ok(near(derivative, 3, 0.06), `${bounce}: initial central difference ${derivative.toFixed(5)} is within 2% of velocity=3`);
    }
  }
}
h.eq(SPRING_SETTLE, 0.005, "settle tolerance stays 0.5 percent");

h.section("CSS linear() follows the clamped curve, including fast wobble");
function linearPoints(css: string): [number, number][] {
  return css.slice(7, -1).split(",").map(part => {
    const match = part.trim().match(/^([\d.e+-]+) ([\d.e+-]+)%$/);
    if (!match) throw new Error(`linear() point lacks explicit percentage: ${part}`);
    return [Number(match[2]) / 100, Number(match[1])];
  });
}
function sampleLinear(points: [number, number][], t: number) {
  let i = 0;
  while (i < points.length - 2 && points[i + 1][0] < t) i++;
  const [a, b] = [points[i], points[i + 1]];
  return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
}
for (const bounce of [0, 0.35, 0.5, 0.7, 0.8]) {
  const r = resolveCurve({ curve: { kind: "spring", bounce } }), points = linearPoints(r.css);
  h.ok(points.length >= 16 && points.length <= 49, `${bounce}: linear() has ${points.length} points in the measured 16–49 range`);
  h.eq([points[0], points.at(-1)], [[0, 0], [1, 1]], `${bounce}: explicit CSS endpoints`);
  h.ok(points.every((p, i) => p[1] >= 0 && p[1] <= 1 && (!i || p[0] > points[i - 1][0])), `${bounce}: CSS times increase and values stay clamped`);
  let error = 0, bounded = true;
  for (let i = 0; i <= 1000; i++) {
    const t = i / 1000;
    error = Math.max(error, Math.abs(sampleLinear(points, t) - r.clamped(t)));
    bounded &&= r.clamped(t) === clamp(r.fn(t));
  }
  h.ok(error <= 0.003, `${bounce}: linear() max error ${error.toFixed(7)} <= 0.003 at 1,001 probes`);
  h.ok(bounded, `${bounce}: clamped is exactly clamp(fn)`);
}
for (const p of [[0.34, 1.56, 0.64, 1], [0.36, 0, 0.66, -0.56], [0.68, -0.6, 0.32, 1.6]] as CurveExtract[]) {
  const r = resolveCurve({ curve: { kind: "bezier", p } });
  h.ok(r.overshoots && r.css.startsWith("linear("), `${p}: overshooting bezier uses clamped linear()`);
  const points = linearPoints(r.css);
  h.ok(Array.from({ length: 1001 }, (_, i) => Math.abs(sampleLinear(points, i / 1000) - r.clamped(i / 1000))).every(e => e <= 0.003), `${p}: CSS and clamped bezier agree`);
}
type CurveExtract = Extract<Curve, { kind: "bezier" }>["p"];
h.eq(resolveCurve({ curve: { kind: "bezier", p: [0.37, 0, 0.63, 1] } }).css, "cubic-bezier(0.37, 0, 0.63, 1)", "in-range bezier stays native cubic-bezier");
h.ok(bezierFn([0.34, 1.56, 0.64, 1])(0.7) > 1, "bezier solver retains overshoot");
h.eq(bezierFn([-1, 0, 2, 1])(0.3), bezierFn([0, 0, 1, 1])(0.3), "bezier x handles clamp on read");
for (const jump of ["start", "end"] as const) {
  const f = stepsFn(4, jump), r = resolveCurve({ curve: { kind: "steps", n: 4, jump } });
  h.eq([f(0), f(0.01), f(0.25), f(0.99), f(1)], jump === "end" ? [0, 0, 0.25, 0.75, 1] : [0, 0.25, 0.5, 1, 1], `${jump}: steps keep exact endpoints and CSS interior jumps`);
  h.eq(r.css, `steps(4, jump-${jump})`, `${jump}: steps CSS`);
  h.ok(!r.overshoots, `${jump}: steps are bounded`);
}
h.eq(stepsFn(0)(0.5), 0, "steps count clamps to one");
h.eq(stepsFn(100)(0.5), 0.5, "steps count clamps to sixty");

h.section("grammar, canonical format and catalog");
const grammar: [string, Curve | string][] = [
  ...EASING_TOKENS.map(t => [t, t] as [string, string]),
  ["spring(0.35)", { kind: "spring", bounce: 0.35 }],
  [" spring( +.35, v=-2e0 ) ", { kind: "spring", bounce: 0.35, velocity: -2 }],
  ["spring(0, v=0)", { kind: "spring", bounce: 0, velocity: 0 }],
  ["spring(k=100, c=10, m=1)", { kind: "spring", bounce: 0.5 }],
  ["spring(m=1, k=100, c=20)", { kind: "spring", bounce: 0 }],
  ["spring(k=100, c=30, m=1)", { kind: "spring", bounce: 1 / 1.5 - 1 }],
  ["spring(k=100, c=0, m=1)", { kind: "spring", bounce: 0.8 }],
  ["spring(-9)", { kind: "spring", bounce: -0.5 }],
  ["spring(2)", { kind: "spring", bounce: 0.8 }],
  ["bezier(.34,1.56,.64,1)", { kind: "bezier", p: [0.34, 1.56, 0.64, 1] }],
  ["cubic-bezier(0.68,-0.6,0.32,1.6)", { kind: "bezier", p: [0.68, -0.6, 0.32, 1.6] }],
  ["bezier(-2,-9,3,8)", { kind: "bezier", p: [0, -1, 1, 2] }],
  ["steps(8)", { kind: "steps", n: 8 }],
  ["steps(1,start)", { kind: "steps", n: 1, jump: "start" }],
  ["steps(1, end)", { kind: "steps", n: 1, jump: "end" }],
  ["steps(0)", { kind: "steps", n: 1 }],
  ["steps(99)", { kind: "steps", n: 60 }],
];
for (const [input, expected] of grammar) {
  const parsed = parseCurve(input);
  h.eq(parsed, expected, `${input}: parses normalized spec`);
  h.eq(parsed && parseCurve(formatCurve(parsed)), parsed, `${input}: parse/format round-trip`);
}
for (const input of ["", "wat", "constructor", "__proto__", "spring()", "spring(NaN)", "spring(Infinity)", "spring(1e999)", "spring(0.3,2)", "spring(0.3, v=)", "spring(0.3, v=1, v=2)", "spring(k=0,c=1,m=1)", "spring(k=1,c=-1,m=1)", "spring(k=1,c=1,m=-1)", "spring(k=1,c=1)", "spring(k=1,c=1,k=1)", "steps(3.5)", "steps(2, middle)", "steps(2, end, start)", "bezier(0,0,1)", "bezier(0,0,1,1,1)", "bezier(0,,1,1)", "bezier(0,0,1,1)junk", "spring(0x10)"]) h.eq(parseCurve(input), null, `${input || '<empty>'}: garbage rejected`);
const physical = parseCurve("spring(k=170,c=26,m=1)");
h.ok(physical && typeof physical !== "string" && physical.kind === "spring" && near(physical.bounce, 1 - 26 / (2 * Math.sqrt(170))), "physical input converts damping ratio to bounce");
h.eq(CURVE_CATALOG.map(c => [c.id, formatCurve(c.spec)]), [
  ["standard", "standard"], ["smooth", "smooth"], ["enter", "enter"], ["exit", "exit"], ["linear", "linear"],
  ["gentle", "bezier(0.37, 0, 0.63, 1)"], ["overshoot", "bezier(0.34, 1.56, 0.64, 1)"],
  ["anticipate", "bezier(0.36, 0, 0.66, -0.56)"], ["anticipate + overshoot", "bezier(0.68, -0.6, 0.32, 1.6)"],
  ["settle", "spring(0)"], ["snappy", "spring(0.2)"], ["bouncy", "spring(0.35)"], ["playful", "spring(0.5)"],
  ["steps", "steps(8)"], ["hold", "steps(1, end)"],
], "catalog names and specs match Appendix B exactly");
h.eq(CURVE_CATALOG.length, 15, "catalog contains exactly the Appendix B fifteen intents");
h.eq(CURVE_CATALOG.map(c => c.group), [...Array(6).fill("Ease"), ...Array(3).fill("Overshoot"), ...Array(4).fill("Spring"), ...Array(2).fill("Discrete")], "catalog group ordering matches Appendix B");
for (const entry of CURVE_CATALOG) {
  h.eq(parseCurve(entry.id), entry.spec, `${entry.id}: name is sugar for its spec`);
  h.eq(catalogMatch(entry.spec), entry.id, `${entry.id}: catalog match`);
  h.eq(parseCurve(formatCurve(entry.spec)), entry.spec, `${entry.id}: canonical format stores the spec`);
  h.ok(entry.label.length > 0, `${entry.id}: label present`);
}
h.eq(catalogMatch({ kind: "spring", bounce: 0.123 }), null, "custom curve has no catalog match");
h.eq(catalogMatch({ kind: "spring", bounce: 0.35, velocity: 1 }), null, "matching compares velocity too");
h.eq(catalogMatch({ kind: "steps", n: 8, jump: "start" }), null, "matching compares jump too");
const copy = parseCurve("overshoot") as Extract<Curve, { kind: "bezier" }>;
copy.p[0] = 0;
h.eq(parseCurve("overshoot"), { kind: "bezier", p: [0.34, 1.56, 0.64, 1] }, "parsing a catalog entry returns an independently editable spec");

h.section("resolution precedence, normalized cache identity and cross-engine parity");
const spring: Curve = { kind: "spring", bounce: 0.35 };
h.ok(resolveCurve({ curve: spring, influence: { in: 50, out: 50 }, easing: "linear", preset: "transform" }) === resolveCurve({ curve: spring }), "curve overrides influence, easing and family default");
h.ok(resolveCurve({ influence: { in: 50, out: 50 }, easing: "linear", preset: "transform" }) === resolveCurve({ influence: { in: 50, out: 50 } }), "influence overrides easing and family default");
h.ok(resolveCurve({ easing: "linear", preset: "transform" }) === resolveCurve({ easing: "linear" }), "easing overrides family default");
h.ok(resolveCurve({ influence: { in: 0, out: 0 }, preset: "transform" }) === resolveCurve({ easing: "smooth" }), "inactive influence preserves default");
for (const def of Object.values(PRESET_CATALOG)) {
  h.ok(resolveCurve({ preset: def.name }) === resolveCurve({ easing: defaultEasingFor(def.name) }), `${def.name}: resolver reads catalog default`);
  h.ok(resolveCurve({}, def.family) === resolveCurve({ easing: def.defaultEasing }), `${def.family}: absent preset uses explicit family default`);
}
h.eq([defaultEasingFor(), defaultEasingFor("transform"), defaultEasingFor("countUp"), defaultEasingFor("videoPause")], ["standard", "smooth", "standard", "linear"], "default easing values preserve historical families");
h.ok(resolveCurve({ curve: { kind: "spring", bounce: 9 } }) === resolveCurve({ curve: { kind: "spring", bounce: 0.8, velocity: 0 } }), "clamped springs share a cache entry");
h.ok(resolveCurve({ curve: { kind: "steps", n: 99 } }) === resolveCurve({ curve: { kind: "steps", n: 60, jump: "end" } }), "normalized steps share a cache entry");
h.ok(resolveCurve({ curve: { kind: "bezier", p: [-1, 0, 2, 1] } }) === resolveCurve({ curve: { kind: "bezier", p: [0, 0, 1, 1] } }), "normalized beziers share a cache entry");
const mutable: Curve = { kind: "spring", bounce: 0.35 }, before = resolveCurve({ curve: mutable });
mutable.bounce = 0.5;
h.ok(before === resolveCurve({ curve: spring }) && before !== resolveCurve({ curve: mutable }), "cache key snapshots values, independent of later author edits");
for (const [name, value] of Object.entries({ resolveCurve, parseCurve, formatCurve, springFn, CURVE_CATALOG, EASING_TOKENS, catalogMatch, springStats, defaultEasingFor })) h.ok(core[name as keyof typeof core] === value, `${name}: flux-core exports the same shared implementation`);

h.section("frame functions allocate no per-sample objects");
const scope = new TestProcessScope();
try {
  const measure = async (spec: Curve, channel: "fn" | "clamped", allocate = false, legacy = false) => {
    const child = scope.spawn(fileURLToPath(import.meta.url), ["--heap-case", JSON.stringify({ spec, channel, allocate, legacy })],
      { nodeArgs: ["--expose-gc", "--no-concurrent-recompilation", "--import", "tsx"] });
    await scope.waitExit(child);
    if (child.code !== 0) throw new Error(child.stderr || child.spawnError || "heap child failed");
    return JSON.parse(child.stdout) as { delta: number; sum: number };
  };
  for (const spec of [...bounces.map(bounce => ({ kind: "spring", bounce }) as Curve), { kind: "spring", bounce: 0.35, velocity: 3 }, { kind: "bezier", p: [0.34, 1.56, 0.64, 1] }, { kind: "steps", n: 8 }] as Curve[]) {
    for (const channel of ["fn", "clamped"] as const) {
      const { delta, sum } = await measure(spec, channel);
      // cubicBezierFn predates M1; V8 boxes its scalar return (16 bytes per
      // call) when its Newton/bisection body exceeds the inlining budget. Pin
      // zero ADDED allocation against that identical legacy solver, not a
      // larger arbitrary budget. New spring/step samplers use a zero baseline.
      const baseline = spec.kind === "bezier" ? (await measure(spec, channel, false, true)).delta : 0;
      h.ok(delta >= 0 && delta - baseline <= 32768 && Number.isFinite(sum) && sum > 0,
        `${formatCurve(spec)} ${channel}: 10k frames use ${delta} heap bytes, legacy baseline ${baseline} (<=32 KiB added overhead)`);
    }
  }
  const control = await measure(spring, "fn", true);
  h.ok(control.delta > 32768, "heap probe detects a deliberately retained allocation on every frame");
} finally { await scope.dispose(); }
await h.done();

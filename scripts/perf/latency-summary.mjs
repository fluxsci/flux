// Input-to-presentation latency from a probe trace (--trace): Chromium's EventLatency async
// slices (input generation → frame presented by the display compositor) and their stage
// children, plus PipelineReporter frame durations. Unlike rAF gaps / CDP taskMs this includes
// the GPU process, the viz display compositor and the platform swap/presentation, so it is
// the number that differs between headless, XWayland and native Wayland.
//   node scripts/perf/latency-summary.mjs <trace.json> [--json]
import fs from 'node:fs';
const f = process.argv[2]; const asJson = process.argv.includes('--json');
const raw = JSON.parse(fs.readFileSync(f, 'utf8')); const ev = raw.traceEvents || raw;
const open = new Map(); const done = [];
for (const e of ev) {
  if (e.ph !== 'b' && e.ph !== 'e') continue;
  const key = `${e.cat}|${e.id ?? e.id2?.local ?? e.id2?.global}|${e.name}`;
  if (e.ph === 'b') { const st = open.get(key) || []; st.push(e); open.set(key, st); }
  else { const st = open.get(key); const b = st && st.pop(); if (b) done.push({ name: e.name, id: key.split('|')[1], ts: b.ts, dur: (e.ts - b.ts) / 1000, args: b.args }); }
}
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1); };
const stats = (xs) => ({ n: xs.length, p50: q(xs, .5), p95: q(xs, .95), max: xs.length ? +Math.max(...xs).toFixed(1) : null });
const out = {};
const el = done.filter((d) => d.name === 'EventLatency');
// Stages are async slices with the parent's id nested inside its time span (ids are recycled,
// so match on id AND containment). An EventLatency that reached the screen has a
// SubmitCompositorFrameToPresentationCompositorFrame stage; coalesced/dropped ones end early.
const byId = new Map(); for (const d of done) if (d.name !== 'EventLatency') { const l = byId.get(d.id) || []; l.push(d); byId.set(d.id, l); }
const byType = {}, dropped = {}, stages = {};
for (const d of el) {
  const t = d.args?.event_latency?.event_type || d.args?.data?.type || '?';
  const kids = (byId.get(d.id) || []).filter((k) => k.ts >= d.ts && k.ts + k.dur * 1000 <= d.ts + d.dur * 1000 + 1);
  if (!kids.some((k) => k.name === 'SubmitCompositorFrameToPresentationCompositorFrame')) { dropped[t] = (dropped[t] || 0) + 1; continue; }
  (byType[t] = byType[t] || []).push(d.dur);
  for (const k of kids) (stages[k.name] = stages[k.name] || []).push(k.dur);
}
out.eventLatencyPresented = Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, stats(v)]));
out.eventLatencyNotPresented = dropped;
out.eventLatencyStages = Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, { ...stats(v), sum: +v.reduce((a, b) => a + b, 0).toFixed(0) }]).sort((a, b) => b[1].sum - a[1].sum).slice(0, 18));
const pr = done.filter((d) => d.name === 'PipelineReporter');
out.pipelineReporter = stats(pr.map((d) => d.dur));
const prState = {}; for (const d of pr) { const s = d.args?.chrome_frame_reporter?.state || '?'; prState[s] = (prState[s] || 0) + 1; }
out.pipelineStates = prState;
// Display-compositor / GPU-process cost per frame: viz draw+swap and the GPU main thread busy time.
const X = ev.filter((e) => e.ph === 'X' && typeof e.dur === 'number');
const tn = {}; for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name') tn[e.pid + ':' + e.tid] = e.args.name;
const pn = {}; for (const e of ev) if (e.ph === 'M' && e.name === 'process_name') pn[e.pid] = e.args.name;
for (const nm of ['Display::DrawAndSwap', 'SkiaOutputSurfaceImplOnDevice::SwapBuffers', 'Graphics.Pipeline.DrawAndSwap', 'DirectRenderer::DrawFrame', 'SkiaRenderer::SwapBuffers', 'GpuVSyncThread']) {
  const xs = X.filter((e) => e.name === nm).map((e) => e.dur / 1000); if (xs.length) out[nm] = stats(xs);
}
const busy = {}; for (const e of X) { const k = e.pid + ':' + e.tid; const lbl = (pn[e.pid] || '?') + '/' + (tn[k] || '?'); busy[lbl] = (busy[lbl] || 0) + e.dur / 1000; }
out.threadBusyMs = Object.fromEntries(Object.entries(busy).filter(([k]) => /GPU|Viz|Compositor|Raster|CrGpuMain|VizCompositor/i.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, +v.toFixed(0)]));
if (asJson) console.log(JSON.stringify(out)); else console.log(JSON.stringify(out, null, 1));

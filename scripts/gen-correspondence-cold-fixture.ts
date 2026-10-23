// Re-records the `v2` pin and `maxDeviationFromOld` of scripts/fixtures/correspondence-cold.json.
//
//   npx tsx scripts/gen-correspondence-cold-fixture.ts          # print what the current planner produces
//   npx tsx scripts/gen-correspondence-cold-fixture.ts --write  # rewrite the fixture
//
// The fixture's `expected` chains are the OLD planner's (recorded at ddbdff3) and are never rewritten: they are the
// independent geometric reference. `v2` is the current planner's chains (byte pin for verify-correspondence) and
// `maxDeviationFromOld` is how far (stage px) the current planner's frames sit from the old planner's at three
// flight times: the convex ring pairs that normal matching re-pairs deviate on purpose (≈2.3 px); open and tile
// chains stay within the gate's 0.25 px. Run it only for a deliberate planner change, with before/after evidence.
import { readFileSync, writeFileSync } from "node:fs";
import { planCorrespondence, sampleCorrespondence } from "../src/lib/slide/correspondence";
import { parameterize, pointAt, sampleNodes } from "../src/lib/slide/outline";
const f = new URL("./fixtures/correspondence-cold.json", import.meta.url);
const j = JSON.parse(readFileSync(f, "utf8"));
for (const c of j.cases) {
  const p = planCorrespondence([c.a], [c.b], { pair: "spatial" }); p.prepare();
  const plan = p.pairs[0].plan!;
  c.v2 = JSON.parse(JSON.stringify({ a: plan.a, b: plan.b, closed: plan.closed }));
  let dev = 0; const out = sampleCorrespondence(p, 0.125);
  for (const t of [0.125, 0.5, 0.875]) {
    sampleCorrespondence(p, t, out);
    const old = sampleNodes(c.expected.a, c.expected.b, t, c.a.bbox.w + (c.b.bbox.w - c.a.bbox.w) * t, c.a.bbox.h + (c.b.bbox.h - c.a.bbox.h) * t, [], { wa: c.a.bbox.w, ha: c.a.bbox.h, wb: c.b.bbox.w, hb: c.b.bbox.h });
    for (const n of old) { n.x += c.a.bbox.x + (c.b.bbox.x - c.a.bbox.x) * t; n.y += c.a.bbox.y + (c.b.bbox.y - c.a.bbox.y) * t; }
    const op = parameterize(old, c.expected.closed), np = parameterize(out[0].nodes, out[0].closed);
    for (let i = 0; i < 1000; i++) { const x = pointAt(op, i / 999), y = pointAt(np, i / 999); dev = Math.max(dev, Math.hypot(x.x - y.x, x.y - y.y)); }
  }
  c.maxDeviationFromOld = Math.round(dev * 1000) / 1000;
  console.log(c.name, "dev", c.maxDeviationFromOld, "nodes", plan.a.length, "(old", c.expected.a.length + ")");
}
if (process.argv.includes("--write")) writeFileSync(f, JSON.stringify(j));

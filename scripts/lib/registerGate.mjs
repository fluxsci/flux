// Register gates in verify-manifest.json structurally (the file round-trips through JSON.stringify(m, null, 2)).
//   node scripts/lib/registerGate.mjs '<json spec>'
// spec: { gates: [{ script, tier, timeoutMs?, exclusive?, runtime?, prerequisites?, coverage? }], groups: { name: [scripts] }, pathMap: [{ glob, run, before? }] }
// Idempotent: an existing gate, group member or pathMap glob is left as it is.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "verify-manifest.json");
const m = JSON.parse(fs.readFileSync(file, "utf8"));
const spec = JSON.parse(process.argv[2] ?? "{}");
for (const g of spec.gates ?? []) {
  const tier = g.tier ?? "pure";
  if (!m.tiers[tier].includes(g.script)) m.tiers[tier].push(g.script);
  if (!m.execution[g.script]) {
    const runtime = g.runtime ?? (g.script.endsWith(".ts") ? "tsx" : g.script.endsWith(".cjs") ? "electron" : "node");
    m.execution[g.script] = {
      runtime, prerequisites: g.prerequisites ?? [], externalNetwork: false, isolation: g.isolation ?? "scratch",
      timeoutMs: g.timeoutMs ?? 120000, exclusive: g.exclusive ?? false, coverage: g.coverage ?? "behavior",
    };
  }
}
for (const [name, members] of Object.entries(spec.groups ?? {})) {
  m.groups[name] ??= [];
  for (const s of members) if (!m.groups[name].includes(s)) m.groups[name].push(s);
}
for (const rule of spec.pathMap ?? []) {
  if (m.pathMap.some((r) => r.glob === rule.glob)) continue;
  const at = rule.before ? m.pathMap.findIndex((r) => r.glob === rule.before) : -1;
  const entry = { glob: rule.glob, run: rule.run };
  if (at >= 0) m.pathMap.splice(at, 0, entry); else m.pathMap.push(entry);
}
fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
console.log("manifest updated:", (spec.gates ?? []).map((g) => g.script).join(", ") || "(no gates)");

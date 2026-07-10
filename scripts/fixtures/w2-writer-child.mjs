// Fault child for verify-w2-atomic (WS-0a): atomicWrites a ~1.5MB JSON in a
// tight loop until killed. Launched directly via `process.execPath --import tsx`
// (see scripts/lib/testProcess.mjs) so the PID the parent kills IS the writer.
//
// Ready protocol: prints "writing-started" only after the FIRST write has fully
// completed, so the parent can inject SIGKILL into a provably-live write loop.
// Watchdog: exits when stdin closes (parent died) — never outlives the test.
import { atomicWrite } from "../../flux-core/fsx.ts";

process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

const target = process.argv[2];
const rows = Array.from({ length: 12000 }, (_, i) => ({ i, s: "x".repeat(100) }));
let n = 0;
await atomicWrite(target, JSON.stringify({ n: ++n, rows }));
console.log("writing-started");
for (;;) await atomicWrite(target, JSON.stringify({ n: ++n, rows }));

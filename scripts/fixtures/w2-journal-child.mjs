// Journal-concurrency child for verify-w2-atomic (WS-0a): appends N entries to
// the shared .meta/journal.ndjson, then exits 0. Two of these race in parallel;
// the parent asserts no entry is lost or garbled.
// Watchdog: exits nonzero when stdin closes (parent died) — never outlives the test.
import { journal } from "../../flux-core/index.ts";

process.stdin.resume();
process.stdin.on("end", () => process.exit(1));
process.stdin.on("close", () => process.exit(1));

const [root, who, nStr] = process.argv.slice(2);
const N = Number(nStr);
for (let i = 0; i < N; i++) await journal(root, { action: "test", target: who + ":" + i });
process.exit(0);

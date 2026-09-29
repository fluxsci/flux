// The command palette's ranking (src/shell/command/commands.ts rankCommands):
// titles beat keywords, prefix beats substring, ties keep the surface's order.
//   node scripts/run-verifies.mjs --tier pure --only verify-command-rank
import { harness } from "./lib/harness.mjs";
import { rankCommands, type Command } from "../src/shell/command/commands";

const h = harness("verify-command-rank");
const cmd = (id: string, title: string, keywords = "", hint = ""): Command => ({ id, title, keywords, hint, run: () => {} });
const list = [
  cmd("comment", "Comment on selection", "annotate note review remark", "⌘⌥M"),
  cmd("x-note", "Toggle notes", "speaker"),
  cmd("annotate", "Annotate…", "feedback screenshot", "Agent"),
  cmd("open-ctx", "Open project context", "background goals"),
  cmd("ctx-rules", "Open project rules", "conventions"),
];
const ids = (q: string) => rankCommands(list, q).map((c) => c.id);
h.eq(ids("Annotate")[0], "annotate", "a title prefix beats a keyword match (Paper's palette: Annotate… before Comment on selection)");
h.eq(ids("annotate"), ["annotate", "comment"], "keyword matches still appear, after title matches");
h.eq(ids("rules"), ["ctx-rules"], "a word inside a title matches");
h.eq(ids("open"), ["open-ctx", "ctx-rules"], "ties keep the surface's own order");
h.eq(ids("⌘⌥m"), ["comment"], "hints are searchable");
h.eq(ids(""), list.map((c) => c.id), "an empty query lists everything in order");
h.eq(ids("zzz"), [], "no match, no rows");
await h.done();

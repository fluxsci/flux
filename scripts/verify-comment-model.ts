// Margin comments, round 2 (2026-11-18): tags you attach, comments you keep out of the AI Inbox,
// and editing what you wrote. The pure model (src/lib/project/comments.ts), what the Inbox builds
// from it (inbox.ts), and what an agent is shown (flux-core). Run via run-verifies.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { harness } from "./lib/harness.mjs";
import { legacyPaperFixture } from "./lib/legacyPaperFixture";
import * as core from "../flux-core/index";
import { appendCommentMessage, commentInInbox, editCommentMessage, normalizeTag, setCommentInbox, setCommentTags, type CommentsFile } from "../src/lib/project/comments";
import { buildInbox, filterInbox, parseInboxQuery, type InboxComment } from "../src/lib/project/inbox";
import { foldAnnotations } from "../src/lib/project/annotations";

const h = harness("verify-comment-model");
const throws = (run: () => unknown, pattern: RegExp, label: string) => { let message = ""; try { run(); } catch (e) { message = (e as Error).message; } h.ok(pattern.test(message), label, message || "did not throw"); };
const at = "2026-11-18T10:00:00.000Z";
const thread = (id: string, body: string, extra: Record<string, unknown> = {}) => ({ id, anchor: { start: 9, end: 22, quote: "growth slowed", prefix: "Mycelial ", suffix: " under nutr" }, resolved: false, messages: [{ author: "You", body, createdAt: at, kind: "human" as const }], ...extra });
const file = (): CommentsFile & { keep: string } => ({ version: 1, keep: "unknown file field", threads: [thread("c1", "first"), thread("c2", "second #stats", { tags: ["needs-reference"] }), thread("c3", "mine only", { inbox: false })] as CommentsFile["threads"] });

h.section("in the AI Inbox, or kept to yourself");
h.eq([commentInInbox({}), commentInInbox({ inbox: true }), commentInInbox({ inbox: false })], [true, true, false], "only an explicit false keeps a comment out (older comments stay in)");
const kept = setCommentInbox(file(), "c1", false);
h.eq([kept.threads[0].inbox, kept.threads[1].inbox, kept.keep], [false, undefined, "unknown file field"], "keeping one changes only that thread; unknown file fields survive");
h.eq(setCommentInbox(kept, "c1", true).threads[0].inbox, true, "and it can be sent later");
throws(() => setCommentInbox(file(), "nope", true), /no comment matches/, "an unknown id is refused");

h.section("tags");
h.eq(["#Needs-Reference", " needs reference ", "todo!", "9lives", "ünïcode", "", "#", "a".repeat(40)].map(normalizeTag), ["needs-reference", "needs-reference", "todo", "lives", "ncode", "", "", "a".repeat(32)], "a tag is stored the way a typed #tag reads");
const tagged = setCommentTags(file(), "c1", ["#Stats", "stats", "Needs Reference", "!!"]);
h.eq(tagged.threads[0].tags, ["stats", "needs-reference"], "tags are normalized and de-duplicated, in the order given");
h.eq("tags" in setCommentTags(tagged, "c1", []).threads[0], false, "no tags leaves no field behind");
h.eq(setCommentTags(file(), "c2", ["a"]).threads[0], file().threads[0], "other threads are untouched");

h.section("editing what you wrote");
const edited = editCommentMessage(file(), "c1", 0, "first, reworded", "2026-11-18T11:00:00.000Z");
h.eq([edited.threads[0].messages[0].body, edited.threads[0].messages[0].editedAt, edited.threads[0].messages[0].createdAt, edited.threads[0].messages[0].author], ["first, reworded", "2026-11-18T11:00:00.000Z", at, "You"], "the text changes; author and time stay; the edit is dated");
throws(() => editCommentMessage(file(), "c1", 0, "   "), /needs text/, "an empty edit is refused");
throws(() => editCommentMessage(file(), "c1", 4, "x"), /no message/, "a message that is not there is refused");
const withAgent = appendCommentMessage(file(), "c1", { author: "heron", body: "Done.", createdAt: at, kind: "agent" });
throws(() => editCommentMessage(withAgent, "c1", 1, "I never said that"), /agent/, "an agent's reply cannot be rewritten");

h.section("what the Inbox is built from");
const comments: InboxComment[] = file().threads.map(t => ({ ...t, doc: "paper/main.qmd" }));
const items = buildInbox({ state: foldAnnotations([]), comments, liveness: { now: Date.parse(at) }, humanAuthors: [] });
h.eq(items.map(i => i.id), ["c1", "c2"], "a comment kept to yourself is not an inbox item");
h.eq(items[1].tags, ["needs-reference", "stats"], "an item's tags are the attached ones and the #words typed in it");
h.eq(filterInbox(items, parseInboxQuery("#needs-reference", { docs: [] })).map(i => i.id), ["c2"], "an attached tag filters the Inbox like a typed one");

h.section("what an agent is shown");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-comment-model-"));
try {
  core.setClient("cli");
  await core.scaffold(root, { title: "Comments" });
  await legacyPaperFixture(root);
  await core.setManuscript(root, "# Title\n\nMycelial growth slowed under nutrient stress. The control group recovered.\n");
  const sidecar = path.join(root, "manuscript", "comments.json");
  await fs.writeFile(sidecar, JSON.stringify(file(), null, 2) + "\n");
  h.eq((await core.listProjectComments(root)).map(t => t.id), ["c1", "c2", "c3"], "the project's own listing has every thread (the manuscript check reads them all)");
  h.eq((await core.listAgentComments(root)).map(t => t.id), ["c1", "c2"], "an agent's listing leaves out the kept ones");
  h.eq((await core.listInbox(root, {})).items.map((i: { id: string }) => i.id).sort(), ["c1", "c2"], "list_inbox does not show a kept comment");
  let refused = "";
  try { await core.resolveProjectComment(root, "c3"); } catch (e) { refused = (e as Error).message; }
  h.ok(/no open comment matches/.test(refused), "an agent cannot resolve a kept comment by its id", refused);
  refused = "";
  try { await core.resolveComment(root, "c3", { docRel: "manuscript/main.qmd" }); } catch (e) { refused = (e as Error).message; }
  h.ok(/no comment matches/.test(refused), "…nor through a document", refused);
  refused = "";
  try { await core.replyToComment(root, "c3", "hello"); } catch (e) { refused = (e as Error).message; }
  h.ok(/expected one comment c3, found 0/.test(refused), "…nor reply to it", refused);
  await core.resolveProjectComment(root, "c1");
  const after = JSON.parse(await fs.readFile(sidecar, "utf8")) as CommentsFile;
  h.eq([after.threads.find(t => t.id === "c3")?.inbox, after.threads.find(t => t.id === "c2")?.tags, after.threads.find(t => t.id === "c1")?.resolved], [false, ["needs-reference"], true], "an agent resolving another comment leaves the kept flag and the tags as they were");
} finally { await fs.rm(root, { recursive: true, force: true }); }

await h.done();

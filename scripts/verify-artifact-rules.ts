// Pure gate for Paper's artifacts: the rules (electron/artifactRules.js), the lister and file
// server every surface shares (electron/artifactServe.cjs), the frame protocol the app parses a
// page's messages with (src/lib/artifacts/frameProtocol.ts), the rail's rows
// (src/lib/artifacts/tree.ts) and the "artifact" target kind.
//
// What it holds:
//   A. what counts as an artifact, in a real folder tree (index folders, lone pages, groups;
//      nothing inside an artifact, a hidden folder or a dependency folder is searched);
//   B. which request paths may be served: nothing that climbs out of the folder, nothing hidden,
//      no link that leaves it, and nothing from a folder that was not opened;
//   C. what a page is served WITH: its policy (no network unless allowed) and the bridge as its
//      first script, placed without reading or changing the rest of the page;
//   D. a page's messages are untrusted: only known shapes pass, clipped; an editing chord stays
//      in the page;
//   E. the rail's rows, lookups by the path an agent was told, and which changes reload a page;
//   F. the dev server's route answers with the same server (the GUI gate's footing);
//   G. source shape: the family is read-only and the scheme is registered before the app is ready.
//
// Run: node scripts/run-verifies.mjs --tier pure --only verify-artifact-rules.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { harness } from "./lib/harness.mjs";
import {
  ARTIFACT_BRIDGE_PATH, ARTIFACT_BRIDGE_TAG, ARTIFACT_SCHEME, artifactBridgeSource, artifactCsp, artifactMime, artifactNameTitle,
  artifactRequestRel, artifactUrlPath, bridgeInsertIndex, classifyArtifactFolder, htmlTitle, skipArtifactDir,
} from "../electron/artifactRules.js";
import { appChord, parseFrameMessage, relOfFramePath } from "../src/lib/artifacts/frameProtocol";
import { artifactAge, artifactAgeWords, artifactForRef, artifactRows, changeTouches, findArtifact, pageRef, sharedTitles } from "../src/lib/artifacts/tree";
import type { ArtifactListing, ArtifactRoot } from "../src/lib/artifacts/types";
import { describeTarget, formatTarget, parseTarget, shortTarget, uniqueTargets, type TargetRef } from "../src/lib/project/targets";
import { anchorOf, artifactThreads, commentTarget, elementWhat, linkedPage, markRect, messageParts, pageAnchors, pageOfRef, threadPlace, threadSubject } from "../src/lib/artifacts/comments";
import type { InboxItem } from "../src/lib/project/inbox";
import { describeStamp } from "../src/lib/project/annotations";
import { createArtifactDevRoutes } from "./lib/artifactDevRoutes.mjs";

const require = createRequire(import.meta.url);
const { createArtifactServer, listArtifacts, describeRoot, bodyStream } = require("../electron/artifactServe.cjs");
const h = harness("verify-artifact-rules");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flux-artifact-rules-")));
const write = (rel: string, text: string) => { const file = path.join(scratch, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const page = (title: string, body = "<h1>x</h1>") => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body>${body}</body>\n</html>\n`;
const read = async (body: unknown) => { const s = bodyStream(body); if (!s) return Buffer.alloc(0); const chunks: Buffer[] = []; for await (const c of s) chunks.push(Buffer.from(c)); return Buffer.concat(chunks); };

// ---------------------------------------------------------------------------------------------
h.section("A. What counts as an artifact");
const project = path.join(scratch, "project"), root = path.join(project, "artifacts");
write("project/artifacts/explorer/index.html", page("Growth &amp; decay"));
write("project/artifacts/explorer/methods.html", page("Methods"));
write("project/artifacts/explorer/app.js", "window.x = 1;");
write("project/artifacts/explorer/data/0.js", "window.d = 0;");
write("project/artifacts/explorer/nested/index.html", page("Never listed: it is inside an artifact"));
write("project/artifacts/reports/summary.html", page("Summary"));
write("project/artifacts/reports/untitled_page.html", "<h1>No title element</h1>");
write("project/artifacts/reports/2026/deep/tool/index.htm", page("Deep tool"));
write("project/artifacts/node_modules/pkg/index.html", page("A dependency's demo"));
write("project/artifacts/.cache/index.html", page("Hidden"));
write("project/artifacts/__pycache__/x.html", page("Cache"));
write("project/artifacts/notes/readme.md", "no pages here");
write("project/artifacts/.secret.html", page("A hidden page"));
write("outside/elsewhere.html", page("Outside"));
write("outside/secret.txt", "outside");
fs.symlinkSync(path.join(scratch, "outside"), path.join(root, "linked_out"));
fs.symlinkSync(path.join(scratch, "outside/secret.txt"), path.join(root, "explorer/leak.txt"));
fs.symlinkSync(path.join(root, "reports/summary.html"), path.join(root, "alias.html"));

h.eq(classifyArtifactFolder([{ name: "index.html", dir: false }, { name: "b.html", dir: false }, { name: "a.HTM", dir: false }, { name: "sub", dir: true }, { name: "x.js", dir: false }]),
  { kind: "artifact", entry: "index.html", pages: ["index.html", "a.HTM", "b.html"] }, "a folder with an index is ONE artifact; its other pages follow the index, by name");
h.eq(classifyArtifactFolder([{ name: "b.html", dir: false }, { name: "a10.html", dir: false }, { name: "a2.html", dir: false }, { name: "sub", dir: true }, { name: ".git", dir: true }, { name: "node_modules", dir: true }]),
  { kind: "group", files: ["a2.html", "a10.html", "b.html"], dirs: ["sub"] }, "a folder without one is a group: each page an artifact, its folders searched (numbers sort as numbers)");
h.ok(skipArtifactDir(".git") && skipArtifactDir("node_modules") && skipArtifactDir("__pycache__") && !skipArtifactDir("pop_explorer"), "hidden, dependency and cache folders are never searched");
h.eq(htmlTitle("<html><head><TITLE  lang='en'>\n  A &amp; B &#8212; &lt;x&gt; &#x41;\n</title>"), "A & B — <x> A", "a page's title is read with its entities, collapsed to one line");
h.eq(htmlTitle("<h1>none</h1>"), "", "a page without a title has none");
h.eq(artifactNameTitle("pop_explorer"), "Pop explorer", "and is named after its folder");
h.eq(artifactNameTitle("syn-states_v2.html"), "Syn states v2", "or its file");

const found = await listArtifacts(root);
const byRel = Object.fromEntries(found.artifacts.map((a: { rel: string }) => [a.rel, a]));
h.eq(Object.keys(byRel).sort(), ["alias.html", "explorer", "reports/2026/deep/tool", "reports/summary.html", "reports/untitled_page.html"],
  "the lister finds index folders at any depth and lone pages; nothing inside an artifact, a hidden or dependency folder, or a link that leaves the root");
h.eq([byRel.explorer.kind, byRel.explorer.entry, byRel.explorer.pages, byRel.explorer.title, byRel.explorer.group],
  ["folder", "explorer/index.html", ["explorer/index.html", "explorer/methods.html"], "Growth & decay", ""], "a folder artifact: entry, pages, title, group");
h.eq([byRel["reports/untitled_page.html"].kind, byRel["reports/untitled_page.html"].title, byRel["reports/untitled_page.html"].group], ["file", "Untitled page", "reports"], "a lone page: named after its file when it has no title, grouped under its folder");
h.eq([byRel["reports/2026/deep/tool"].entry, byRel["reports/2026/deep/tool"].group], ["reports/2026/deep/tool/index.htm", "reports/2026/deep"], "index.htm counts; the group is the folder above");
h.ok(byRel.explorer.mtimeMs > 0 && !found.missing && !found.truncated, "the listing carries when the artifact last changed");
// `visited` holds native paths (they are handed to the watcher); compare them as posix-relative keys.
h.eq(found.visited.map((d: string) => path.relative(root, d).split(path.sep).join("/")).sort(), ["", "explorer", "notes", "reports", "reports/2026", "reports/2026/deep", "reports/2026/deep/tool"],
  "the folders to watch are the ones that were read: the root, the groups and each artifact's own folder; never what is inside an artifact (explorer/data, explorer/nested)");
h.eq((await listArtifacts(path.join(scratch, "nowhere"))).missing, true, "a folder that is not there is `missing`, not an error");
const rootArtifact = await listArtifacts(path.join(root, "explorer"));
h.eq(rootArtifact.artifacts.map((a: { rel: string; entry: string; title: string }) => [a.rel, a.entry, a.title]), [["", "index.html", "Growth & decay"]], "a root that is itself an artifact is listed as one");

// ---------------------------------------------------------------------------------------------
h.section("B. Which paths may be served");
h.eq(artifactRequestRel("/explorer/index.html"), "explorer/index.html", "an ordinary path");
h.eq(artifactRequestRel("/explorer/"), "explorer/index.html", "a folder path names its index");
h.eq(artifactRequestRel("/"), "index.html", "so does the root");
h.eq(artifactRequestRel("/a%20b/c%23d.html"), "a b/c#d.html", "names are decoded once");
for (const bad of ["/../project.json", "/explorer/../../x", "/%2e%2e/x", "/explorer/%2e%2e%2fx", "/.env", "/explorer/.secret", "/a\\b", "/a%00b", "/a%5cb", "/%", "explorer/index.html", "/C:/Windows/x"])
  h.eq(artifactRequestRel(bad), null, `refused: ${bad}`);
h.eq(artifactUrlPath("a b/c#d?.html"), "/a%20b/c%23d%3F.html", "a file's URL path encodes what a URL would misread");
h.eq(artifactRequestRel(artifactUrlPath("a b/c#d?.html")), "a b/c#d?.html", "and round-trips");

const server = createArtifactServer();
const registered = await server.register(root);
h.ok(/^r[0-9a-f]{30}$/.test(registered.id), "a root's id is a hash of its real folder");
h.eq((await createArtifactServer().register(root)).id, registered.id, "the same folder is the same origin in every session");
h.eq(await server.register(path.join(root, "explorer/app.js")), null, "a file cannot be registered as a root");
const get = (pathname: string, extra: Record<string, unknown> = {}) => server.respond({ id: registered.id, pathname, ...extra });
h.eq((await get("/explorer/app.js")).status, 200, "a file of the folder is served");
h.eq((await read((await get("/explorer/app.js")).body)).toString(), "window.x = 1;", "byte for byte");
h.eq((await get("/explorer/")).status, 200, "a folder path answers with its index");
h.eq((await get("/explorer/leak.txt")).status, 403, "a link that leaves the folder is refused");
h.eq((await get("/linked_out/elsewhere.html")).status, 403, "so is a file reached through a linked folder that leaves it");
h.eq((await get("/alias.html")).status, 200, "a link that stays inside the folder is served");
h.eq((await get("/.secret.html")).status, 403, "a hidden file is refused");
h.eq((await get("/../outside/secret.txt")).status, 403, "a path that climbs out is refused");
h.eq((await get("/missing.js")).status, 404, "a missing file is 404");
h.eq((await get("/explorer/app.js", { method: "POST" })).status, 405, "only GET and HEAD");
h.eq((await server.respond({ id: "r" + "0".repeat(30), pathname: "/explorer/app.js" })).status, 403, "a folder that was never opened is not served");
const ranged = await get("/explorer/app.js", { range: "bytes=7-9" });
h.eq([ranged.status, ranged.headers["Content-Range"], (await read(ranged.body)).toString()], [206, "bytes 7-9/13", "x ="], "byte ranges are honoured (media in a page)");
h.eq((await get("/explorer/app.js", { range: "bytes=99-" })).status, 416, "an unsatisfiable range says so");
h.eq([artifactMime("a/b.JS"), artifactMime("x.html"), artifactMime("data.bin"), artifactMime("p.wasm"), artifactMime("noext")],
  ["text/javascript; charset=utf-8", "text/html; charset=utf-8", "application/octet-stream", "application/wasm", "application/octet-stream"], "content types come from the extension; the unknown is bytes");
h.eq((await get("/explorer/app.js")).headers["X-Content-Type-Options"], "nosniff", "and are not second-guessed");
h.ok((await server.fileFor(registered.id, "explorer/app.js")) === path.join(root, "explorer/app.js") && (await server.fileFor(registered.id, "explorer/leak.txt")) === null, "fileFor names a served file and refuses the same paths");

// ---------------------------------------------------------------------------------------------
h.section("C. What a page is served with");
const html = await get("/explorer/index.html");
const served = (await read(html.body)).toString();
const original = fs.readFileSync(path.join(root, "explorer/index.html"), "utf8");
h.eq(served, original.replace("<head>", "<head>" + ARTIFACT_BRIDGE_TAG), "the bridge is the page's first script; every other byte is the file's");
h.eq(Number(html.headers["Content-Length"]), Buffer.byteLength(served), "the length says what is sent");
h.eq(html.headers["Content-Security-Policy"], artifactCsp(), "a page carries the artifact policy");
h.ok(!/https?:|wss?:/.test(artifactCsp()) && /connect-src 'self' data: blob:(;|$)/.test(artifactCsp()), "which withholds the network");
h.ok(/connect-src 'self' data: blob: https: http: wss: ws:/.test(artifactCsp({ network: true })) && /script-src [^;]*https:/.test(artifactCsp({ network: true })), "unless the reader allowed it for the folder");
h.ok(/object-src 'none'/.test(artifactCsp()) && /frame-src 'self' data: blob:(;|$)/.test(artifactCsp({ network: true })), "plugins never; frames only its own, even with the network");
server.rootOf(registered.id).network = true;
h.eq((await get("/explorer/index.html")).headers["Content-Security-Policy"], artifactCsp({ network: true }), "the folder's switch reaches its pages");
server.rootOf(registered.id).network = false;
h.eq((await get("/explorer/app.js")).headers["Content-Security-Policy"], undefined, "only pages carry a policy");
// A page far larger than the head that is read: placed in the head, the tail streamed untouched (multi-byte text at the seam).
const tail = "é漢🙂".repeat(40000);
write("project/artifacts/big.html", `<!doctype html><html><head><title>Big</title></head><body><script>var d = "${tail}";</script></body></html>`);
const big = await get("/big.html");
h.eq((await read(big.body)).toString(), fs.readFileSync(path.join(root, "big.html"), "utf8").replace("<head>", "<head>" + ARTIFACT_BRIDGE_TAG), "a page of megabytes is streamed whole; multi-byte text across the seam is intact");
h.eq(Number(big.headers["Content-Length"]), fs.statSync(path.join(root, "big.html")).size + Buffer.byteLength(ARTIFACT_BRIDGE_TAG), "and its length is the file's plus the tag");
h.eq([bridgeInsertIndex("<!doctype html><html><head lang='en'><title>"), bridgeInsertIndex("<!DOCTYPE html><HTML><body>"), bridgeInsertIndex("<!doctype html><p>x"), bridgeInsertIndex("<p>bare</p>")],
  ["<!doctype html><html><head lang='en'>".length, "<!DOCTYPE html><HTML>".length, "<!doctype html>".length, 0], "the bridge goes after <head>, else <html>, else the doctype, else first");
const bridge = await get(ARTIFACT_BRIDGE_PATH);
h.eq([(bridge.status), bridge.headers["Content-Type"], (await read(bridge.body)).toString()], [200, "text/javascript; charset=utf-8", artifactBridgeSource()], "the bridge is served at its reserved path");
h.ok(new Function(`return function check() { ${artifactBridgeSource()} }`) && artifactBridgeSource().startsWith("(function artifactBridge()"), "and is one self-contained function, called");
h.ok(!/\bimport\b|\brequire\(/.test(artifactBridgeSource()), "that loads nothing");
h.eq((await get("/explorer/index.html", { method: "HEAD" })).body, null, "HEAD sends no body");

// ---------------------------------------------------------------------------------------------
h.section("D. A page's messages are untrusted");
const m = (o: Record<string, unknown>) => parseFrameMessage({ fluxArtifact: 1, ...o });
h.eq(m({ type: "state", path: "/e/index.html", view: "#n=3", title: "T", scrollY: 120.4, scrollMax: 900, heading: 2 }),
  { type: "state", path: "/e/index.html", view: "#n=3", title: "T", scrollY: 120.4, scrollMax: 900, heading: 2 }, "a state report passes");
h.eq(m({ type: "ready", path: "/e/index.html", view: "", title: "x".repeat(500) })?.type === "ready" && (m({ type: "ready", path: "/e/index.html", view: "", title: "x".repeat(500) }) as { title: string }).title.length, 200, "a title is clipped");
for (const bad of [null, "state", 7, { type: "state" }, { fluxArtifact: 2, type: "pointer" }, { fluxArtifact: 1, type: "eval", code: "x" }, { fluxArtifact: 1, type: "state", path: "e/index.html", view: "", scrollY: 0, scrollMax: 0, heading: -1 },
  { fluxArtifact: 1, type: "state", path: "/e", view: "", scrollY: -5, scrollMax: 0, heading: -1 }, { fluxArtifact: 1, type: "state", path: "/e", view: "", scrollY: Infinity, scrollMax: 0, heading: -1 },
  { fluxArtifact: 1, type: "state", path: "/" + "x".repeat(5000), view: "", scrollY: 0, scrollMax: 0, heading: -1 }, { fluxArtifact: 1, type: "key", key: "", code: "KeyA" }, { fluxArtifact: 1, type: "outline", items: "none" }])
  h.eq(parseFrameMessage(bad), null, `dropped: ${JSON.stringify(bad)?.slice(0, 70)}`);
h.eq(m({ type: "open", url: "https://example.org/a" }), { type: "open", url: "https://example.org/a" }, "a web link may be opened in the browser");
for (const url of ["file:///etc/passwd", "javascript:alert(1)", "flux-artifact://x/y", "smb://host/share", "https://" + "a".repeat(3000)]) h.eq(m({ type: "open", url }), null, `never: ${url.slice(0, 40)}`);
h.eq(m({ type: "outline", items: [{ level: 1, text: "A" }, { level: 9, text: "bad level" }, { level: 2, text: "B".repeat(300) }, "junk"] }),
  { type: "outline", items: [{ level: 1, text: "A" }, { level: 3, text: "" }, { level: 2, text: "B".repeat(120) }, { level: 3, text: "" }] }, "an outline keeps its positions (a later index names a heading); bad entries are blank, text is clipped");
h.eq((m({ type: "outline", items: Array.from({ length: 900 }, () => ({ level: 2, text: "h" })) }) as { items: unknown[] }).items.length, 300, "and stops at 300 headings");
h.eq(m({ type: "selection", text: "s".repeat(900) }), { type: "selection", text: "s".repeat(600) }, "selected words are clipped");
h.eq(m({ type: "selection", text: "plateaus", prefix: "p".repeat(90), suffix: "by18h", rect: { x: 10, y: 20.5, w: 80, h: 18 }, heading: "Results" }),
  { type: "selection", text: "plateaus", prefix: "p".repeat(64), suffix: "by18h", rect: { x: 10, y: 20.5, w: 80, h: 18 }, heading: "Results" }, "a selection carries the words around it, where it is and its heading");
h.eq(m({ type: "selection", text: "x", rect: { x: 1, y: 2, w: -3, h: 4 } }), { type: "selection", text: "x" }, "a box that is not a box is left out");
h.eq(m({ type: "selection", text: "" , rect: { x: 1, y: 2, w: 3, h: 4 } }), { type: "selection", text: "" }, "no words, no selection");
h.eq(m({ type: "anchors", items: [{ id: "fb1", found: true }, { id: "fb2", found: "yes" }, { id: "" }, null, { id: "x".repeat(200), found: true }] }), { type: "anchors", items: [{ id: "fb1", found: true }, { id: "fb2", found: false }] }, "a report of found comments: ids and booleans only");
h.eq(m({ type: "anchor", id: "fb1", how: "hover", rect: { x: 1, y: 2, w: 3, h: 4 } }), { type: "anchor", id: "fb1", how: "hover", rect: { x: 1, y: 2, w: 3, h: 4 } }, "the pointer on a comment's mark");
h.eq(m({ type: "anchor", id: "", how: "leave" }), { type: "anchor", id: "", how: "leave" }, "and off it");
for (const bad of [{ type: "anchor", id: "fb1", how: "hover" }, { type: "anchor", id: "", how: "click", rect: { x: 1, y: 2, w: 3, h: 4 } }, { type: "anchor", id: "fb1", how: "dance", rect: { x: 1, y: 2, w: 3, h: 4 } }, { type: "anchor", id: "fb1", how: "move", rect: { x: NaN, y: 2, w: 3, h: 4 } }])
  h.eq(m(bad), null, `dropped: ${JSON.stringify(bad)}`);
h.eq(m({ type: "pick", cancel: true }), { type: "pick", cancel: true }, "picking abandoned");
h.eq(m({ type: "pick", selector: "#curve", tag: "svg", plot: false, label: "Growth curve", text: "", heading: "Curve", rect: { x: 1, y: 2, w: 300, h: 200 }, point: { trace: "held out", x: "3", y: "0.49", junk: "no", z: 7 } }),
  { type: "pick", selector: "#curve", tag: "svg", plot: false, label: "Growth curve", text: "", heading: "Curve", rect: { x: 1, y: 2, w: 300, h: 200 }, point: { trace: "held out", x: "3", y: "0.49" } }, "a picked element: its path, kind, label, heading, box, and a plot's point as text");
for (const bad of [{ type: "pick", selector: "", tag: "svg", rect: { x: 1, y: 2, w: 3, h: 4 } }, { type: "pick", selector: "#a", tag: "SVG onload=x", rect: { x: 1, y: 2, w: 3, h: 4 } }, { type: "pick", selector: "#a", tag: "svg" }])
  h.eq(m(bad), null, `dropped: ${JSON.stringify(bad)}`);
const key = (o: Record<string, unknown>) => m({ type: "key", key: "o", code: "KeyO", ...o }) as Parameters<typeof appChord>[0];
h.ok(appChord(key({ altKey: true })) && appChord(key({ ctrlKey: true, shiftKey: true, key: "M", code: "KeyM" })) && appChord(key({ key: "F1", code: "F1" })) && appChord(key({ ctrlKey: true, key: "1", code: "Digit1" })), "chords are offered to the app: Alt+O, Ctrl+Shift+M, F1, Ctrl+1");
for (const k of ["c", "v", "x", "a", "z", "C"]) h.ok(!appChord(key({ ctrlKey: true, key: k })) && !appChord(key({ metaKey: true, key: k })), `an editing chord stays in the page: Ctrl+${k}`);
h.ok(!appChord(key({ ctrlKey: true, shiftKey: true, key: "Z" })) && !appChord(key({ key: "Escape", code: "Escape" })) && !appChord(key({ key: "a" })), "so do redo, Escape and plain typing");
h.eq(relOfFramePath("flux-artifact://rabc/", "/pop_explorer/io.html"), "pop_explorer/io.html", "the frame's location names the page below its root");
h.eq(relOfFramePath("/__flux-dev/artifacts/serve/rabc/", "/__flux-dev/artifacts/serve/rabc/a%20b/"), "a b/index.html", "under the dev route too; a folder is its index");
h.eq(relOfFramePath("/__flux-dev/artifacts/serve/rabc/", "/__flux-dev/artifacts/serve/rother/x.html"), null, "a location outside the root is not a page of it");

// ---------------------------------------------------------------------------------------------
h.section("E. The rail, lookups and reloads");
const described: ArtifactRoot = await describeRoot(server, { dir: root, linked: false, projectRoot: project, urlBase: (id: string) => `${ARTIFACT_SCHEME}://${id}` });
h.eq(described.artifacts.find((a) => a.rel === "explorer")?.pages.map((p) => p.url), [`flux-artifact://${registered.id}/explorer/index.html`, `flux-artifact://${registered.id}/explorer/methods.html`], "every page has its address on the root's origin");
h.eq(described.artifacts.find((a) => a.rel === "explorer")?.ref, "artifacts/explorer/index.html", "inside the project an agent is told a project path");
h.ok((described as unknown as { watchDirs: string[] }).watchDirs.includes(path.join(root, "explorer")) && !(described as unknown as { watchDirs: string[] }).watchDirs.includes(path.join(root, "explorer/data")), "a described root says which folders to watch");
h.eq((await describeRoot(server, { dir: root, linked: false, projectRoot: project, urlBase: () => "", watchDirCap: 3 }) as unknown as { watching: boolean; watchDirs: string[] }).watchDirs.length, 0, "a root with more folders than the watch budget is listed and not watched");
const outsideRoot: ArtifactRoot = await describeRoot(server, { dir: path.join(scratch, "outside"), linked: true, projectRoot: project, urlBase: (id: string) => `${ARTIFACT_SCHEME}://${id}` });
h.eq([outsideRoot.linked, outsideRoot.label, outsideRoot.artifacts[0].ref], [true, "outside", path.join(scratch, "outside/elsewhere.html")], "outside it, where the page is on disk");
h.eq(await describeRoot(server, { dir: path.join(scratch, "nowhere"), linked: false, projectRoot: project, urlBase: () => "" }), null, "a project without an artifacts folder has no root to show");
const gone: ArtifactRoot = await describeRoot(server, { dir: path.join(scratch, "nowhere"), linked: true, projectRoot: project, urlBase: () => "" });
h.eq([gone.missing, gone.id, gone.artifacts.length], [true, "", 0], "a linked folder that is gone is still shown, as missing");
const listing: ArtifactListing = { roots: [described, outsideRoot], linkedDir: outsideRoot.dir, projectDir: root };
const rowText = (r: ReturnType<typeof artifactRows>[number]) => `${"  ".repeat(r.depth)}${r.kind === "group" ? `${r.name}/ (${r.count})` : r.artifact.title}`;
h.eq(artifactRows(described).map(rowText), ["Summary", "Big", "Growth & decay", "reports/ (3)", "  2026/ (1)", "    deep/ (1)", "      Deep tool", "  Summary", "  Untitled page"],
  "rows: each level by name, folders and artifacts together; a group counts what is under it");
const folded = new Set([`${described.id}:reports/`]);
h.eq(artifactRows(described, folded).map(rowText), ["Summary", "Big", "Growth & decay", "reports/ (3)"], "a folded group hides its rows");
const explorer = findArtifact(listing, `${described.id}:explorer`)!;
h.eq(artifactForRef(listing, "artifacts/explorer/methods.html"), { artifact: explorer, page: "explorer/methods.html" }, "a page path an agent was told finds its artifact and page");
h.eq(artifactForRef(listing, "artifacts/explorer/data/extra.html")?.page, "explorer/data/extra.html", "a page deeper in an artifact's folder belongs to that artifact");
h.eq(artifactForRef(listing, path.join(scratch, "outside/elsewhere.html"))?.artifact.rootId, outsideRoot.id, "an absolute path finds a linked folder's page");
h.eq(artifactForRef(listing, "artifacts/unknown.html"), null, "an unknown path finds nothing");
h.eq(pageRef(explorer, "explorer/methods.html"), "artifacts/explorer/methods.html", "pageRef is the inverse");
h.ok(changeTouches(explorer, [path.join(root, "explorer/data/0.js")]) && !changeTouches(explorer, [path.join(root, "reports/summary.html"), path.join(root, "explorer2/x.js")]), "a folder artifact reloads for files in its folder only");
const summary = findArtifact(listing, `${described.id}:reports/summary.html`)!;
h.ok(changeTouches(summary, [path.join(root, "reports/summary.html")]) && !changeTouches(summary, [path.join(root, "reports/untitled_page.html")]), "a lone page reloads for its own file only");
const now = Date.UTC(2026, 10, 24, 12);
h.eq([30e3, 20 * 60e3, 5 * 3600e3, 30 * 3600e3, 6 * 86400e3, 90 * 86400e3].map((ago) => artifactAge(now - ago, now)), ["now", "20m", "5h", "1d", "6d", "2026-08-26"], "a row says how fresh in a few characters");
h.eq(artifactAgeWords(now - 5 * 3600e3, now), "changed 5 h ago (2026-11-24 07:00 UTC)", "and its tooltip in words, with the moment");
h.eq([...sharedTitles({ roots: [{ ...described, artifacts: [{ ...explorer, title: "Same" }, { ...summary, title: "Same" }, { ...explorer, id: "x", title: "Other" }] }], linkedDir: null, projectDir: root })], ["Same"], "artifacts that share a title are told apart by their file");

const target: TargetRef = { kind: "artifact", path: "artifacts/explorer/index.html", view: "#rec=3&K=2", title: "Growth explorer", heading: "Curve", quote: "plateaus by 18 h" };
h.eq(describeTarget(target), 'text "plateaus by 18 h" in artifact "Growth explorer" (artifacts/explorer/index.html#rec=3&K=2) § "Curve"', "an artifact target tells an agent the words, the page, where in it and the heading");
h.eq(shortTarget(target), "“plateaus by 18 h” · \"Growth explorer\"", "and reads short for a chip");
h.eq(parseTarget(formatTarget(target)), { kind: "artifact", path: "artifacts/explorer/index.html", view: "#rec=3&K=2" }, "its shorthand round-trips the page and the view");
h.eq(parseTarget("artifact:/data/x/pop explorer/io.html?a=1#b"), { kind: "artifact", path: "/data/x/pop explorer/io.html", view: "?a=1#b" }, "an absolute path, a query and a hash");
let refused = ""; try { parseTarget("artifact:artifacts/explorer"); } catch (e) { refused = (e as Error).message; }
h.ok(/expected a page path/.test(refused), "the shorthand names a page, not a folder");
h.eq(uniqueTargets([target, { ...target, quote: "another passage" }, { ...target }]).length, 2, "two selections on one page are two targets");
h.eq(describeStamp({ surface: "paper", artifact: { path: "artifacts/explorer/index.html", view: "#n=1", title: "Growth explorer" } }), "paper · artifact artifacts/explorer/index.html#n=1", "a stamp without targets still says which page");

// ---------------------------------------------------------------------------------------------
h.section("E2. Comments on a page are Inbox items");
const base = { path: "artifacts/explorer/index.html", view: "#rec=3", title: "Growth explorer" };
const passage = commentTarget(base, { quote: "plateaus by 18 h", prefix: "controlseries", suffix: ".Thestressed", heading: "Curve" });
const element = commentTarget(base, { selector: "#curve", tag: "div", plot: true, label: "Held-out gain", text: "", heading: "Curve", point: { trace: "held out", x: "3", y: "0.49" } });
h.eq(passage, { kind: "artifact", path: "artifacts/explorer/index.html", view: "#rec=3", title: "Growth explorer", heading: "Curve", quote: "plateaus by 18 h", prefix: "controlseries", suffix: ".Thestressed" }, "a comment on selected words: the page, the view, the words and what surrounds them");
h.eq(element.element, { selector: "#curve", tag: "div", what: "plot", label: "Held-out gain" }, "a comment on a picked element says what it is and what it is called");
h.eq(describeTarget(element), 'plot "Held-out gain" at point (trace "held out", x 3, y 0.49) in artifact "Growth explorer" (artifacts/explorer/index.html#rec=3) § "Curve"', "an agent is told the plot, the point, the page, the view and the heading");
h.eq(shortTarget(element), 'plot "Held-out gain" at point (trace "held out", x 3, y 0.49) · "Growth explorer"', "and the chip says the same, short");
h.eq([elementWhat("svg", false), elementWhat("div", true), elementWhat("table", false), elementWhat("p", false), elementWhat("h2", false), elementWhat("div", false)], ["figure", "plot", "table", "paragraph", "heading", "section"], "what a picked element is, in a word");
h.eq(parseTarget(formatTarget(element)), { kind: "artifact", path: "artifacts/explorer/index.html", view: "#rec=3" }, "the shorthand names the page and view (an anchor is not an identity an agent types)");
h.eq(uniqueTargets([passage, element, { ...element }, { ...element, point: { trace: "other" } }]).length, 3, "comments on different things of one page are different targets");
const item = (id: string, target: TargetRef | null, over: Partial<InboxItem> = {}): InboxItem => ({
  id, kind: "annotation", surface: "paper", where: "", text: "t", tags: [], status: "open", chip: "Open", archived: false, route: "none", claimedBy: null, assignedTo: null, lastHolder: null,
  createdAt: `2026-11-24T10:00:0${id.length}.000Z`, lastActivity: "", figureIds: [], deckIds: [], targets: target ? [target] : [], thread: [{ kind: "human", author: "You", text: "t", ts: "" }], context: null, ...over,
} as InboxItem);
const items = [
  item("bb", { ...passage, path: "artifacts/explorer/methods.html", view: undefined } as TargetRef),
  item("a", passage),
  item("ccc", element, { status: "resolved" }),
  item("dddd", { kind: "artifact", path: "artifacts/explorer/index.html", title: "Growth explorer" }),
  item("eeeee", { kind: "artifact", path: "artifacts/reports/summary.html", quote: "elsewhere" }),
  item("ffffff", passage, { status: "withdrawn" }),
  item("ggggggg", passage, { archived: true }),
  item("hhhhhhhh", { kind: "doc", path: "paper/notes.qmd", from: 0, to: 4 }),
  item("iiiiiiiii", passage, { kind: "comment" }),
];
const threads = artifactThreads(items, explorer);
h.eq(threads.map((t) => [t.id, t.page, t.view, t.resolved, t.anchored]), [["a", "explorer/index.html", "#rec=3", false, true], ["bb", "explorer/methods.html", "", false, true], ["ccc", "explorer/index.html", "#rec=3", true, true], ["dddd", "explorer/index.html", "", false, false]],
  "an artifact's threads: the Inbox annotations that point at its pages, oldest first; not another artifact's, not withdrawn or archived ones, not manuscript comments");
h.eq([pageOfRef(explorer, "artifacts/explorer/data/x.html"), pageOfRef(explorer, "artifacts/explorer2/index.html"), pageOfRef(summary, "artifacts/reports/summary.html"), pageOfRef(summary, "artifacts/reports/other.html")], ["explorer/data/x.html", null, "reports/summary.html", null], "a page belongs to the artifact whose folder holds it (a lone page: only itself)");
h.eq(pageAnchors(threads, "explorer/index.html"), [{ id: "a", quote: "plateaus by 18 h", prefix: "controlseries", suffix: ".Thestressed" }], "the page is asked to mark its open, anchored comments: not resolved ones, not the other page's, not a note about the whole page");
h.eq(anchorOf(threads[2]), { id: "ccc", selector: "#curve", tag: "div", label: "Held-out gain", text: undefined }, "an element's anchor is its path, kind and label");
const foundMap = new Map([["a", true]]);
h.eq([threadPlace(threads[0], "explorer/index.html", "#rec=3", foundMap), threadPlace(threads[0], "explorer/index.html", "#rec=9", new Map()), threadPlace(threads[0], "explorer/index.html", "#rec=3", new Map()), threadPlace(threads[1], "explorer/index.html", "", foundMap), threadPlace(threads[3], "explorer/index.html", "", foundMap)],
  ["here", "other-view", "lost", "other-page", "page"], "where a thread stands: marked here, made on another view, no longer on the page, on another page, or about the page as a whole");
h.eq(threadPlace(threads[0], "explorer/index.html", "#rec=9", foundMap), "here", "a comment made on another view that IS on this one is simply here");
h.eq([threadSubject(passage), threadSubject(element), threadSubject({ kind: "artifact", path: "x.html", heading: "Curve" })],
  [{ kind: "passage", text: "plateaus by 18 h" }, { kind: "element", text: 'plot "Held-out gain" · point (trace "held out", x 3, y 0.49)' }, { kind: "page", text: "the page, at “Curve”" }], "what a thread is about, as its card says it");
h.eq(threadSubject(commentTarget(base, { selector: "div:nth-of-type(2)", tag: "div", plot: true, label: "", text: "", heading: "The K-curve" })).text, "plot under “The K-curve”", "a plot with no name of its own is named by the heading it is under");
h.eq(messageParts("Done. See [recording 12 at K = 5](#rec=12&K=5), [the soma page](io.html#rec=12) and [the docs](https://example.org/x). Also [a script](javascript:alert(1)) and [up](../../etc/passwd.html)."),
  [{ text: "Done. See " }, { label: "recording 12 at K = 5", view: "#rec=12&K=5" }, { text: ", " }, { label: "the soma page", page: "io.html", view: "#rec=12" }, { text: " and [the docs](https://example.org/x). Also [a script](javascript:alert(1)) and [up](../../etc/passwd.html)." }],
  "an agent's reply may link INTO the page (a view, another page of the artifact); every other link stays text");
h.eq(messageParts("no links here"), [{ text: "no links here" }], "plain text is one part");
h.eq([linkedPage("pop_explorer/index.html", "io.html"), linkedPage("pop_explorer/index.html", undefined), linkedPage("summary.html", "other.html")], ["pop_explorer/io.html", "pop_explorer/index.html", "other.html"], "a linked page is beside the page the thread is on");
h.eq([markRect({ x: 10, y: -20, w: 100, h: 60 }, { x: 300, y: 90 }, { w: 800, h: 600 }), markRect({ x: 10, y: 700, w: 100, h: 60 }, { x: 300, y: 90 }, { w: 800, h: 600 })], [{ x: 310, y: 90, w: 100, h: 40 }, null], "the picture's box is the part of the subject in view, in window coordinates; none when it is out of view");

// ---------------------------------------------------------------------------------------------
h.section("F. The dev server's route is the same server");
const routes = createArtifactDevRoutes({ projectDir: root, projectRoot: project });
const httpServer = http.createServer((req, res) => { void routes.handler(req, res, () => { res.statusCode = 404; res.end("next"); }); });
await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
try {
  const devListing = await (await fetch(`${origin}/__flux-dev/artifacts/list`)).json() as ArtifactListing;
  const devExplorer = devListing.roots[0].artifacts.find((a) => a.rel === "explorer")!;
  h.eq([devListing.roots.length, devExplorer.title, devExplorer.pages[0].url], [1, "Growth & decay", `/__flux-dev/artifacts/serve/${registered.id}/explorer/index.html`], "the route lists the same artifacts, addressed on the dev server");
  const devPage = await fetch(origin + devExplorer.pages[0].url);
  h.eq(await devPage.text(), served, "and serves the same page, bridge and all");
  h.ok(devPage.headers.get("content-security-policy") === artifactCsp().replaceAll("'self'", `'self' ${origin}`) && devPage.headers.get("access-control-allow-origin") === "*", "with the same policy, `self` spelled as the dev server (the frame is sandboxed there)");
  h.eq(await (await fetch(origin + ARTIFACT_BRIDGE_PATH)).text(), artifactBridgeSource(), "the bridge's absolute path is answered too");
  h.eq((await fetch(`${origin}/__flux-dev/artifacts/serve/${registered.id}/explorer/leak.txt`)).status, 403, "and it refuses what the app refuses");
  h.eq(await (await fetch(`${origin}/elsewhere`)).text(), "next", "every other path is left to the dev server");
  // A request line no URL parser accepts (a gate once asked for "//?fixture=demo") took the dev server down.
  const odd = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: (httpServer.address() as { port: number }).port, path: "//?fixture=demo" }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve(t)); });
    req.on("error", reject); req.end();
  });
  h.eq(odd, "next", "a request the route cannot parse is passed on, never thrown");
} finally { await new Promise((resolve) => httpServer.close(resolve)); }
const fixture = await listArtifacts(path.join(repo, "scripts/fixtures/artifacts"));
h.eq(fixture.artifacts.map((a: { rel: string; title: string; pages: string[] }) => `${a.rel}=${a.title} (${a.pages.length})`).sort(), ["explorer=Growth explorer (2)", "reports/summary.html=Summary of the & first run (1)"], "the dev fixture's artifacts are the two the GUI gate opens");

// ---------------------------------------------------------------------------------------------
h.section("G. Source shape");
const family = fs.readFileSync(path.join(repo, "electron/ipc/artifacts.cjs"), "utf8");
const serve = fs.readFileSync(path.join(repo, "electron/artifactServe.cjs"), "utf8");
h.ok(!/\b(writeFile|appendFile|rename|unlink|rmdir|mkdir|copyFile|createWriteStream|\brm)\s*\(/.test(family + serve), "the family and its server never write, move or remove a file");
h.ok(/writePrefs\(\{ \.\.\.prefs, artifactDirs: dirs \}\)/.test(family) && !/project\.json/.test(family.replace(/\/\/.*$/gm, "")), "the folder link is written to preferences, never to project.json");
h.ok(/depth: 0,/.test(family) && !/depth: ARTIFACT_LIMITS/.test(family) && /watchServed\(state, file\)/.test(family), "the watcher watches listed folders one level deep and served files one by one: it never walks an artifact's data");
const mainSource = fs.readFileSync(path.join(repo, "electron/main.cjs"), "utf8");
h.ok(/registerSchemesAsPrivileged\(\[[\s\S]*?scheme: "flux-artifact", privileges: \{ standard: true, secure: true, stream: true, supportFetchAPI: true \} \}\]\)/.test(mainSource), "the scheme is registered with the app's one privileged-scheme call: standard and secure, an origin of its own");
h.ok(/artifactsFamily\.guardFrames\(win\)/.test(mainSource), "every window guards where an artifact frame may go");
const csps = [fs.readFileSync(path.join(repo, "index.html"), "utf8"), mainSource].map((s) => /frame-src ([^;"]+);/.exec(s)?.[1]);
h.eq(csps, ["'self' flux-artifact:", "'self' flux-artifact:"], "the app may frame its own pages and artifacts, nothing else (index.html and the dev header agree)");
h.eq(ARTIFACT_SCHEME, "flux-artifact", "one scheme name");

await h.done(() => fs.rmSync(scratch, { recursive: true, force: true }));

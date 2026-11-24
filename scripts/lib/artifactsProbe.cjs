// Probe for verify-artifacts-electron.cjs: boots the actual composition root (electron/main.cjs)
// on a project with an artifacts/ folder and a linked folder outside it, opens an artifact in
// Paper and looks at the frame from the main process: its origin, its process, what it may and
// may not reach, how it follows the files, and how the page's keyboard still reaches the app.
"use strict";
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "1";
const fs = require("node:fs"), path = require("node:path");
const root = process.env.PROBE_PROJECT, scratch = process.env.PROBE_SCRATCH, linked = process.env.PROBE_LINKED;
if (!root || !scratch || !linked) throw new Error("Missing hermetic probe context");
const { app, BrowserWindow, shell } = require("electron");
app.disableHardwareAcceleration();
// The web opens in the reader's browser: here, into a list.
const opened = [];
shell.openExternal = async (url) => { opened.push(String(url)); };
let uncaught = 0;
const rendererExceptions = [];
process.on("uncaughtException", e => { uncaught++; console.log(`PROBE uncaught=${String(e?.stack || e)}`); });
require("../../electron/main.cjs");

const checks = [];
const check = (ok, label, detail) => { checks.push({ ok: !!ok, label, ...(detail ? { detail: String(detail).slice(0, 400) } : {}) }); console.log(`PROBE check=${JSON.stringify(checks.at(-1))}`); if (!ok) throw new Error(label); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 15000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch (e) { last = e.message; } await sleep(50); }
  throw new Error(`Timeout: ${label}${last ? `; ${last}` : ""}`);
}
let win;
const js = code => win.webContents.executeJavaScript(code, true);
const artifactFrame = () => win.webContents.mainFrame.framesInSubtree.find(f => f !== win.webContents.mainFrame && f.url.startsWith("flux-artifact://"));
const inFrame = code => artifactFrame().executeJavaScript(code, true);
const view = () => js(`(() => { const v = document.querySelector('.aview'); return v ? { ...v.dataset } : null; })()`);
async function nativeClick(point, label) {
  const at = await waitFor(() => point(), label);
  win.webContents.focus();
  for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}
const centreOf = selectorJs => () => js(`(() => { const el = ${selectorJs}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()`);
// Input INSIDE the page is made in the page (element.click(), a dispatched keydown): this
// window-free harness has no compositor to hit-test a native press into an out-of-process frame,
// so webContents.sendInputEvent never arrives there. What is under test is the chain from the
// page's event to the app (the bridge, the message, Paper), which is the same either way.
const rows = () => js(`[...document.querySelectorAll('[data-artifact-row]')].map(e => e.querySelector('.a-title')?.textContent ?? '')`);

async function main() {
  win = await waitFor(() => BrowserWindow.getAllWindows()[0], "native window");
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.log("PROBE renderer=" + JSON.stringify({ level, message }));
    if (level >= 3 && /Uncaught/.test(message)) rendererExceptions.push(message);
  });
  await waitFor(() => js("!!window.fig?.artifactsList && !!document.querySelector('.cm-editor')"), "project opened in Paper", 30000);
  check(app.getPath("userData").startsWith(scratch + path.sep), "native config and single-instance lock are isolated");

  // 1. The project's own artifacts/ folder is listed with nothing set up.
  await waitFor(async () => (await rows()).includes("Growth explorer"), "the project's artifacts in the rail");
  check((await rows()).join("|") === "Growth explorer|Summary of the & first run", "Paper lists the project's artifacts/ folder: a folder artifact and a page in a group", (await rows()).join("|"));

  // 2. Linking a folder outside the project (what Settings does) adds it; dependency folders are never searched.
  const listing = await js(`window.fig.artifactsSetDir(${JSON.stringify(root)}, ${JSON.stringify(linked)})`);
  check(listing.linkedDir === linked && listing.roots.length === 2 && listing.roots[1].linked, "a linked folder becomes the project's second artifact root");
  const linkedTitles = listing.roots[1].artifacts.map(a => `${a.title}@${a.ref}`).sort();
  check(linkedTitles.length === 2 && linkedTitles[0] === `Linked tool@${path.join(linked, "deep/tool/index.html")}` && linkedTitles[1] === `Loose report@${path.join(linked, "report.html")}`, "the linked folder's artifacts are found at any depth, with absolute page paths for agents; node_modules is skipped", linkedTitles.join(" | "));
  const prefsFile = path.join(app.getPath("userData"), "preferences.json");
  check(JSON.parse(fs.readFileSync(prefsFile, "utf8")).artifactDirs?.[root] === linked && !fs.readFileSync(path.join(root, "project.json"), "utf8").includes(linked), "the link is a machine preference keyed by the project; project.json is untouched");
  await js(`window.fig.artifactsSetDir(${JSON.stringify(path.join(scratch, "elsewhere"))}, ${JSON.stringify(linked)}).then(() => 'accepted', e => 'refused: ' + e.message)`).then(r => check(String(r).startsWith("refused"), "a window cannot link a folder to a project it does not have open", r));

  // 3. Open one: the page loads in a frame of its own origin and its own process, without the app's bridge.
  await nativeClick(centreOf(`[...document.querySelectorAll('[data-artifact-row]')].find(e => e.textContent.includes('Growth explorer'))`), "the Growth explorer row");
  await waitFor(async () => (await view())?.artifactReady === "true", "the artifact's page answers");
  const frame = await waitFor(() => artifactFrame(), "the artifact frame");
  const main = win.webContents.mainFrame;
  check(/^flux-artifact:\/\/r[0-9a-f]{30}$/.test(frame.origin) && frame.origin !== main.origin, "the page has an origin of its own", `${frame.origin} vs ${main.origin}`);
  check(frame.processId !== main.processId, "and a renderer process of its own", `${frame.processId} vs ${main.processId}`);
  check(await inFrame(`document.body.dataset.series`) === "control", "the page's own scripts and data ran");
  check(await inFrame(`typeof window.fig`) === "undefined", "the app's file bridge is not in the page");
  check(await inFrame(`(() => { try { return String(window.parent.document.title); } catch (e) { return 'refused'; } })()`) === "refused", "the page cannot reach into the app's document");
  check(await js(`getComputedStyle(document.querySelector('.editor-col')).display`) === "none" && await js(`!document.querySelector('.dm-wrap')`), "the document's editor is hidden, not unmounted, and the margin gives its room to the page");
  check(await js(`document.querySelector('.outline')?.textContent.includes('Growth under nutrient stress') && document.querySelector('.outline').textContent.includes('Curve')`), "the rail's Outline reads the page's headings");

  // 4. What the page may not do.
  check(await inFrame(`fetch('https://example.org/x').then(() => 'reached', () => 'refused')`) === "refused", "the page cannot reach the network");
  await waitFor(() => js(`!!document.querySelector('.aview .notice')`), "the strip says a request was refused");
  check(/1 blocked/.test(await js(`document.querySelector('.aview .notice').textContent`)), "the strip says so, once");
  const status = await inFrame(`Promise.all(['/%2e%2e/project.json', '/explorer/.secret', '/explorer/out.txt', '/explorer/data.js'].map(u => fetch(u).then(r => r.status, () => 0)))`);
  // The URL parser folds "%2e%2e" itself, so the first asks for /project.json of the ROOT: not there. The rule that
  // refuses a path which does climb is pinned in verify-artifact-rules (pure).
  check(status.join(",") === "404,403,403,200", "a path that tries to climb out finds nothing; hidden files and links that leave the folder are refused", status.join(","));
  check(await inFrame(`fetch('flux-artifact://r000000000000000000000000000000/x.html').then(r => r.status, () => 0)`) !== 200, "a folder that was never opened is not served");

  // 5. The page's own navigation and state.
  await inFrame(`(() => { const s = document.getElementById('series'); s.value = 'stressed'; s.dispatchEvent(new Event('change')); })()`);
  await waitFor(async () => (await view())?.artifactView === "#s=stressed", "the page's view reaches the strip");
  check(await js(`document.querySelector('.aview .viewchip')?.textContent`) === "#s=stressed", "the strip shows where in the page the reader is");
  // A page kept off the network may ASK for a link to open; it opens when the reader says so.
  await inFrame(`document.querySelector('#to-web').click()`);
  await waitFor(() => js(`!!document.querySelector('.aview .notice.link')`), "the strip offers the link");
  check(opened.length === 0 && artifactFrame()?.url.includes("/explorer/index.html"), "a link to the web does not open by itself and the frame stays on the artifact: the strip offers it", await js(`document.querySelector('.aview .notice.link').textContent.trim()`));
  await js(`document.querySelector('.aview .notice.link').click()`);
  await waitFor(() => opened.length > 0, "the offered link opens in the browser");
  check(opened.length === 1 && opened[0] === "https://example.org/growth", "the reader's click opens it in the browser", opened.join(","));
  await inFrame(`document.querySelector('#to-methods').click()`);
  await waitFor(async () => (await view())?.artifactPage === "explorer/methods.html" && (await view())?.artifactReady === "true", "the second page");
  check(await js(`document.querySelector('.aview .page.on')?.textContent`) === "methods" && await js(`document.querySelector('.outline')?.textContent.includes('Measurement')`), "following a link inside the artifact moves the page tab and the outline");
  await nativeClick(centreOf(`[...document.querySelectorAll('.aview .page')].find(b => b.textContent === 'index')`), "the index page tab");
  await waitFor(async () => (await view())?.artifactPage === "explorer/index.html" && (await view())?.artifactReady === "true", "back on the first page");

  // 6. The page has the keyboard; the app's chords still work.
  const chord = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', code: 'KeyO', altKey: true, bubbles: true, cancelable: true }))`;
  check(await js(`!!document.querySelector('.leftrail')`), "the rail is open");
  await inFrame(chord);
  await waitFor(() => js(`!document.querySelector('.leftrail')`), "Alt+O, pressed in the page, folds the rail");
  check(true, "a chord pressed while the page has the keyboard reaches Paper");
  await inFrame(chord);
  await waitFor(() => js(`!!document.querySelector('.leftrail')`), "Alt+O again opens it");
  await inFrame(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true }))`);
  await sleep(300);
  check(await js(`!!document.querySelector('.leftrail') && !!document.querySelector('.aview')`), "an editing chord (Ctrl+C) stays in the page");

  // 7. Following the files: a file the page loaded reloads it in place; a build's log does not.
  await inFrame(`(() => { const s = document.getElementById('series'); s.value = 'stressed'; s.dispatchEvent(new Event('change')); window.__mark = 1; })()`);
  await waitFor(async () => (await view())?.artifactView === "#s=stressed", "the view before the reload");
  fs.writeFileSync(path.join(root, "artifacts/explorer/build.log"), "step 1\n");
  await sleep(1500);
  check(await inFrame(`window.__mark`) === 1, "a file no page loaded (the build's log) reloads nothing");
  const data = path.join(root, "artifacts/explorer/data.js");
  fs.writeFileSync(data, fs.readFileSync(data, "utf8").replace("version: 1", "version: 2"));
  await waitFor(async () => artifactFrame() && await inFrame(`document.getElementById('stamp')?.textContent`) === "data version 2", "the page reloads with the new data", 12000);
  check(await inFrame(`document.body.dataset.series`) === "stressed" && (await view())?.artifactView === "#s=stressed", "the reloaded page is where the reader was");
  check(await inFrame(`typeof window.__mark`) === "undefined", "and it is a fresh page");

  // A file two folders down, loaded on demand: it is watched from the moment a page reads it. Its neighbour nobody read is not.
  check(await inFrame(`fetch('data/deep/extra.json').then(r => r.json()).then(j => j.n)`) === 1, "the page loads a data file two folders down");
  await inFrame(`window.__mark = 2; void 0`);
  await sleep(600); // the watch on the newly served file is being added
  fs.writeFileSync(path.join(root, "artifacts/explorer/data/deep/unread.json"), '{"n":2}');
  await sleep(1500);
  check(await inFrame(`window.__mark`) === 2, "a data file no page read changes: nothing reloads");
  fs.writeFileSync(path.join(root, "artifacts/explorer/data/deep/extra.json"), '{"n":2}');
  await waitFor(async () => artifactFrame() && await inFrame(`typeof window.__mark`) === "undefined", "the page reloads for the data file it read", 12000);
  check(true, "a data file a page read, deep in the artifact's folder, reloads the page when it changes");

  // 8. A new page on disk appears in the rail by itself.
  fs.writeFileSync(path.join(root, "artifacts/fresh.html"), "<!doctype html><title>Fresh from the agent</title><h1>New</h1>");
  await waitFor(async () => (await rows()).includes("Fresh from the agent"), "the new artifact in the rail", 12000);
  check(true, "an artifact written while the project is open appears in the rail");

  // A folder made first and its page written later (a build that writes its index last).
  fs.mkdirSync(path.join(root, "artifacts/later"));
  await sleep(1500);
  fs.writeFileSync(path.join(root, "artifacts/later/index.html"), "<!doctype html><title>Written last</title><h1>Later</h1>");
  await waitFor(async () => (await rows()).includes("Written last"), "an artifact whose folder came before its page", 12000);
  check(true, "a folder that gets its index page later becomes an artifact in the rail");

  // 9. A comment on the page, in the real frame: made, pictured, found again after the page is rebuilt, and reported lost when its words are gone.
  await inFrame(`(() => { const p = [...document.querySelectorAll('main p')].find(e => e.textContent.includes('plateaus by 18 h')); p.scrollIntoView({ block: 'center' }); const t = p.firstChild, at = t.nodeValue.indexOf('plateaus by 18 h'), r = document.createRange(); r.setStart(t, at); r.setEnd(t, at + 16); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
  await waitFor(() => js(`document.querySelector('.sel-bubble')?.dataset.selected === 'plateaus by 18 h'`), "the Comment key on the selected words");
  await js(`document.querySelector('.sel-bubble button').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`);
  await waitFor(() => js(`document.activeElement === document.querySelector('[data-artifact-card="draft"] textarea')`), "the new comment has the keyboard");
  win.webContents.insertText("Is this a ceiling of the assay?");
  await waitFor(() => js(`document.querySelector('[data-artifact-card="draft"] textarea')?.value === 'Is this a ceiling of the assay?'`), "the comment is typed");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: ["control"] });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers: ["control"] });
  const marked = () => inFrame(`[...(CSS.highlights.get('flux-comment') ?? []), ...(CSS.highlights.get('flux-comment-on') ?? [])].map(r => r.toString())`);
  await waitFor(async () => (await view())?.artifactComments === "1" && (await view())?.artifactFound === "1", "the comment is saved and marked on the page");
  const ledgerFile = path.join(root, ".meta/feedback.ndjson");
  const note = fs.readFileSync(ledgerFile, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(e => e.kind === "note").at(-1);
  check(note.text === "Is this a ceiling of the assay?" && note.context.targets[0].kind === "artifact" && note.context.targets[0].path === "artifacts/explorer/index.html" && note.context.targets[0].quote === "plateaus by 18 h" && note.context.targets[0].view === "#s=stressed",
    "a comment written on selected words of the page is an Inbox note on that page, view and passage", JSON.stringify(note.context.targets[0]));
  const picture = path.join(root, note.context.snapshot?.image ?? "missing");
  const png = fs.existsSync(picture) ? fs.readFileSync(picture) : Buffer.alloc(0);
  check(png.length > 3000 && png.readUInt32BE(0) === 0x89504e47 && note.context.snapshot.marks.length === 1, "with a picture of the page beside the ledger, the words boxed", `${png.length} bytes`);
  check((await marked()).join("|") === "plateaus by 18 h", "the real page marks the words, and only them");
  check(await inFrame(`document.querySelectorAll('mark').length + document.body.querySelectorAll('[data-flux-artifact], flux-artifact-marks').length`) === 0, "without changing the page's body");
  // The agent rebuilds the page: the sentence moves into a new section, with new markup inside it.
  const index = path.join(root, "artifacts/explorer/index.html");
  const original = fs.readFileSync(index, "utf8");
  fs.writeFileSync(index, original.replace("<p>The control series plateaus by 18 h. The stressed series keeps rising.</p>", "").replace('<h2 id="s-curve">Curve</h2>', '<h2 id="s-summary">Summary</h2>\n  <p id="moved">In short: the <b>control</b> series <i>plateaus</i> by 18 h, as the table shows.</p>\n  <h2 id="s-curve">Curve</h2>'));
  await waitFor(async () => artifactFrame() && await inFrame(`!!document.getElementById('moved')`), "the rebuilt page is shown", 12000);
  await waitFor(async () => (await view())?.artifactFound === "1" && (await marked()).join("|") === "plateaus by 18 h", "the comment is found in the rebuilt page");
  check(await inFrame(`[...CSS.highlights.get('flux-comment')][0].startContainer.parentElement.closest('#moved') !== null`), "after the page is rebuilt with the sentence moved and marked up differently, the comment is on it again");
  // Then the sentence is taken out altogether.
  await js(`document.querySelector('.aview .key[aria-label="Comments on this artifact"]').click()`);
  fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace(/<p id="moved">[\s\S]*?<\/p>/, "<p>Twelve of fourteen cultures grew.</p>"));
  await waitFor(async () => (await view())?.artifactFound === "0" && (await view())?.artifactComments === "1", "the comment's words are gone from the page", 12000);
  await waitFor(() => js(`document.querySelector('.arail [data-rail-thread] .where')?.dataset.where === 'lost'`), "the thread says so");
  check(await js(`document.querySelector('.arail [data-rail-thread] .where').textContent.trim()`) === "no longer on the page" && await js(`document.querySelector('.arail [data-rail-thread] .mtext').textContent`) === "Is this a ceiling of the assay?", "when the words are gone the comment is kept, and says they are no longer on the page");
  fs.writeFileSync(index, original);
  await waitFor(async () => (await view())?.artifactFound === "1", "the words are back and so is the mark", 12000);
  check(true, "and when the words come back, so does its mark");
  await js(`document.querySelector('.arail .x').click()`);

  // 10. Back to the document: the same editor, never reloaded.
  await nativeClick(centreOf(`document.querySelector('.aview .key.close')`), "the strip's close key");
  await waitFor(() => js(`!document.querySelector('.aview') && getComputedStyle(document.querySelector('.editor-col')).display !== 'none'`), "the document is back");
  check(await js(`document.querySelector('.cm-content')?.textContent.includes('Start writing')`), "the document is shown again, as it was");
  check(uncaught === 0 && rendererExceptions.length === 0, "no uncaught exception in the main process or the window", rendererExceptions.join(" | "));
}

app.whenReady().then(() => main()).then(
  () => { console.log(`PROBE result=${JSON.stringify({ ok: true, checks })}`); },
  e => { console.log(`PROBE result=${JSON.stringify({ ok: false, error: String(e?.message || e), checks })}`); },
);

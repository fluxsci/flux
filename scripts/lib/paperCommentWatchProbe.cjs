// Probe for verify-paper-comment-watch-electron.cjs: boots the actual composition root
// (electron/main.cjs) on a new-layout project, then plays an agent through the real CLI against
// the open Paper editor, with native input for the GUI half.
"use strict";
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "1";
const fs = require("node:fs"), path = require("node:path");
const { execFile } = require("node:child_process");
const root = process.env.PROBE_PROJECT, scratch = process.env.PROBE_SCRATCH, node = process.env.PROBE_NODE, repo = process.env.PROBE_REPO;
if (!root || !scratch || !node || !repo) throw new Error("Missing hermetic probe context");
const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
let uncaught = 0;
const rendererExceptions = [];
process.on("uncaughtException", e => { uncaught++; console.log(`PROBE uncaught=${String(e?.stack || e)}`); });
require("../../electron/main.cjs");

const ID = "c-watch", SIDECAR = path.join(root, "paper/notes.comments.json"), DOC = path.join(root, "paper/notes.qmd");
const checks = [];
const check = (ok, label, detail) => { checks.push({ ok: !!ok, label, ...(detail ? { detail } : {}) }); console.log(`PROBE check=${JSON.stringify(checks.at(-1))}`); if (!ok) throw new Error(label); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 15000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch (e) { last = e.message; } await sleep(50); }
  throw new Error(`Timeout: ${label}${last ? `; ${last}` : ""}`);
}
const bodies = () => { try { return JSON.parse(fs.readFileSync(SIDECAR, "utf8")).threads.find(t => t.id === ID)?.messages.map(m => m.body) ?? []; } catch { return null; } };
/** The agent: the real CLI (flux-core), as a separate process. */
const cli = (...args) => new Promise(resolve => execFile(node, ["--import", "tsx", path.join(repo, "flux-cli.ts"), ...args, "--root", root],
  { cwd: repo, env: process.env, timeout: 60000 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));

let win;
const js = code => win.webContents.executeJavaScript(code, true);
const cardMessages = () => js(`(() => { const c = document.querySelector('[data-comment-card].ready'); return c && c.dataset.commentCard === ${JSON.stringify(ID)} ? [...c.querySelectorAll('.mtext')].map(m => m.textContent) : null; })()`);
async function click(selectorJs, label) {
  const at = await waitFor(() => js(`(() => { const el = ${selectorJs}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()`), label);
  win.webContents.focus();
  for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}
async function reply(text) {
  await click(`[...document.querySelectorAll('[data-comment-card].ready .acts button')].find(b => b.textContent.trim() === 'Reply')`, "the card's Reply action");
  await waitFor(() => js(`document.activeElement?.getAttribute('aria-label') === 'Reply'`), "reply composer focus");
  win.webContents.insertText(text);
  await waitFor(() => js(`document.activeElement?.value === ${JSON.stringify(text)}`), "reply typed");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: ["control"] });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers: ["control"] });
}

async function main() {
  win = await waitFor(() => BrowserWindow.getAllWindows()[0], "native window");
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.log("PROBE renderer=" + JSON.stringify({ level, message }));
    if (level >= 3 && /Uncaught/.test(message)) rendererExceptions.push(message);
  });
  await waitFor(() => js("!!window.fig?.onFsChanged && !!document.querySelector('.cm-editor')"), "project opened in Paper", 30000);
  check(app.getPath("userData").startsWith(scratch + path.sep), "native config and single-instance lock are isolated");
  await js("window.__watchEvents = []; window.fig.onFsChanged(e => window.__watchEvents.push(e)); void 0;");
  await waitFor(() => js(`!!document.querySelector('.cm-comment-hl[data-cid=${JSON.stringify(ID)}]')`), "the comment's text is marked");
  check(true, "paper/notes.qmd is open with its margin comment");

  // 1. An agent replies; the open app hears of it and shows it.
  let r = await cli("reply", ID, "Agent reply one");
  check(r.code === 0, "the agent's reply goes through the CLI", (r.stderr || r.stdout).trim().slice(0, 300));
  check(JSON.stringify(bodies()) === JSON.stringify(["Is this the right verb?", "Agent reply one"]), "flux-core appended it to paper/notes.comments.json");
  await waitFor(() => js(`window.__watchEvents.some(e => e.subsystem === 'manuscript' && e.path.endsWith('notes.comments.json'))`), "watcher event for the paper/ sidecar");
  check(true, "the project watcher reports the paper/ sidecar change as a manuscript change");
  await click(`document.querySelector('.cm-comment-hl[data-cid=${JSON.stringify(ID)}]')`, "the commented text");
  const shown = await waitFor(async () => { const m = await cardMessages(); return m && m.includes("Agent reply one") ? m : null; }, "the card shows the agent's reply");
  check(true, "the open app shows the agent's reply", JSON.stringify(shown));

  // 2. Replying in the GUI keeps the agent's reply on disk.
  await reply("Human reply one");
  const want1 = ["Is this the right verb?", "Agent reply one", "Human reply one"];
  await waitFor(() => JSON.stringify(bodies()) === JSON.stringify(want1), "GUI reply saved beside the agent's", 8000).catch(() => {});
  check(JSON.stringify(bodies()) === JSON.stringify(want1), "after the GUI reply both messages are on disk", JSON.stringify(bodies()));
  await sleep(1500); // a trailing save would land within this
  check(JSON.stringify(bodies()) === JSON.stringify(want1), "and stay there", JSON.stringify(bodies()));

  // 3. An agent reply that lands just before a GUI reply is sent: the app has not heard of it yet
  //    when the GUI reply is made, and its save (600 ms later) must not erase it.
  r = await cli("reply", ID, "Agent reply two");
  check(r.code === 0, "a second agent reply goes through the CLI", (r.stderr || r.stdout).trim().slice(0, 300));
  await reply("Human reply two");
  const want2 = [...want1, "Agent reply two", "Human reply two"];
  await waitFor(() => JSON.stringify(bodies()) === JSON.stringify(want2), "both new replies on disk", 8000).catch(() => {});
  await sleep(1500);
  check(JSON.stringify(bodies()) === JSON.stringify(want2), "a GUI reply sent before the app heard of an agent's reply keeps both", JSON.stringify(bodies()));
  const final = await waitFor(async () => { const m = await cardMessages(); return m && JSON.stringify(m) === JSON.stringify(want2) ? m : null; }, "the card shows all five messages").catch(() => null);
  check(!!final, "the open card shows every message, in order", JSON.stringify(await cardMessages()));

  // 4. An agent's document edit reaches the open editor (it no longer stays stale).
  const edited = fs.readFileSync(DOC, "utf8").replace("The control group recovered.", "The control group recovered. An agent added this sentence.");
  r = await cli("set-manuscript", "--doc", "paper/notes.qmd", "--file", await (async () => { const f = path.join(scratch, "edited.qmd"); fs.writeFileSync(f, edited); return f; })());
  check(r.code === 0, "the agent's document edit goes through the CLI", (r.stderr || r.stdout).trim().slice(0, 300));
  await waitFor(() => js(`document.querySelector('.cm-content')?.textContent.includes('An agent added this sentence.')`), "editor shows the agent's edit");
  check(true, "the open editor shows the agent's paper/ document edit");
  await sleep(1500);
  check(fs.readFileSync(DOC, "utf8") === edited, "the editor does not write its stale text back over it");
  check(JSON.stringify(bodies()) === JSON.stringify(want2), "the thread is intact after the document reload", JSON.stringify(bodies()));

  check(uncaught === 0, "no uncaught main-process exceptions");
  check(rendererExceptions.length === 0, "no uncaught renderer exceptions", rendererExceptions.join("; "));
}
function finish(result) {
  fs.writeSync(1, "PROBE result=" + JSON.stringify(result) + "\n");
  process.exit(result.ok ? 0 : 1); // app.exit can wait on retained native watchers
}
app.whenReady().then(() => main().then(() => finish({ ok: true, checks })).catch(async e => {
  try { console.log("PROBE dom=" + JSON.stringify((await js("document.body.innerText")).slice(-4000))); } catch { /* no window */ }
  finish({ ok: false, checks, error: String(e.stack || e) });
}));
setTimeout(() => { fs.writeSync(1, "PROBE fatal=watchdog-timeout\n"); process.exit(2); }, 140000);

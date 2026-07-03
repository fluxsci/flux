// PaperCite — the live Citation Group editor end-to-end.
// Verifies: Alt-C with the caret in a [@a; @b] group opens the Citation Group
// pane listing members IN SOURCE ORDER; Backspace removes the highlighted
// member (doc text updates, order preserved); type-to-search + Enter adds a
// member; removing every member deletes the group plus its stray space;
// double-clicking a cite chip opens the same pane; the BibliographyView card
// follows the caret.
//   Run (dev server on :1420 must be up): node scripts/verify-citegroup.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, shot } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);

const setup = await page.evaluate(async () => {
  const view = window.__fluxView || (window.__flux?.editors ?? [])[0];
  if (!view) return { error: "no editor view" };
  window.__fluxSeedBib(
    ["a", "b", "c", "d"].map((k, i) => ({
      key: `ref${k}`,
      title: `The ${k} study of things`,
      authors: [`Author${k}`, `Coauthor${k}`],
      year: String(2015 + i),
    })),
  );
  const text = [
    "---",
    "title: Group test",
    "citation-style: numeric",
    "---",
    "A claim citing two studies [@refb; @refa] here.",
    "More prose after.",
  ].join("\n");
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: 0 },
  });
  await new Promise((r) => requestAnimationFrame(r));
  // Caret INSIDE the group (chip edge) — line 5, position of "[@".
  const line = view.state.doc.line(5);
  const at = line.from + line.text.indexOf("[@");
  view.dispatch({ selection: { anchor: at } });
  view.focus();
  return { ok: true };
});
if (setup.error) {
  console.error(JSON.stringify(setup));
  process.exit(1);
}

const groupLine = () =>
  page.evaluate(() => window.__fluxView.state.doc.line(5).text);
const paneState = () =>
  page.evaluate(() => ({
    pane: !!document.querySelector(".cgp"),
    members: [...document.querySelectorAll(".cgp .row.member .who")].map((e) => e.textContent?.trim()),
    inputFocused: document.activeElement === document.querySelector(".cgp input"),
  }));

// --- Alt-C opens the group editor, members in SOURCE order (b before a) -----
await page.keyboard.down("Alt");
await page.keyboard.press("KeyC");
await page.keyboard.up("Alt");
await sleep(400);
const opened = await paneState();
const orderOk =
  opened.pane &&
  opened.members.length === 2 &&
  opened.members[0]?.startsWith("Authorb") &&
  opened.members[1]?.startsWith("Authora");

// --- Backspace removes the FIRST member (hl=0), order of the rest preserved --
await page.keyboard.press("Backspace");
await sleep(300);
const afterRemove = await paneState();
const lineAfterRemove = await groupLine();
const removeOk =
  afterRemove.members.length === 1 &&
  afterRemove.members[0]?.startsWith("Authora") &&
  lineAfterRemove.includes("[@refa]") &&
  !lineAfterRemove.includes("refb");

// --- type-to-search + Enter appends (order: existing first, new appended) ---
await page.keyboard.type("study of things");
await sleep(250);
await page.keyboard.press("ArrowDown"); // highlight moves into results
await sleep(100);
const addedKey = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".cgp .row:not(.member)")];
  const hl = rows.find((r) => r.classList.contains("hl"));
  return hl?.querySelector(".who")?.textContent?.trim() ?? null;
});
await page.keyboard.press("Enter");
await sleep(300);
const lineAfterAdd = await groupLine();
const addOk = /\[@refa; @ref[bcd]\]/.test(lineAfterAdd);

// --- removing every member deletes the group + the stray space --------------
// (addResult already cleared the query and re-homed the highlight to members.)
await page.keyboard.press("Backspace");
await sleep(200);
await page.keyboard.press("Backspace");
await sleep(300);
const lineAfterEmpty = await groupLine();
const emptyOk =
  lineAfterEmpty === "A claim citing two studies here." &&
  (await paneState()).pane; // pane stays open in insert mode

// --- dblclick on a cite chip opens the pane ---------------------------------
await page.keyboard.press("Escape"); // close pane, focus editor
await sleep(200);
await page.evaluate(async () => {
  const view = window.__fluxView;
  const line = view.state.doc.line(6);
  view.dispatch({
    changes: { from: line.from, insert: "New cite [@refc; @refd]. " },
    selection: { anchor: view.state.doc.line(1).from },
  });
  await new Promise((r) => requestAnimationFrame(r));
});
await sleep(200);
const chipBox = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".flux-cite")].pop();
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
let dblOk = false;
if (chipBox) {
  // A REAL double-click: two down/up pairs, the second with clickCount 2 —
  // that's what makes Chrome synthesize the dblclick event. (mouse.click with
  // {clickCount: 2} sends one pair and never fires dblclick.)
  await page.mouse.move(chipBox.x, chipBox.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await sleep(400);
  const s = await paneState();
  dblOk = s.pane && s.members.length === 2 && (s.members[0]?.startsWith("Authorc") ?? false);
}

// --- BibliographyView card follows the caret ---------------------------------
await page.keyboard.press("Escape");
await sleep(200);
const cardOk = await page.evaluate(async () => {
  // Summon the References pane; caret is already inside the [@refc; @refd] group.
  window.__fluxMargin.summon("bibliography");
  await new Promise((r) => setTimeout(r, 300));
  const chips = [...document.querySelectorAll(".grpcard .gchip")].map((e) => e.textContent ?? "");
  return chips.length === 2 && chips[0].includes("Authorc");
});

await shot(page, "citegroup-final");
const errs = realErrors(page);
await browser.close();

const res = { orderOk, removeOk, addedKey, addOk, emptyOk, dblOk, cardOk };
console.log(JSON.stringify({ citegroup: res, errs }, null, 2));
const ok = orderOk && removeOk && addOk && emptyOk && dblOk && cardOk && errs.length === 0;
if (!ok) {
  console.error("\nCITEGROUP VERIFY: FAIL");
  process.exit(1);
}
console.log("\nCITEGROUP VERIFY: PASS");

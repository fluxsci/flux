// Paper's artifacts in the GUI (dev server, the demo fixture): the Artifacts part of the Files
// rail, an artifact in the centre card in place of the document, its strip and page tabs, the
// rail's Outline reading the page's headings, the page staying where the reader is across a
// reload, the app's chords from inside a page, a comment made on a page (Annotate) naming the
// page, its view, its heading and the selected words, the palette, and the last artifact coming
// back with the project.
//
// The pages come from the dev server's artifact route (scripts/lib/artifactDevRoutes.mjs), which
// runs the app's own lister and file server over scripts/fixtures/artifacts. What only the real
// app can show (the flux-artifact: origin and process, the page policy, the watcher) is
// verify-artifacts-electron.cjs.
import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors, shot, sleep } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { perfBudget } from "./lib/perfBudget.mjs";
import { openAnnotation, fillNote, ledger } from "./lib/annotationFixture.mjs";

const h = harness("verify-paper-artifacts-gui");
const { browser, page } = await launch({ width: 1500, height: 950 });
const view = () => page.evaluate(() => { const v = document.querySelector(".aview"); return v ? { ...v.dataset } : null; });
const ready = (pageRel) => waitFor(page, (rel) => { const v = document.querySelector(".aview"); return v?.dataset.artifactReady === "true" && (!rel || v.dataset.artifactPage === rel); }, pageRel ?? null, { label: `artifact page ${pageRel ?? ""} ready`, timeout: 15000 });
const frame = () => page.frames().find((f) => f.url().includes("/__flux-dev/artifacts/serve/"));
const row = (title) => page.evaluate((t) => { const el = [...document.querySelectorAll("[data-artifact-row]")].find((e) => e.querySelector(".a-title")?.textContent === t); if (!el) throw new Error(`no artifact row "${t}"`); el.click(); }, title);
const outline = () => page.$$eval(".outline .oitem", (els) => els.map((e) => `${e.classList.contains("active") ? "*" : ""}${e.textContent.trim()}`));
const emit = (info) => page.evaluate((i) => window.__fluxEmitArtifactsChanged(i), info);

try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 1000 });
  await clickMode(page, "Paper");
  await waitFor(page, () => !!document.querySelector("[data-artifact-row]"), null, { label: "artifact rows", timeout: 15000 });

  h.section("the rail");
  const rail = await page.evaluate(() => {
    const scroll = document.querySelector(".dp-scroll");
    const heads = [...scroll.querySelectorAll(".dp-head .folder-label, .a-head .a-label")].map((e) => e.textContent.trim());
    const head = scroll.querySelector('[data-artifact-root="project"]');
    const list = head.nextElementSibling;
    return { heads, rows: [...list.querySelectorAll(".a-title, .a-name")].map((e) => e.textContent), pages: list.querySelector("[data-artifact-row] .a-pages")?.textContent,
      age: !!list.querySelector("[data-artifact-row] .a-age")?.textContent, ref: list.querySelector("[data-artifact-row]").title };
  });
  h.eq(rail.heads.slice(0, 3), ["Documents", "Context", "Artifacts"], "Artifacts is the third part of the Files rail, under Documents and Context");
  h.eq(rail.rows, ["Growth explorer", "reports", "Summary of the & first run"], "it lists the project's artifacts: an explorer, and a page inside a folder");
  h.ok(rail.pages === "2" && rail.age && rail.ref.split("\n")[0] === "scripts/fixtures/artifacts/explorer/index.html" && /^changed /.test(rail.ref.split("\n")[1]), "a row says how many pages, how fresh, and (as its tooltip) where the page is and when it changed");
  const listing = await page.evaluate(() => window.fig.artifactsList());
  const explorer = listing.roots[0].artifacts.find((a) => a.rel === "explorer");

  // The rail is one list to the keyboard: the walk goes on from Context into Artifacts, and a group folds on ←.
  await page.evaluate(() => [...document.querySelectorAll(".dp-scroll .dp-item:not([data-artifact-row])")].at(-1).focus());
  const walked = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press("ArrowDown"); walked.push(await page.evaluate(() => (document.activeElement.querySelector(".a-eyebrow, .a-name, .a-title")?.textContent ?? document.activeElement.textContent).trim())); }
  h.eq(walked, ["Artifacts", "Growth explorer", "reports", "Summary of the & first run"], "↓ walks from the last document into Artifacts, row by row");
  await page.keyboard.press("ArrowLeft");
  h.eq(await page.evaluate(() => document.activeElement.querySelector(".a-name")?.textContent), "reports", "← on a page steps out to its group");
  await page.keyboard.press("ArrowLeft");
  h.eq(await page.$$eval("[data-artifact-row] .a-title", (els) => els.map((e) => e.textContent)), ["Growth explorer"], "← on the group folds it");
  await page.keyboard.press("ArrowRight");
  h.eq(await page.$$eval("[data-artifact-row] .a-title", (els) => els.length), 2, "→ opens it again");

  h.section("an artifact in place of the document");
  h.ok(await page.evaluate(() => !document.querySelector(".aview") && !!document.querySelector(".dp-item.active:not([data-artifact-row])")), "Paper starts on the document");
  const t0 = Date.now();
  await row("Growth explorer");
  await ready("explorer/index.html");
  const opened = Date.now() - t0;
  const budget = perfBudget(1000);
  h.ok(opened < budget.ms, `opening an artifact is a navigation: ${opened} ms (< ${budget.text} ms)`);
  const shown = await page.evaluate(() => ({
    editor: getComputedStyle(document.querySelector(".editor-col")).display, cm: !!document.querySelector(".editor-col .cm-editor"), margin: !!document.querySelector(".dm-wrap"),
    active: [...document.querySelectorAll(".dp-item.active")].map((e) => e.dataset.artifactRow ? "artifact" : "document"),
    title: document.querySelector(".aview .title").textContent, tabs: [...document.querySelectorAll(".aview .page")].map((e) => `${e.classList.contains("on") ? "*" : ""}${e.textContent}`),
    sandbox: document.querySelector(".aview iframe").getAttribute("sandbox"), src: document.querySelector(".aview iframe").getAttribute("src"),
    card: (() => { const a = document.querySelector(".artifact-col").getBoundingClientRect(), w = document.querySelector(".work").getBoundingClientRect(), r = document.querySelector(".leftrail").getBoundingClientRect(); return { fills: w.right - a.right < 40, besideRail: a.left - r.right < 40 }; })(),
  }));
  h.ok(shown.editor === "none" && shown.cm, "the document's editor is hidden, still mounted");
  h.ok(!shown.margin && shown.card.fills && shown.card.besideRail, "the page takes the document's card and the margin's room");
  h.eq(shown.active, ["artifact"], "the rail marks the artifact, not the document");
  h.eq([shown.title, shown.tabs], ["Growth explorer", ["*index", "methods"]], "the strip names the page and offers the artifact's pages");
  h.ok(!/allow-same-origin|allow-top-navigation|allow-popups/.test(shown.sandbox) && /allow-scripts/.test(shown.sandbox), `on the dev server the page shares the app's site, so the frame is sandboxed into an origin of its own (${shown.sandbox})`);
  h.eq(shown.src, explorer.pages[0].url, "the frame loads the page's own address");
  h.eq(await frame().evaluate(() => [document.body.dataset.series, typeof window.fig, typeof window.__fluxArtifactBridge]), ["control", "undefined", "boolean"], "the page's scripts ran; it has the bridge and nothing of the app's");
  h.eq(await outline(), ["Growth under nutrient stress", "Curve", "Table", "Notes", "End"].map((t, i) => (i === 0 ? "*" : "") + t), "the rail's Outline reads the page's headings, the one in view marked");
  h.eq(await page.$eval(".outline .ohead", (e) => e.textContent), "Growth explorer", "under the page's title");
  await shot(page, "paper-artifact-open");

  h.section("where the reader is");
  await frame().select("#series", "stressed");
  await waitFor(page, () => document.querySelector(".aview")?.dataset.artifactView === "#s=stressed", null, { label: "the view reaches the strip" });
  h.eq(await page.$eval(".aview .viewchip", (e) => e.textContent), "#s=stressed", "the strip shows the page's own address: where in it the reader is");
  await page.evaluate(() => [...document.querySelectorAll(".outline .oitem")].find((e) => e.textContent.trim() === "End").click());
  await waitFor(page, () => document.querySelector(".outline .oitem.active")?.textContent.trim() === "End", null, { label: "the outline follows the page" });
  const scrolled = await frame().evaluate(() => Math.round(scrollY));
  h.ok(scrolled > 800, `a heading in the Outline scrolls the page to it (${scrolled} px), and the Outline follows`);

  h.section("following the files");
  await frame().evaluate(() => { window.__mark = 1; });
  await emit({ paths: [explorer.dir.replace(/explorer$/, "reports") + "/summary.html"], structure: false });
  await sleep(900); // a reload would come 500 ms after the change: its absence is the claim
  h.eq(await frame().evaluate(() => window.__mark), 1, "another artifact's files changing reloads nothing here");
  const loadKey = () => page.$eval(".aview", (e) => e.dataset.artifactLoad);
  const swapped = (before) => waitFor(page, (b) => { const v = document.querySelector(".aview"); return !!v && v.dataset.artifactLoad !== b && v.querySelectorAll("iframe").length === 1; }, before, { label: "the reloaded page takes the place of the one on screen", timeout: 8000 });
  let before = await loadKey();
  await emit({ paths: [explorer.dir + "/data.js"], structure: false });
  await waitFor(page, () => !!document.querySelector(".aview .key.pulse"), null, { label: "the follow key lights as the page reloads" });
  // The new page loads UNDER the one on screen: until it has answered and scrolled, the reader keeps the old one.
  await waitFor(page, () => document.querySelectorAll(".aview iframe").length === 2 || document.querySelector(".aview")?.dataset.artifactLoad !== "1", null, { label: "the reload is under way" });
  await swapped(before);
  const landed = await frame().evaluate(() => [typeof window.__mark, document.body.dataset.series, Math.round(scrollY)]);
  h.eq(landed.slice(0, 2), ["undefined", "stressed"], "a file of this artifact changing reloads the page: a fresh page, on the same view");
  h.ok(Math.abs(landed[2] - scrolled) <= 4, `it takes the old page's place already scrolled to where the reader was (${landed[2]} vs ${scrolled} px): no blink, no jump`);
  h.eq([(await view()).artifactView, (await outline()).find((t) => t.startsWith("*"))], ["#s=stressed", "*End"], "the strip and the Outline still say where the reader is");
  // Held still: the change is noted, the page stays.
  await page.click('.aview .key[aria-label="Follow changes on disk"]');
  await frame().evaluate(() => { window.__mark = 2; });
  await emit({ paths: [explorer.dir + "/app.js"], structure: false });
  await waitFor(page, () => !!document.querySelector(".aview .key.due"), null, { label: "the reload key says the files changed" });
  h.eq(await frame().evaluate(() => window.__mark), 2, "held still, the page does not reload; the reload key says the files changed");
  before = await loadKey();
  await page.click('.aview .key[aria-label="Reload the page"]');
  await swapped(before);
  h.ok(await page.evaluate(() => !document.querySelector(".aview .key.due")), "after a reload by hand the key is quiet again");
  h.eq(await frame().evaluate(() => typeof window.__mark), "undefined", "the reload key reads the page again");
  await page.click('.aview .key[aria-label="Follow changes on disk"]');

  h.section("pages, links and keys");
  await frame().click("#to-methods");
  await ready("explorer/methods.html");
  h.eq([await page.$$eval(".aview .page", (els) => els.map((e) => `${e.classList.contains("on") ? "*" : ""}${e.textContent}`)), await outline()], [["index", "*methods"], ["*Methods", "Measurement"]], "a link inside the artifact moves the page tab and the Outline");
  await page.evaluate(() => [...document.querySelectorAll(".aview .page")].find((e) => e.textContent === "index").click());
  await ready("explorer/index.html");
  h.ok((await outline()).includes("Curve"), "a page tab opens that page");
  await frame().click("h1");
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyO"); await page.keyboard.up("Alt");
  await waitFor(page, () => !document.querySelector(".leftrail"), null, { label: "Alt+O from inside the page folds the rail" });
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyO"); await page.keyboard.up("Alt");
  await waitFor(page, () => !!document.querySelector(".leftrail"), null, { label: "Alt+O again opens it" });
  h.ok(true, "with the keyboard in the page, Paper's chord (Alt+O) still folds and opens the rail");
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyE"); await page.keyboard.up("Alt");
  await sleep(300); // an export dialog would open within a frame or two: its absence is the claim
  h.ok(await page.evaluate(() => !document.querySelector('[role="dialog"]')), "a chord that acts on the document (Export, Alt+E) does nothing while a page is showing");

  h.section("a comment on a page");
  await frame().select("#series", "stressed");
  await frame().evaluate(() => { const p = document.getElementById("lede"), r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await sleep(350); // the page reports a selection 150 ms after it settles
  await openAnnotation(page);
  const chips = await page.$eval(".target-chips", (e) => e.textContent);
  h.ok(chips.includes("Pick a series") && chips.includes("Growth explorer"), `Annotate, opened over a page, is about the selected words in that page (${chips.trim().slice(0, 90)})`);
  await fillNote(page, "Is the plateau real?");
  await page.$eval("[data-annotation-surface] button.primary", (b) => b.click());
  await waitFor(page, () => !document.querySelector("[data-annotation-surface]"), null, { label: "the note is saved" });
  const note = (await ledger(page)).filter((e) => e.kind === "note").at(-1);
  const target = note?.context?.targets?.[0];
  h.eq([target?.kind, target?.path, target?.view, target?.title, target?.quote?.slice(0, 13)], ["artifact", "scripts/fixtures/artifacts/explorer/index.html", "#s=stressed", "Growth explorer", "Pick a series"], "the saved note names the page, the view, and the words");
  h.eq([note?.context?.surface, note?.context?.artifact?.path, note?.context?.doc ?? null], ["paper", "scripts/fixtures/artifacts/explorer/index.html", null], "and its stamp is the artifact, not the hidden document");

  h.section("comments on the page");
  const ds = () => page.$eval(".aview", (e) => ({ ...e.dataset }));
  const counts = (open, found) => waitFor(page, ([o, f]) => { const d = document.querySelector(".aview")?.dataset; return d?.artifactComments === String(o) && d?.artifactFound === String(f); }, [open, found], { label: `${open} open comments, ${found} marked on the page`, timeout: 8000 });
  const marked = () => frame().evaluate(() => [...(CSS.highlights.get("flux-comment") ?? []), ...(CSS.highlights.get("flux-comment-on") ?? [])].map((r) => r.toString().replace(/\s+/g, " ")).sort());
  const selectOnly = (selector, words) => frame().evaluate(([sel, w]) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(w)); el.scrollIntoView({ block: "center" }); const t = [...el.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.includes(w)), at = t.nodeValue.indexOf(w), r = document.createRange(); r.setStart(t, at); r.setEnd(t, at + w.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, [selector, words]);
  // The page reports a selection 150 ms after it settles: the Comment key is for THESE words once it says so.
  const selectWords = async (selector, words) => { await selectOnly(selector, words); await waitFor(page, (w) => document.querySelector(".sel-bubble")?.dataset.selected === w, words, { label: `the Comment key on "${words}"` }); };
  const pointIn = async (fn, arg) => { const at = await frame().evaluate(fn, arg), box = await (await page.$(".aview iframe")).boundingBox(); return { x: box.x + at.x, y: box.y + at.y }; };
  const notes = async () => (await ledger(page)).filter((e) => e.kind === "note");
  const agent = (events) => page.evaluate(async (list) => { const f = window.__flux, p = f.get(f.shell.currentProject).path + "/.meta/feedback.ndjson", s = { id: "heron", name: "heron", client: "claude" }; await window.fig.feedbackAppend(p, list.map((e) => JSON.stringify({ ts: new Date().toISOString(), client: "claude", session: s, ...e }) + "\n").join("")); window.fig._emitFsChange({ subsystem: "feedback", path: p }); }, events);
  // The note just made with Annotate named selected words: it is a comment on those words, and the page shows it.
  await counts(1, 1);
  h.ok((await marked())[0].startsWith("Pick a series; the page keeps"), "a note made with Annotate over selected words is marked on those words in the page");
  // Select other words: one key appears on them; it opens a card to write in, on the words.
  await selectWords("main p", "plateaus by 18 h");
  await page.waitForSelector(".sel-bubble button");
  const bubble = await (await page.$(".sel-bubble button")).boundingBox();
  await page.mouse.click(bubble.x + bubble.width / 2, bubble.y + bubble.height / 2);
  await page.waitForSelector('[data-artifact-card="draft"] textarea');
  await waitFor(page, () => document.activeElement === document.querySelector('[data-artifact-card="draft"] textarea'), null, { label: "the new comment has the keyboard" });
  h.eq(await page.$eval('[data-artifact-card="draft"] .about', (e) => e.textContent.replace(/\s+/g, " ").trim()), "New comment on plateaus by 18 h", "the Comment key on selected words opens a card to write in, saying what it is on");
  h.ok(!(await page.$(".sel-bubble")) && (await marked()).includes("plateaus by 18 h"), "while it is written the words stay marked and the key is gone");
  await page.keyboard.type("Is the plateau real, or the assay's ceiling?");
  await page.keyboard.down("Control"); await page.keyboard.press("Enter"); await page.keyboard.up("Control");
  await counts(2, 2);
  let made = (await notes()).at(-1);
  h.eq([made.text, made.context.targets[0].kind, made.context.targets[0].quote, made.context.targets[0].heading, made.context.targets[0].view, made.context.artifact.path],
    ["Is the plateau real, or the assay's ceiling?", "artifact", "plateaus by 18 h", "Notes", "#s=stressed", "scripts/fixtures/artifacts/explorer/index.html"],
    "Ctrl+Enter saves it to the Inbox as a note on the page, the view, the heading and the words");
  h.ok(/Thecontrolseries$/.test(made.context.targets[0].prefix) && /^\.Thestressedseries/.test(made.context.targets[0].suffix), `with the words around them, to find them again (${made.context.targets[0].prefix} | ${made.context.targets[0].suffix})`);
  h.ok(made.context.snapshot?.image === `.meta/feedback/${made.id}.png` && made.context.snapshot.marks.length === 1 && made.context.snapshot.marks[0].kind === "box", "and a picture of the page as it was, the words boxed");
  h.eq(await page.evaluate(async (rel) => { const f = window.__flux; const b = new Uint8Array(await window.fig.readFile(f.get(f.shell.currentProject).path + "/" + rel)); return [b[0], b[1], b[2], b[3]]; }, made.context.snapshot.image), [137, 80, 78, 71], "the picture is a PNG beside the ledger");
  h.ok((await marked()).includes("plateaus by 18 h") && !(await page.$('[data-artifact-card="draft"]')), "the page keeps the words marked; the card is gone");
  // The pointer resting on the marked words opens the thread on them; a press keeps it open.
  const onWords = () => pointIn(() => { const r = [...CSS.highlights.get("flux-comment")].find((x) => x.toString() === "plateaus by 18 h").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  let at = await onWords();
  await page.mouse.move(at.x - 4, at.y); await page.mouse.move(at.x, at.y);
  await page.waitForSelector(`[data-artifact-card="${made.id}"].ready`);
  h.eq(await page.$eval(`[data-artifact-card="${made.id}"]`, (e) => [e.classList.contains("pinned"), e.querySelector(".mtext").textContent, e.querySelector(".status").textContent]), [false, "Is the plateau real, or the assay's ceiling?", "Open"], "the pointer resting on marked words opens their thread in a card: the comment, and where it stands");
  await page.mouse.click(at.x, at.y);
  await waitFor(page, (id) => document.querySelector(`[data-artifact-card="${id}"]`)?.classList.contains("pinned"), made.id, { label: "a press keeps the card open" });
  // An agent takes it, and answers with a link into the page.
  await agent([{ kind: "claim", target: made.id }, { kind: "reply", target: made.id, id: "r-heron", author: { kind: "agent", name: "heron" }, text: "It is a ceiling: see [the control series](#s=control) and [the method](methods.html)." }]);
  await waitFor(page, (id) => document.querySelector(`[data-artifact-card="${id}"] .status`)?.textContent === "Claimed by heron" && document.querySelectorAll(`[data-artifact-card="${id}"] .viewlink`).length === 2, made.id, { label: "the agent's claim and answer reach the open card" });
  h.eq(await page.$eval(`[data-artifact-card="${made.id}"]`, (e) => [...e.querySelectorAll(".msg")].map((m) => `${m.classList.contains("agent") ? "agent" : "you"}:${m.querySelector(".who").textContent}`)), ["you:You", "agent:heron"], "an agent's claim and answer appear in the open card as they are written, links into the page as buttons");
  await page.$eval(`[data-artifact-card="${made.id}"] .acts button`, (b) => b.click());
  await page.waitForSelector(`[data-artifact-card="${made.id}"] textarea[aria-label="Reply"]`);
  await page.keyboard.type("Then say so in the caption.");
  await page.keyboard.down("Control"); await page.keyboard.press("Enter"); await page.keyboard.up("Control");
  await waitFor(page, (id) => document.querySelectorAll(`[data-artifact-card="${id}"] .msg`).length === 3, made.id, { label: "the reply is in the thread" });
  h.eq((await ledger(page)).filter((e) => e.kind === "reply" && e.target === made.id).map((e) => e.author.kind), ["agent", "human"], "a reply written in the card is an Inbox reply on the same item");
  before = await loadKey();
  await page.$eval(`[data-artifact-card="${made.id}"] .viewlink`, (b) => b.click());
  await swapped(before);
  await waitFor(page, () => document.querySelector(".aview")?.dataset.artifactView === "#s=control", null, { label: "the link's view" });
  await counts(2, 2);
  h.eq(await frame().evaluate(() => document.body.dataset.series), "control", "a link in an answer takes the page to that view, and the comments are found on it again");
  // A plot has no words to select: the strip's key, then a press on the plot.
  await page.click('.aview .key[aria-label="Comment on a part of the page"]');
  await waitFor(page, () => document.querySelector('.aview .key[aria-label="Comment on a part of the page"]')?.getAttribute("aria-pressed") === "true", null, { label: "picking" });
  at = await pointIn(() => { const el = document.getElementById("curve"); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(at.x - 4, at.y); await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  await page.waitForSelector('[data-artifact-card="draft"] textarea');
  h.eq(await page.$eval('[data-artifact-card="draft"] .about', (e) => e.textContent.replace(/\s+/g, " ").trim()), 'New comment on figure "Growth curve"', "the strip's key, then a press on a plot, starts a comment on the plot");
  await page.keyboard.type("Draw both series here.");
  await page.keyboard.down("Control"); await page.keyboard.press("Enter"); await page.keyboard.up("Control");
  await counts(3, 3);
  made = (await notes()).at(-1);
  h.eq([made.context.targets[0].element, made.context.targets[0].heading, made.context.targets[0].quote ?? null], [{ selector: "#curve", tag: "svg", what: "figure", label: "Growth curve" }, "Curve", null], "it names the element: its path, what it is and what it is called");
  // Ctrl+Alt+M, pressed in the page with words selected, is the Comment key.
  await frame().click("h1"); // the keyboard is in the page, as it is after selecting with the mouse
  await selectWords("main p", "keeps rising");
  await page.keyboard.down("Control"); await page.keyboard.down("Alt"); await page.keyboard.press("KeyM"); await page.keyboard.up("Alt"); await page.keyboard.up("Control");
  await page.waitForSelector('[data-artifact-card="draft"] textarea');
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector('[data-artifact-card="draft"]'), null, { label: "Escape drops the draft" });
  h.eq((await notes()).length, 3, "Ctrl+Alt+M on a selection in the page starts a comment; Escape drops it and nothing is saved");
  // The comments beside the page (Alt+A, also from inside the page).
  await frame().click("h1");
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyA"); await page.keyboard.up("Alt");
  await page.waitForSelector(".arail");
  const railRows = () => page.$$eval(".arail [data-rail-thread]", (els) => els.map((e) => `${e.querySelector(".about").textContent.replace(/\s+/g, " ").trim()} [${e.querySelector(".status")?.textContent ?? ""}]${e.classList.contains("done") ? " done" : ""}`));
  h.eq([await page.$eval(".arail .count", (e) => e.textContent), (await railRows()).length, await page.$eval('.aview .key[aria-label="Comments on this artifact"] .n', (e) => e.textContent)], ["3 open", 3, "3"], "Alt+A, pressed in the page, opens the comments beside it; the strip's key counts the open ones");
  h.ok((await railRows()).some((t) => t === "On plateaus by 18 h [Claimed by heron]") && (await railRows()).some((t) => t === 'On figure "Growth curve" [Open]'), `each thread says what it is on and where it stands (${(await railRows()).join(" · ")})`);
  await counts(3, 3);
  // The agent resolves one: it leaves the page's marks and folds under Resolved.
  const claimed = (await notes()).at(-2).id;
  await agent([{ kind: "resolve", target: claimed, note: "Caption now says it is a ceiling.", author: { kind: "agent", name: "heron" } }]);
  await counts(2, 2);
  h.ok(!(await marked()).includes("plateaus by 18 h") && await page.$eval(".arail .fold", (e) => e.textContent.replace(/\s+/g, " ").trim()) === "Resolved 1", "a comment an agent resolves leaves the page's marks and folds under Resolved");
  // You resolve one yourself; and take one back.
  await page.evaluate((id) => [...document.querySelectorAll(`.arail [data-rail-thread="${id}"] .acts button`)].find((b) => b.textContent === "Resolve").click(), made.id);
  await counts(1, 1);
  h.eq((await ledger(page)).filter((e) => e.kind === "resolve").map((e) => e.author?.kind), ["agent", "human"], "Resolve in the rail closes your own comment in the Inbox");
  // On another page of the artifact the comments say where they are, and take you there.
  await page.evaluate(() => [...document.querySelectorAll(".aview .page")].find((e) => e.textContent === "methods").click());
  await ready("explorer/methods.html");
  await waitFor(page, () => document.querySelector(".arail [data-rail-thread] .where")?.dataset.where === "other-page", null, { label: "the thread says it is on another page" });
  h.eq(await page.$eval(".arail [data-rail-thread] .where", (e) => e.textContent.replace(/\s+/g, " ").trim()), "on the page index", "on another page of the artifact a thread says which page it is on");
  await page.$eval(".arail [data-rail-thread] .where button", (b) => b.click());
  await ready("explorer/index.html");
  await page.waitForSelector(".artifact-card.ready.pinned");
  h.ok((await ds()).artifactFound === "1" && await page.$eval(".artifact-card.pinned .about", (e) => e.textContent.includes("Pick a series")), "its link goes to that page and opens the thread on its words");
  await page.$eval(".artifact-card.pinned .acts .del", (b) => b.click());
  await counts(0, 0);
  h.ok((await ledger(page)).some((e) => e.kind === "withdraw") && (await marked()).length === 0 && !(await page.$(".artifact-card")), "Delete takes your comment back: withdrawn in the Inbox, gone from the page");
  // The files change under the page: the reloaded copy marks the comments again.
  await selectWords("main p", "keeps rising");
  await page.waitForSelector(".sel-bubble button");
  await page.$eval(".sel-bubble button", (b) => b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
  await page.waitForSelector('[data-artifact-card="draft"] textarea');
  await page.keyboard.type("Compare with the second run.");
  await page.keyboard.down("Control"); await page.keyboard.press("Enter"); await page.keyboard.up("Control");
  await counts(1, 1);
  before = await loadKey();
  await emit({ paths: [explorer.dir + "/data.js"], structure: false });
  await swapped(before);
  await counts(1, 1);
  h.eq(await marked(), ["keeps rising"], "after the page is reloaded from disk its comments are marked again");
  await page.click(".arail .x");
  await waitFor(page, () => !document.querySelector(".arail"), null, { label: "rail closed" });

  h.section("the palette, the filter, and back");
  await page.keyboard.down("Control"); await page.keyboard.press("KeyK"); await page.keyboard.up("Control");
  await page.waitForSelector(".cp input");
  await page.type(".cp input", "artifact: summary");
  await waitFor(page, () => document.querySelector(".cp li.sel .ct")?.textContent === "Open artifact: Summary of the & first run", null, { label: "the palette offers the artifact" });
  await page.keyboard.press("Enter");
  await ready("reports/summary.html");
  // The palette fades out over ~110 ms and its backdrop takes clicks until it is gone; a page in one
  // file can answer sooner than that, and a click on the strip then lands on the backdrop.
  await waitFor(page, () => !document.querySelector(".cp-scrim, .cp"), null, { label: "the palette is gone" });
  h.eq([await page.$eval(".aview .title", (e) => e.textContent), await page.$$eval(".aview .page", (els) => els.length), await frame().evaluate(() => document.getElementById("inline").dataset.ran)],
    ["Summary of the & first run", 0, "yes"], "the palette opens an artifact; a page in one file (inline style and script) runs, and has no page tabs");
  await page.focus('[aria-label="Filter documents"]');
  await page.keyboard.type("explorer");
  await waitFor(page, () => !!document.querySelector(".a-head.flat"), null, { label: "the filter reaches artifacts" });
  h.eq(await page.$$eval("[data-artifact-row] .a-title", (els) => els.map((e) => e.textContent)), ["Growth explorer"], "the rail's filter finds artifacts by title or folder");
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".a-head.flat"), null, { label: "the filter is cleared" });
  await page.click(".aview .key.close");
  await waitFor(page, () => !document.querySelector(".aview") && getComputedStyle(document.querySelector(".editor-col")).display !== "none", null, { label: "back on the document" });
  h.ok(await page.evaluate(() => document.activeElement?.closest(".cm-editor") !== null && !!document.querySelector(".dm-wrap") && !!document.querySelector(".dp-item.active:not([data-artifact-row])")), "the close key returns to the document: editor focused, margin back, the document marked in the rail");
  h.ok(await page.evaluate(() => window.__fluxView.state.doc.toString().includes("Mycelial extension increased")), "the document is as it was: never reloaded");
  // Alt+H: the document and the artifact last shown, either way round, from the editor and from inside the page.
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyH"); await page.keyboard.up("Alt");
  await ready("reports/summary.html");
  h.ok(true, "Alt+H in the document shows the artifact last open");
  await frame().click("h1");
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyH"); await page.keyboard.up("Alt");
  await waitFor(page, () => !document.querySelector(".aview") && document.activeElement?.closest(".cm-editor") !== null, null, { label: "Alt+H from inside the page returns to the document" });
  h.ok(true, "Alt+H pressed in the page goes back to the document");
  await row("Growth explorer");
  await ready("explorer/index.html");
  await page.evaluate(() => [...document.querySelectorAll(".dp-item:not([data-artifact-row])")].find((e) => e.textContent.includes("Supplementary")).click());
  await waitFor(page, () => !document.querySelector(".aview") && document.querySelector(".dp-item.active")?.textContent.includes("Supplementary"), null, { label: "a document row leaves the artifact" });
  h.ok(true, "choosing a document in the rail leaves the artifact for that document");
  await row("Growth explorer");
  await ready("explorer/index.html");
  await frame().select("#series", "stressed");
  await waitFor(page, () => document.querySelector(".aview")?.dataset.artifactView === "#s=stressed", null, { label: "a view to come back to" });
  await page.click(".aview .key.close");
  await waitFor(page, () => !document.querySelector(".aview"), null, { label: "closed" });
  await row("Growth explorer");
  await ready("explorer/index.html");
  h.eq([(await view()).artifactView, await frame().evaluate(() => document.body.dataset.series)], ["#s=stressed", "stressed"], "reopening the artifact last shown from the rail comes back to the view it was on");

  h.section("the last artifact comes back with the project");
  await row("Growth explorer");
  await ready("explorer/index.html");
  await frame().select("#series", "stressed");
  await waitFor(page, () => document.querySelector(".aview")?.dataset.artifactView === "#s=stressed", null, { label: "view before leaving" });
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 1000 });
  await clickMode(page, "Paper");
  await ready("explorer/index.html");
  h.eq([(await view()).artifactView, await frame().evaluate(() => document.body.dataset.series)], ["#s=stressed", "stressed"], "reopening the project shows the artifact that was open, on the view it was on");
  await page.click(".aview .key.close");
  await waitFor(page, () => !document.querySelector(".aview"), null, { label: "closed" });
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 1000 });
  await clickMode(page, "Paper");
  await waitFor(page, () => !!document.querySelector("[data-artifact-row]"), null, { label: "artifact rows again", timeout: 15000 });
  await sleep(400); // a restore would mount the view right after the rows: its absence is the claim
  h.ok(await page.evaluate(() => !document.querySelector(".aview")), "a project left on its document reopens on its document");

  h.ok(realErrors(page).length === 0, `clean browser console: ${realErrors(page).join(" | ")}`);
} catch (e) {
  h.fail(`${e?.stack || e}`);
  await shot(page, "paper-artifacts-failure").catch(() => {});
}
await h.done(() => browser.close());

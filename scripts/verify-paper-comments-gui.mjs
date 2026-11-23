// Paper comments, end to end (owner request 2026-11-18): commented text wears its own colour
// (blue unless Settings or a tag says otherwise); resting the pointer on it opens the thread in
// a card right there, where it can be answered, edited, tagged, resolved, deleted, or opened in
// the margin's Comments pane; a comment is yours alone unless it is sent to the AI Inbox, which
// has its own button (the Flux AI mark) and chord; tags do not exist until you make one, then
// colour their comments and filter the pane.
//   Run (dev server must be up): node scripts/verify-paper-comments-gui.mjs
import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors, shot, sleep, setDoc } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-paper-comments-gui");
const { browser, page } = await launch();
const ROOT = "/demo/myc-growth-paper";
const SIDECAR = `${ROOT}/manuscript/comments.json`;
const BLUE = [67, 133, 190]; // #4385be, the default
const ORANGE = [188, 82, 21]; // #bc5215, the first tag colour

try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 1000 });
  await clickMode(page, "Paper");
  await waitFor(page, () => !!window.__fluxView, null, { timeout: 10000 });
  // The second passage sits in a line with markup: the editor redraws such a line when the caret
  // arrives in it, which is exactly when a click on commented text has to keep working.
  const TEXT = ["# Notes", "", "Alpha sentence one is here for a private note.", "", "- **Bravo** sentence two is *here* for the [agent](https://example.org).", "", "Charlie sentence three is spare.", ""].join("\n");
  await setDoc(page, TEXT);
  await sleep(400);

  // ---- helpers ------------------------------------------------------------------------
  const sidecar = async () => {
    const text = await page.evaluate(async (p) => ((await window.fig.exists(p)) ? window.fig.readText(p) : ""), SIDECAR);
    return text ? JSON.parse(text).threads : [];
  };
  const saved = (test, label) => waitFor(page, async ([p, src]) => {
    if (!(await window.fig.exists(p))) return false;
    // eslint-disable-next-line no-new-func
    return new Function("threads", `return (${src})(threads)`)(JSON.parse(await window.fig.readText(p)).threads);
  }, [SIDECAR, test.toString()], { timeout: 6000, label });
  const selectWord = (needle, length = needle.length) => page.evaluate(([n, len]) => {
    const view = window.__fluxView, at = view.state.doc.toString().indexOf(n);
    view.dispatch({ selection: { anchor: at, head: at + len } });
    view.focus();
  }, [needle, length]);
  const dragOver = async (needle) => {
    const box = await page.evaluate((n) => {
      const view = window.__fluxView, at = view.state.doc.toString().indexOf(n);
      const a = view.coordsAtPos(at), b = view.coordsAtPos(at + n.length);
      return { x1: a.left + 1, x2: b.left - 1, y: (a.top + a.bottom) / 2 };
    }, needle);
    await page.mouse.move(box.x1, box.y); await page.mouse.down();
    await page.mouse.move((box.x1 + box.x2) / 2, box.y, { steps: 4 }); await page.mouse.move(box.x2, box.y, { steps: 4 });
    await page.mouse.up();
    await waitFor(page, () => !!document.querySelector(".bubble"), null, { timeout: 4000, label: "selection bubble" });
  };
  const card = () => page.evaluate(() => {
    const c = document.querySelector("[data-comment-card]");
    if (!c) return null;
    const text = (s) => c.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() ?? null;
    return {
      id: c.dataset.commentCard, pinned: c.classList.contains("pinned"), focus: document.activeElement?.getAttribute("aria-label") ?? null,
      inCard: c.contains(document.activeElement), dest: text(".dest"), send: text(".send"), about: text(".about q"),
      tags: [...c.querySelectorAll(".tag")].map((t) => t.dataset.tag), add: text(".add"), menu: !!c.querySelector(".menu"),
      msgs: [...c.querySelectorAll(".mtext")].map((m) => m.textContent), when: [...c.querySelectorAll(".when")].map((m) => m.textContent.trim()),
      acts: [...c.querySelectorAll(".acts button")].map((b) => b.textContent.trim()),
      rows: new Set([...c.querySelectorAll(".acts button")].map((b) => Math.round(b.getBoundingClientRect().top))).size,
    };
  });
  const cardOpen = (id) => waitFor(page, (want) => { const c = document.querySelector("[data-comment-card].ready"); return !!c && (!want || c.dataset.commentCard === want); }, id ?? null, { timeout: 4000, label: "comment card" });
  const cardGone = () => waitFor(page, () => !document.querySelector("[data-comment-card]"), null, { timeout: 4000, label: "comment card gone" });
  const marks = () => page.evaluate(() => [...document.querySelectorAll(".cm-comment-hl")].map((e) => {
    const m = getComputedStyle(e).backgroundColor.match(/[\d.]+/g).map(Number);
    // rgb()/rgba() carry 0-255 channels, color(srgb …) carries 0-1.
    const rgb = getComputedStyle(e).backgroundColor.startsWith("color(") ? m.slice(0, 3).map((v) => Math.round(v * 255)) : m.slice(0, 3);
    return { id: e.dataset.cid, text: e.textContent, rgb, alpha: m[3] ?? 1, active: e.classList.contains("active") };
  }));
  const markPoint = (id) => page.evaluate((id) => { const r = document.querySelector(`.cm-comment-hl[data-cid="${id}"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, id);
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
  const type = (text) => page.keyboard.type(text, { delay: 5 });
  const chord = async (keys, key) => { for (const k of keys) await page.keyboard.down(k); await page.keyboard.press(key); for (const k of [...keys].reverse()) await page.keyboard.up(k); };
  const inboxIds = () => page.evaluate(async () => {
    // What the Inbox panel lists as open: its own store, its own filter.
    const m = await import("/src/shell/inbox/inboxStore.ts"), { filterInbox } = await import("/src/lib/project/inbox.ts");
    const release = m.retainInbox();
    await m.refreshInbox();
    let items = [];
    m.inboxItems.subscribe((v) => (items = v))();
    release();
    return filterInbox(items, {}).map((i) => i.id);
  });
  const settings = (name) => page.evaluate(async (name) => { const m = await import("/src/lib/settings.ts"); let v; m.settings.subscribe((s) => (v = s[name]))(); return v; }, name);
  const park = () => page.mouse.move(40, 860); // the pointer, away from text and cards
  const clickIn = (scope, selector) => page.evaluate(([scope, selector]) => { const el = document.querySelector(scope)?.querySelector(selector); if (!el) throw new Error(`missing ${scope} ${selector}`); el.click(); }, [scope, selector]);
  const clickAct = (scope, label) => page.evaluate(([scope, label]) => { const b = [...document.querySelectorAll(`${scope} .acts button`)].find((x) => x.textContent.trim() === label); if (!b) throw new Error(`no action ${label}`); b.click(); }, [scope, label]);

  // ---- the two ways in ----------------------------------------------------------------
  h.section("the selection toolbar: a note for yourself, or a comment for Flux AI");
  h.eq(await settings("paperCommentTags"), [], "there are no tags until you make one");
  h.eq(await page.evaluate(() => document.querySelector("section.paper").style.getPropertyValue("--c-comment-hl")), "#4385be", "the highlight colour is blue by default, carried on the Paper root");
  await dragOver("sentence one");
  const bubble = await page.evaluate(() => {
    const own = document.querySelector('.bubble button[aria-label="Comment"]'), ai = document.querySelector('.bubble button[aria-label="Comment for Flux AI"]');
    const mark = ai?.querySelector(".flux-ai-mark");
    return { own: !!own, ai: !!ai, mark: !!mark, still: !!mark && mark.classList.contains("still"), order: !!own && !!ai && !!(own.compareDocumentPosition(ai) & Node.DOCUMENT_POSITION_FOLLOWING), aiTitle: ai?.title ?? "" };
  });
  h.ok(bubble.own && bubble.ai && bubble.order, "the toolbar offers Comment, then Comment for Flux AI");
  h.ok(bubble.mark && bubble.still, "the Flux AI button is the Flux AI mark, at rest (nothing in a toolbar animates)");
  h.ok(/AI Inbox/.test(bubble.aiTitle), "its tooltip says where the comment goes");

  h.section("a new comment is written on its text");
  await page.click('.bubble button[aria-label="Comment"]');
  await cardOpen();
  await waitFor(page, () => document.activeElement?.getAttribute("aria-label") === "New comment", null, { timeout: 3000, label: "composer focus" });
  let c = await card();
  h.ok(c.pinned && c.focus === "New comment", "the card opens at the selection and takes the keyboard");
  h.eq([c.dest, c.send], ["Just for me", "Comment"], "a plain comment is yours alone");
  h.eq(c.about, "sentence one", "it says what it is about");
  h.eq([c.tags, c.add], [[], "+ tag"], "no tags are offered or attached by default");
  h.ok(!(await page.$('[data-pane-id="comments"]')), "the margin's pane is not summoned to write a comment");
  h.eq((await marks()).map((m) => m.text), ["sentence one"], "its text is marked while you write");
  h.eq(await sidecar(), [], "an unsent comment is not saved");

  await type("Is this the right word?");
  // A tag made while drafting: the menu keeps the keyboard (attaching one used to steal it back).
  await clickIn("[data-comment-card]", ".add");
  await waitFor(page, () => document.activeElement?.getAttribute("aria-label") === "Tag name", null, { timeout: 3000, label: "tag field focus" });
  await type("Needs Reference");
  const offered = await page.evaluate(() => { const c = document.querySelector("[data-comment-card]"), m = c.querySelector(".menu"); const cr = c.getBoundingClientRect(), mr = m.getBoundingClientRect(); return { rows: [...m.querySelectorAll(".row")].map((r) => r.textContent.replace(/\s+/g, " ").trim()), inside: mr.bottom <= cr.bottom + 1 && mr.top >= cr.top && mr.right <= cr.right + 1 }; });
  h.eq(offered.rows, ["+New tag #needs-reference"], "a new name is offered as a new tag, in its stored form");
  h.ok(offered.inside, "the tag menu opens inside the card (nothing cuts it off)");
  await page.keyboard.press("Enter");
  await waitFor(page, () => document.querySelector("[data-comment-card] .tag")?.dataset.tag === "needs-reference", null, { timeout: 3000, label: "tag attached" });
  c = await card();
  h.ok(c.menu && c.focus === "Tag name", "after attaching, the tag menu still has the keyboard");
  h.eq(await settings("paperCommentTags"), ["needs-reference=#bc5215"], "the new tag joins your list in Settings with the first palette colour");
  await page.keyboard.press("Escape");
  await sleep(120);
  c = await card();
  h.ok(c && !c.menu && c.inCard, "Escape closes the tag menu only; the card stays");
  await clickIn("[data-comment-card]", 'textarea[aria-label="New comment"]');
  await page.focus('[data-comment-card] textarea[aria-label="New comment"]');
  await chord(["Control"], "Enter");
  await cardGone();
  await saved((threads) => threads.length === 1 && threads[0].messages.length === 1, "first comment saved");
  let threads = await sidecar();
  const first = threads[0].id;
  h.eq([threads[0].inbox, threads[0].tags, threads[0].messages[0].body, threads[0].messages[0].kind, "draft" in threads[0]], [false, ["needs-reference"], "Is this the right word?", "human", false], "Ctrl+Enter sends it: saved as a private comment with its tag");
  h.ok(!(await inboxIds()).includes(first), "a comment kept to yourself is not in the AI Inbox");

  // ---- colour ---------------------------------------------------------------------------
  h.section("commented text has its own colour");
  await selectWord("# Notes", 0); await park(); await sleep(150);
  let m = (await marks())[0];
  h.ok(near(m.rgb, ORANGE) && m.alpha > 0.1 && m.alpha < 0.5, `a tagged comment wears its tag's colour as a tint (${m.rgb} @ ${m.alpha})`);
  await page.evaluate(async () => { const s = await import("/src/lib/settings.ts"); s.settings.update((v) => ({ ...v, paperCommentTags: ["needs-reference"] })); });
  await waitFor(page, ([id, want]) => { const e = document.querySelector(`.cm-comment-hl[data-cid="${id}"]`); const v = getComputedStyle(e).backgroundColor.match(/[\d.]+/g).map(Number); const rgb = getComputedStyle(e).backgroundColor.startsWith("color(") ? v.slice(0, 3).map((x) => Math.round(x * 255)) : v.slice(0, 3); return rgb.every((x, i) => Math.abs(x - want[i]) <= 2); }, [first, BLUE], { timeout: 3000, label: "default colour" });
  h.ok(true, "a tag with no colour of its own leaves the comment the default blue");
  await page.evaluate(async () => { const s = await import("/src/lib/settings.ts"); s.settings.update((v) => ({ ...v, paperCommentColor: "#66800b" })); });
  await waitFor(page, (id) => { const e = document.querySelector(`.cm-comment-hl[data-cid="${id}"]`); const v = getComputedStyle(e).backgroundColor.match(/[\d.]+/g).map(Number); const rgb = getComputedStyle(e).backgroundColor.startsWith("color(") ? v.slice(0, 3).map((x) => Math.round(x * 255)) : v.slice(0, 3); return Math.abs(rgb[0] - 102) <= 2 && Math.abs(rgb[1] - 128) <= 2 && Math.abs(rgb[2] - 11) <= 2; }, first, { timeout: 3000, label: "settings colour" });
  h.ok(true, "the Settings colour recolours every untagged comment live");
  await page.evaluate(async () => { const s = await import("/src/lib/settings.ts"); s.settings.update((v) => ({ ...v, paperCommentColor: "#4385be", paperCommentTags: ["needs-reference=#bc5215"] })); });
  await waitFor(page, (id) => document.querySelector(`.cm-comment-hl[data-cid="${id}"]`)?.style.getPropertyValue("--cm-hl") === "#bc5215", first, { timeout: 3000, label: "tag colour back" });

  // ---- the hover card ---------------------------------------------------------------------
  h.section("rest the pointer on commented text: its card opens there");
  let p = await markPoint(first);
  await page.mouse.move(p.x, p.y - 70); await sleep(80);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await sleep(60);
  h.ok(!(await card()), "a pointer passing over does not flash a card (it waits for a rest)");
  await cardOpen(first);
  c = await card();
  h.ok(!c.pinned, "the card opened by hover is not pinned");
  h.eq(c.msgs, ["Is this the right word?"], "it shows the thread");
  h.eq(c.acts, ["Reply", "Resolve", "In margin", "Delete"], "with every action on it");
  h.eq(c.rows, 1, "the actions sit on one line");
  h.eq([c.dest, c.tags], ["Just for me", ["needs-reference"]], "and who it is for, and its tags");
  h.ok(!(await page.evaluate(() => document.querySelector("[data-comment-card]").contains(document.activeElement))), "a hover card does not take the keyboard from the manuscript");
  const inside = await page.evaluate(() => { const r = document.querySelector("[data-comment-card]").getBoundingClientRect(); return { x: r.left + 60, y: r.top + 20 }; });
  await page.mouse.move(inside.x, inside.y, { steps: 5 });
  await sleep(600);
  h.ok(!!(await card()), "moving onto the card keeps it");
  await park();
  await cardGone();
  h.ok(true, "leaving the text and the card lets it go");

  h.section("answer and edit in the card");
  p = await markPoint(first);
  await page.mouse.click(p.x, p.y);
  await cardOpen(first);
  c = await card();
  h.ok(c.pinned, "a click on the text pins its card");
  h.ok((await marks())[0].active, "and marks the text as the comment in hand");
  await park(); await sleep(500);
  h.ok(!!(await card()), "a pinned card stays when the pointer leaves");
  await clickAct("[data-comment-card]", "Reply");
  await waitFor(page, () => document.activeElement?.getAttribute("aria-label") === "Reply", null, { timeout: 3000, label: "reply focus" });
  await type("Second thought: keep it.");
  await chord(["Control"], "Enter");
  await saved((threads) => threads[0].messages.length === 2, "reply saved");
  h.eq((await card()).msgs, ["Is this the right word?", "Second thought: keep it."], "a reply is added in place");
  await clickIn("[data-comment-card]", '.msg:first-child button[aria-label="Edit this message"]');
  await waitFor(page, () => document.activeElement?.getAttribute("aria-label") === "Edit message", null, { timeout: 3000, label: "edit focus" });
  h.eq(await page.evaluate(() => document.activeElement.value), "Is this the right word?", "editing opens on what you wrote");
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await type("Is 'plateaued' the right word?");
  await chord(["Control"], "Enter");
  await saved((threads) => threads[0].messages[0].body === "Is 'plateaued' the right word?" && !!threads[0].messages[0].editedAt, "edit saved");
  c = await card();
  h.eq(c.msgs[0], "Is 'plateaued' the right word?", "the message is rewritten in place");
  h.ok(/edited/.test(c.when[0]) && !/edited/.test(c.when[1]), "and says it was edited");
  threads = await sidecar();
  h.eq([threads[0].messages[0].author, threads[0].messages.length], [threads[0].messages[1].author, 2], "it keeps its author and its place in the thread");

  h.section("send a comment to the AI Inbox, or take it back");
  await clickIn("[data-comment-card]", ".dest");
  await saved((threads) => threads[0].inbox === true, "sent to inbox");
  h.eq((await card()).dest, "For Flux AI", "the switch says who it is for now");
  h.ok((await inboxIds()).includes(first), "it is in the AI Inbox");
  await clickIn("[data-comment-card]", ".dest");
  await saved((threads) => threads[0].inbox === false, "taken back");
  h.ok(!(await inboxIds()).includes(first), "taken back, it is gone from the AI Inbox");
  h.eq((await sidecar())[0].tags, ["needs-reference"], "changing who it is for keeps its tags");

  h.section("letting a card go");
  await page.mouse.click(700, 760);
  await cardGone();
  h.ok(true, "a click elsewhere closes a pinned card");
  // Click into commented text and write: the card must not be left hanging over the line.
  p = await markPoint(first);
  await page.mouse.click(p.x, p.y);
  await cardOpen(first);
  h.ok(await page.evaluate(() => window.__fluxView.hasFocus), "clicking commented text still puts the caret there");
  await page.keyboard.press("ArrowRight");
  await cardGone();
  h.ok(true, "a key in the manuscript sends the card away (you are writing)");
  await page.mouse.move(p.x + 3, p.y); await sleep(450);
  h.ok(!(await card()), "and text under a resting pointer does not bring it back while you type");
  await sleep(500); await park(); await sleep(100);
  // A drag through commented text selects; it does not ask for the comment.
  await dragOver("sentence one");
  await sleep(350);
  h.ok(!(await page.evaluate(() => document.querySelector("[data-comment-card]")?.classList.contains("pinned") ?? false)), "dragging a selection through commented text does not pin its card");
  await selectWord("# Notes", 0); await park(); await cardGone();
  p = await markPoint(first);
  await page.mouse.click(p.x, p.y);
  await cardOpen(first);
  await clickAct("[data-comment-card]", "Reply");
  await waitFor(page, () => document.activeElement?.getAttribute("aria-label") === "Reply", null, { timeout: 3000, label: "reply focus" });
  await page.keyboard.press("Escape"); await sleep(120);
  h.ok(!!(await card()) && (await card()).acts.includes("Reply"), "Escape in a composer backs out of the composer only");
  await page.focus("[data-comment-card]");
  await page.keyboard.press("Escape");
  await cardGone();
  h.ok(true, "Escape on the card closes it");

  // ---- a comment for Flux AI ----------------------------------------------------------
  h.section("a comment for Flux AI");
  await dragOver("sentence two");
  await page.click('.bubble button[aria-label="Comment for Flux AI"]');
  await cardOpen();
  await waitFor(page, () => document.activeElement?.getAttribute("aria-label") === "New comment", null, { timeout: 3000, label: "composer focus" });
  c = await card();
  h.eq([c.dest, c.send], ["For Flux AI", "Send to Flux AI"], "the Flux AI button starts a comment addressed to the AI Inbox");
  await type("Please check this claim.");
  await clickIn("[data-comment-card]", ".send");
  await cardGone();
  await saved((threads) => threads.length === 2 && threads[1].messages.length === 1, "ai comment saved");
  threads = await sidecar();
  const second = threads[1].id;
  h.eq([threads[1].inbox, threads[1].tags], [true, undefined], "it is saved as an inbox comment, with no tags");
  const ids = await inboxIds();
  h.ok(ids.includes(second) && !ids.includes(first), "the AI Inbox has it, and still not the private one");
  await selectWord("# Notes", 0); await park(); await sleep(150);
  m = (await marks()).find((x) => x.id === second);
  h.ok(near(m.rgb, BLUE), `an untagged comment is blue (${m.rgb})`);

  h.section("the keyboard");
  await selectWord("sentence three");
  await chord(["Control", "Alt"], "m");
  await cardOpen();
  c = await card();
  h.eq([c.dest, c.pinned], ["Just for me", true], "Ctrl+Alt+M starts a private comment on the selection");
  await page.keyboard.press("Escape");
  await cardGone();
  h.eq([(await marks()).length, (await sidecar()).length], [2, 2], "Escape drops an unsent comment and its mark");
  await selectWord("sentence three");
  // The physical key: with Shift held a real keyboard reports "M", and so does the driver then.
  await chord(["Control", "Shift", "Alt"], "KeyM");
  await cardOpen();
  h.eq((await card()).dest, "For Flux AI", "Ctrl+Shift+Alt+M starts one for Flux AI");
  // Change your mind before sending: the switch is right there.
  await clickIn("[data-comment-card]", ".dest");
  await sleep(80);
  h.eq([(await card()).dest, (await card()).send], ["Just for me", "Comment"], "who it is for can be changed before it is sent");
  await page.mouse.click(700, 760);
  await cardGone();
  h.eq((await marks()).length, 2, "clicking away drops an unsent comment that has no words in it");
  // Words typed and not sent are never thrown away by a stray click, a key in the manuscript,
  // or starting another comment.
  await selectWord("sentence three");
  await chord(["Control", "Alt"], "m");
  await cardOpen();
  await waitFor(page, () => document.activeElement?.getAttribute("aria-label") === "New comment", null, { timeout: 3000, label: "composer focus" });
  await type("Half a thought");
  await page.mouse.click(700, 760);
  await sleep(200);
  h.eq(await page.evaluate(() => document.querySelector('[data-comment-card] textarea[aria-label="New comment"]')?.value ?? null), "Half a thought", "a click elsewhere leaves a comment you have started writing");
  await page.keyboard.press("ArrowLeft");
  await sleep(120);
  h.ok(!!(await card()), "so does a key in the manuscript");
  await selectWord("sentence one");
  await chord(["Control", "Alt"], "m");
  await sleep(250);
  c = await card();
  h.eq([await page.evaluate(() => document.querySelector('[data-comment-card] textarea[aria-label="New comment"]')?.value ?? null), c.focus, (await marks()).length], ["Half a thought", "New comment", 3], "starting another comment hands the keyboard back to the unsent one instead of dropping it");
  await page.keyboard.press("Escape");
  await cardGone();
  h.eq((await marks()).length, 2, "Esc is how you drop it");
  // A reply begun in a card that hover opened: the card is now being worked in, and stays.
  await selectWord("# Notes", 0); await park(); await sleep(800);
  p = await markPoint(first);
  await page.mouse.move(p.x, p.y - 60); await page.mouse.move(p.x, p.y, { steps: 3 });
  await cardOpen(first);
  await clickAct("[data-comment-card]", "Reply");
  await waitFor(page, () => document.activeElement?.getAttribute("aria-label") === "Reply", null, { timeout: 3000, label: "reply focus" });
  h.ok((await card()).pinned, "working in a hover card pins it");
  await type("unsent");
  await park(); await sleep(500);
  await page.mouse.click(700, 760); await sleep(200);
  h.eq(await page.evaluate(() => document.querySelector('[data-comment-card] textarea[aria-label="Reply"]')?.value ?? null), "unsent", "an unsent reply survives the pointer leaving and a click elsewhere");
  await page.focus('[data-comment-card] textarea[aria-label="Reply"]');
  await page.keyboard.press("Escape"); await sleep(100);
  await page.focus("[data-comment-card]");
  await page.keyboard.press("Escape");
  await cardGone();
  h.eq(await page.evaluate(() => window.__fluxView.state.doc.toString()), TEXT, "the chords type nothing into the manuscript");

  // ---- the margin's pane ------------------------------------------------------------------
  h.section("the margin's Comments pane");
  p = await markPoint(first);
  await page.mouse.click(p.x, p.y);
  await cardOpen(first);
  await clickAct("[data-comment-card]", "In margin");
  await waitFor(page, () => !!document.querySelector('[data-pane-id="comments"] [data-thread-card]'), null, { timeout: 6000, label: "comments pane" });
  await cardGone();
  const PANE = '[data-pane-id="comments"]';
  const pane = () => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return {
      count: el.querySelector(".count")?.textContent.replace(/\s+/g, " ").trim(),
      cards: [...el.querySelectorAll("[data-thread-card]")].map((x) => ({ id: x.dataset.threadCard, active: x.classList.contains("active"), resolved: x.classList.contains("resolved"), dest: x.querySelector(".dest")?.textContent.trim(), tags: [...x.querySelectorAll(".tag")].map((t) => t.dataset.tag), acts: [...x.querySelectorAll(".acts button")].map((b) => b.textContent.trim()) })),
      filters: [...el.querySelectorAll(".filters .f")].map((f) => ({ text: f.textContent.replace(/\s+/g, " ").trim(), on: f.getAttribute("aria-pressed") === "true" })),
      ai: !!el.querySelector('.head button[aria-label="Comment for Flux AI"] .flux-ai-mark'),
    };
  }, PANE);
  let v = await pane();
  h.eq(v.cards.map((x) => [x.id, x.active]), [[first, true], [second, false]], "In margin opens the pane on that comment, and closes the card");
  h.eq(v.cards.map((x) => x.dest), ["Just for me", "For Flux AI"], "each thread says who it is for");
  h.ok(!v.cards[0].acts.includes("In margin"), "a thread already in the margin does not offer In margin");
  h.ok(v.ai, "the pane has the Flux AI way in beside + Comment");
  h.eq(v.filters.map((f) => f.text), ["#needs-reference1", "Flux AI1"], "tags in use, and Flux AI, are offered as filters with their counts");
  await clickIn(PANE, '[data-filter-tag="needs-reference"]');
  await sleep(120);
  v = await pane();
  h.eq([v.cards.map((x) => x.id), v.filters[0].on], [[first], true], "a tag filter shows only the comments that carry it");
  await clickIn(PANE, "[data-filter-ai]");
  await sleep(120);
  v = await pane();
  h.eq([v.cards.map((x) => x.id), v.filters.map((f) => f.on)], [[second], [false, true]], "the Flux AI filter shows only inbox comments (one filter at a time)");
  await clickIn(PANE, "[data-filter-ai]");
  await sleep(120);
  h.eq((await pane()).cards.length, 2, "clicking the filter again shows everything");

  // Tag from the pane, from the list this time.
  await page.evaluate(async () => { const s = await import("/src/lib/settings.ts"); s.settings.update((x) => ({ ...x, paperCommentTags: [...x.paperCommentTags, "stats=#24837b"] })); });
  await clickIn(`${PANE} [data-thread-card="${second}"]`, ".add");
  await waitFor(page, () => document.activeElement?.getAttribute("aria-label") === "Tag name", null, { timeout: 3000, label: "tag field" });
  h.eq(await page.evaluate((sel) => [...document.querySelectorAll(`${sel} .menu .row`)].map((r) => r.textContent.trim()), PANE), ["#needs-reference", "#stats"], "the tag menu lists your tags");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await saved((threads) => threads[1].tags?.[0] === "stats", "tag from the list saved");
  await page.keyboard.press("Escape");
  await waitFor(page, ([id]) => document.querySelector(`.cm-comment-hl[data-cid="${id}"]`)?.style.getPropertyValue("--cm-hl") === "#24837b", [second], { timeout: 3000, label: "tag colour on the text" });
  h.ok(true, "a tag picked from the list is saved and recolours its text");
  h.eq((await pane()).filters.map((f) => f.text), ["#needs-reference1", "#stats1", "Flux AI1"], "the new tag joins the filters, in your list's order");
  // Remove it again: the filter row follows.
  await clickIn(`${PANE} [data-thread-card="${second}"]`, '.tag[data-tag="stats"] .drop');
  await saved((threads) => !threads[1].tags, "tag removed");
  h.eq((await pane()).filters.map((f) => f.text), ["#needs-reference1", "Flux AI1"], "removing the last use of a tag removes its filter");

  h.section("resolve, reopen, delete");
  // Resolve from the card: the card and the highlight go, the pane keeps the thread.
  // The real pointer has rested on the FIRST comment's text since the pane was opened from its card (every pane action above is
  // a DOM click). When the second comment's mark is redrawn (its tag came and went) the browser re-targets a resting pointer,
  // and 240 ms later the first comment's hover card hangs over the second comment's line. The click below then landed on that
  // card whenever the steps above took that long (the pool here, the hosted ui-gate on 11-19 and 11-23: "comment card" timed
  // out) and on the text when they did not (alone). With a 600 ms pause put before the click the step as it was fails 7 of 12
  // runs with that timeout; this one fails none of 10. A person's pointer
  // is not parked there: it leaves the text, a hover card goes, and the text is clicked once it is what lies under the point.
  await page.mouse.move(700, 760);
  await cardGone();
  p = await waitFor(page, (id) => { const el = document.querySelector(`.cm-comment-hl[data-cid="${id}"]`); if (!el) return null; const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; return document.elementFromPoint(x, y)?.closest(`.cm-comment-hl[data-cid="${id}"]`) ? { x, y } : null; }, second, { label: "the commented text is under the pointer" });
  await page.mouse.click(p.x, p.y);
  await cardOpen(second).catch(async (e) => { throw new Error(`${e.message}; under the point: ${await page.evaluate(({ x, y }) => { const n = document.elementFromPoint(x, y); return n ? `<${n.tagName.toLowerCase()} class="${n.className}">` : "nothing"; }, p)}; cards: ${await page.evaluate(() => [...document.querySelectorAll("[data-comment-card]")].map((c) => `${c.dataset.commentCard}${c.classList.contains("ready") ? " ready" : ""}`).join(", ") || "none")}`); });
  await clickAct("[data-comment-card]", "Resolve");
  await cardGone();
  await saved((threads) => threads[1].resolved === true, "resolved");
  h.eq((await marks()).map((x) => x.id), [first], "a resolved comment's text is no longer marked");
  v = await pane();
  h.eq([v.count, v.cards[1].resolved, v.cards[1].acts], ["1 open·1 resolved", true, ["Reopen", "Delete"]], "the pane keeps it as resolved, to reopen or delete");
  h.ok(!(await inboxIds()).includes(second), "a resolved comment has left the AI Inbox");
  await clickAct(`${PANE} [data-thread-card="${second}"]`, "Reopen");
  await saved((threads) => threads[1].resolved === false, "reopened");
  h.eq((await marks()).length, 2, "reopening marks its text again");
  h.eq((await sidecar())[1].inbox, true, "and it is still addressed to Flux AI");
  await clickAct(`${PANE} [data-thread-card="${first}"]`, "Delete");
  await saved((threads) => threads.length === 1, "deleted");
  h.eq([(await marks()).map((x) => x.id), (await sidecar()).map((t) => t.id)], [[second], [second]], "Delete removes the thread and its mark");
  // Delete from the card.
  await page.evaluate(() => window.__fluxMargin?.closeAll());
  await sleep(200);
  p = await markPoint(second);
  await page.mouse.move(p.x, p.y - 60); await page.mouse.move(p.x, p.y, { steps: 3 });
  await cardOpen(second);
  await clickAct("[data-comment-card]", "Delete");
  await cardGone();
  await saved((threads) => threads.length === 0, "all deleted");
  h.eq((await marks()).length, 0, "Delete in the hover card removes it too");
  h.eq(await page.evaluate(() => window.__fluxView.state.doc.toString()), TEXT, "none of this changed the manuscript's words");

  await shot(page, "paper-comments");
  h.eq(realErrors(page), [], "no console errors");
} catch (e) {
  h.fail(`threw: ${e?.stack || e}`);
}
await h.done(() => browser.close());

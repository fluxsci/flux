// Behavioral gate for Paper's local correction fabric. Exercises the real
// Vite module worker + Harper WASM, the exact product example, one-step undo,
// continued typing, protected syntax, toggling, and correction details UI.
import {
  APP_URL,
  clickMode,
  gotoApp,
  launch,
  realErrors,
  shot,
  waitFor,
} from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-paper-local-corrections");
const { browser, page } = await launch({ width: 1440, height: 900 });
await page.evaluateOnNewDocument(() => {
  localStorage.removeItem("flux.paper.localCorrections.v1");
  localStorage.removeItem("flux.paper.localLanguage.v2");
  const current = JSON.parse(localStorage.getItem("flux.settings") || "{}");
  localStorage.setItem("flux.settings", JSON.stringify({
    ...current,
    paperLocalCorrections: true,
    paperContextualCorrections: true,
    paperCorrectionGuidance: "Preserve named sensors and scientific identifiers.",
  }));
});
await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 1000 });
await clickMode(page, "Paper", { settle: 350 });
await waitFor(page, () => !!window.__fluxView, null, { timeout: 15000, label: "Paper editor" });
await waitFor(
  page,
  () => document.querySelector("[data-correction-status]")?.getAttribute("data-correction-status") === "ready",
  null,
  { timeout: 20000, label: "local worker ready" },
);

const replaceDoc = async (text = "") => {
  await page.evaluate((next) => {
    const view = window.__fluxView;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, selection: { anchor: next.length } });
    view.focus();
  }, text);
};
const doc = () => page.evaluate(() => window.__fluxView.state.doc.toString());
const pressLocalChord = async (targetPage, key, { shift = false } = {}) => {
  await targetPage.keyboard.down("Alt");
  if (shift) await targetPage.keyboard.down("Shift");
  await targetPage.keyboard.press(key);
  if (shift) await targetPage.keyboard.up("Shift");
  await targetPage.keyboard.up("Alt");
};

h.section("exact product interaction");
await replaceDoc();
await page.keyboard.type("The chemical structure is a very compelx ", { delay: 3 });
// Wait for the word lane to fix "compelx" at its own boundary before typing on.
// The one-step-undo assertion below pins history-batch SCOPING (newest batch
// only); whether the two fixes land as one or two batches during continuous
// fast typing is worker scheduling, not the contract, and under load the
// coalesced single batch made this gate flake.
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The chemical structure is a very complex ",
  null,
  { timeout: 8000, label: "word-lane compelx correction" },
);
await page.keyboard.type("o bject.", { delay: 3 });
const correctionStartedAt = Date.now();
await page.keyboard.type(" ");
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The chemical structure is a very complex object. ",
  null,
  { timeout: 8000, label: "complex object correction" },
);
const correctionElapsedMs = Date.now() - correctionStartedAt;
const exact = await page.evaluate(() => ({
  text: window.__fluxView.state.doc.toString(),
  marks: [...document.querySelectorAll(".cm-local-correction")].map((el) => el.textContent),
  caret: window.__fluxView.state.selection.main.head,
}));
h.eq(exact.text, "The chemical structure is a very complex object. ", "exact example corrects locally");
h.ok(correctionElapsedMs < 900, `warm correction settles promptly (${correctionElapsedMs} ms)`);
h.eq(exact.marks, ["complex", "object"], "both changes carry transient blue-pulse marks");
h.eq(exact.caret, exact.text.length, "caret remains at the end of the user's text");
await shot(page, "paper-local-correction-pulse");

await page.evaluate(() => {
  document.querySelector(".cm-local-correction")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
});
await waitFor(page, () => !!document.querySelector(".cm-local-correction-menu"), null, { label: "correction menu" });
const menuText = await page.evaluate(() => document.querySelector(".cm-local-correction-menu")?.textContent ?? "");
h.ok(menuText.includes("compelx → complex") && menuText.includes("Undo") && menuText.includes("Add to dictionary"), "click reveals concise correction, undo, and dictionary actions");
await shot(page, "paper-local-correction-menu");
await page.keyboard.press("Escape");

await page.keyboard.down("Control");
await page.keyboard.press("KeyZ");
await page.keyboard.up("Control");
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The chemical structure is a very complex o bject. ",
  null,
  { timeout: 4000, label: "one-step correction undo" },
);
h.eq(await doc(), "The chemical structure is a very complex o bject. ", "one Undo targets only the most recent real-time correction batch");

h.section("learning and uninterrupted typing");
await replaceDoc();
await page.keyboard.type("The chemical structure is a very compelx o bject. ", { delay: 2 });
await new Promise((resolve) => setTimeout(resolve, 700));
h.eq(await doc(), "The chemical structure is a very complex o bject. ", "immediate Undo learns only the correction the user actually reversed");

await page.evaluate(() => {
  localStorage.removeItem("flux.paper.localCorrections.v1");
  localStorage.removeItem("flux.paper.localLanguage.v2");
  window.dispatchEvent(new Event("flux:local-corrections-reset"));
});
await replaceDoc();
await page.keyboard.type("The chemical structure is a very compelx o bject. ", { delay: 2 });
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The chemical structure is a very complex object. ",
  null,
  { timeout: 8000, label: "live learning reset" },
);
h.ok(true, "reset learning immediately clears active project vetoes");

// Use different, unblocked typos and continue typing before the worker returns.
await replaceDoc();
await page.keyboard.type("This experiemnt had a strucutre. The next idea keeps moving.", { delay: 1 });
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "This experiment had a structure. The next idea keeps moving.",
  null,
  { timeout: 8000, label: "continued typing correction" },
);
const continued = await page.evaluate(() => ({
  text: window.__fluxView.state.doc.toString(),
  caret: window.__fluxView.state.selection.main.head,
}));
h.eq(continued.caret, continued.text.length, "late local results map behind continued typing without moving the caret");

await replaceDoc();
const splitTrap = "Each trace was compared agains a blinded annotation. The anisotropic kernel remained stable. ";
await page.keyboard.type(splitTrap, { delay: 1 });
await new Promise((resolve) => setTimeout(resolve, 700));
h.eq(await doc(), splitTrap, "the real worker never splits a misspelling or scientific term into two valid words");

h.section("sentence judgment lane");
await page.evaluate(() => {
  window.__contextPackets = [];
  window.__contextDelay = 30;
  window.__contextCancelled = [];
  window.fig.correctionDecide = async ({ packet }) => {
    window.__contextPackets.push(packet);
    await new Promise((resolve) => setTimeout(resolve, window.__contextDelay));
    const decisions = packet.candidates.map((candidate) => {
      if (candidate.original.toLowerCase() === "conext") {
        return { candidateId: candidate.id, action: "rescue", replacement: "context" };
      }
      if (candidate.original.toLowerCase() === "wayus" && candidate.rescueSuggestions?.includes("ways")) {
        return { candidateId: candidate.id, action: "rescue", replacement: "ways" };
      }
      if (candidate.original.toLowerCase() === "recoreded") {
        return { candidateId: candidate.id, action: "rescue", replacement: "recorded" };
      }
      const use = candidate.original.toLowerCase() === "cite" && candidate.from === packet.text.lastIndexOf("cite");
      const wanted = "site";
      const found = candidate.suggestions.findIndex((suggestion) => suggestion.replacement.toLowerCase() === wanted);
      return { candidateId: candidate.id, action: use ? "use" : "keep", suggestionIndex: Math.max(0, found) };
    });
    return {
      version: 1,
      requestId: packet.requestId,
      decisions,
      diagnostics: decisions.map((decision) => ({
        candidateId: decision.candidateId,
        stage: decision.action === "keep" ? "kept" : decision.action === "rescue" ? "accepted-rescue" : "accepted-suggestion",
        ...(decision.replacement ? { replacement: decision.replacement } : {}),
      })),
    };
  };
  window.fig.correctionCancel = async (requestId) => {
    window.__contextCancelled.push(requestId);
    return true;
  };
});
await replaceDoc();
await page.keyboard.type("Please cite the recording cite in the methods. ", { delay: 2 });
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "Please cite the recording site in the methods. ",
  null,
  { timeout: 8000, label: "contextual real-word correction" },
);
const contextual = await page.evaluate(() => ({
  text: window.__fluxView.state.doc.toString(),
  caret: window.__fluxView.state.selection.main.head,
  marked: [...document.querySelectorAll(".cm-local-correction")].some((element) => element.textContent === "site"),
  packet: window.__contextPackets.at(-1),
}));
h.eq(contextual.caret, contextual.text.length, "a sentence-level correction preserves the live caret");
h.ok(contextual.marked, "a contextual decision carries a transient correction mark");
h.ok(await page.evaluate(() => !!document.querySelector(".cm-local-correction-contextual")), "a smart correction uses the dedicated red-to-blue underline morph");
h.ok(
  contextual.packet?.projectContext?.personalGuidance === "Preserve named sensors and scientific identifiers." && contextual.packet?.candidates?.every((candidate) => Array.isArray(candidate.suggestions)),
  "the provider receives bounded candidates plus durable guidance, never rewrite authority",
);

await replaceDoc();
await page.evaluate(() => { window.__contextDelay = 300; });
await page.keyboard.type("The wayus ", { delay: 2 });
await waitFor(page, () => document.querySelector(".cm-context-issue-deferred")?.textContent === "wayus", null, { timeout: 4000, label: "deferred issue underline" });
h.ok(true, "Harper deferral fades in as a red underline at the completed-word boundary");
h.eq(
  await page.evaluate(() => document.querySelector(".cm-context-issue-deferred")?.getAttribute("spellcheck")),
  "false",
  "a tracked issue suppresses Chromium's competing native spelling marker",
);
await page.keyboard.type("in which the system acts remain unclear. ", { delay: 2 });
await waitFor(page, () => document.querySelector(".cm-context-issue-pending")?.textContent === "wayus", null, { timeout: 4000, label: "pending issue underline" });
h.ok(true, "the same red underline remains visible while sentence judgment is running");
await shot(page, "paper-context-issue-pending");
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The ways in which the system acts remain unclear. ",
  null,
  { timeout: 8000, label: "lexicon-expanded wayus correction" },
);
await page.evaluate(() => { window.__contextDelay = 30; });
const wayusPacket = await page.evaluate(() => window.__contextPackets.at(-1));
const wayusCandidate = wayusPacket?.candidates?.find((candidate) => candidate.original.toLowerCase() === "wayus");
h.ok(
  wayusCandidate?.suggestions?.length === 0 && wayusCandidate?.rescueSuggestions?.includes("ways"),
  "the real Harper worker isolates ways as a locally verified rescue proposal",
);

await replaceDoc();
await page.keyboard.type("The conext made the intended meaning clear. ", { delay: 2 });
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The context made the intended meaning clear. ",
  null,
  { timeout: 8000, label: "model-originated rescue correction" },
);
const fallbackPacket = await page.evaluate(() => window.__contextPackets.at(-1));
const fallbackCandidate = fallbackPacket?.candidates?.find((candidate) => candidate.original.toLowerCase() === "conext");
h.ok(
  fallbackCandidate?.rescueEligible
    && !fallbackCandidate.suggestions.some((suggestion) => suggestion.replacement === "context")
    && !fallbackCandidate.rescueSuggestions.includes("context"),
  "a model-originated word crosses the editor only when Harper omitted it and the local worker independently accepts it",
);

await page.evaluate(() => { window.__contextDelay = 180; });
await replaceDoc();
await page.keyboard.type("The recording cite identified cortex. The next idea keeps moving.", { delay: 1 });
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The recording site identified cortex. The next idea keeps moving.",
  null,
  { timeout: 8000, label: "contextual result behind continued typing" },
);
h.eq(
  await page.evaluate(() => window.__fluxView.state.selection.main.head),
  (await doc()).length,
  "a delayed contextual result maps behind uninterrupted typing without moving the caret",
);

await page.evaluate(() => {
  window.__contextPackets.length = 0;
  window.__contextDelay = 180;
});
await replaceDoc();
const continuousSource = "The recording cite marked cortex. The injection cite marked thalamus. The target cite marked striatum. ";
const continuousExpected = continuousSource.replaceAll("cite", "site");
await page.keyboard.type(continuousSource, { delay: 1 });
try {
  await waitFor(
    page,
    (expected) => window.__fluxView.state.doc.toString() === expected,
    continuousExpected,
    { timeout: 8000, label: "continuous sentence backfill" },
  );
} catch (error) {
  console.error("continuous sentence debug", await page.evaluate(() => ({
    text: window.__fluxView.state.doc.toString(),
    packets: window.__contextPackets,
  })));
  throw error;
}
h.eq(await page.evaluate(() => window.__contextPackets.length), 3, "bounded contextual FIFO examines every sentence during continuous fast typing");
h.eq(await page.evaluate(() => window.__fluxView.state.selection.main.head), continuousExpected.length, "continuous sentence backfill preserves the live caret");

await page.evaluate(() => { window.__contextDelay = 350; });
await replaceDoc();
await page.keyboard.type("The recording cite marked cortex. ", { delay: 1 });
await new Promise((resolve) => setTimeout(resolve, 90));
await page.evaluate(() => {
  const view = window.__fluxView;
  const from = view.state.doc.toString().indexOf("cite");
  view.dispatch({ changes: { from, to: from + 4, insert: "shape" }, selection: { anchor: from + 5 } });
});
await new Promise((resolve) => setTimeout(resolve, 500));
h.eq(await doc(), "The recording shape marked cortex. ", "editing a pending span cancels the stale contextual mutation");
h.ok(await page.evaluate(() => window.__contextCancelled.length > 0), "stale in-flight work is cancelled at the provider boundary");

await page.evaluate(() => { window.__contextDelay = 20; });
await replaceDoc();
await page.keyboard.type("The blue label was a compliment to the orange trace. ", { delay: 1 });
await waitFor(page, () => !!document.querySelector(".cm-context-issue-declined"), null, { timeout: 4000, label: "declined orange issue" });
h.eq(await doc(), "The blue label was a compliment to the orange trace. ", "a contextual keep decision leaves intentional real-word prose byte-identical");
await page.evaluate(() => {
  document.querySelector(".cm-context-issue-declined")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
});
await waitFor(page, () => !!document.querySelector('[data-flux-context-issue-details="declined"]'), null, { label: "declined issue details" });
const declinedDetails = await page.evaluate(() => document.querySelector(".cm-context-issue-menu")?.textContent ?? "");
h.ok(declinedDetails.includes("Left unchanged") && declinedDetails.includes("preferred the original wording"), "clicking an orange issue explains the structured abstention without exposing model chain-of-thought");
await shot(page, "paper-context-issue-declined-details");
await page.keyboard.press("Escape");

await replaceDoc();
await page.keyboard.type("The signal was recoreded. ", { delay: 2 });
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The signal was recorded. ",
  null,
  { timeout: 8000, label: "dictionary candidate correction" },
);
await page.evaluate(() => {
  document.querySelector(".cm-local-correction")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
});
await waitFor(page, () => !!document.querySelector(".cm-local-correction-menu"), null, { label: "dictionary menu" });
await page.evaluate(() => {
  const button = [...document.querySelectorAll(".cm-local-correction-menu button")]
    .find((candidate) => candidate.textContent === "Add to dictionary");
  button?.click();
});
await waitFor(
  page,
  () => window.__fluxView.state.doc.toString() === "The signal was recoreded. ",
  null,
  { label: "dictionary restores original" },
);
await replaceDoc();
await page.keyboard.type("The signal was recoreded. ", { delay: 2 });
await new Promise((resolve) => setTimeout(resolve, 700));
h.eq(await doc(), "The signal was recoreded. ", "Add to dictionary restores and learns a project-specific term");

h.section("word tools and instantaneous aliases");
await page.evaluate(() => {
  localStorage.removeItem("flux.paper.localCorrections.v1");
  localStorage.removeItem("flux.paper.localLanguage.v2");
  window.dispatchEvent(new Event("flux:local-corrections-reset"));
});
await replaceDoc("iGluSnFR4f");
await page.evaluate(() => {
  const view = window.__fluxView;
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  view.focus();
});
await waitFor(page, () => !!document.querySelector('.bubble [title^="Word tools"]'), null, { label: "word tools selection button" });
const wordToolsTitle = await page.$eval('.bubble [title^="Word tools"]', (button) => button.getAttribute("title"));
h.eq(wordToolsTitle, "Word tools  Shift+Alt+W", "Word tools hover shows the native Linux shortcut, not macOS symbols");
await page.click('.bubble [title^="Word tools"]');
await waitFor(page, () => !!document.querySelector(".cm-local-word-tools"), null, { label: "word tools popover" });
const initialTools = await page.evaluate(() => ({
  text: document.querySelector(".cm-local-word-tools")?.textContent ?? "",
  project: document.querySelector('[data-word-scope="project"]')?.getAttribute("aria-pressed"),
  personal: document.querySelector('[data-word-scope="personal"]')?.getAttribute("aria-pressed"),
}));
h.ok(initialTools.text.includes("iGluSnFR4f") && initialTools.project === "false" && initialTools.personal === "false", "selection toolbar opens scoped Word tools for the exact scientific term");
await shot(page, "paper-local-word-tools-empty");

await page.click('[data-word-scope="project"]');
await waitFor(page, () => document.querySelector('[data-word-scope="project"]')?.getAttribute("aria-pressed") === "true", null, { label: "project dictionary active" });
await page.type('.cm-local-alias-form input', "igf");
await page.click('.cm-local-alias-form button');
await waitFor(page, () => document.querySelector(".cm-local-alias-row strong")?.textContent === "igf", null, { label: "project alias saved" });
const configuredTools = await page.evaluate(() => document.querySelector(".cm-local-word-tools")?.textContent ?? "");
h.ok(configuredTools.includes("igf") && configuredTools.includes("Project"), "the popover adds and exposes a removable project alias");
await shot(page, "paper-local-word-tools-configured");
await page.click('.cm-local-word-tools-header button[aria-label="Close word tools"]');

await replaceDoc();
const protectedAliases = "`igf in code` and $igf in math$ and @igf citation ";
await page.keyboard.type(protectedAliases, { delay: 1 });
await new Promise((resolve) => setTimeout(resolve, 120));
h.eq(await doc(), protectedAliases, "aliases do not expand inside code, math, or citation syntax while it is still being typed");

await replaceDoc();
await page.keyboard.type("igf", { delay: 2 });
const aliasStartedAt = Date.now();
await page.keyboard.type(" ");
await waitFor(page, () => window.__fluxView.state.doc.toString() === "iGluSnFR4f ", null, { timeout: 1500, label: "instant alias expansion" });
const aliasElapsedMs = Date.now() - aliasStartedAt;
const aliasVisual = await page.evaluate(() => ({
  text: window.__fluxView.state.doc.toString(),
  mark: document.querySelector(".cm-local-correction")?.textContent ?? "",
  caret: window.__fluxView.state.selection.main.head,
}));
h.ok(aliasElapsedMs < 100, `alias expansion stays in the instantaneous class (${aliasElapsedMs} ms)`);
h.eq(aliasVisual, { text: "iGluSnFR4f ", mark: "iGluSnFR4f", caret: 11 }, "alias morphs in place with the same zero-layout visual and an unmoved caret");

await page.keyboard.down("Control");
await page.keyboard.press("KeyZ");
await page.keyboard.up("Control");
await waitFor(page, () => window.__fluxView.state.doc.toString() === "igf", null, { label: "alias transaction undo" });
h.eq(await doc(), "igf", "one Undo restores the typed alias exactly");
await page.keyboard.type(" ");
await waitFor(page, () => window.__fluxView.state.doc.toString() === "iGluSnFR4f ", null, { label: "alias re-expansion" });
await page.evaluate(() => {
  document.querySelector(".cm-local-correction")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
});
await waitFor(page, () => !!document.querySelector(".cm-local-correction-menu"), null, { label: "alias correction menu" });
const aliasMenu = await page.evaluate(() => document.querySelector(".cm-local-correction-menu")?.textContent ?? "");
h.ok(aliasMenu.includes("Expanded alias") && aliasMenu.includes("igf → iGluSnFR4f") && aliasMenu.includes("Remove alias"), "the pulse menu identifies alias expansion and offers direct removal");
await page.evaluate(() => {
  const button = [...document.querySelectorAll(".cm-local-correction-menu button")]
    .find((candidate) => candidate.textContent === "Remove alias");
  button?.click();
});
await waitFor(page, () => window.__fluxView.state.doc.toString() === "igf ", null, { label: "remove alias and restore trigger" });
await replaceDoc();
await page.keyboard.type("igf ", { delay: 2 });
await new Promise((resolve) => setTimeout(resolve, 120));
h.eq(await doc(), "igf ", "Remove alias stops expansion immediately");

h.section("dictionary hotkeys and scientific typo matching");
await replaceDoc("iGluSnFR4f");
await page.evaluate(() => {
  const view = window.__fluxView;
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  view.focus();
});
await pressLocalChord(page, "KeyD", { shift: true }); // existing project entry toggles OUT
await pressLocalChord(page, "KeyD"); // personal entry toggles IN
await pressLocalChord(page, "KeyW", { shift: true });
await waitFor(page, () => !!document.querySelector(".cm-local-word-tools"), null, { label: "word tools from hotkey" });
await waitFor(page, () => document.activeElement?.matches(".cm-local-alias-form input") ?? false, null, { label: "alias input focus" });
const hotkeyScopes = await page.evaluate(() => ({
  project: document.querySelector('[data-word-scope="project"]')?.getAttribute("aria-pressed"),
  personal: document.querySelector('[data-word-scope="personal"]')?.getAttribute("aria-pressed"),
  aliasFocused: document.activeElement?.matches(".cm-local-alias-form input") ?? false,
}));
h.eq(hotkeyScopes, { project: "false", personal: "true", aliasFocused: true }, "scope hotkeys toggle independently and the alias hotkey focuses its input");
await page.keyboard.press("Escape");
await pressLocalChord(page, "KeyD"); // personal OUT
await pressLocalChord(page, "KeyD", { shift: true }); // project IN

await replaceDoc();
await page.keyboard.type("We measured IgluSnrf4. ", { delay: 2 });
await waitFor(page, () => window.__fluxView.state.doc.toString() === "We measured iGluSnFR4f. ", null, { timeout: 8000, label: "explicit scientific dictionary correction" });
h.eq(await doc(), "We measured iGluSnFR4f. ", "project dictionary corrects the requested mixed-case scientific near miss");
await replaceDoc();
await page.keyboard.type("We measured iGluSnFR4f and SLAP3. ", { delay: 2 });
await new Promise((resolve) => setTimeout(resolve, 500));
h.eq(await doc(), "We measured iGluSnFR4f and SLAP3. ", "canonical terms and meaningful version-like identifiers remain byte-identical");

h.section("protected syntax and preference");
await replaceDoc();
const protectedSource = "The `experiemnt` code, $occured$ value, @experiemnt citation, and 5 Hz remain. ";
await page.keyboard.type(protectedSource, { delay: 1 });
await new Promise((resolve) => setTimeout(resolve, 800));
h.eq(await doc(), protectedSource, "code, math, citation keys, and scientific numbers remain byte-identical");

await replaceDoc();
const scientificSource = "The somata and glia produced a data set at one timepoint in the brainstem wildtype cohort. ";
await page.keyboard.type(scientificSource, { delay: 1 });
await new Promise((resolve) => setTimeout(resolve, 700));
h.eq(await doc(), scientificSource, "unfamiliar scientific words and valid open compounds are left alone");

h.section("backlog flagging on document load");
await page.evaluate(() => {
  const view = window.__fluxView;
  const text = [
    "The chamber enviroment remained stable throughout the whole experiment.",
    "",
    "```",
    "const enviroment = 1;",
    "```",
    "",
    "Ready.",
  ].join("\n");
  // A programmatic whole-document swap is exactly how PaperMode opens and
  // switches documents — the backlog-scan trigger under test.
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
  view.focus();
});
await waitFor(
  page,
  () => [...document.querySelectorAll(".cm-context-issue-flagged")].some((el) => el.textContent === "enviroment"),
  null,
  { timeout: 10000, label: "flagged backlog underline" },
);
const backlog = await page.evaluate(() => ({
  flagged: [...document.querySelectorAll(".cm-context-issue-flagged")].map((el) => el.textContent),
  text: window.__fluxView.state.doc.toString(),
}));
h.eq(backlog.flagged, ["enviroment"], "the prose typo is flagged once; the fenced-code copy stays unmarked");
h.ok(backlog.text.startsWith("The chamber enviroment remained stable"), "backlog flagging never edits the document");
// Give any wrongly-scheduled judgment/correction time to appear, then pin its absence.
await new Promise((resolve) => setTimeout(resolve, 900));
const backlogSettled = await page.evaluate(() => ({
  pending: document.querySelectorAll(".cm-context-issue-pending").length,
  corrected: document.querySelectorAll(".cm-local-correction").length,
  stillFlagged: [...document.querySelectorAll(".cm-context-issue-flagged")].map((el) => el.textContent),
}));
h.eq([backlogSettled.pending, backlogSettled.corrected], [0, 0], "backlog flags never invoke the smart layer and never auto-correct");
h.eq(backlogSettled.stillFlagged, ["enviroment"], "the flag persists until the text is edited");
await page.evaluate(() => {
  document.querySelector(".cm-context-issue-flagged")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
});
await waitFor(page, () => document.querySelector(".cm-context-issue-menu")?.dataset.fluxContextIssueDetails === "flagged", null, { label: "flagged details tooltip" });
const flaggedMenu = await page.evaluate(() => document.querySelector(".cm-context-issue-menu")?.textContent ?? "");
h.ok(flaggedMenu.includes("Flagged by the local checker"), "clicking a flagged span explains who flagged it and why");
await page.keyboard.press("Escape");

await page.click("[data-correction-status]");
await waitFor(
  page,
  () => document.querySelector("[data-correction-status]")?.getAttribute("data-correction-status") === "off",
  null,
  { label: "corrections disabled" },
);
await replaceDoc();
await page.keyboard.type("This experiemnt occured. ", { delay: 2 });
await new Promise((resolve) => setTimeout(resolve, 600));
h.eq(await doc(), "This experiemnt occured. ", "status-pill toggle disables all automatic changes");
await page.click("[data-correction-status]");
await waitFor(
  page,
  () => document.querySelector("[data-correction-status]")?.getAttribute("data-correction-status") === "ready",
  null,
  { timeout: 4000, label: "warm worker re-enabled" },
);
h.ok(true, "re-enabling reuses the warm local worker");

h.section("managed-local settings UX");
await page.click('button[aria-label="Settings"]');
await waitFor(page, () => !!document.querySelector('.modal[aria-label="Settings"]'), null, { label: "Settings modal" });
const settingsModel = await page.evaluate(() => ({
  provider: document.querySelector('.correction-grid select')?.value,
  text: document.querySelector('.modal[aria-label="Settings"]')?.textContent ?? "",
  judgmentOptions: [...document.querySelectorAll('.correction-grid select')]
    .flatMap((select) => [...select.options].map((option) => option.value))
    .filter((value) => value.includes("aggressive") || value === "standard"),
}));
h.eq(settingsModel.provider, "flux", "the Flux-managed local provider is the product default");
h.ok(settingsModel.text.includes("Install local model") && settingsModel.text.includes("resumable and SHA-256 verified"), "Settings exposes explicit install, verification, and removal lifecycle UX");
h.eq(settingsModel.judgmentOptions, ["standard", "aggressive", "really-aggressive"], "Settings exposes Standard, Aggressive, and Really aggressive judgment modes");
await page.evaluate(() => {
  const done = [...document.querySelectorAll('.modal[aria-label="Settings"] button')].find((button) => button.textContent === "Done");
  done?.click();
});
await waitFor(page, () => !document.querySelector('.modal[aria-label="Settings"]'), null, { label: "Settings modal closed" });

h.section("runtime hygiene");
h.eq(realErrors(page), [], "no browser, worker, WASM, or CSP errors");

h.section("Vim visual selection parity");
const vimPage = await browser.newPage();
await vimPage.evaluateOnNewDocument(() => {
  localStorage.removeItem("flux.paper.localCorrections.v1");
  localStorage.removeItem("flux.paper.localLanguage.v2");
  localStorage.setItem("flux.paper.vimFlavor", "vim");
  const current = JSON.parse(localStorage.getItem("flux.settings") || "{}");
  localStorage.setItem("flux.settings", JSON.stringify({ ...current, paperLocalCorrections: true }));
});
await gotoApp(vimPage, { url: `${APP_URL}?fixture=demo`, settle: 500 });
await clickMode(vimPage, "Paper", { settle: 250 });
await waitFor(vimPage, () => !!window.__fluxView && !!document.querySelector(".cm-vim-panel"), null, { timeout: 10000, label: "Vim Paper editor" });
await vimPage.evaluate(() => {
  const view = window.__fluxView;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "jRGECO1a" }, selection: { anchor: 0 } });
  view.focus();
});
await vimPage.keyboard.press("Escape");
await vimPage.keyboard.press("0");
await vimPage.keyboard.press("v");
await vimPage.keyboard.press("$");
const visualSelection = await vimPage.evaluate(() => {
  const view = window.__fluxView;
  const range = view.state.selection.main;
  return view.state.sliceDoc(range.from, range.to);
});
h.eq(visualSelection, "jRGECO1a", "Vim visual mode produces the same selected word contract");
await pressLocalChord(vimPage, "KeyD", { shift: true });
await pressLocalChord(vimPage, "KeyW", { shift: true });
await waitFor(vimPage, () => !!document.querySelector(".cm-local-word-tools"), null, { label: "Vim visual Word tools" });
const vimTools = await vimPage.evaluate(() => ({
  term: document.querySelector(".cm-local-word-tools-header strong")?.textContent,
  project: document.querySelector('[data-word-scope="project"]')?.getAttribute("aria-pressed"),
}));
h.eq(vimTools, { term: "jRGECO1a", project: "true" }, "dictionary and Word tools hotkeys work without leaving Vim visual mode");
h.eq(realErrors(vimPage), [], "Vim parity path has a clean browser console");
await vimPage.close();
await h.done(async () => browser.close());

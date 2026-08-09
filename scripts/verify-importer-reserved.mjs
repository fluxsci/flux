// Reserved-folder gate for the Plot Importer (browser, demo fixture): plots/_lighttable/ and
// plots/_dissections/ are companion material, so they are absent from the browse listing AND
// from search — a plain query can never surface one of ten thousand sweep images. Hidden is
// not sealed: typing "_" offers them as enterable rows, Enter descends and clears the box, and
// from inside, search is SCOPED to that folder (a plot at the plots/ root is unreachable).
// Stepping back out restores the ordinary plots/ scope. Material reached this deliberately is
// importable like any plot.
//   Run (dev server on :1420 must be up): node scripts/verify-importer-reserved.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg, extra = "") =>
  cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : "")));

const ROOT = "/demo/myc-growth-paper";
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
await clickMode(page, "Figure");
await sleep(700);

// ---- seed BEFORE opening the importer (open() lists + scans once) ---------------
// Names are deliberately unique so a fixture plot can never satisfy an assertion.
await page.evaluate(async (root) => {
  const svg = (fill) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="72pt" height="72pt" viewBox="0 0 72 72"><rect width="72" height="72" fill="${fill}"/></svg>`;
  await window.fig.writeText(`${root}/plots/zulu-outer.svg`, svg("#d95f02"));
  // A Lighttable collection: sets of aligned images, thousands in the real thing.
  await window.fig.writeText(`${root}/plots/_lighttable/sweepdir/quebec_007.svg`, svg("#1b9e77"));
  await window.fig.writeText(`${root}/plots/_lighttable/sweepdir/smoothing-0.1/quebec_012.svg`, svg("#7570b3"));
  // The other reserved folder, so "_" has two answers.
  await window.fig.writeText(`${root}/plots/_dissections/zulu-outer/quebec_sub.svg`, svg("#e7298a"));
}, ROOT);

const snap = () =>
  page.evaluate(() => {
    const F = window.__flux;
    return {
      open: !!document.querySelector(".importer"),
      rows: [...document.querySelectorAll(".row .nm")].map((n) => n.textContent),
      dirs: [...document.querySelectorAll(".row")]
        .filter((r) => r.querySelector(".ic")?.textContent?.trim() === "📁")
        .map((r) => r.querySelector(".nm")?.textContent),
      cur: document.querySelector(".path .cur")?.textContent ?? "",
      search: document.querySelector(".search-in")?.value ?? "",
      placeholder: document.querySelector(".search-in")?.getAttribute("placeholder") ?? "",
      hint: document.querySelector("[data-reserved-hint]")?.textContent?.trim() ?? "",
      els: F.figures()[0].elements.length,
    };
  });

const altI = async () => {
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyI");
  await page.keyboard.up("Alt");
  await sleep(500); // open() + rAF focus + background scan
};
/** Replace the query: Escape clears a non-empty box (it only closes when already empty). */
const setSearch = async (text) => {
  if ((await snap()).search) {
    await page.keyboard.press("Escape");
    await sleep(120);
  }
  if (text) await page.keyboard.type(text, { delay: 12 });
  await sleep(220); // search is synchronous; this is the Svelte flush + row render
};

await altI();
let s = await snap();
ok(s.open, "importer opens");

// ---- 1. hidden from the browse listing -----------------------------------------
ok(s.rows.includes("zulu-outer"), "an ordinary plot at the plots/ root is listed", s.rows.join(","));
ok(
  !s.dirs.includes("_lighttable") && !s.dirs.includes("_dissections"),
  "neither reserved folder appears as a browse row",
  s.dirs.join(","),
);
ok(/_dissections/.test(s.hint) && /_lighttable/.test(s.hint), "the browse listing says how to reach them", s.hint);

// ---- 2. hidden from search ------------------------------------------------------
await setSearch("quebec");
s = await snap();
ok(s.rows.length === 0, "a plain search reaches NOTHING inside either reserved folder", s.rows.join(","));
await setSearch("zulu");
s = await snap();
ok(s.rows.includes("zulu-outer"), "…while ordinary plots search exactly as before", s.rows.join(","));

// ---- 3. "_" is the way in -------------------------------------------------------
await setSearch("_");
s = await snap();
ok(
  s.dirs.includes("_dissections") && s.dirs.includes("_lighttable"),
  "typing '_' offers both reserved folders as enterable rows",
  s.dirs.join(","),
);
await setSearch("_light");
s = await snap();
ok(
  s.dirs.includes("_lighttable") && !s.dirs.includes("_dissections"),
  "'_light' narrows to the one folder",
  s.dirs.join(","),
);
ok(s.rows[0] === "_lighttable", "…and it is the highlighted row, so Enter enters it", s.rows.join(","));

// ---- 4. entering scopes the search ----------------------------------------------
await page.keyboard.press("Enter");
await sleep(450); // descend: loadDir + a re-scoped background scan
s = await snap();
ok(s.open && s.cur === "_lighttable", `Enter descends into the folder (path shows "${s.cur}")`);
ok(s.search === "", "…and clears the search box, so you land in its listing");
ok(s.dirs.includes("sweepdir"), "the folder's own contents are listed normally", s.dirs.join(","));
ok(/inside _lighttable/i.test(s.placeholder), "the box says the search is now scoped", s.placeholder);

await setSearch("zulu");
s = await snap();
ok(s.rows.length === 0, "a scoped search cannot reach the plots/ root", s.rows.join(","));
await setSearch("quebec");
s = await snap();
ok(
  s.rows.includes("quebec_007") && s.rows.includes("quebec_012"),
  "…and finds this folder's material at every depth",
  s.rows.join(","),
);
ok(!s.rows.includes("quebec_sub"), "…but never the OTHER reserved folder's material", s.rows.join(","));

// ---- 5. reached deliberately, it imports like any plot --------------------------
const before = s.els;
await setSearch("quebec_007");
await page.keyboard.down("Control");
await page.keyboard.press("Enter");
await page.keyboard.up("Control");
await sleep(600);
s = await snap();
ok(!s.open && s.els === before + 1, `Ctrl+Enter imports the highlighted image (${before} → ${s.els})`);

// ---- 6. leaving restores the ordinary scope -------------------------------------
await altI();
await setSearch("_light");
await page.keyboard.press("Enter");
await sleep(450);
await page.keyboard.press("Backspace"); // empty box + empty query → up
await sleep(450);
s = await snap();
ok(s.cur === "" && s.dirs.includes("sweepdir") === false, `Backspace steps back out to plots/ (cur "${s.cur}")`);
await setSearch("zulu");
s = await snap();
ok(s.rows.includes("zulu-outer"), "the ordinary plots/ search works again", s.rows.join(","));
await setSearch("quebec");
s = await snap();
ok(s.rows.length === 0, "…and the reserved folders are hidden again", s.rows.join(","));

await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await sleep(200);

const errs = realErrors(page);
ok(errs.length === 0, "no console/page errors", errs.join(" | "));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);

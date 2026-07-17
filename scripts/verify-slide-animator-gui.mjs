// Animation rework §6/§8 — the ANIMATOR pane (beats rail + properties pane)
// over the live stores. REWRITE of the slide-migration animator gate; the old
// assertions are dispositioned, none dropped silently:
//   • dock on-demand / preview-teardown-rAF / missing-target tolerate+heal /
//     clean console — KEPT verbatim;
//   • "PartsTree quick actions author per-kind defaults" — RE-HOMED onto
//     Ctrl+Shift+A (the same smart-default engine; the S/A/M tree is deleted);
//   • NEW: the rail's chip/expand accordion, chord adds from canvas AND
//     X-ray-equivalent selections, Ctrl+Shift+D exits, group/ungroup with
//     deck-persisted collapse, properties-pane binding, no-tree assertion.
// Run: node scripts/verify-slide-animator-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL, waitFor } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const chord = async (page, key) => {
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await sleep(250);
};

const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  ok(await clickMode(page, "Slide", { settle: 2600 }), "entered Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });

  // dock is OFF by default (on-demand)
  ok(!(await page.evaluate(() => !!document.querySelector(".animator"))), "the Animator dock is on-demand (closed by default)");

  // shapes to animate
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => {
      const fig = p.figures.find((x) => x.id === sid);
      fig.elements.push(
        { type: "rect", id: "anim-rect", name: "Hero", x: 100, y: 100, width: 120, height: 80, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 },
        { type: "ellipse", id: "anim-ell", name: "Moon", x: 300, y: 100, width: 60, height: 60, rotation: 0, fill: "#d0a215", stroke: "none", strokeWidth: 0 },
      );
    });
  });

  // chords are INERT while the dock is closed
  await page.evaluate(() => window.__flux.fig.selectOnly("anim-rect"));
  await chord(page, "KeyA");
  const inert = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    return { beats: o.slides.find((x) => x.id === sid).beats.length, sel: f.get(f.fig.selection).size };
  });
  ok(inert.beats === 1, "⌃⇧A is INERT with the animator closed (no beat authored)");
  ok(inert.sel === 1, "…and never falls through to select-all (the !shiftKey guard)");

  await page.evaluate(() => {
    [...document.querySelectorAll(".deckbar button")].find((b) => /Animate/.test(b.textContent || ""))?.click();
  });
  await waitFor(page, () => !!document.querySelector(".animator"), null, { timeout: 5000, label: "dock open" });
  ok(true, "Animate toggle opens the dock");
  ok(!(await page.evaluate(() => !!document.querySelector(".animator .parts"))), "there is NO parts tree / S-A-M column (everything is visible by default)");
  ok(await page.evaluate(() => !!document.querySelector(".animator .props")), "the Properties mini-pane renders");
  ok(await page.evaluate(() => !!document.querySelector(".animator .beatrail")), "…beside the beats rail");

  // ⌃⇧A on a CANVAS selection authors the per-kind default (rect → popIn)
  await page.evaluate(() => window.__flux.fig.selectOnly("anim-rect"));
  await chord(page, "KeyA");
  const a1 = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const s = o.slides.find((x) => x.id === sid);
    return {
      beats: s.beats.length,
      tracks: s.beats.flatMap((b) => b.tracks).map((t) => ({ target: t.target, preset: t.preset })),
      activeBeat: f.get(f.slide.activeBeat),
      lanes: [...document.querySelectorAll(".beatrail .trk")].length,
    };
  });
  ok(a1.beats === 2 && a1.tracks.some((t) => t.target === "anim-rect" && t.preset === "popIn"),
    "⌃⇧A authored the per-kind default (rect → popIn) on an auto-created build beat (re-homes the old quick-action assertion)");
  ok(a1.activeBeat === 1 && a1.lanes >= 1, "…the beat expanded and the track renders as a lane");

  // ⌃⇧A on an X-RAY-equivalent selection (the X-ray writes the same store)
  await page.evaluate(() => {
    const f = window.__flux;
    f.fig.selection.set(new Set(["anim-ell"]));
  });
  await chord(page, "KeyA");
  const a2 = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    return o.slides.find((x) => x.id === sid).beats.flatMap((b) => b.tracks).some((t) => t.target === "anim-ell" && t.preset === "popIn");
  });
  ok(a2, "⌃⇧A works from a store-written selection identically (the X-ray path writes the same store)");

  // ⌃⇧D adds the exit family — into a LATER beat (an exit in the enter's own
  // beat would family-replace it; exits after enters is the real shape)
  await page.evaluate(() => {
    window.__flux.slide.commitDeckLive((d) => {
      const sid = window.__flux.get(window.__flux.fig.activeFigureId);
      window.__flux.slideOps.addBeat(d, sid, { label: "second" });
    });
    window.__flux.slide.activeBeat.set(2);
  });
  await sleep(200);
  await page.evaluate(() => window.__flux.fig.selectOnly("anim-rect"));
  await chord(page, "KeyD");
  const d1 = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const s = o.slides.find((x) => x.id === sid);
    return { b2: s.beats[2].tracks.map((t) => t.preset), all: s.beats.flatMap((b) => b.tracks).filter((t) => t.target === "anim-rect").map((t) => t.preset) };
  });
  ok(d1.b2.includes("popOut"), `⌃⇧D added the per-kind exit (rect → popOut) into the active beat (${d1.b2.join(",")})`);
  ok(d1.all.includes("popIn") && d1.all.includes("popOut"), `…coexisting with the enter across beats (${d1.all.join(",")})`);
  await page.evaluate(() => window.__flux.slide.activeBeat.set(1));
  await sleep(200);
  const rail = await page.evaluate(() => ({
    chips: [...document.querySelectorAll(".beatrail .beat-c")].length,
    expanded: [...document.querySelectorAll(".beatrail .beat-x")].length,
  }));
  ok(rail.expanded === 1, "exactly ONE beat renders expanded (the accordion)");
  ok(rail.chips >= 2, `the other beats render as chips (${rail.chips})`);
  const expandSwitch = await page.evaluate(() => {
    const chips = [...document.querySelectorAll(".beatrail .beat-c")];
    const last = chips[chips.length - 1];
    last.click();
    return Number(last.dataset.beatIndex);
  });
  await sleep(200);
  const railAfter = await page.evaluate(() => ({
    active: window.__flux.get(window.__flux.slide.activeBeat),
    expandedIdx: Number(document.querySelector(".beatrail .beat-x")?.dataset.beatIndex),
  }));
  ok(railAfter.active === expandSwitch && railAfter.expandedIdx === expandSwitch, "clicking a chip expands THAT beat (activeBeat follows)");
  await page.evaluate(() => window.__flux.slide.activeBeat.set(1));
  await sleep(200);

  // properties pane binds the selected track
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const t = o.slides.find((x) => x.id === sid).beats[1].tracks.find((tk) => tk.target === "anim-rect");
    f.slide.selTrackIds.set([t.id]);
  });
  await sleep(200);
  const propsBound = await page.evaluate(() => {
    const dur = document.querySelector('.props [data-fld="d"]');
    return dur ? Number(dur.value) : null;
  });
  ok(propsBound === 300, `the Properties pane binds the selected track (duration ${propsBound})`);
  await page.evaluate(() => {
    const dur = document.querySelector('.props [data-fld="d"]');
    dur.value = "760";
    dur.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(200);
  const propsWrote = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    return o.slides.find((x) => x.id === sid).beats[1].tracks.find((tk) => tk.target === "anim-rect")?.duration;
  });
  ok(propsWrote === 760, "…and edits write back to the track (duration 760)");

  // group / ungroup + deck-persisted collapse
  const gState = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const beat = o.slides.find((x) => x.id === sid).beats[1];
    const ids = beat.tracks.map((t) => t.id).filter(Boolean);
    f.slide.selTrackIds.set(ids);
    f.slide.commitDeckLive((d) => {
      const b = window.__flux.slideOps.slideById(d, sid).beats[1];
      window.__flux.slideOps.groupTracks(d, sid, b.id, ids, "X-axis build");
    });
    const after = f.get(f.slide.deckOverlay).slides.find((x) => x.id === sid).beats[1];
    return { groups: after.groups?.length ?? 0, label: after.groups?.[0]?.label, memberRefs: after.tracks.filter((t) => t.groupId).length };
  });
  ok(gState.groups === 1 && gState.label === "X-axis build" && gState.memberRefs >= 2, "⌘G groups the selected lanes under a labeled TrackGroup");
  await sleep(200);
  ok(await page.evaluate(() => !!document.querySelector(".beatrail .grp-row")), "…the group renders as a header row");
  await page.evaluate(() => document.querySelector(".beatrail .grp-row .chev")?.click());
  await sleep(250);
  const collapsed = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const beat = o.slides.find((x) => x.id === sid).beats[1];
    return {
      persisted: beat.groups?.[0]?.collapsed === true,
      laneCount: [...document.querySelectorAll(".beatrail .trk")].length,
    };
  });
  ok(collapsed.persisted, "collapse state persists in the DECK model (Beat.groups[].collapsed)");
  ok(collapsed.laneCount === 0, "…and the collapsed group hides its member lanes (one span row instead)");
  await page.evaluate(() => document.querySelector(".beatrail .grp-row .chev")?.click());
  await sleep(200);

  // --- Phase-4 properties: TRIM controls (drawOn) --------------------------------
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const t = o.slides.find((x) => x.id === sid).beats[1].tracks.find((tk) => tk.target === "anim-rect");
    f.slide.selTrackIds.set([t.id]);
  });
  await sleep(150);
  await page.evaluate(() => {
    const sel = document.querySelector('.props [data-fld="p"]');
    sel.value = "drawOn";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(200);
  ok(await page.evaluate(() => !!document.querySelector(".props .trim")), "a drawOn track shows the Trim path controls");
  await page.evaluate(() => {
    [...document.querySelectorAll(".props .trim .sg2")].find((b) => /both ends/.test(b.textContent || ""))?.click();
  });
  await page.evaluate(() => {
    [...document.querySelectorAll(".props .trim .pb")].find((b) => b.title?.includes("the tr corner"))?.click();
  });
  await sleep(200);
  const trimWrote = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const t = o.slides.find((x) => x.id === sid).beats[1].tracks.find((tk) => tk.target === "anim-rect");
    return t.params;
  });
  ok(trimWrote?.mode === "both-ends" && trimWrote?.anchor === "corner-tr", `trim controls write Track.params (${JSON.stringify(trimWrote)})`);
  await page.evaluate(() => {
    [...document.querySelectorAll(".props .trim .sg2")].find((b) => /single/.test(b.textContent || ""))?.click();
  });
  await sleep(150);
  const trimDefaults = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const t = o.slides.find((x) => x.id === sid).beats[1].tracks.find((tk) => tk.target === "anim-rect");
    return t.params;
  });
  ok(trimDefaults?.mode === undefined && trimDefaults?.anchor === "corner-tr", "a param set back to its DEFAULT deletes the key (legacy compile path preserved)");

  // writeOn direction select
  await page.evaluate(() => {
    const sel = document.querySelector('.props [data-fld="p"]');
    sel.value = "writeOn";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(200);
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll(".props select")].find((s) => [...s.options].some((o) => /left → right/.test(o.textContent || "")));
    sel.value = "btt";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(150);
  const wipeDir = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    return o.slides.find((x) => x.id === sid).beats[1].tracks.find((tk) => tk.target === "anim-rect")?.params?.direction;
  });
  ok(wipeDir === "btt", "writeOn's direction select writes params.direction");

  // --- Phase-4 properties: transform Δ chips + clear ------------------------------
  const deltaSetup = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    let tid = "";
    f.slide.commitDeckLive((d) => {
      const b = f.slideOps.slideById(d, sid).beats[1];
      const t = f.slideOps.setTransform(d, sid, b.id, "anim-ell", { state: { x: 500, fill: "#111111" } });
      tid = t?.id ?? "";
    });
    f.slide.selTrackIds.set([tid]);
    return tid;
  });
  await sleep(200);
  const deltaChips = await page.evaluate(() => [...document.querySelectorAll(".props .dchip")].map((c) => c.textContent?.replace("✕", "").trim()));
  ok(deltaChips.includes("x") && deltaChips.includes("fill"), `the transform Δ summary lists the captured props (${deltaChips.join(",")})`);
  await page.evaluate(() => {
    [...document.querySelectorAll(".props .dchip")].find((c) => c.textContent?.includes("fill"))?.querySelector(".dx")?.click();
  });
  await sleep(150);
  const afterDrop = await page.evaluate((tid) => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    return o.slides.find((x) => x.id === sid).beats.flatMap((b) => b.tracks).find((t) => t.id === tid)?.to?.state;
  }, deltaSetup);
  ok(afterDrop?.x === 500 && !("fill" in (afterDrop ?? {})), "✕ drops ONE captured prop from to.state");
  await page.evaluate(() => document.querySelector(".props .dclear")?.click());
  await sleep(150);
  const afterClear = await page.evaluate((tid) => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    return o.slides.find((x) => x.id === sid).beats.flatMap((b) => b.tracks).find((t) => t.id === tid)?.to?.state;
  }, deltaSetup);
  ok(afterClear && Object.keys(afterClear).length === 0, "clear t₂ resets the patch (t₂ ≡ t₁)");

  // --- Phase-5: preset save → library apply -------------------------------------
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const t = o.slides.find((x) => x.id === sid).beats[1].tracks.find((tk) => tk.target === "anim-rect");
    f.slide.selTrackIds.set([t.id]);
  });
  await sleep(200);
  await page.evaluate(() => document.querySelector(".props .saveas")?.click());
  await sleep(150);
  await page.evaluate(() => {
    const inp = document.querySelector(".props .psave input");
    inp.value = "My Reveal";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector(".props .psave button")?.click();
  });
  await sleep(300);
  const savedPreset = await page.evaluate(() => JSON.parse(localStorage.getItem("flux.presets.animations") || "[]"));
  ok(savedPreset.length === 1 && savedPreset[0].payload?.name === "My Reveal" && !savedPreset[0].payload?.track?.target,
    "Save-as-preset stores the track's reusable settings (no binding) in the machine library");
  await page.evaluate(() => {
    window.__flux.fig.selectOnly("anim-ell");
    [...document.querySelectorAll(".animator .bar button")].find((b) => /Library/.test(b.textContent || ""))?.click();
  });
  await waitFor(page, () => !!document.querySelector(".animlib"), null, { timeout: 5000, label: "library open" });
  await page.evaluate(() => {
    [...document.querySelectorAll(".animlib .apply")].find((b) => /My Reveal/.test(b.textContent || ""))?.click();
  });
  await sleep(300);
  const applied = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const tracks = o.slides.find((x) => x.id === sid).beats[1].tracks.filter((t) => t.target === "anim-ell");
    return tracks.map((t) => ({ preset: t.preset, duration: t.duration, dir: t.params?.direction }));
  });
  ok(applied.some((t) => t.preset === "writeOn" && t.duration === 760 && t.dir === "btt"),
    `the library preset applied its exact settings to the new selection (${JSON.stringify(applied)})`);

  // --- Phase-5: template save from lanes → apply onto a fresh shape set ----------
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    // a fresh pair to receive the template
    f.fig.commit((p) => {
      const fig = p.figures.find((x) => x.id === sid);
      fig.elements.push(
        { type: "rect", id: "tpl-rect", x: 400, y: 200, width: 50, height: 40, rotation: 0, fill: "#333", stroke: "none", strokeWidth: 0, cornerRadius: 0 },
        { type: "ellipse", id: "tpl-ell", x: 470, y: 200, width: 40, height: 40, rotation: 0, fill: "#555", stroke: "none", strokeWidth: 0 },
      );
    });
    const o = f.get(f.slide.deckOverlay);
    const b1 = o.slides.find((x) => x.id === sid).beats[1];
    const ids = b1.tracks.filter((t) => t.target === "anim-rect" || t.target === "anim-ell").map((t) => t.id).slice(0, 2);
    f.slide.selTrackIds.set(ids);
  });
  await sleep(200);
  // applying a preset closes the popover (by design) — reopen for templates
  await page.evaluate(() => {
    if (!document.querySelector(".animlib")) {
      [...document.querySelectorAll(".animator .bar button")].find((b) => /Library/.test(b.textContent || ""))?.click();
    }
  });
  await waitFor(page, () => !!document.querySelector(".animlib"), null, { timeout: 5000, label: "library reopen" });
  await page.evaluate(() => {
    [...document.querySelectorAll(".animlib .tab")].find((b) => /Templates/.test(b.textContent || ""))?.click();
  });
  await sleep(150);
  await page.evaluate(() => {
    const inp = document.querySelector(".animlib .save input");
    inp.value = "Pair build";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    [...document.querySelectorAll(".animlib .save button")].find((b) => /Save selection/.test(b.textContent || ""))?.click();
  });
  await sleep(300);
  const savedTpl = await page.evaluate(() => JSON.parse(localStorage.getItem("flux.presets.animTemplates") || "[]"));
  ok(savedTpl.length === 1 && savedTpl[0].payload?.slots?.length === 2, "Save-selection derived a 2-slot template from the lanes");
  await page.evaluate(() => {
    const f = window.__flux;
    f.fig.selection.set(new Set(["tpl-rect", "tpl-ell"]));
    [...document.querySelectorAll(".animlib .apply")].find((b) => /Pair build/.test(b.textContent || ""))?.click();
  });
  await sleep(350);
  const tplApplied = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const b1 = o.slides.find((x) => x.id === sid).beats[1];
    const bound = b1.tracks.filter((t) => t.target === "tpl-rect" || t.target === "tpl-ell");
    const grouped = bound.every((t) => t.groupId) && new Set(bound.map((t) => t.groupId)).size === 1;
    const g = b1.groups?.find((x) => x.id === bound[0]?.groupId);
    return { n: bound.length, grouped, label: g?.label };
  });
  ok(tplApplied.n === 2 && tplApplied.grouped && tplApplied.label === "Pair build",
    `the template bound onto the fresh pair as ONE labeled TrackGroup (${tplApplied.n} tracks, "${tplApplied.label}")`);

  // Preview plays via the player, then tears down — and NO rAF loop survives
  await page.evaluate(() => {
    window.__rafCount = 0;
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      window.__rafCount++;
      return orig(cb);
    };
  });
  await page.evaluate(() => {
    [...document.querySelectorAll(".animator .bar button")].find((b) => /Preview/.test(b.textContent || ""))?.click();
  });
  await waitFor(page, () => !!document.querySelector(".preview-overlay"), null, { timeout: 5000, label: "preview overlay" });
  ok(true, "Preview swaps the stage to the player (present-in-place)");
  await waitFor(page, () => !document.querySelector(".preview-overlay"), null, { timeout: 20000, label: "preview auto-stop" });
  ok(true, "…and returns to the static editor at rest when the build ends");
  const raf = await page.evaluate(async () => {
    window.__rafCount = 0;
    await new Promise((r) => setTimeout(r, 700));
    return window.__rafCount;
  });
  ok(raf <= 6, `no continuous main-thread rAF loop after preview teardown (${raf} calls in 700ms — E43)`);

  // delete the track's target element → the lane marks MISSING, nothing crashes.
  // Blur the dock first: with dock focus, Delete is the COCKPIT's delete-tracks
  // (this key intentionally has two scopes).
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    document.body.focus();
    window.__flux.slide.selTrackIds.set([]);
    window.__flux.fig.selectOnly("anim-rect");
  });
  await page.keyboard.press("Delete");
  await sleep(500);
  const missing = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    const o = f.get(f.slide.deckOverlay);
    const s = o.slides.find((x) => x.id === sid);
    return {
      trackKept: s.beats.flatMap((b) => b.tracks).some((t) => t.target === "anim-rect"),
      missChip: !!document.querySelector(".beatrail .trk.missing"),
      elGone: !f.get(f.fig.project).figures.find((x) => x.id === sid).elements.some((e) => e.id === "anim-rect"),
    };
  });
  ok(missing.elGone, "the element deleted through the figure editor");
  ok(missing.trackKept, "…its track is KEPT (never auto-pruned — undo restores the pair)");
  ok(missing.missChip, "…and the lane shows the missing-target marker");

  await page.keyboard.down("Control");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Control");
  await sleep(400);
  const healed = await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    return {
      back: f.get(f.fig.project).figures.find((x) => x.id === sid).elements.some((e) => e.id === "anim-rect"),
      missChip: !!document.querySelector(".beatrail .trk.missing"),
    };
  });
  ok(healed.back && !healed.missChip, "undoing the deletion heals the track (marker gone) — the tolerate-don't-prune payoff");

  const errs = realErrors(page);
  ok(errs.length === 0, "console is clean", errs.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
console.log(fails ? `\nSLIDE ANIMATOR GUI: FAIL (${fails})` : "\nSLIDE ANIMATOR GUI: PASS");
process.exit(fails ? 1 : 0);

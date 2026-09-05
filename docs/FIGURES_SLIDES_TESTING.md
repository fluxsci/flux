# Testing the figure and slide overhaul

Work is on `codex/figures-slides-overhaul`. Quit an older running Flux instance,
then run `npm run electron:build` from the repository to launch this branch.

A disposable project is prepared at `test-results/figures-slides-playground`.
It has two linked figures, a manuscript, and five animation scenarios. To create
another fresh copy, run:

```sh
npx tsx scripts/create-overhaul-playground.ts /path/to/a/new-directory
```

Open the project folder in Flux. The generator refuses to overwrite an existing
project. Your existing projects are not needed for these checks.

Existing figure IDs and reference keys are preserved. Titles and publication
numbers can change without changing those keys; manuscript order never assigns
figure numbers. A figure sent to Slide has its own editable composition while
its linked plot data continues to update automatically.

## Figures and Paper

1. Open **Figure → All…**. Search for “Growth”, edit its title, and copy its
   permanent reference. Inspect its preview, source, and **Used in** links.
2. Use **Numbering** to change its designation. Follow **Used in** to Paper:
   the reference follows the same figure and displays its current number.
3. Reorder the manuscript paragraphs. Its initial prose deliberately references
   Figure 2 before Figure 1. Paper order must have no effect on either figure.
4. Edit a linked SVG in the playground's `plots/` directory. Figure, Paper, and
   Slide should pick it up automatically. Try **Freeze**, regenerate again, and
   confirm the frozen usage stays fixed while linked usages update.
5. Try deleting a referenced figure. Review the displayed uses, then cancel.

## Slides

Open the **Figures & slides playground** deck and turn on **Animate**.

1. **Reveal, leave, re-enter:** inspect Start and each named step. Try Play,
   Pause, ruler scrubbing in both directions, Stop, and replay.
2. **Semantic scatter build:** select and hover timing lanes, inspect their plot
   targets, retime and group effects, and undo the gesture.
3. **Chained data morph:** play A → B → C, then scrub backward. The second morph
   must begin at B, with the same data state in the editor and presentation.
4. **Transform chain + camera:** choose **Edit after step**, change the object,
   and return to Design. Earlier states must remain intact. Test Undo/Redo while
   a preview is paused.
5. **Concurrent appearance + transform:** inspect position, rotation, and
   opacity as both effects run together.
6. Export the deck and open the HTML in a browser. Rehearse with arrow keys;
   compare the result with Flux's Present mode.

A self-contained export is already prepared at
`test-results/figures-slides-playground/exports/animation-review.html`.

For older decks with no recorded source dimensions, the first load establishes
the baseline from the current source. Subsequent updates preserve the placement's
physical scale, including when the deck is closed and across Undo/Redo.

Full behavior references: [Figure](modes/figure.qmd) and [Slide](modes/slide.qmd).

## Verification completed

On 2026-09-05, the branch passed:

- `npm run check`: 0 errors and 0 warnings; `npm run build`: successful.
- Complete core suite: **193/193 scripts**.
- Complete Paper regression suite: **42/42 scripts**.
- Production bundle and startup checks: **4/4 scripts**.
- Real Electron source synchronization: **35/35 assertions** across two app launches.
- Targeted Figure/Slide authoring, history, tenancy, source, camera, playback and
  offline export checks, plus both performance fixtures below.

A synthetic legacy preservation fixture covers 1,200 figures on 40 canvases and
3,600 manuscript references, checking IDs, keys, captions, geometry and asset bytes
through saving and reopening. All testing used disposable projects.

## Measured responsiveness

Measured in a visible Brave browser on this Mac, with the existing performance
budgets unchanged. The dense fixture has 1,200 plot points and 120 authoring
tracks; both fixtures verify actual moving geometry and reverse scrubbing.

| Interaction, p95 | Normal (31 slides) | Dense (13 slides) |
|---|---:|---:|
| Switch slide | 9.5 ms | 16.7 ms |
| Edit on stage | 18.5 ms | 18.5 ms |
| Select/retime animation | 10.5 ms | 11.5 ms |
| Scrub | 10.3 ms | 10.3 ms |
| Playback frame spacing | 10.3 ms | 10.3 ms |

The largest measured authoring interaction was 29 ms. Playback had no frame over
25 ms in the normal fixture; the dense run had two (83.5 ms at startup and
50.3 ms during playback). Both passed the unchanged 17 ms p95 frame gate, had
zero animation callbacks while idle, and redrew one thumbnail per edit.

The headless browser's idle timing control itself exceeded that frame budget
(18.1 ms p95), so real-display runs were used for the timing results above.
Reproduce with `FLUX_HEADFUL=1` and `FLUX_CHROME` pointing to an installed Chromium
browser, then run `node scripts/verify-scale-slide.mjs` and
`node scripts/verify-scale-slide-dense.mjs` separately.

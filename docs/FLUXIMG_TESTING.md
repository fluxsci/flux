# Trying images and image stacks (fluximg)

A walk through the first build of fluximg in the app, with synthetic test bundles. Each line says
what to do and what should happen. The user page is `docs/concepts/images.qmd`; the gates are
`node scripts/run-verifies.mjs --group fluximg` (§7 of the engineering guide).

## Test bundles

Write the reference bundles into a scratch folder, then copy some into a saved Flux project's
`plots/` folder:

```sh
node --import tsx scripts/fluximg-fixtures.ts /tmp/fluximg-fixtures
cp -r /tmp/fluximg-fixtures/{stack_u16,movie_f32,mean_f64_layers,mid_tiled_u16,rgb_u8,hdr_f32}.fluximg <project>/plots/
```

| Bundle | What it is |
|---|---|
| `stack_u16` | two channels (structure, signal), 7 z planes at −61.5 … −55.5 µm, 64 × 48 px, 0.25 µm pixels; opens at z 4 |
| `movie_f32` | a float movie, 24 frames at 80 Hz, two channels, stored compactly, no data outside two rectangles |
| `mean_f64_layers` | a 2-D two-channel image with two image layers, a labels layer with a table, two shape layers and a region |
| `mid_tiled_u16` | 1300 × 1100 px, two channels, stored as tiles with one overview |
| `rgb_u8` | an RGB photograph |
| `hdr_f32` | float data whose compact copy was refused: stored exactly |

A real check also wants one stack written by fluxplot (`fp.imsave`, docs/concepts/images.qmd)
and one large one (2048 × 2048 or more, tens of planes).

## Placing

1. Open the Plots rail in Figure. **Each bundle is one tile** marked ▦, with a picture on a dark
   backdrop; hovering or **Space** shows a line such as "2 channels · 7 z · 64 × 48 · uint16".
   Nothing inside a bundle folder is listed.
2. Make a folder `plots/broken.fluximg` with no `fluximg.json` in it. **It is listed, and its tile
   says why it has no picture.**
3. Double-click `stack_u16`. **It lands on the active figure at one image pixel per canvas pixel**
   (64 × 48 canvas px), showing z 4 in magenta and green.
4. Place `stack_u16` again (drag the tile onto the figure). **A second element appears; the
   project still holds one copy** (`fig/assets/` has one `*.fluximg` folder for it).
5. Place `mid_tiled_u16` on a narrow figure. **It is narrowed to the figure's width.** It shows a
   soft draft at once, then sharpens.
6. **Import** (**Ctrl+Shift+K**), choose `plots/rgb_u8.fluximg/fluximg.json`. **The photograph is
   placed in true colour.**
7. Drag a `.fluximg` folder from the file manager onto a figure. **It is placed** (desktop app
   only).
8. Switch to Slide and try to place a bundle. **It is refused**: "N-dimensional images (fluximg)
   cannot be placed on slides yet: keep them in a figure."
9. In a new, unsaved figure outside a project, try to place one. **Refused before anything is
   copied**, with a message to open or create a project.

## The live view

10. Select a `stack_u16` element, press **R**. **Rails appear (Depth at the image's right side),
    a panel opens beside the image, and a readout line sits below it.** The Depth row is armed.
11. Double-click the other `stack_u16` element. **Its live view opens** (the first one closes).
12. Roll the wheel over the image. **Wheel down moves to the next plane**; the rail's playhead,
    the panel's Depth row ("4/7 · −58.5 µm") and the picture follow at once. **Shift+wheel** moves
    ten (clamped to the stack). **↑ / ↓** step through depth.
13. Drag along the Depth rail. **The picture scrubs**; release, then **Ctrl+Z**: **the whole drag
    undoes as one step.** A run of wheel notches is one step too.
14. Hover the image. **The readout shows x and y in µm and each channel's value under the
    pointer.**
15. Press **e**, then **2** (max). **A maximum projection over all 7 planes**; the rail shows a
    band and the panel "max over 7 planes". Roll the wheel: **the run narrows / widens around its
    middle.** Drag the band's edges and its inside; **Shift**-drag elsewhere on the rail draws a
    new run. **e**, **1** (plane): **back to the plane in the middle of the run.**
16. Press **1** (channel structure). **The channel zone opens with its histogram and three
    fields.** Drag the white handle: **the picture brightens/darkens live.** Type `2000` in White
    point, **Enter**: kept. Type `5`, **Escape**: the previous value comes back.
17. Press **a** repeatedly in the channel zone. **The window steps 1–99 %, full range, 0.1–99.9 %,
    1–99.8 % and round** (the image starts at 1–99.8 %).
18. **c** then a colour; **g** cycles Linear → Log → Gamma (**a gamma note appears**; with Log and
    a black point at 0, **a note says it is drawn linear**); **z** inverts; **x** hides the
    channel; **v** solos it (again: back to both); **d** resets it.
19. **Escape**: back to the panel's home. **a**: Auto for every channel.
20. **x** at home: **two new panels to the right, one per channel, each in gray with its name**;
    one **Ctrl+Z** removes both.
21. **b**, **w**, **c**, **g**: **scale bar (bottom right), position stamp ("z …",
    top left), channel names (top right), calibration bar (bottom left) appear and go.**
22. **n**: the Pixels row toggles **true pixels / smoothed**; zoom the canvas in to see it.
23. **v** (Frame): roll the wheel over the image: **the image zooms inside its box around the
    pointer; the box does not move.** Drag: **the image moves under the frame.** **x**: **an
    inset panel appears to the right with a scale bar, the original returns to its earlier frame
    and outlines the inset's region.** **d** in the Frame zone: whole image again.
24. Place `movie_f32`, press **R**. **Time is a rail below the image.** **Space**: **plays in real
    time, 80 planes a second** (a 60 Hz screen shows 60 of them; the rail's ▶ does the same); **Escape** stops it. **← / →** step.
25. Place `mean_f64_layers`, **R**, then **d**. **Layers & objects lists five layers, top
    first.** On the synapse footprints row, **→ opens its objects with their table columns.** Hover a row: **its
    object is outlined on the image.** Hover an object on the image: **its row is found.**
    **a** and type part of a name or value: **the list filters.** **x** shows/hides,
    **e** then the wheel changes opacity, **c** colours, **q** turns object names on,
    **Shift+↑ / ↓** reorders.
26. **R** closes the view; so does clicking elsewhere on the canvas, or **Escape** from home.
    **The element keeps exactly what was set** (its still matches the last live frame).
27. While the view is open, **Ctrl+Z / Ctrl+Shift+Z** step through the gestures; plain keys never
    reach canvas shortcuts (no nudge, no delete).

## The Inspector

28. Select a `stack_u16` element (no live view). **Sections Image, Channels, Position,
    Annotations and View** (Layers only for an image with layers). Image says the size per
    pixel, "Stored exactly (uint16)" and the source path; on `movie_f32` it says "Stored
    compactly: 16-bit steps of the float32 values".
29. Type a White value: **the picture changes; one undo step.** Scrub a field with the wheel:
    **one undo step for the run.**
30. Type the image's default window back: **the key disappears from the stored view** (an
    all-default view leaves the element with no `view` in `fig/canvases/*.json`).
31. Position: change the plane; choose Maximum and a From/To run; toggle scale bar, stamp,
    channel names, calibration bar; Pixels True/Smoothed; Background Transparent; Region shown
    X/Y/W/H. **Each shows at once; the live view (if open) agrees.**
32. **Live view R** button in the Image header **opens the live view**; on a locked element it
    is disabled with "Unlock and show the image to open it".

## Exports and other outputs

33. Export the figure as SVG and PDF. **Each image is drawn at 300 dpi at its printed size;
    zoom in on a small image in a PDF viewer: sharp pixels, not blur. Layers, names, scale bar
    and stamps are vectors** (selectable text in the SVG).
34. Export PNG at a high dpi. **The image is drawn at that dpi from the full-resolution pixels**
    (for `mid_tiled_u16`, not from its overview).
35. Embed the figure in a Paper document. **The images show there**, with the same view.
36. Headless: `flux render-figure <figId> --png --out /tmp/f.png`. **Same picture as the app.**
37. Move a placed bundle's asset folder away and render: **a dark stand-in with the image's name,
    and a warning naming the reason**; the figure still renders.

## Update from source

38. With the project open, replace `plots/stack_u16.fluximg` with new content (re-run a fluxplot
    script that writes it, or copy another bundle to a temporary name and rename it into
    place). **Every element placed from it updates within about a second and keeps its view.**
    If the new image has fewer planes or channels, **a notice says what was adjusted.** One
    **Ctrl+Z** brings back the previous version.

## Agents

39. `flux image-info <elementId>`: **dims with units and positions, channels with percentiles,
    layers, and the element's view in words ("z 4/7 · −58.5 µm").**
40. `flux set-image-view <elementId> --view '{"projection":{"dim":"z","mode":"max","from":0,"to":7}}'`
    with the app open: **the element shows the projection at once.** A bad key (`{"index":{"t":0}}`
    on the z-stack): **refused, naming the problem; nothing written.**
41. `flux place-image <figId> plots/stack_u16.fluximg`: **placed, `reused: true`** (same content
    already in the project).

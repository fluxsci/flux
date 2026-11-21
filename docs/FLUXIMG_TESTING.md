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

10. Select a `stack_u16` element, press **R**. **The image wears a pink frame with corner marks
    and its control board stands round it: no menu opens.** Depth is a rail at the image's left
    (a plot of the stack, a pink playhead with a dot on each channel's trace, a paper flag
    "4 · −58.5 µm"). The console is at its right: the image's name with a pink lamp, "7 z ·
    64 × 48 · 0.25 µm/px", one strip per channel (a lamp with its digit, its name, its window in
    numbers, its histogram with two pink handles) and a row of paper keys. The blue selection
    box and its handles are gone while the view is open.
11. Double-click the other `stack_u16` element. **Its live view opens** (the first one closes).
12. Rest the pointer on a paper key, a lamp, the rail's **Z**. **A small paper label names the
    thing and its key** ("Scale bar  B"); it leaves with the pointer.
13. Roll the wheel over the image. **Wheel down moves to the next plane**; the playhead, its flag
    and the picture follow at once, and each strip's histogram changes with the plane (it is of
    the pixels on screen; the faint outline behind it is the whole image's). **Shift+wheel**
    moves ten (clamped to the stack). **↑ / ↓** step through depth.
14. Rest on the Depth rail. **A dark flag names the plane under the pointer and its position**; a
    click goes there. Drag along the rail: **the picture scrubs**; release, then **Ctrl+Z**:
    **the whole drag undoes as one step.** A run of wheel notches is one step too.
15. Move the pointer over the image. **The console's head shows x and y in µm, every strip marks
    that pixel's value on its histogram (a tick and the number), and four small ticks on the
    frame ride with the pointer.** Off the image: **the head says what the image is again.**
16. Press **e**. **A row of paper chips opens on the rail** (off, max, mean, min, sum, std).
    Press **2** (max): **a maximum projection over all 7 planes**; the rail shows a pink band
    with a grip at each end, the flag reads "max 1–7", the projection key is lit and the play
    key is gone. Roll the wheel: **the run narrows / widens around its middle.** Drag a grip and
    the band's inside; **Shift**-drag elsewhere on the rail draws a new run. **e**, **1** (off):
    **back to the plane in the middle of the run.**
17. On the structure strip, drag the right pink handle: **the picture brightens / darkens live
    and the strip's white number follows.** Drag between the handles: **the window slides.**
    Roll the wheel over the plot near a handle: **that point moves.** Double-click the plot:
    **Auto for that channel alone.** Click the white number, type `2000`, **Enter**: kept. Click
    it again, type `5`, **Escape**: dropped. None of this takes the channel in hand: **the wheel
    over the image still steps planes.**
18. Click the structure strip's lamp. **The channel is hidden; its strip goes dim and its lamp is
    a ring.** **Shift+1** shows it again. **Alt+1**: **only that channel**; again: both.
19. Press **1**. **The strip is outlined pink: the channel is in hand.** Roll the wheel anywhere:
    **its white point moves.** Press **1** again (black point), again (gamma), again (white).
    Drag on the image: **right narrows the window about its centre, left widens it; up
    brightens, down darkens**, and the window stops at the channel's own lowest and highest
    values. **Ctrl+Z** undoes the whole drag. **Escape**: **the strip lets go; the view stays
    open and the wheel over the image moves through depth again.**
20. Rest the pointer on the **Auto** key. **Each strip shows, dashed, where its two points would
    go; nothing changes.** Press **a** repeatedly: **every window steps through 0.1–99.9 %,
    1–99.8 % and 1–99 % of the pixels in view, then their full range, and round** (a step that
    would give the window already on screen is skipped). With a channel in hand (**1**), **a**
    is that channel's alone.
21. Rest on a strip: **its own keys come out.** The curve key steps Linear → Log → Gamma (with a
    black point at 0, Log says it is drawn linear until the black point is above 0). **The
    paper line across the plot is the transfer curve; pull its dot up or down and it bends
    (gamma).** The colour key opens a drawer of swatches under the plot: pick one; **Invert**
    inverts; the last key puts the channel back to how the image came.
22. Rest on the **Split** key. **Dashed pink boxes on the figure show where each channel's panel
    would go, each with its name.** Press it (or **s**): **two new panels to the right of the
    image, one per channel, each in gray with its name**; one **Ctrl+Z** removes both.
23. Press **b**, **w**, **c**, **g**. **Scale bar (bottom right), position stamp ("z …", top
    left), channel names (top right) and calibration bar (bottom left) appear, and their keys
    light.** Drag the scale bar toward another corner: **the four corners are marked and it
    lands in the one under the pointer; the whole carry is one undo step.** **Shift+b** four
    times walks it round the corners and back. Roll the wheel over the scale bar: **its length
    steps through round values (1, 2, 5, 10 …).** Roll it over the stamp: **its text grows or
    shrinks half a point a notch.** Press the four keys again: gone.
24. Press **v**. **The frame's corners thicken into handles and a small map appears in the
    console.** Roll the wheel up over the image: **the image zooms inside its box around the
    pointer; the box does not move; the map shows the frame as a pink rectangle and dims the
    rest**, with how far in it is ("2.5×") and the pixels shown. Drag on the image: **it moves
    under the frame.** Drag the rectangle on the map, press elsewhere on the map, roll the
    wheel over it. **n** switches **true pixels / smoothed** (zoom the canvas in to see it).
    **Escape**: **the frame lets go and stays zoomed in; a drag on the image still moves it.**
    **Shift+V**: **the whole image again, the box keeps its place and width, and the map
    leaves.**
25. Press **x**. **The Inset key is lit; nothing is made yet.** Drag a box on the image: **a
    dashed pink guide follows the drag; on release an inset panel with a scale bar appears
    beside the image (to the right, or below when the right has no room), the image keeps its
    frame and outlines the inset's region, and a message says where the inset went.** The tool
    lets go by itself. Rest on the region's rectangle on the image: **its edge lights pink.**
    Drag the edge: **the region moves and the inset panel shows what is under it as you go.**
    Roll the wheel over the edge: **the region shrinks or grows about its middle.** Inside the
    rectangle the image still reads out.
26. **v**, zoom in with the wheel, then press **x** twice. **An inset of the frame as it is
    appears, and the image shows the whole of itself again.**
27. Place `mid_tiled_u16` on a narrow figure (as in step 5, so it is as wide as the figure),
    press **R** and rest on **Split**. **The dashed boxes are inside the image's own box, as a
    grid, the image first.** Press it: **nothing lies outside the figure**, and the message
    says they share its place. **Ctrl+Z**.
28. On the same image, with the figure no taller than the image (no room below either): **x**
    and drag a box. **The inset stands on the image in its top-right corner at two fifths of the
    image's height; the live view closes with the inset selected, and the message says "Inset
    placed on the image".**
29. Place `movie_f32`, press **R**. **Time is a rail under the image, like an x axis, with a
    round play key.** **Space**: **plays in real time, 80 planes a second** (a 60 Hz screen
    shows 60 of them); the play key is lit and its ring fills as the movie goes by. Click the
    small **1×** dial beside it: **2×**; roll the wheel over it both ways. **Escape** stops the
    movie. **← / →** step.
30. Place `mean_f64_layers`, **R**. **A layers card lists five layers, top first, each with a
    lamp in its colour.** Click a lamp: the layer hides. Click the synapse footprints row: **its
    objects open with their table columns.** Rest on an object's row: **it lights up on the
    image.** Rest on an object on the image: **its row lights, and a card beside the pointer
    names it, its layer, its table's values and the pixel's.** Type in the filter: the list
    narrows. Rest on a layer's row and roll the wheel over its **%** (or drag it sideways):
    opacity. Press **d**: **the card is outlined pink and has the keys** (**↑ / ↓**, **x**,
    **e**, **c**, **q**, **Shift+↑ / ↓**); **Escape** gives them back.
30b. Still on `mean_f64_layers`: rest on the synapse footprints row and press its **colour by**
    key. **The table's columns appear as keys, each with a picture.** Rest on **dendrite**: **the
    outlines take two colours on the image, the one without a dendrite grey; nothing is written
    yet.** Press it: kept, one undo step. Press **opacity by**, then **pixels**: **the smaller
    objects are fainter.** Drag the strip's pink handles, roll the wheel over it. Press the
    **key** beside the filter: **a key with d1, d2 and "no value" appears on the image**; drag it
    to another corner, rest on d1: **its two objects light up.** **R** closes: the element at rest
    shows the same colours; an SVG export carries them.
31. Pan the canvas (Space-drag) so the image is at its left edge, then its right edge; zoom the
    canvas in (**Ctrl** + wheel) until the image fills the window. **The rail and the console
    change sides as their room goes, and stand over the image's edges only when it fills the
    window; no instrument ever covers another, and all stay inside the canvas.** A wide, low
    image takes its console under it.
32. **R** closes the view; so does the console's **×**, clicking elsewhere on the canvas, or
    **Escape** with nothing in hand. **The element keeps exactly what was set** (its still
    matches the last live frame), and the selection box is back.
33. While the view is open, **Ctrl+Z / Ctrl+Shift+Z** step through the gestures and the board
    follows; plain keys never reach canvas shortcuts (no nudge, no delete).

## The Inspector

34. Select a `stack_u16` element (no live view). **Sections Image, Channels, Position,
    Annotations and View** (Layers only for an image with layers). Image says the size per
    pixel, "Stored exactly (uint16)" and the source path; on `movie_f32` it says "Stored
    compactly: 16-bit steps of the float32 values".
35. Type a White value: **the picture changes; one undo step.** Scrub a field with the wheel:
    **one undo step for the run.**
36. Type the image's default window back: **the key disappears from the stored view** (an
    all-default view leaves the element with no `view` in `fig/canvases/*.json`).
37. Position: change the plane; choose max and a From/To run; toggle scale bar, stamp,
    channel names, calibration bar; Pixels True/Smoothed; Background Transparent; Region shown
    X/Y/W/H. **Each shows at once; the live view (if open) agrees.**
38. **Live view R** button in the Image header **opens the live view**; on a locked element it
    is disabled with "Unlock and show the image to open it".

## Exports and other outputs

39. Export the figure as SVG and PDF. **Each image is drawn at 300 dpi at its printed size;
    zoom in on a small image in a PDF viewer: sharp pixels, not blur. Layers, names, scale bar
    and stamps are vectors** (selectable text in the SVG).
40. Export PNG at a high dpi. **The image is drawn at that dpi from the full-resolution pixels**
    (for `mid_tiled_u16`, not from its overview).
41. Embed the figure in a Paper document. **The images show there**, with the same view.
42. Headless: `flux render-figure <figId> --png --out /tmp/f.png`. **Same picture as the app.**
43. Move a placed bundle's asset folder away and render: **a dark stand-in with the image's name,
    and a warning naming the reason**; the figure still renders.

## Update from source

44. With the project open, replace `plots/stack_u16.fluximg` with new content (re-run a fluxplot
    script that writes it, or copy another bundle to a temporary name and rename it into
    place). **Every element placed from it updates within about a second and keeps its view.**
    If the new image has fewer planes or channels, **a notice says what was adjusted.** One
    **Ctrl+Z** brings back the previous version.

## Agents

45. `flux image-info <elementId>`: **dims with units and positions, channels with percentiles,
    layers, and the element's view in words ("z 4/7 · −58.5 µm").**
46. `flux set-image-view <elementId> --view '{"projection":{"dim":"z","mode":"max","from":0,"to":7}}'`
    with the app open: **the element shows the projection at once.** A bad key (`{"index":{"t":0}}`
    on the z-stack): **refused, naming the problem; nothing written.**
47. `flux place-image <figId> plots/stack_u16.fluximg`: **placed, `reused: true`** (same content
    already in the project).

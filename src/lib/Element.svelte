<script lang="ts">
  import type { Element } from "./types";
  import { assetData } from "./assets";
  import { project } from "./store";
  import { assetDisplaySize } from "./ops";
  import { lineRender, elementBBox, dashAttr } from "./geometry";
  import { pathRender } from "./path";
  import { elementPaints } from "./color/gradient";
  import { blockLayout, letterSpacing } from "./text";
  import { segmentAttrs } from "./export";
  import PlotElement from "./PlotElement.svelte";

  export let element: Element;

  // solid colours, or url(#…) gradients when a colormap is set (color/gradient.ts)
  $: paints = elementPaints(element);
  // Crop rendering for `<image>`-backed rasters (P5): the crop window lives in
  // intrinsic content px (assetDisplaySize units), shown via a nested-svg
  // viewport — viewBox = the window, the image drawn at full display size
  // inside it. Falls back to the uncropped image when the asset is unsized.
  $: imgDisp = element.type === "image" && element.crop ? assetDisplaySize($project, element.assetId) : null;
  // FIG-2: rotate/flip about the element's true bbox centre. Lines/arrows carry
  // width/height 0 (their geometry is x1/y1→x2/y2), so `element.x + width/2` put the pivot on
  // endpoint 1 — a rotated/flipped line swung about its end, wrong on screen AND in export.
  // The model mutates in place. Keep the derived center as scalar values so
  // unchanged elements do not publish fresh reactive objects on every edit.
  let cx = 0, cy = 0;
  $: {
    const box = elementBBox(element);
    cx = box.x + box.w / 2;
    cy = box.y + box.h / 2;
  }
  $: transform = buildTransform(element, cx, cy);

  // Rotation + flip about the element centre, as an SVG transform list. Flip is
  // a scale(±1) sandwiched between translate-to-centre and back.
  function buildTransform(el: Element, ox: number, oy: number): string | undefined {
    const parts: string[] = [];
    if (el.rotation) parts.push(`rotate(${el.rotation} ${ox} ${oy})`);
    const sx = el.flipX ? -1 : 1;
    const sy = el.flipY ? -1 : 1;
    if (sx !== 1 || sy !== 1)
      parts.push(`translate(${ox} ${oy}) scale(${sx} ${sy}) translate(${-ox} ${-oy})`);
    return parts.length ? parts.join(" ") : undefined;
  }
</script>

<g {transform} opacity={element.opacity ?? 1}>
  {#each paints.defs as d (d.id)}
    <linearGradient id={d.id} x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2} gradientUnits={d.units}>
      {#each d.stops as st, i (i)}<stop offset={st.offset} stop-color={st.color} />{/each}
    </linearGradient>
  {/each}
  {#if element.type === "plot"}
    <PlotElement element={element} />
  {:else if element.type === "video"}
    <!-- Authoring uses the prepared still: selection and direct manipulation
         never start a decoder, playback or audio. The shared player owns that. -->
    {#if $assetData[element.posterAssetId]}
      <image x={element.x} y={element.y} width={element.width} height={element.height}
        preserveAspectRatio="none" href={$assetData[element.posterAssetId]} />
    {:else}
      <rect x={element.x} y={element.y} width={element.width} height={element.height} fill="#202020" stroke="#777" />
      <text x={element.x + element.width / 2} y={element.y + element.height / 2} text-anchor="middle" dominant-baseline="middle"
        fill="#ddd" font-size={Math.max(10, Math.min(18, element.width / 15))}>Video preview unavailable</text>
    {/if}
  {:else if element.type === "image"}
    {#if $assetData[element.assetId]}
      {#if element.crop && imgDisp}
        <svg
          x={element.x}
          y={element.y}
          width={element.width}
          height={element.height}
          viewBox={`${element.crop.x} ${element.crop.y} ${element.crop.width} ${element.crop.height}`}
          preserveAspectRatio="none"
          style="overflow:hidden"
        >
          <image
            x="0"
            y="0"
            width={imgDisp.width}
            height={imgDisp.height}
            preserveAspectRatio="none"
            href={$assetData[element.assetId]}
          />
        </svg>
      {:else}
        <image
          x={element.x}
          y={element.y}
          width={element.width}
          height={element.height}
          preserveAspectRatio="none"
          href={$assetData[element.assetId]}
        />
      {/if}
    {:else}
      <rect
        x={element.x}
        y={element.y}
        width={element.width}
        height={element.height}
        fill="#eee"
        stroke="#bbb"
      />
    {/if}
  {:else if element.type === "rect"}
    <rect
      x={element.x}
      y={element.y}
      width={element.width}
      height={element.height}
      rx={element.cornerRadius}
      fill={paints.fill}
      stroke={paints.stroke}
      stroke-width={element.strokeWidth}
      stroke-dasharray={dashAttr(element)}
    />
  {:else if element.type === "ellipse"}
    <ellipse
      cx={element.x + element.width / 2}
      cy={element.y + element.height / 2}
      rx={element.width / 2}
      ry={element.height / 2}
      fill={paints.fill}
      stroke={paints.stroke}
      stroke-width={element.strokeWidth}
      stroke-dasharray={dashAttr(element)}
    />
  {:else if element.type === "line"}
    {@const lr = lineRender(element)}
    <!-- wide invisible hit area for easy selection (full model endpoints) -->
    <line
      x1={element.x + element.x1}
      y1={element.y + element.y1}
      x2={element.x + element.x2}
      y2={element.y + element.y2}
      stroke="transparent"
      stroke-width={Math.max(12, element.strokeWidth + 8)}
    />
    <line
      x1={element.x + lr.x1}
      y1={element.y + lr.y1}
      x2={element.x + lr.x2}
      y2={element.y + lr.y2}
      stroke={paints.stroke}
      stroke-width={element.strokeWidth}
      stroke-linecap={lr.cap}
      stroke-dasharray={dashAttr(element)}
    />
    {#each lr.polys as tri}
      <polygon
        points={tri.map(([px, py]) => `${element.x + px},${element.y + py}`).join(" ")}
        fill={paints.heads}
      />
    {/each}
    {#each lr.vees as v}
      <polyline
        points={v.map(([px, py]) => `${element.x + px},${element.y + py}`).join(" ")}
        fill="none"
        stroke={paints.heads}
        stroke-width={element.strokeWidth}
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {/each}
  {:else if element.type === "path"}
    {@const pr = pathRender(element)}
    <!-- wide invisible hit stroke (same trick as lines) so hovering/selecting a
         path doesn't demand pixel-perfect aim; the interior of closed shapes
         hits via the visible path's own fill -->
    <path
      d={element.d}
      transform={`translate(${element.x} ${element.y})`}
      fill="none"
      stroke="transparent"
      stroke-width={Math.max(12, element.strokeWidth + 8)}
    />
    <path
      d={pr.d}
      transform={`translate(${element.x} ${element.y})`}
      fill={paints.fill}
      stroke={paints.stroke}
      stroke-width={element.strokeWidth}
      stroke-linejoin="round"
      stroke-linecap={element.cap ?? "round"}
      stroke-dasharray={dashAttr(element)}
    />
    {#each pr.polys as tri}
      <polygon
        points={tri.map(([px, py]) => `${element.x + px},${element.y + py}`).join(" ")}
        fill={paints.heads}
      />
    {/each}
    {#each pr.vees as v}
      <polyline
        points={v.map(([px, py]) => `${element.x + px},${element.y + py}`).join(" ")}
        fill="none"
        stroke={paints.heads}
        stroke-width={element.strokeWidth}
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {/each}
  {:else if element.type === "text"}
    <!-- text.ts blockLayout is the ONE arrangement source (shared with export.ts
         and so with every headless render): the wrap cache when present else the
         hard lines, anchored by align, dropped by valign, advanced by line height
         plus paragraph spacing, and stretched to textLength where justified. -->
    {@const L = blockLayout(element)}
    <text
      x={L.x}
      y={L.baselineY}
      font-family={element.fontFamily}
      font-size={element.fontSize}
      font-weight={element.fontWeight}
      font-style={element.fontStyle}
      text-decoration={element.underline ? "underline" : undefined}
      letter-spacing={letterSpacing(element) || undefined}
      fill={paints.fill}
      text-anchor={L.anchor}
      style="white-space:pre"
    >
      {#each L.lines as ln}
        <tspan
          x={L.x}
          dy={ln.dy}
          textLength={ln.justifyWidth}
          lengthAdjust={ln.justifyWidth != null ? "spacing" : undefined}
          >{#if ln.segments}{#each ln.segments as seg}{@const a = segmentAttrs(element, seg)}<tspan
                dx={seg.dx}
                dy={seg.dy}
                font-size={a["font-size"]}
                font-weight={a["font-weight"]}
                font-style={a["font-style"]}
                text-decoration={a["text-decoration"]}
                fill={a.fill}>{seg.text}</tspan
              >{/each}{:else}{ln.text}{/if}</tspan
        >
      {/each}
    </text>
  {/if}
</g>

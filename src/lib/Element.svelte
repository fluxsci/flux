<script lang="ts">
  import type { Element } from "./types";
  import { assetData } from "./assets";
  import { project } from "./store";
  import { assetDisplaySize } from "./ops";
  import { lineRender, elementBBox, dashAttr } from "./geometry";
  import { pathRender } from "./path";
  import { visualLines, lineH } from "./text";
  import PlotElement from "./PlotElement.svelte";

  export let element: Element;

  $: e = element;
  // Crop rendering for `<image>`-backed rasters (P5): the crop window lives in
  // intrinsic content px (assetDisplaySize units), shown via a nested-svg
  // viewport — viewBox = the window, the image drawn at full display size
  // inside it. Falls back to the uncropped image when the asset is unsized.
  $: imgDisp = e.type === "image" && e.crop ? assetDisplaySize($project, e.assetId) : null;
  // FIG-2: rotate/flip about the element's true bbox centre. Lines/arrows carry
  // width/height 0 (their geometry is x1/y1→x2/y2), so `e.x + width/2` put the pivot on
  // endpoint 1 — a rotated/flipped line swung about its end, wrong on screen AND in export.
  $: bbox = elementBBox(e);
  $: cx = bbox.x + bbox.w / 2;
  $: cy = bbox.y + bbox.h / 2;
  $: transform = buildTransform(e, cx, cy);

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

<g {transform} opacity={e.opacity ?? 1}>
  {#if e.type === "plot"}
    <PlotElement element={e} />
  {:else if e.type === "image"}
    {#if $assetData[e.assetId]}
      {#if e.crop && imgDisp}
        <svg
          x={e.x}
          y={e.y}
          width={e.width}
          height={e.height}
          viewBox={`${e.crop.x} ${e.crop.y} ${e.crop.width} ${e.crop.height}`}
          preserveAspectRatio="none"
          style="overflow:hidden"
        >
          <image
            x="0"
            y="0"
            width={imgDisp.width}
            height={imgDisp.height}
            preserveAspectRatio="none"
            href={$assetData[e.assetId]}
          />
        </svg>
      {:else}
        <image
          x={e.x}
          y={e.y}
          width={e.width}
          height={e.height}
          preserveAspectRatio="none"
          href={$assetData[e.assetId]}
        />
      {/if}
    {:else}
      <rect
        x={e.x}
        y={e.y}
        width={e.width}
        height={e.height}
        fill="#eee"
        stroke="#bbb"
      />
    {/if}
  {:else if e.type === "rect"}
    <rect
      x={e.x}
      y={e.y}
      width={e.width}
      height={e.height}
      rx={e.cornerRadius}
      fill={e.fill}
      stroke={e.stroke}
      stroke-width={e.strokeWidth}
      stroke-dasharray={dashAttr(e)}
    />
  {:else if e.type === "ellipse"}
    <ellipse
      cx={e.x + e.width / 2}
      cy={e.y + e.height / 2}
      rx={e.width / 2}
      ry={e.height / 2}
      fill={e.fill}
      stroke={e.stroke}
      stroke-width={e.strokeWidth}
      stroke-dasharray={dashAttr(e)}
    />
  {:else if e.type === "line"}
    {@const lr = lineRender(e)}
    <!-- wide invisible hit area for easy selection (full model endpoints) -->
    <line
      x1={e.x + e.x1}
      y1={e.y + e.y1}
      x2={e.x + e.x2}
      y2={e.y + e.y2}
      stroke="transparent"
      stroke-width={Math.max(12, e.strokeWidth + 8)}
    />
    <line
      x1={e.x + lr.x1}
      y1={e.y + lr.y1}
      x2={e.x + lr.x2}
      y2={e.y + lr.y2}
      stroke={e.stroke}
      stroke-width={e.strokeWidth}
      stroke-linecap={lr.cap}
      stroke-dasharray={dashAttr(e)}
    />
    {#each lr.polys as tri}
      <polygon
        points={tri.map(([px, py]) => `${e.x + px},${e.y + py}`).join(" ")}
        fill={e.stroke}
      />
    {/each}
    {#each lr.vees as v}
      <polyline
        points={v.map(([px, py]) => `${e.x + px},${e.y + py}`).join(" ")}
        fill="none"
        stroke={e.stroke}
        stroke-width={e.strokeWidth}
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {/each}
  {:else if e.type === "path"}
    {@const pr = pathRender(e)}
    <!-- wide invisible hit stroke (same trick as lines) so hovering/selecting a
         path doesn't demand pixel-perfect aim; the interior of closed shapes
         hits via the visible path's own fill -->
    <path
      d={e.d}
      transform={`translate(${e.x} ${e.y})`}
      fill="none"
      stroke="transparent"
      stroke-width={Math.max(12, e.strokeWidth + 8)}
    />
    <path
      d={pr.d}
      transform={`translate(${e.x} ${e.y})`}
      fill={e.closed ? e.fill : "none"}
      stroke={e.stroke}
      stroke-width={e.strokeWidth}
      stroke-linejoin="round"
      stroke-linecap="round"
      stroke-dasharray={dashAttr(e)}
    />
    {#each pr.polys as tri}
      <polygon
        points={tri.map(([px, py]) => `${e.x + px},${e.y + py}`).join(" ")}
        fill={e.stroke}
      />
    {/each}
    {#each pr.vees as v}
      <polyline
        points={v.map(([px, py]) => `${e.x + px},${e.y + py}`).join(" ")}
        fill="none"
        stroke={e.stroke}
        stroke-width={e.strokeWidth}
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {/each}
  {:else if e.type === "text"}
    <!-- visualLines = the wrap cache (sizing auto-h/fixed) else the hard lines;
         dy = lineH (fontSize × lineHeight, default 1.2 — the one source in text.ts) -->
    <text
      x={e.align === "center"
        ? e.x + e.width / 2
        : e.align === "right"
          ? e.x + e.width
          : e.x}
      y={e.y + e.fontSize}
      font-family={e.fontFamily}
      font-size={e.fontSize}
      font-weight={e.fontWeight}
      font-style={e.fontStyle}
      text-decoration={e.underline ? "underline" : undefined}
      fill={e.color}
      text-anchor={e.align === "center"
        ? "middle"
        : e.align === "right"
          ? "end"
          : "start"}
      style="white-space:pre"
    >
      {#each visualLines(e) as ln, i}
        <tspan
          x={e.align === "center"
            ? e.x + e.width / 2
            : e.align === "right"
              ? e.x + e.width
              : e.x}
          dy={i === 0 ? 0 : lineH(e)}>{ln}</tspan
        >
      {/each}
    </text>
  {/if}
</g>

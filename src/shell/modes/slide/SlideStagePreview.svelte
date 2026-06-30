<script lang="ts">
  // SlideStagePreview — the P0 stage renderer: draws a slide's elements at their
  // authoring pixel coordinates inside a fixed-size .stage, uniformly scaled to
  // fit the available area (the §5.6 auto-scale approach the real player reuses).
  // P0 renders text boxes/math/shapes faithfully enough to confirm the model and
  // be screenshotted; rich media (image/video/plot/figure) draw as labeled
  // placeholders until P1 wires the real element renderers + the live player.
  import type { Slide, SlideElement, DeckTheme, StageSize } from "../../../lib/slide/types";
  import { themeCssVars } from "../../../lib/slide/theme";

  let {
    slide,
    theme,
    stage,
    interactive = false,
  }: {
    slide: Slide;
    theme: DeckTheme;
    stage: StageSize;
    interactive?: boolean;
  } = $props();

  // Measure the container; scale the fixed-size stage to fit (letterboxed).
  let fitW = $state(0);
  let fitH = $state(0);
  const scale = $derived(
    fitW > 0 && fitH > 0 ? Math.min(fitW / stage.width, fitH / stage.height) : 0,
  );

  const bg = $derived(slide.background ?? theme.background);

  function markerChar(m: string | undefined): string {
    if (m === "bullet") return "•";
    if (m === "dash") return "–";
    if (m === "number") return ""; // numbered handled positionally (P1)
    return "";
  }

  function emphColor(e: string | undefined): string | undefined {
    if (e === "accent") return theme.accent;
    if (e === "muted") return theme.textMuted;
    return undefined;
  }

  // A coarse label for placeholder element kinds (real renderers land in P1).
  function placeholderLabel(el: SlideElement): string {
    switch (el.type) {
      case "image":
        return "Image";
      case "svg":
        return "SVG";
      case "video":
        return "Video";
      case "plot":
        return "Plot";
      case "embedFigure":
        return `Figure: ${(el as { figureId?: string }).figureId ?? ""}`;
      default:
        return el.type;
    }
  }
</script>

<div class="fit" class:interactive bind:clientWidth={fitW} bind:clientHeight={fitH}>
  {#if scale > 0}
    <div class="scaled" style={`width:${stage.width * scale}px;height:${stage.height * scale}px`}>
      <div
        class="stage"
        style={`width:${stage.width}px;height:${stage.height}px;transform:scale(${scale});background:${bg};${themeCssVars(theme)}`}>
        {#each slide.elements as el (el.id)}
          <div
            class="el"
            style={`left:${el.x}px;top:${el.y}px;width:${el.width}px;height:${el.height}px;` +
              (el.rotation ? `transform:rotate(${el.rotation}deg);` : "") +
              (el.opacity != null ? `opacity:${el.opacity};` : "")}>
            {#if el.type === "textBox"}
              <div
                class="tbox"
                style={`text-align:${el.align ?? "left"};justify-content:${
                  el.valign === "middle" ? "center" : el.valign === "bottom" ? "flex-end" : "flex-start"
                };color:${el.color ?? "var(--sl-text)"};font-family:${el.fontFamily ?? "var(--sl-font-body)"};` +
                  `font-size:${el.fontSize ?? 32}px;font-weight:${el.fontWeight ?? 400};font-style:${el.fontStyle ?? "normal"};` +
                  `line-height:${el.lineHeight ?? 1.25}`}>
                {#each el.blocks as b (b.id)}
                  <div class="blk" style={`padding-left:${(b.level ?? 0) * 1.4}em;${emphColor(b.emphasis) ? `color:${emphColor(b.emphasis)}` : ""}`}>
                    {#if markerChar(b.marker)}<span class="mk">{markerChar(b.marker)}</span>{/if}<span>{b.text}</span>
                  </div>
                {/each}
              </div>
            {:else if el.type === "math"}
              <div class="math" style={`color:${el.color ?? "var(--sl-text)"};font-size:${el.fontSize ?? 32}px`}>
                {(el as { tex: string }).tex}
              </div>
            {:else if el.type === "text"}
              <div
                class="tbox"
                style={`color:${(el as { color?: string }).color ?? "var(--sl-text)"};font-size:${(el as { fontSize?: number }).fontSize ?? 24}px`}>
                {(el as { text: string }).text}
              </div>
            {:else if el.type === "rect" || el.type === "ellipse"}
              <div
                class="shape"
                style={`background:${(el as { fill?: string }).fill ?? "transparent"};border:${(el as { strokeWidth?: number }).strokeWidth ?? 0}px solid ${(el as { stroke?: string }).stroke ?? "transparent"};border-radius:${el.type === "ellipse" ? "50%" : ((el as { cornerRadius?: number }).cornerRadius ?? 0) + "px"}`}>
              </div>
            {:else}
              <div class="ph">{placeholderLabel(el)}</div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .fit {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .scaled {
    position: relative;
    /* Frame the slide so it reads as a distinct surface even when the slide
       background matches the dark app "desk" (flux-dark on flux-dark). */
    border: 1px solid var(--c-line-strong, #343331);
    box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5);
  }
  .stage {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    overflow: hidden;
  }
  .el {
    position: absolute;
    box-sizing: border-box;
  }
  .tbox {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .blk {
    display: flex;
    gap: 0.4em;
  }
  .mk {
    flex: 0 0 auto;
    color: var(--sl-accent);
  }
  .math {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--sl-font-mono);
    font-style: italic;
  }
  .shape {
    width: 100%;
    height: 100%;
    box-sizing: border-box;
  }
  .ph {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    border: 1px dashed color-mix(in oklab, var(--sl-text-muted) 60%, transparent);
    border-radius: 4px;
    color: var(--sl-text-muted);
    font-family: var(--sl-font-mono);
    font-size: 14px;
    background: color-mix(in oklab, var(--sl-surface) 40%, transparent);
  }
</style>

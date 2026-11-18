<script lang="ts">
  // The Flux AI mark as a component: fluxAiMark.ts says what it is and why its look is global.
  import { FLUX_AI_DOTS, FLUX_AI_VIEWBOX, type FluxAiTone } from "./fluxAiMark";
  let { size = 16, tone = "ready" }: { size?: number; tone?: FluxAiTone } = $props();
</script>

<svg class="flux-ai-mark" data-tone={tone} width={size} height={size} viewBox={FLUX_AI_VIEWBOX} aria-hidden="true">
  {#each FLUX_AI_DOTS as dot, i (i)}<circle cx={dot.cx} cy={dot.cy} r={dot.r} fill={dot.fill} style={`--o:${dot.o}`} />{/each}
</svg>

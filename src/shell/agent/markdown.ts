// `use:markdown={text}` — renders agent prose through the inert renderer
// (src/lib/agent/markdownDom.ts) into the node. Re-renders are coalesced to
// one per animation frame, so a burst of streaming deltas costs one parse of
// the current message, never one per delta. Blocks that appear after the
// previous render get the `arrive` fade; the block still streaming does not
// re-animate. Links open through the desktop bridge (never a navigation in
// the renderer); fenced code gets a hover Copy button.
import { renderMarkdown } from "../../lib/agent/markdownDom";
import { fileBridge } from "../../lib/project/types";

export interface MarkdownParams { text: string; streaming?: boolean }

function decorate(node: HTMLElement): void {
  for (const pre of node.querySelectorAll("pre")) {
    const btn = node.ownerDocument.createElement("button");
    btn.type = "button"; btn.className = "md-copy"; btn.textContent = "Copy"; btn.setAttribute("aria-label", "Copy code");
    pre.appendChild(btn);
  }
}

export function markdown(node: HTMLElement, params: MarkdownParams | string) {
  const read = (p: MarkdownParams | string) => typeof p === "string" ? { text: p, streaming: false } : { text: p.text, streaming: !!p.streaming };
  let current = read(params);
  let rendered = "", frame = 0, lastCount = 0;
  const render = () => {
    frame = 0;
    if (current.text === rendered) return;
    const frag = renderMarkdown(current.text, node.ownerDocument, { linkAttr: "data-external" });
    const count = frag.childNodes.length;
    if (current.streaming) {
      // New blocks (beyond the ones already on screen) arrive; the one still growing does not blink.
      for (let i = Math.max(0, lastCount - 1); i < count; i++) {
        const child = frag.childNodes[i];
        if (i >= lastCount && child instanceof HTMLElement) child.classList.add("arrive");
      }
    }
    node.replaceChildren(frag);
    decorate(node);
    rendered = current.text; lastCount = count;
  };
  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const a = target?.closest?.("a[data-external]") as HTMLAnchorElement | null;
    if (a) {
      e.preventDefault(); e.stopPropagation();
      const href = a.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href)) void (fileBridge()?.openExternal?.(href) ?? window.open(href, "_blank", "noopener"));
      return;
    }
    const copy = target?.closest?.(".md-copy") as HTMLButtonElement | null;
    if (copy) {
      e.preventDefault(); e.stopPropagation();
      const code = copy.parentElement?.querySelector("code")?.textContent ?? "";
      void navigator.clipboard?.writeText(code).then(() => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1200); }).catch(() => {});
    }
  };
  node.addEventListener("click", onClick);
  render();
  return {
    update(next: MarkdownParams | string) {
      current = read(next);
      // Deltas coalesce to one render per frame; a completed message paints now.
      if (!current.streaming) { if (frame) { cancelAnimationFrame(frame); frame = 0; } render(); }
      else if (!frame) frame = requestAnimationFrame(render);
    },
    destroy() { node.removeEventListener("click", onClick); if (frame) cancelAnimationFrame(frame); },
  };
}

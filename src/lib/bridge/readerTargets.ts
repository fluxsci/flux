import { boundsOf, registerTargetResolver } from "./targetResolvers";
import { describeTarget, type TargetRef } from "../project/targets";
import type { ContextStamp } from "../project/annotations";

export function registerReaderTargets(root: () => Element | null, context: () => ContextStamp["reader"], active: () => boolean) {
  return registerTargetResolver({ surface: "reader", root,
    revision: () => { const c = context(), scroll = root()?.querySelector('.pdf-scroll'); return [c?.citekey,c?.page,c?.selection,c?.highlightId,root()?.querySelector('.pdf-root'),scroll?.scrollLeft,scroll?.scrollTop]; },
    current() {
      const c = context();
      return active() && c ? [{ kind: "passage", citekey: c.citekey, page: c.page ?? 1, quote: c.selection, highlightId: c.highlightId, title: c.title }] : [];
    },
    within(rect) {
      const c = context(); if (!c) return [];
      const pages = new Map<number, { text: string[]; bounds: ReturnType<typeof boundsOf> }>();
      for (const span of root()?.querySelectorAll('.textLayer span') ?? []) {
        const b = boundsOf(span), page = Number(span.closest('[data-page-number]')?.getAttribute('data-page-number'));
        if (!page || !span.textContent?.trim() || b.x < rect.x || b.y < rect.y || b.x + b.w > rect.x + rect.w || b.y + b.h > rect.y + rect.h) continue;
        const p = pages.get(page);
        if (!p) pages.set(page, { text: [span.textContent], bounds: b });
        else { const x = Math.min(p.bounds.x,b.x), y = Math.min(p.bounds.y,b.y); p.bounds = { x,y,w:Math.max(p.bounds.x+p.bounds.w,b.x+b.w)-x,h:Math.max(p.bounds.y+p.bounds.h,b.y+b.h)-y }; p.text.push(span.textContent); }
      }
      return [...pages].map(([page, p]) => { const ref: TargetRef = { kind: "passage", citekey: c.citekey, title: c.title, page, quote: p.text.join(" ") }; return {ref,bounds:p.bounds,label:describeTarget(ref)}; });
    },
    at(_x, _y, node) {
      const c = context(), page = node?.closest('[data-page-number]');
      if (!c || !page) return [];
      const span = node?.closest('.textLayer span');
      const ref: TargetRef = { kind: "passage", citekey: c.citekey, title: c.title, page: Number(page.getAttribute('data-page-number')), quote: span?.textContent?.trim() ?? c.selection };
      return [{ ref, bounds: boundsOf(span ?? page), label: describeTarget(ref) }];
    },
  });
}

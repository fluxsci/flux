// The §2.5 keyboard map — the whole thing, in one place.
//
// Focus rule: while an input has focus the map is inert except Escape
// (clear + blur) and Enter (blur); everything else types normally.
import type { store as LtStore } from "./store.svelte";

type Store = typeof LtStore;

export function handleKey(e: KeyboardEvent, s: Store): void {
  const t = e.target as HTMLElement | null;
  const inInput =
    !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  if (inInput) {
    if (e.key === "Escape") {
      s.clearSearch();
      (t as HTMLInputElement).blur();
      e.preventDefault();
    } else if (e.key === "Enter") {
      (t as HTMLInputElement).blur();
      e.preventDefault();
    }
    return;
  }
  if (!s.manifest || s.manifest.keys.length === 0) return;
  // Ctrl/Cmd+Enter: Compare — the selected item across ALL sets.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "Enter") {
    if (s.view === "grid") {
      s.openCompare();
      e.preventDefault();
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const k = e.key;
  let handled = true;

  // Annotation keys work identically in grid, detail, and compare — they act
  // on the selected item (which IS the viewed item in detail/compare). Inert
  // until an annotation class is open.
  if (k === "v" || k === "x" || k === "n") {
    if (!s.annot) return;
    if (k === "n") s.openNotes();
    else s.toggleMark(k === "v" ? "valid" : "exclude");
    e.preventDefault();
    return;
  }

  if (k >= "1" && k <= "9") {
    s.switchSet(Number(k) - 1); // jump to set N (same item — the EDA move)
  } else if (k === "Tab") {
    s.stepSet(e.shiftKey ? -1 : 1);
  } else if (s.view === "compare") {
    switch (k) {
      case "Escape":
        s.closeCompare();
        break;
      case "ArrowLeft":
        s.moveSelection(-1);
        break;
      case "ArrowRight":
        s.moveSelection(1);
        break;
      case "Home":
        s.selectEdge(false);
        break;
      case "End":
        s.selectEdge(true);
        break;
      case "Enter":
      case " ":
        s.openDetailFromCompare(s.setIndex);
        break;
      case "c":
        s.toggleCaptions();
        break;
      default:
        handled = false;
    }
  } else if (s.view === "grid") {
    switch (k) {
      case "ArrowLeft":
        s.moveSelection(-1);
        break;
      case "ArrowRight":
        s.moveSelection(1);
        break;
      case "ArrowUp":
        s.moveSelection(-s.cols);
        break;
      case "ArrowDown":
        s.moveSelection(s.cols);
        break;
      case "Enter":
      case " ":
        s.openDetail();
        break;
      case "Escape":
        if (s.search) s.clearSearch();
        else handled = false;
        break;
      case "[":
      case "-":
        s.setCols(s.cols - 1);
        break;
      case "]":
      case "=":
      case "+":
        s.setCols(s.cols + 1);
        break;
      case "/":
        s.searchEl?.focus();
        s.searchEl?.select();
        break;
      case "c":
        s.toggleCaptions();
        break;
      case "Home":
        s.selectEdge(false);
        break;
      case "End":
        s.selectEdge(true);
        break;
      case "PageUp":
        s.gridApi?.pageBy(-1);
        break;
      case "PageDown":
        s.gridApi?.pageBy(1);
        break;
      default:
        handled = false;
    }
  } else {
    switch (k) {
      case "ArrowLeft":
        s.detailStep(-1);
        break;
      case "ArrowRight":
        s.detailStep(1);
        break;
      case "ArrowUp":
        s.stepSet(-1);
        break;
      case "ArrowDown":
        s.stepSet(1);
        break;
      case "Enter":
        s.detailApi?.toggleFit();
        break;
      // " " (Space) is deliberately absent: hold-Space+drag is the pan hand
      // tool, owned by Detail.svelte's own key tracking.
      case "Escape":
        s.closeDetail();
        break;
      case "[":
      case "-":
        s.detailApi?.zoomBy(1 / 1.25);
        break;
      case "]":
      case "=":
      case "+":
        s.detailApi?.zoomBy(1.25);
        break;
      case "0":
        s.detailApi?.resetZoom();
        break;
      case "c":
        s.toggleCaptions();
        break;
      case "Home":
        s.detailEdge(false);
        break;
      case "End":
        s.detailEdge(true);
        break;
      default:
        handled = false;
    }
  }
  if (handled) e.preventDefault();
}

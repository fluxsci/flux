<script lang="ts">
  // Slide editor — the right-hand inspector. Edits the selected element(s), or the
  // active slide's own properties when nothing is selected. Mirrors the figure
  // editor's Inspector (compact rows, --c-* tokens, number inputs). EVERY edit goes
  // through `commitDeck` (the store's single write path — it structuredClones the
  // deck + marks dirty), so the GUI, flux-core, and the live bridge stay in lockstep.
  // Geometry/opacity/lock route through the pure `setElementBox` op; slide fields
  // through `setSlide`; style fields the ops don't cover are mutated directly on the
  // element found inside the commit callback (find → narrow → assign).
  import { deck as deckStore, selection, activeSlideId, commitDeck } from "../../../lib/slide/store";
  import * as slideOps from "../../../lib/slide/ops";
  import { resolveTheme } from "../../../lib/slide/theme";
  import type { SlideElement, TextBlock, LayoutId, TransitionKind } from "../../../lib/slide/types";

  // Explicit (non-theme) font stacks offered in the family picker.
  const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";

  // `focused` is accepted for parity with sibling panes (unused — this pane is
  // entirely driven by the editor stores).
  let { focused = true }: { focused?: boolean } = $props();

  // Live editor state (Svelte auto-subscription on the writable stores).
  const deck = $derived($deckStore);
  const theme = $derived(resolveTheme(deck?.theme));

  const activeSlide = $derived.by(() => {
    const d = deck;
    if (!d) return null;
    const byId = $activeSlideId ? slideOps.slideById(d, $activeSlideId) : null;
    return byId ?? d.slides[0] ?? null;
  });

  const selectedEls = $derived.by<SlideElement[]>(() => {
    const slide = activeSlide;
    if (!slide) return [];
    return $selection
      .map((id) => slide.elements.find((e) => e.id === id))
      .filter((e): e is SlideElement => !!e);
  });

  const single = $derived(selectedEls.length === 1 ? (selectedEls[0] ?? null) : null);

  // --- write helpers — every edit funnels through commitDeck -------------------
  function num(v: string, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function commitBox(id: string, patch: Parameters<typeof slideOps.setElementBox>[2]) {
    commitDeck((d) => slideOps.setElementBox(d, id, patch));
  }

  // Mutate an element's fields directly (for style the ops don't cover). The
  // callback re-narrows by `type` so the assignment is type-checked.
  function commitEl(id: string, fn: (el: SlideElement) => void) {
    commitDeck((d) => {
      const found = slideOps.findElement(d, id);
      if (found) fn(found.el);
    });
  }

  function commitSlide(patch: Parameters<typeof slideOps.setSlide>[2]) {
    const sid = activeSlide?.id;
    if (!sid) return;
    commitDeck((d) => slideOps.setSlide(d, sid, patch));
  }

  // setSlide can't clear `background` (it ignores null); delete the field to fall
  // back to the theme default.
  function clearBackground() {
    const sid = activeSlide?.id;
    if (!sid) return;
    commitDeck((d) => {
      const s = slideOps.slideById(d, sid);
      if (s) delete s.background;
    });
  }

  // --- text-box blocks --------------------------------------------------------
  function addBlock(id: string) {
    const sid = activeSlide?.id;
    if (!sid) return;
    commitDeck((d) => {
      slideOps.addBullet(d, sid, id, "New bullet");
    });
  }
  function removeBlock(id: string, blockId: string) {
    commitEl(id, (el) => {
      if (el.type === "textBox") el.blocks = el.blocks.filter((b) => b.id !== blockId);
    });
  }
  function setBlock(id: string, blockId: string, fn: (b: TextBlock) => void) {
    commitEl(id, (el) => {
      if (el.type !== "textBox") return;
      const b = el.blocks.find((x) => x.id === blockId);
      if (b) fn(b);
    });
  }

  // --- multi-selection --------------------------------------------------------
  function setOpacityAll(v: number) {
    const ids = selectedEls.map((e) => e.id);
    commitDeck((d) => {
      for (const id of ids) slideOps.setElementBox(d, id, { opacity: v });
    });
  }
  function deleteSelected() {
    const ids = selectedEls.map((e) => e.id);
    if (!ids.length) return;
    commitDeck((d) => slideOps.deleteElements(d, ids));
    selection.set([]);
  }
  // Arrange (align / distribute / group / z-order) — all funnel through commitDeck
  // (so they undo) and act on the current selection; the pure ops guard the counts.
  function withSel(fn: (d: import("../../../lib/slide/types").Deck, sid: string, ids: string[]) => void) {
    const sid = activeSlide?.id;
    if (!sid) return;
    commitDeck((d) => fn(d, sid, selectedEls.map((e) => e.id)));
  }
  const alignSel = (m: slideOps.AlignMode) => withSel((d, s, i) => slideOps.alignElements(d, s, i, m));
  const distSel = (axis: "h" | "v") => withSel((d, s, i) => slideOps.distributeElements(d, s, i, axis));

  // A native <input type="color"> only accepts #rrggbb — map shorthand/alpha hex,
  // and fall back (theme colour) for CSS vars / "transparent" / named colours.
  function colorValue(c: string | undefined, fallback: string): string {
    if (c) {
      if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
      if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7);
      if (/^#[0-9a-fA-F]{3}$/.test(c))
        return "#" + c.slice(1).split("").map((ch) => ch + ch).join("");
    }
    return /^#[0-9a-fA-F]{6}$/.test(fallback) ? fallback : "#000000";
  }
</script>

<div class="inspector">
  {#if single}
    {@const el = single}
    <!-- SINGLE ELEMENT -->
    <section class="hdr"><h4>{el.type}</h4></section>

    <!-- GEOMETRY -->
    <section>
      <h4>Geometry</h4>
      <div class="row">
        <label>X<input type="number" step="1" value={Math.round(el.x)}
          onchange={(e) => commitBox(el.id, { x: num(e.currentTarget.value, el.x) })} /></label>
        <label>Y<input type="number" step="1" value={Math.round(el.y)}
          onchange={(e) => commitBox(el.id, { y: num(e.currentTarget.value, el.y) })} /></label>
      </div>
      <div class="row">
        <label>W<input type="number" step="1" value={Math.round(el.width)}
          onchange={(e) => commitBox(el.id, { width: num(e.currentTarget.value, el.width) })} /></label>
        <label>H<input type="number" step="1" value={Math.round(el.height)}
          onchange={(e) => commitBox(el.id, { height: num(e.currentTarget.value, el.height) })} /></label>
      </div>
      <div class="row">
        <label>Rotation°<input type="number" step="1" value={Math.round(el.rotation ?? 0)}
          onchange={(e) => commitBox(el.id, { rotation: num(e.currentTarget.value, el.rotation ?? 0) })} /></label>
        <label class="btn-reset">&nbsp;<button title="Reset rotation to 0°"
          onclick={() => commitBox(el.id, { rotation: 0 })}>Reset</button></label>
      </div>
      <label class="rng">
        <span class="rng-head"><span>Opacity</span><span class="val">{Math.round((el.opacity ?? 1) * 100)}%</span></span>
        <input type="range" min="0" max="1" step="0.01" value={el.opacity ?? 1}
          oninput={(e) => commitBox(el.id, { opacity: Number(e.currentTarget.value) })} />
      </label>
      <label class="chk">
        <input type="checkbox" checked={el.locked ?? false}
          onchange={(e) => commitBox(el.id, { locked: e.currentTarget.checked })} />
        Locked
      </label>
    </section>

    <!-- TYPE-SPECIFIC -->
    {#if el.type === "textBox"}
      <section>
        <h4>Blocks</h4>
        {#each el.blocks as block (block.id)}
          <div class="block">
            <textarea rows="2" value={block.text}
              oninput={(e) => { const v = e.currentTarget.value; setBlock(el.id, block.id, (b) => (b.text = v)); }}
            ></textarea>
            <div class="blk-head">
              <label>Marker
                <select value={block.marker ?? "none"}
                  onchange={(e) => { const v = e.currentTarget.value; setBlock(el.id, block.id, (b) => (b.marker = v as TextBlock["marker"])); }}>
                  <option value="none">None</option>
                  <option value="bullet">Bullet</option>
                  <option value="dash">Dash</option>
                  <option value="number">Number</option>
                </select>
              </label>
              <label>Emphasis
                <select value={block.emphasis ?? "none"}
                  onchange={(e) => { const v = e.currentTarget.value; setBlock(el.id, block.id, (b) => (b.emphasis = v as TextBlock["emphasis"])); }}>
                  <option value="none">None</option>
                  <option value="accent">Accent</option>
                  <option value="muted">Muted</option>
                </select>
              </label>
              <div class="indent" role="group" aria-label="Indent">
                <button class="del" title="Outdent" aria-label="Outdent" disabled={(block.level ?? 0) === 0}
                  onclick={() => setBlock(el.id, block.id, (b) => (b.level = Math.max(0, (b.level ?? 0) - 1)))}>⇤</button>
                <button class="del" title="Indent" aria-label="Indent" disabled={(block.level ?? 0) >= 4}
                  onclick={() => setBlock(el.id, block.id, (b) => (b.level = Math.min(4, (b.level ?? 0) + 1)))}>⇥</button>
              </div>
              <button class="del" title="Remove block" aria-label="Remove block"
                onclick={() => removeBlock(el.id, block.id)}>×</button>
            </div>
          </div>
        {/each}
        <button class="add" onclick={() => addBlock(el.id)}>+ Add block</button>
      </section>
      <section>
        <h4>Text style</h4>
        <div class="row">
          <label>Size<input type="number" step="1" value={el.fontSize ?? 40}
            onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "textBox") x.fontSize = num(v, x.fontSize ?? 40); }); }} /></label>
          <label>Weight
            <select value={el.fontWeight ?? 400}
              onchange={(e) => { const v = Number(e.currentTarget.value); commitEl(el.id, (x) => { if (x.type === "textBox") x.fontWeight = Number.isFinite(v) ? v : 400; }); }}>
              <option value={400}>Regular</option>
              <option value={600}>Semibold</option>
              <option value={700}>Bold</option>
            </select>
          </label>
        </div>
        <div class="row">
          <label>Font
            <select value={el.fontFamily ?? "var(--sl-font-body)"}
              onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "textBox") x.fontFamily = v; }); }}>
              <option value="var(--sl-font-body)">Body (theme)</option>
              <option value="var(--sl-font-title)">Title (theme)</option>
              <option value="var(--sl-font-mono)">Mono (theme)</option>
              <option value={SANS}>Sans</option>
              <option value={SERIF}>Serif</option>
            </select>
          </label>
          <label>Line&nbsp;ht<input type="number" step="0.05" min="0.8" max="3" value={el.lineHeight ?? 1.25}
            onchange={(e) => { const v = Number(e.currentTarget.value); commitEl(el.id, (x) => { if (x.type === "textBox") x.lineHeight = Number.isFinite(v) ? v : 1.25; }); }} /></label>
        </div>
        <label class="chk">
          <input type="checkbox" checked={el.fontStyle === "italic"}
            onchange={(e) => { const c = e.currentTarget.checked; commitEl(el.id, (x) => { if (x.type === "textBox") x.fontStyle = c ? "italic" : "normal"; }); }} />
          Italic
        </label>
        <div class="row">
          <label>Align
            <select value={el.align ?? "left"}
              onchange={(e) => { const v = e.currentTarget.value as "left" | "center" | "right"; commitEl(el.id, (x) => { if (x.type === "textBox") x.align = v; }); }}>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>
          <label>V-Align
            <select value={el.valign ?? "top"}
              onchange={(e) => { const v = e.currentTarget.value as "top" | "middle" | "bottom"; commitEl(el.id, (x) => { if (x.type === "textBox") x.valign = v; }); }}>
              <option value="top">Top</option>
              <option value="middle">Middle</option>
              <option value="bottom">Bottom</option>
            </select>
          </label>
        </div>
        <label class="full">Color
          <input type="color" value={colorValue(el.color, theme.text)}
            onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "textBox") x.color = v; }); }} />
        </label>
      </section>
    {:else if el.type === "math"}
      <section>
        <h4>Equation</h4>
        <textarea class="mono" rows="3" value={el.tex} spellcheck="false"
          oninput={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "math") x.tex = v; }); }}
        ></textarea>
        <label class="chk">
          <input type="checkbox" checked={el.display ?? false}
            onchange={(e) => { const c = e.currentTarget.checked; commitEl(el.id, (x) => { if (x.type === "math") x.display = c; }); }} />
          Display (block, centered)
        </label>
        <div class="row">
          <label>Size<input type="number" step="1" value={el.fontSize ?? 40}
            onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "math") x.fontSize = num(v, x.fontSize ?? 40); }); }} /></label>
          <label>Color<input type="color" value={colorValue(el.color, theme.text)}
            onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "math") x.color = v; }); }} /></label>
        </div>
      </section>
    {:else if el.type === "rect" || el.type === "ellipse" || el.type === "path"}
      <section>
        <h4>Fill / stroke</h4>
        <div class="row">
          <label>Fill<input type="color" value={colorValue(el.fill, theme.accent)}
            onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "rect" || x.type === "ellipse" || x.type === "path") x.fill = v; }); }} /></label>
          <label>Stroke<input type="color" value={colorValue(el.stroke, theme.text)}
            onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "rect" || x.type === "ellipse" || x.type === "path") x.stroke = v; }); }} /></label>
        </div>
        <div class="row">
          <label>Stroke W<input type="number" step="1" min="0" value={el.strokeWidth}
            onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "rect" || x.type === "ellipse" || x.type === "path") x.strokeWidth = num(v, x.strokeWidth); }); }} /></label>
          {#if el.type === "rect"}
            <label>Radius<input type="number" step="1" min="0" value={el.cornerRadius}
              onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "rect") x.cornerRadius = num(v, x.cornerRadius); }); }} /></label>
          {/if}
        </div>
      </section>
    {:else if el.type === "line"}
      <section>
        <h4>Line</h4>
        <div class="row">
          <label>Stroke<input type="color" value={colorValue(el.stroke, theme.text)}
            onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "line") x.stroke = v; }); }} /></label>
          <label>Stroke W<input type="number" step="1" min="0" value={el.strokeWidth}
            onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "line") x.strokeWidth = num(v, x.strokeWidth); }); }} /></label>
        </div>
        <label class="chk">
          <input type="checkbox" checked={el.arrowEnd}
            onchange={(e) => { const c = e.currentTarget.checked; commitEl(el.id, (x) => { if (x.type === "line") x.arrowEnd = c; }); }} />
          Arrow end
        </label>
      </section>
    {:else if el.type === "video"}
      <section>
        <h4>Video</h4>
        <div class="ref">video · {el.assetId}</div>
        <label class="chk"><input type="checkbox" checked={el.muted ?? false}
          onchange={(e) => { const c = e.currentTarget.checked; commitEl(el.id, (x) => { if (x.type === "video") x.muted = c; }); }} /> Muted</label>
        <label class="chk"><input type="checkbox" checked={el.loop ?? false}
          onchange={(e) => { const c = e.currentTarget.checked; commitEl(el.id, (x) => { if (x.type === "video") x.loop = c; }); }} /> Loop</label>
        <label class="chk"><input type="checkbox" checked={el.controls ?? false}
          onchange={(e) => { const c = e.currentTarget.checked; commitEl(el.id, (x) => { if (x.type === "video") x.controls = c; }); }} /> Controls</label>
        <label class="chk"><input type="checkbox" checked={el.autoplay ?? false}
          onchange={(e) => { const c = e.currentTarget.checked; commitEl(el.id, (x) => { if (x.type === "video") x.autoplay = c; }); }} /> Autoplay</label>
      </section>
    {:else if el.type === "embedFigure"}
      <section>
        <h4>Embedded figure</h4>
        <div class="ref">embedFigure · {el.figureId}</div>
        <label class="full">Fit
          <select value={el.fit ?? "contain"}
            onchange={(e) => { const v = e.currentTarget.value as "contain" | "cover" | "fill"; commitEl(el.id, (x) => { if (x.type === "embedFigure") x.fit = v; }); }}>
            <option value="contain">Contain</option>
            <option value="cover">Cover</option>
            <option value="fill">Fill</option>
          </select>
        </label>
      </section>
    {:else if el.type === "text"}
      <section>
        <h4>Text</h4>
        <label class="full">Text<input type="text" value={el.text}
          onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "text") x.text = v; }); }} /></label>
        <div class="row">
          <label>Size<input type="number" step="1" value={el.fontSize}
            onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "text") x.fontSize = num(v, x.fontSize); }); }} /></label>
          <label>Align
            <select value={el.align}
              onchange={(e) => { const v = e.currentTarget.value as "left" | "center" | "right"; commitEl(el.id, (x) => { if (x.type === "text") x.align = v; }); }}>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>
        </div>
        <label class="full">Color<input type="color" value={colorValue(el.color, theme.text)}
          onchange={(e) => { const v = e.currentTarget.value; commitEl(el.id, (x) => { if (x.type === "text") x.color = v; }); }} /></label>
      </section>
    {:else if el.type === "image" || el.type === "svg" || el.type === "plot"}
      <section>
        <h4>{el.type}</h4>
        <div class="ref">{el.type} · {el.assetId}</div>
        <p class="note">Imported asset — edit its geometry above.</p>
      </section>
    {/if}
  {:else if selectedEls.length > 1}
    {@const first = selectedEls[0]}
    {#if first}
      <!-- MULTIPLE ELEMENTS -->
      <section class="hdr"><h4><span class="count">{selectedEls.length}</span> selected</h4></section>
      <section>
        <h4>Geometry (first)</h4>
        <div class="row">
          <label>X<input type="number" step="1" value={Math.round(first.x)}
            onchange={(e) => commitBox(first.id, { x: num(e.currentTarget.value, first.x) })} /></label>
          <label>Y<input type="number" step="1" value={Math.round(first.y)}
            onchange={(e) => commitBox(first.id, { y: num(e.currentTarget.value, first.y) })} /></label>
        </div>
        <div class="row">
          <label>W<input type="number" step="1" value={Math.round(first.width)}
            onchange={(e) => commitBox(first.id, { width: num(e.currentTarget.value, first.width) })} /></label>
          <label>H<input type="number" step="1" value={Math.round(first.height)}
            onchange={(e) => commitBox(first.id, { height: num(e.currentTarget.value, first.height) })} /></label>
        </div>
        <label class="rng">
          <span class="rng-head"><span>Opacity (all)</span><span class="val">{Math.round((first.opacity ?? 1) * 100)}%</span></span>
          <input type="range" min="0" max="1" step="0.01" value={first.opacity ?? 1}
            oninput={(e) => setOpacityAll(Number(e.currentTarget.value))} />
        </label>
      </section>
      <section>
        <h4>Arrange</h4>
        <div class="arrange">
          <button title="Align left" onclick={() => alignSel("left")} aria-label="Align left">⇤</button>
          <button title="Align centers (horizontal)" onclick={() => alignSel("hcenter")} aria-label="Align horizontal centers">↔</button>
          <button title="Align right" onclick={() => alignSel("right")} aria-label="Align right">⇥</button>
          <button title="Align top" onclick={() => alignSel("top")} aria-label="Align top">⤒</button>
          <button title="Align middles (vertical)" onclick={() => alignSel("vcenter")} aria-label="Align vertical centers">↕</button>
          <button title="Align bottom" onclick={() => alignSel("bottom")} aria-label="Align bottom">⤓</button>
        </div>
        <div class="arrange two">
          <button title="Distribute horizontally (needs 3+)" onclick={() => distSel("h")}>Distribute&nbsp;H</button>
          <button title="Distribute vertically (needs 3+)" onclick={() => distSel("v")}>Distribute&nbsp;V</button>
        </div>
        <div class="arrange two">
          <button title="Group (⌘/Ctrl+G)" onclick={() => withSel((d, s, i) => slideOps.groupElements(d, s, i))}>Group</button>
          <button title="Ungroup (⇧⌘/Ctrl+G)" onclick={() => withSel((d, s, i) => slideOps.ungroupElements(d, s, i))}>Ungroup</button>
        </div>
        <div class="arrange two">
          <button title="Bring to front (⇧⌘/Ctrl+])" onclick={() => withSel((d, s, i) => slideOps.bringToFront(d, s, i))}>Bring front</button>
          <button title="Send to back (⇧⌘/Ctrl+[)" onclick={() => withSel((d, s, i) => slideOps.sendToBack(d, s, i))}>Send back</button>
        </div>
      </section>
      <section>
        <button class="danger" onclick={deleteSelected}>Delete {selectedEls.length} elements</button>
      </section>
    {/if}
  {:else if activeSlide}
    {@const s = activeSlide}
    <!-- NO SELECTION → SLIDE PROPERTIES -->
    <section class="hdr"><h4>Slide</h4></section>
    <section>
      <label class="full">Name<input type="text" value={s.name ?? ""}
        onchange={(e) => { const v = e.currentTarget.value; commitSlide({ name: v }); }} /></label>
      <label class="full">Background
        <input type="color" value={colorValue(s.background, theme.background)}
          onchange={(e) => { const v = e.currentTarget.value; commitSlide({ background: v }); }} />
      </label>
      <button class="add" onclick={clearBackground}>Use theme default</button>
    </section>
    <section>
      <label class="full">Layout
        <select value={s.layout ?? "blank"}
          onchange={(e) => { const v = e.currentTarget.value as LayoutId; commitSlide({ layout: v }); }}>
          <option value="title">Title</option>
          <option value="section">Section</option>
          <option value="content-figure">Content + figure</option>
          <option value="two-column">Two column</option>
          <option value="full-bleed">Full bleed</option>
          <option value="blank">Blank</option>
        </select>
      </label>
      <label class="full">Transition
        <select value={s.transition ?? "none"}
          onchange={(e) => { const v = e.currentTarget.value as TransitionKind; commitSlide({ transition: v }); }}>
          <option value="none">None</option>
          <option value="fade">Fade</option>
          <option value="slide">Slide</option>
          <option value="push">Push</option>
        </select>
      </label>
    </section>
    <section>
      <h4>Speaker notes</h4>
      <textarea rows="5" value={s.notes ?? ""} placeholder="Notes for the presenter view…"
        oninput={(e) => { const v = e.currentTarget.value; commitSlide({ notes: v }); }}
      ></textarea>
    </section>
  {:else}
    <p class="empty">No deck loaded.</p>
  {/if}
</div>

<style>
  .inspector {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    box-sizing: border-box;
    background: var(--c-surface);
    border-left: 1px solid var(--c-line);
    color: var(--c-tx);
    font-size: var(--ts-sm);
    padding: 2px 12px 28px;
  }
  section {
    padding: 10px 0;
    border-bottom: 1px solid var(--c-line);
  }
  section:last-child {
    border-bottom: none;
  }
  .hdr {
    padding-bottom: 6px;
  }
  h4 {
    margin: 0 0 8px;
    font-size: var(--ts-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--c-tx-muted);
  }
  .hdr h4 {
    color: var(--c-tx-hi);
    letter-spacing: 0.02em;
    text-transform: none;
    font-size: var(--ts-sm);
  }
  .row {
    display: flex;
    gap: var(--sp-2);
    margin-bottom: 6px;
  }
  .row:last-child {
    margin-bottom: 0;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
    color: var(--c-tx-2);
    font-size: var(--ts-xs);
  }
  label.full {
    width: 100%;
  }
  label.chk {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    font-size: var(--ts-sm);
    margin-top: 6px;
  }
  label.rng {
    gap: 5px;
    margin-top: 8px;
  }
  .rng-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .val {
    color: var(--c-tx-muted);
    font-size: var(--ts-xs);
    font-variant-numeric: tabular-nums;
  }
  input,
  select,
  textarea {
    box-sizing: border-box;
    width: 100%;
    background: var(--c-bg-raised, var(--c-bg));
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    border-radius: var(--r-1);
    padding: 4px 6px;
    font: inherit;
    font-size: var(--ts-sm);
    outline: none;
  }
  input:focus,
  select:focus,
  textarea:focus {
    border-color: var(--c-accent);
  }
  input[type="checkbox"] {
    width: auto;
  }
  input[type="range"] {
    padding: 0;
    accent-color: var(--c-accent);
  }
  input[type="color"] {
    height: 28px;
    padding: 2px;
    cursor: pointer;
  }
  textarea {
    resize: vertical;
    min-height: 46px;
    line-height: 1.45;
    font-family: inherit;
  }
  textarea.mono {
    font-family: var(--font-mono);
    font-size: var(--ts-xs);
  }
  button {
    background: var(--c-bg-raised, var(--c-bg));
    color: var(--c-tx-2);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    padding: 5px 8px;
    font: inherit;
    font-size: var(--ts-sm);
    cursor: pointer;
  }
  button:hover {
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .add {
    width: 100%;
    margin-top: 4px;
  }
  .arrange {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 4px;
    margin-bottom: 6px;
  }
  .arrange.two {
    grid-template-columns: 1fr 1fr;
  }
  .arrange:last-child {
    margin-bottom: 0;
  }
  .arrange button {
    padding: 5px 4px;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .arrange:not(.two) button {
    font-size: var(--ts-md, 15px);
    line-height: 1;
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 1px solid var(--c-line);
    border-radius: var(--r-2);
    padding: 6px;
    margin-bottom: 8px;
  }
  .blk-head {
    display: flex;
    align-items: flex-end;
    gap: var(--sp-2);
  }
  .blk-head .del {
    flex: 0 0 auto;
    width: 26px;
    padding: 4px 0;
    line-height: 1;
  }
  .del:hover {
    border-color: var(--c-danger);
    color: var(--c-danger);
  }
  .danger {
    width: 100%;
  }
  .danger:hover {
    border-color: var(--c-danger);
    color: var(--c-danger);
  }
  .ref {
    font-family: var(--font-mono);
    font-size: var(--ts-xs);
    color: var(--c-tx-muted);
    background: var(--c-bg);
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    padding: 6px 8px;
    word-break: break-all;
    margin-bottom: 6px;
  }
  .note {
    margin: 6px 0 0;
    font-size: var(--ts-xs);
    line-height: 1.4;
    color: var(--c-tx-muted);
  }
  .count {
    color: var(--c-tx-hi);
    font-variant-numeric: tabular-nums;
  }
  .empty {
    padding: 16px 0;
    color: var(--c-tx-muted);
    font-style: italic;
    font-size: var(--ts-sm);
  }
</style>

<script lang="ts" module>
  // Lucide-derived icon paths (ISC). Inlined to avoid a dependency for the
  // small set the shell needs; we can adopt the lucide-svelte package later.
  export const ICONS: Record<string, string> = {
    home: '<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    lighttable:
      '<rect width="18" height="14" x="3" y="3" rx="2"/><path d="M4 21h1"/><path d="M9 21h1"/><path d="M14 21h1"/><path d="M19 21h1"/>',
    // ---- mode icons (2026-11 redesign) ----
    // Each has its own outline and its own accent palette: neutral structure in
    // currentColor, colour (the --icon-* tokens in styles/tokens.css) only on the
    // one thing the mode is about. Every stroke width is written out, so an icon
    // looks the same whatever `stroke` the caller passes. verify-mode-icons pins
    // the set.
    // Figure: a plot being placed — selection box and handles, the curve, and the
    // Flux cursor itself (its dart from cursorFamily's ARROW_SHAPE, default colours).
    figure:
      '<path d="M11.7 15.5H3.5V4H17v7.6" stroke-width="1.5" stroke-linejoin="miter"/><path d="M6.1 12.75c3.2 0 3-6 8.4-6" stroke="var(--icon-figure)" stroke-width="2.4"/><rect x="1.7" y="2.2" width="3.6" height="3.6" rx=".7" fill="currentColor" stroke="none"/><rect x="15.2" y="2.2" width="3.6" height="3.6" rx=".7" fill="currentColor" stroke="none"/><rect x="1.7" y="13.7" width="3.6" height="3.6" rx=".7" fill="currentColor" stroke="none"/><path d="M12.9 11.2L21.46 16.22L17.19 17.33L14.69 20.96z" fill="var(--icon-pointer)" stroke="var(--icon-pointer-edge)" stroke-width="1.5" paint-order="stroke"/>',
    // Slide: a slide flying in — small and tilted, larger and straighter, at rest.
    slide:
      '<path d="M1.94 14.88L5.13 13.78M11.58 17.1L11.86 17.92L3.92 20.65L1.94 14.88" stroke-width="1.6" opacity=".4"/><path d="M4.6 10L7.7 9.57M16.46 15.35L16.6 16.4L5.71 17.93L4.6 10" stroke-width="1.6" opacity=".72"/><rect x="7.7" y="5.85" width="13" height="9.5" rx="2" stroke-width="2"/><path d="M12.8 8.4v4.4l3.74-2.2z" fill="var(--icon-slide)" stroke="var(--icon-slide)" stroke-width="1.1"/>',
    // Paper: the text caret splitting two lines of words.
    paper:
      '<path d="M3 9h5M3 15h5M16 9h5M16 15h5" stroke-width="2"/><path d="M12 5.25v13.5M8.9 3.5c1.9 0 3.1.6 3.1 1.75 0-1.15 1.2-1.75 3.1-1.75M8.9 20.5c1.9 0 3.1-.6 3.1-1.75 0 1.15 1.2 1.75 3.1 1.75" stroke="var(--icon-paper)" stroke-width="2.2"/>',
    // Library: book spines on a shelf, one leaning.
    library:
      '<rect x="2.5" y="6.5" width="3.8" height="14" rx=".9" fill="var(--icon-library)" stroke="none"/><rect x="6.9" y="9" width="3.1" height="11.5" rx=".8" fill="currentColor" stroke="none"/><rect x="10.6" y="4.5" width="3.5" height="16" rx=".9" fill="currentColor" stroke="none"/><rect x="18.3" y="7" width="3.5" height="13.5" rx=".9" fill="var(--icon-library)" stroke="none" transform="rotate(-18 18.3 20.5)"/><path d="M2.5 22.1h19" stroke-width="1.4"/>',
    // Reader: a loose pile of printed papers, one line highlighted.
    reader:
      '<path d="M3.3 6.76L6.8 5.95M12.23 19.58L6.56 20.89L3.3 6.76" stroke-width="1.6" opacity=".6"/><path d="M16.8 5.82L20.9 7.15L16.41 20.94L9.06 18.55" stroke-width="1.6" opacity=".85"/><rect x="6.8" y="4.05" width="10" height="14.5" rx="1.5" stroke-width="2"/><path d="M9.5 7.4h4.6M9.5 15.2h3" stroke-width="1.75"/><path d="M9.1 11.3h5.4" stroke="var(--icon-reader)" stroke-width="3.8" stroke-linecap="butt"/>',
    help:
      '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.2a2.8 2.8 0 1 1 4.1 2.5c-.9.5-1.3 1-1.3 1.9"/><circle cx="12" cy="16.8" r="0.7" fill="currentColor" stroke="none"/>',
    inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="m3 13 3-8h12l3 8v6H3z"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    folder:
      '<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H21a1 1 0 0 1 .97 1.24l-1.5 6A2 2 0 0 1 18.53 19H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v1.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    min: '<path d="M5 12h14"/>',
    max: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
    restore:
      '<rect x="8" y="3.5" width="12.5" height="12.5" rx="1.5"/><path d="M16 16.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 2 19V8a1.5 1.5 0 0 1 1.5-1.5H6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    split:
      '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M12 4v16"/>',
    settings:
      '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    // ---- formatting (selection bubble) ----
    bold: '<path d="M6 4h7a4 4 0 0 1 0 8H6z"/><path d="M6 12h8a4 4 0 0 1 0 8H6z"/>',
    italic:
      '<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>',
    codeInline: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    superscript: '<path d="m4 19 8-8"/><path d="m12 19-8-8"/><path d="M20 12h-4c0-1.5.44-2 1.5-2.5S20 8.33 20 7c0-.47-.17-.93-.48-1.29a2.11 2.11 0 0 0-2.62-.44c-.42.24-.74.62-.9 1.07"/>',
    subscript: '<path d="m4 5 8 8"/><path d="m12 5-8 8"/><path d="M20 19h-4c0-1.5.44-2 1.5-2.5S20 15.33 20 14c0-.47-.17-.93-.48-1.29a2.11 2.11 0 0 0-2.62-.44c-.42.24-.74.62-.9 1.07"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    heading: '<path d="M6 12h12"/><path d="M6 4v16"/><path d="M18 4v16"/>',
    quote:
      '<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>',
    listBullet:
      '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    textColor: '<path d="M4 20h16"/><path d="m6 16 6-12 6 12"/><path d="M8 12h8"/>',
    // ---- toolbar / chrome ----
    panelLeft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    // Rail toggles: the sidebar half is FILLED, so on/off reads at a glance.
    panelLeftFill:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M3.6 3.6h5v16.8h-5z" fill="currentColor" stroke="none" opacity="0.55"/>',
    panelRight: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
    panelRightFill:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="M15.4 3.6h5v16.8h-5z" fill="currentColor" stroke="none" opacity="0.55"/>',
    textFlow: '<path d="M21 6H3"/><path d="M15 12H3"/><path d="M17 18H3"/>',
    page: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/>',
    fileText:
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    download:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    message:
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    // ---- science (Phase 2/3) ----
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    image:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    table:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M12 3v18"/>',
    hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
    bookOpen:
      '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    bookText:
      '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="M8 11h8"/><path d="M8 7h6"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
    trash:
      '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    cornerUpRight: '<path d="m15 14 5-5-5-5"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
    reply: '<path d="M9 17l-5-5 5-5"/><path d="M4 12h11a5 5 0 0 1 5 5v2"/>',
  };
</script>

<script lang="ts">
  let {
    name,
    size = 18,
    stroke = 1.75,
    class: klass = "",
  }: { name: string; size?: number; stroke?: number; class?: string } = $props();
</script>

<svg
  class={klass}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html ICONS[name] ?? ""}
</svg>

/**
 * The board's pictograms: 16 x 16, drawn for a 1.3 px round stroke in the key's ink. A part with class `f` is
 * filled instead of stroked, `q` is quiet (half strength). Markup strings: they are constants of this file,
 * never anything read from a project.
 */
export const GLYPHS = {
  close: `<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>`,
  // A contrast disc with a spark: set the contrast for me.
  auto: `<circle cx="7" cy="9" r="4.6"/><path class="f" d="M7 4.4a4.6 4.6 0 010 9.2z"/><path d="M13 1.6v3.6M11.2 3.4h3.6"/>`,
  // One picture becoming one per channel.
  split: `<path class="f q" d="M1.6 3.4h6.8v9.2H1.6z"/><path d="M10.6 3.4h3.8v3.9h-3.8zM10.6 8.7h3.8v3.9h-3.8z"/>`,
  // A viewfinder: the frame in hand.
  frame: `<path d="M2 5.6V2h3.6M10.4 2H14v3.6M14 10.4V14h-3.6M5.6 14H2v-3.6"/><circle class="f" cx="8" cy="8" r="1.5"/>`,
  // A region pulled out of its picture.
  inset: `<path class="q" d="M1.8 4.2h9v10h-9z" stroke-dasharray="1.6 1.6"/><path class="f" d="M8.2 1.8h6v6h-6z"/>`,
  whole: `<path d="M9.6 2H14v4.4M14 2L9.4 6.6M6.4 14H2V9.6M2 14l4.6-4.6"/>`,
  // True pixels: squares you can count.
  pixels: `<path class="f" d="M2 2h4v4H2zM10 2h4v4h-4zM6 6h4v4H6zM2 10h4v4H2zM10 10h4v4h-4z"/>`,
  scalebar: `<path d="M2 5.4v5.2M14 5.4v5.2" /><path d="M2 8h12" stroke-width="2"/>`,
  // Words in the picture's corner: where (or when) this plane is.
  stamp: `<path class="q" d="M1.8 1.8h12.4v12.4H1.8z"/><path d="M4.2 5h5.6M4.2 7.8h3.6" stroke-width="1.5"/>`,
  // A legend: each channel by name.
  names: `<circle class="f" cx="3.4" cy="4.2" r="1.4"/><circle class="f" cx="3.4" cy="8" r="1.4"/><circle class="f" cx="3.4" cy="11.8" r="1.4"/><path d="M6.8 4.2h7M6.8 8h4.6M6.8 11.8h6"/>`,
  // A calibration bar: dark to bright, with its ticks.
  colorbar: `<path d="M1.8 4.6h12.4v4.6H1.8z"/><path class="f" d="M8 4.6h6.2v4.6H8z"/><path d="M2 11.6v1.8M8 11.6v1.8M14 11.6v1.8"/>`,
  layers: `<path d="M8 2.2l6 3.1-6 3.1-6-3.1z"/><path d="M2 8.4l6 3.1 6-3.1M2 11.2l6 3.1 6-3.1" class="q"/>`,
  play: `<path class="f" d="M5.2 3.2v9.6l8-4.8z"/>`,
  // Play through: a walk to the far end of the stack (a play mark against its end stop).
  through: `<path class="f" d="M2.6 3.4v9.2l7.2-4.6z"/><path d="M12.6 3.2v9.6" stroke-width="2"/>`,
  // Blend planes: two planes over each other, the one behind showing through.
  blend: `<path class="q f" d="M2 4.4h8.2v8.2H2z"/><path d="M5.8 2h8.2v8.2H5.8z"/>`,
  // The movie keys: start, pause, stop.
  pause: `<path class="f" d="M4.4 3.6h2.7v8.8H4.4zM8.9 3.6h2.7v8.8H8.9z"/>`,
  halt: `<path class="f" d="M4 4h8v8H4z"/>`,
  // How a movie runs: round and round, back and forth, once.
  loop: `<path d="M12.4 6.4a4.6 4.6 0 10.3 3.2"/><path d="M13.4 3.2v3.4H10"/>`,
  bounce: `<path d="M2.4 6h10.2M10.4 3.6L12.8 6l-2.4 2.4"/><path d="M13.6 10.4H3.4M5.6 8L3.2 10.4l2.4 2.4"/>`,
  once: `<path d="M2.4 8h9.6M9.4 5.2L12.2 8l-2.8 2.8"/><path d="M13.8 4.4v7.2" stroke-width="1.6"/>`,
  stop: `<path class="f" d="M4.4 3.6h2.7v8.8H4.4zM8.9 3.6h2.7v8.8H8.9z"/>`,
  // Planes laid onto one.
  project: `<path class="q" d="M3.2 3h9.6M3.2 5.8h9.6M3.2 8.6h9.6"/><path d="M2 12.6h12" stroke-width="2.2"/>`,
  solo: `<circle cx="8" cy="8" r="5.2"/><circle class="f" cx="8" cy="8" r="2"/>`,
  color: `<path d="M8 2.2c2.5 3 4.1 5 4.1 7.2a4.1 4.1 0 01-8.2 0c0-2.2 1.6-4.2 4.1-7.2z"/><path class="f q" d="M8 13.4a4 4 0 004-4H4a4 4 0 004 4z"/>`,
  linear: `<path class="q" d="M2.2 2.2v11.6h11.6"/><path d="M3.4 12.6l9.6-9.6"/>`,
  log: `<path class="q" d="M2.2 2.2v11.6h11.6"/><path d="M3.4 12.6C3.6 6.6 6.6 3.4 13 3"/>`,
  gamma: `<path class="q" d="M2.2 2.2v11.6h11.6"/><path d="M3.4 12.6C9.4 12.4 12.6 9.4 13 3"/>`,
  invert: `<circle cx="8" cy="8" r="5.4"/><path class="f" d="M8 2.6a5.4 5.4 0 000 10.8z"/>`,
  reset: `<path d="M3.4 8.4a4.6 4.6 0 104.6-4.8H4.4"/><path d="M6.6 1.4L4.2 3.6l2.4 2.2"/>`,
  open: `<path d="M6 3.6l4.4 4.4L6 12.4"/>`,
  // Objects coloured by a column: three outlines, each its own colour (one filled, one quiet, one bare).
  colorBy: `<circle class="f" cx="4.4" cy="5" r="2.6"/><circle class="f q" cx="11.4" cy="5.6" r="2.6"/><circle cx="7.6" cy="11.4" r="2.6"/>`,
  // Objects faded by a column: the same shape, fainter and fainter.
  opacityBy: `<path class="f" d="M1.6 5.4h3.8v5.2H1.6z"/><path class="f q" d="M6.1 5.4h3.8v5.2H6.1z"/><path d="M10.6 5.4h3.8v5.2h-3.8z" stroke-dasharray="1.2 1.2"/>`,
  // The key: swatches with their words.
  key: `<path class="f" d="M2 2.6h3v3H2z"/><path class="f q" d="M2 6.5h3v3H2z"/><path d="M2.5 10.9h2v2h-2z"/><path d="M7 4.1h7M7 8h5M7 11.9h6"/>`,
  // Objects without a value: left out.
  hideMissing: `<circle cx="8" cy="8" r="5" stroke-dasharray="1.6 1.6"/><path d="M3.4 12.6l9.2-9.2"/>`,
  none: `<circle cx="8" cy="8" r="5.2"/><path d="M4.4 11.6l7.2-7.2"/>`,
  search: `<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.6 3.6"/>`,
} as const;

export type GlyphName = keyof typeof GLYPHS;

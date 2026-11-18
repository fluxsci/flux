// How the Dissect viewer names things. A plot's companion files are usually named after the plot
// itself: `growth-curves-rem-sorted/growth-curves-rem-sorted--source_data.csv` under the plot
// `growth-curves`. Shown whole, every label in a row starts with the same forty characters and
// the part that tells them apart is cut off (owner, 2026-11-18: "get the whole name displayed …
// make sure the file names don't overlap"). So a label is the name WITHOUT what it shares with
// its parent; the whole name stays in the tooltip. Pure: no DOM, no I/O.

/** The last segment of a plot key (`folder/sub/growth-curves` → `growth-curves`). */
export const keyStem = (key: string): string => key.split("/").filter(Boolean).pop() ?? key;

const LEADING_SEPARATORS = /^[\s._\-–—]+/;

/** `name` without a leading `stem`, when what follows the stem starts at a separator or is
 *  nothing at all ("plotter" does not lose "plot"). Case is ignored for the comparison. */
export function withoutStem(name: string, stem: string): string {
  if (!stem || name.length < stem.length || name.slice(0, stem.length).toLowerCase() !== stem.toLowerCase()) return name;
  const rest = name.slice(stem.length);
  if (rest && !LEADING_SEPARATORS.test(rest)) return name;
  return rest.replace(LEADING_SEPARATORS, "");
}

/** A group folder's label: its name without the plot's name in front (the whole name when
 *  nothing would be left). */
export function groupLabel(group: string, stem: string): string {
  return withoutStem(group, stem) || group;
}

/** A file's label and extension. The label is the name without its extension and without its
 *  group's name (else the plot's) in front; it is "" when the file is named exactly after its
 *  group or plot, which is to say it IS that group's own picture or table. */
export function fileLabel(name: string, group: string, stem: string): { label: string; ext: string } {
  const match = /^(.*?)(?:\.([A-Za-z0-9]{1,8}))?$/.exec(name);
  const base = match?.[1] || name, ext = (match?.[2] ?? "").toLowerCase();
  let label = group ? withoutStem(base, group) : base;
  if (label === base) label = withoutStem(base, stem);
  return { label, ext };
}

/** Roughly how wide `text` is, in px, set in the viewer's small mono face at `size` px with
 *  `spacing` em of letter-spacing: enough to lay labels out without measuring the DOM. */
export const monoWidth = (text: string, size = 9.5, spacing = 0): number => Math.ceil(text.length * size * (0.6 + spacing));

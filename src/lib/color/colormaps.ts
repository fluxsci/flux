// Pure lookup data for renderers/offline exports. Collection descriptions,
// websites and licenses remain in the picker-facing collections module.
import { COLORMAP_DATA, type ColormapDef, type ColormapData } from './colormaps.gen';
export { COLORMAP_DATA };
export type { ColormapDef, ColormapData, ColormapType } from './colormaps.gen';

export function findColormap(name: string): { collection: ColormapData; map: ColormapDef; reversed: boolean } | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const reversed = trimmed.endsWith('_r'), base = reversed ? trimmed.slice(0, -2) : trimmed, dot = base.indexOf('.');
  if (dot > 0) {
    const prefix = base.slice(0, dot), id = prefix === 'cmr' ? 'cmasher' : prefix;
    const collection = COLORMAP_DATA.find(c => c.id === id), map = collection?.maps.find(m => m.name === base.slice(dot + 1));
    return collection && map ? { collection, map, reversed } : null;
  }
  for (const collection of COLORMAP_DATA) {
    const map = collection.maps.find(m => m.name === base);
    if (map) return { collection, map, reversed };
  }
  return null;
}

export function colormapStops(map: ColormapDef, reversed = false): string[] {
  return reversed ? [...map.colors].reverse() : map.colors;
}

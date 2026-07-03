// Single source of color truth: the Flexoki 2.0 design-token file at repo root.
import tokens from '../../../../flexoki.tokens.json'

const flat: Record<string, string> = {}
for (const [group, entries] of Object.entries(tokens as Record<string, unknown>)) {
  if (group.startsWith('$') || typeof entries !== 'object' || entries === null) continue
  for (const [name, tok] of Object.entries(entries as Record<string, any>)) {
    const hex = tok?.$value?.hex
    if (typeof hex === 'string') flat[name] = hex
  }
}

/** Hex for a Flexoki token, e.g. fx('paper'), fx('olive-600'). */
export function fx(name: string): string {
  const hex = flat[name]
  if (!hex) throw new Error(`unknown flexoki token: ${name}`)
  return hex
}

/** rgba() string for a token at a given alpha. */
export function fxa(name: string, alpha: number): string {
  const hex = fx(name)
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

export const tokenNames = Object.keys(flat)

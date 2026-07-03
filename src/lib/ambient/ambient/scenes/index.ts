import type { Scene } from '../types'
import { rainpond } from './rainpond'
import { harmonograph } from './harmonograph'
import { constellations } from './constellations'
import { contours } from './contours'
import { chladni } from './chladni'
import { inkwind } from './inkwind'
import { suminagashi } from './suminagashi'
import { neurons } from './neurons'
import { radiolaria } from './radiolaria'
import { orrery } from './orrery'
import { hitomezashi } from './hitomezashi'
import { loom } from './loom'
import { mountains } from './mountains'
import { asemic } from './asemic'

export const sceneList: Scene[] = [
  rainpond,
  harmonograph,
  constellations,
  contours,
  chladni,
  inkwind,
  suminagashi,
  neurons,
  radiolaria,
  orrery,
  hitomezashi,
  loom,
  mountains,
  asemic,
]

export const scenes: Record<string, Scene> = Object.fromEntries(
  sceneList.map((s) => [s.id, s])
)

// Dedicated to transient viewport snapshots; gallery prewarming can never
// queue in front of a zoom capture. A resvg panic is contained in this child.
import { createRequire } from 'node:module';
import { rasterizeScene } from './sceneRasterEngine.mjs';
const { readFrames, writeFrame } = createRequire(import.meta.url)('./sceneRasterProtocol.cjs');
let busy = false;
readFrames(process.stdin, async (header, body) => {
  if (busy) { writeFrame(process.stdout, { rid: header.rid, error: 'Raster worker is busy' }, Buffer.alloc(0)); return; }
  busy = true;
  try {
    const result = await rasterizeScene({ rid: header.rid, regions: header.regions, svg: body.toString('utf8') });
    writeFrame(process.stdout, { rid: header.rid, rasters: result.rasters.map(r => ({ width: r.width, height: r.height, byteLength: r.bytes.length })) }, Buffer.concat(result.rasters.map(r => r.bytes)));
  } catch (error) { writeFrame(process.stdout, { rid: header.rid, error: String(error?.message ?? error) }, Buffer.alloc(0)); }
  finally { busy = false; }
}, () => process.exit(2));
process.stdin.on('end', () => process.exit(0));

// Only this supervised Node child loads native resvg; stdout is binary frames.
import protocol from './sceneRasterProtocol.cjs';
import { rasterizeFigure } from './figureRasterEngine.mjs';
const { readFrames, writeFrame } = protocol;
let busy = false;
readFrames(process.stdin, async (header, body) => {
  if (busy) { writeFrame(process.stdout, { rid: header.rid, error: 'Figure raster worker is busy' }, Buffer.alloc(0)); return; }
  busy = true;
  try {
    const request = JSON.parse(body.toString('utf8'));
    if (request.rid !== header.rid) throw Error('Invalid figure raster identity');
    const { png, ...result } = await rasterizeFigure(request);
    writeFrame(process.stdout, { rid: header.rid, ...result }, png);
  } catch (error) { writeFrame(process.stdout, { rid: header.rid, error: String(error?.message ?? error) }, Buffer.alloc(0)); }
  finally { busy = false; }
}, () => process.exit(2), 96 * 1024 * 1024);
process.stdin.on('end', () => process.exit(0));

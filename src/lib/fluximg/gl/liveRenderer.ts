/**
 * The live view's renderer: WebGL2, raw stored samples as integer or float textures, and the whole view
 * (value map, display window, norm, colour table, blend, background, crop) applied in the fragment shader.
 * Changing contrast, a colour map or the crop is a uniform update and one draw.
 *
 * It is a FAST PATH for `render.ts`, never a second definition of the picture: the law in the shader below is
 * the one in render.ts, statement for statement, and a gate holds the two to the same 8-bit output. Two
 * documented differences, both only while interacting: when minifying it samples nearest instead of averaging
 * (the still that replaces it on release averages), and normalization runs in float32.
 *
 * Browser-only (needs a canvas). No Svelte, no stores: the live view component owns one instance.
 */
import type { ValueMap } from "../encoding";
import type { FluximgDtype, FluximgTypedArray } from "../types";
import type { PixelRect } from "../view";

export interface LivePlane {
  /** Identity of the pixels (asset, level, plane, or a projection's recipe): the texture cache key. */
  key: string;
  width: number;
  height: number;
  dtype: FluximgDtype;
  data: FluximgTypedArray;
  /** null = the samples already are values (a projection), with NaN for no data. */
  map: ValueMap | null;
}

export interface LiveChannel {
  plane: LivePlane | null;
  /** 256 RGBA entries. */
  table: Uint8Array;
  range: [number, number];
  norm: "linear" | "log" | "gamma";
  gamma: number;
}

export interface LiveLayer extends LiveChannel {
  opacity: number;
  opacityFromValue: boolean;
}

export interface LiveFrame {
  /** Size of the source planes (whichever level they come from). */
  width: number;
  height: number;
  /** Only the channels that contribute (visible ones, or the solo channel). */
  channels: LiveChannel[];
  layers: LiveLayer[];
  /** "#rrggbb" or "transparent". */
  background: string;
  smooth: boolean;
  /** The visible rectangle, in source-plane pixels. */
  crop: PixelRect;
  /** Drawing-buffer size in device pixels. */
  outWidth: number;
  outHeight: number;
}

export const MAX_LIVE_CHANNELS = 6;
export const MAX_LIVE_LAYERS = 3;
const LUT_ROWS = MAX_LIVE_CHANNELS + MAX_LIVE_LAYERS;

type Kind = "u" | "i" | "f";
const kindOf = (d: FluximgDtype): Kind => (d === "float32" || d === "float64" ? "f" : d === "int8" || d === "int16" || d === "int32" ? "i" : "u");

interface Tex { tex: WebGLTexture; bytes: number; used: number; width: number; height: number; kind: Kind; data: FluximgTypedArray }

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** One sampling function per sampler type: (value, ok) at an integer source pixel; outside the plane is no data. */
function fetchFn(kind: Kind): string {
  const sampler = kind === "u" ? "usampler2D" : kind === "i" ? "isampler2D" : "sampler2D";
  const nan = kind === "f" ? "f != f || isnan(f) || " : "";
  return `
float fetch_${kind}(${sampler} s, ivec2 p, vec4 m, float hasNodata, out float ok) {
  if (p.x < 0 || p.y < 0 || p.x >= int(uSrc.x) || p.y >= int(uSrc.y)) { ok = 0.0; return 0.0; }
  float f = float(texelFetch(s, p, 0).r);
  ok = (${nan}(hasNodata > 0.5 && f == m.w)) ? 0.0 : 1.0;
  return m.y + m.x * (f - m.z);
}
float sample_${kind}(${sampler} s, vec2 src, vec4 m, float hasNodata, out float ok) {
  if (uSmooth < 0.5) return fetch_${kind}(s, ivec2(floor(src)), m, hasNodata, ok);
  // Bilinear on VALUES between pixel centres; a neighbour without data is left out and the weights renormalized.
  vec2 q = src - 0.5; ivec2 p0 = ivec2(floor(q)); vec2 t = q - floor(q);
  float acc = 0.0, wsum = 0.0, k; float v;
  v = fetch_${kind}(s, p0, m, hasNodata, k);               acc += v * k * (1.0 - t.x) * (1.0 - t.y); wsum += k * (1.0 - t.x) * (1.0 - t.y);
  v = fetch_${kind}(s, p0 + ivec2(1, 0), m, hasNodata, k); acc += v * k * t.x * (1.0 - t.y);         wsum += k * t.x * (1.0 - t.y);
  v = fetch_${kind}(s, p0 + ivec2(0, 1), m, hasNodata, k); acc += v * k * (1.0 - t.x) * t.y;         wsum += k * (1.0 - t.x) * t.y;
  v = fetch_${kind}(s, p0 + ivec2(1, 1), m, hasNodata, k); acc += v * k * t.x * t.y;                 wsum += k * t.x * t.y;
  ok = wsum > 0.0 ? 1.0 : 0.0;
  return wsum > 0.0 ? acc / wsum : 0.0;
}`;
}

function fragmentSource(channels: Kind[], layers: Kind[]): string {
  const kinds = [...new Set([...channels, ...layers])];
  const decl = (prefix: string, i: number, kind: Kind): string =>
    `uniform ${kind === "u" ? "usampler2D" : kind === "i" ? "isampler2D" : "sampler2D"} ${prefix}T${i};
uniform vec4 ${prefix}M${i};   // mul, add, sub, nodata
uniform vec4 ${prefix}W${i};   // low, high, gamma, norm (0 linear, 1 log, 2 gamma)
uniform vec4 ${prefix}O${i};   // hasNodata, lut row, opacity, opacityFromValue`;
  return `#version 300 es
precision highp float; precision highp int;
precision highp sampler2D; precision highp usampler2D; precision highp isampler2D;
uniform vec4 uCrop;            // x, y, width, height in source pixels
uniform vec2 uOut;             // output size in device pixels
uniform vec2 uSrc;             // source plane size
uniform vec4 uBackground;      // rgb, alpha (0 = transparent)
uniform float uSmooth;
uniform sampler2D uLut;        // 256 x ${LUT_ROWS} RGBA
${channels.map((k, i) => decl("c", i, k)).join("\n")}
${layers.map((k, i) => decl("l", i, k)).join("\n")}
out vec4 outColor;
${kinds.map(fetchFn).join("\n")}
// The colour law of render.ts: normalize into [0, 1], slot = min(255, trunc(x * 256)).
float norm01(float v, vec4 w) {
  float x;
  if (w.w == 1.0 && w.x > 0.0) x = v > 0.0 ? log(v / w.x) / log(w.y / w.x) : 0.0;
  else {
    x = (v - w.x) / (w.y - w.x);
    if (w.w == 2.0) x = pow(clamp(x, 0.0, 1.0), w.z);
  }
  return clamp(x, 0.0, 1.0);
}
vec3 lut(float x, float row) { return texelFetch(uLut, ivec2(min(255, int(x * 256.0)), int(row)), 0).rgb; }
void main() {
  // Output pixel (ox, oy), counted from the top-left, shows the source point at the centre of its footprint.
  vec2 o = vec2(floor(gl_FragCoord.x), uOut.y - 1.0 - floor(gl_FragCoord.y));
  vec2 src = uCrop.xy + (o + 0.5) * (uCrop.zw / uOut);
  vec3 rgb = vec3(0.0); float any = 0.0; float ok; float v;
${channels.map((k, i) => `  v = sample_${k}(cT${i}, src, cM${i}, cO${i}.x, ok); if (ok > 0.5) { rgb += lut(norm01(v, cW${i}), cO${i}.y); any = 1.0; }`).join("\n")}
  vec4 c = any > 0.5 ? vec4(min(rgb, vec3(1.0)), 1.0) : vec4(uBackground.rgb * uBackground.a, uBackground.a);
${layers.map((k, i) => `  v = sample_${k}(lT${i}, src, lM${i}, lO${i}.x, ok); if (ok > 0.5) { float x = norm01(v, lW${i}); float a = lO${i}.z * (lO${i}.w > 0.5 ? x : 1.0); c = vec4(lut(x, lO${i}.y) * a + c.rgb * (1.0 - a), a + c.a * (1.0 - a)); }`).join("\n")}
  outColor = c;                // premultiplied
}`;
}

export class FluximgLiveRenderer {
  readonly gl: WebGL2RenderingContext;
  private programs = new Map<string, { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> }>();
  private textures = new Map<string, Tex>();
  private lutTex: WebGLTexture;
  private lutRows: Array<Uint8Array | null> = new Array(LUT_ROWS).fill(null);
  private quad: WebGLBuffer;
  private tick = 0;
  private residentBytes = 0;
  lost = false;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas, private budgetBytes = 384 * 1024 * 1024) {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: "high-performance" }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("fluximg: WebGL2 is not available");
    this.gl = gl;
    (canvas as HTMLCanvasElement).addEventListener?.("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.lutTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + 15);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 256, LUT_ROWS);
    this.nearest(gl.TEXTURE_2D);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
  }

  /** The renderer string of the GPU actually in use (gates record it; a software rasterizer is still correct). */
  rendererName(): string {
    const ext = this.gl.getExtension("WEBGL_debug_renderer_info");
    return String(ext ? this.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : this.gl.getParameter(this.gl.RENDERER));
  }

  private nearest(target: number): void {
    const gl = this.gl;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private program(channels: Kind[], layers: Kind[]): { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> } {
    const sig = `${channels.join("")}|${layers.join("")}`;
    let p = this.programs.get(sig);
    if (p) return p;
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`fluximg: shader failed to compile: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource(channels, layers)));
    gl.bindAttribLocation(program, 0, "aPos");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`fluximg: shader failed to link: ${gl.getProgramInfoLog(program)}`);
    p = { program, uniforms: new Map() };
    this.programs.set(sig, p);
    return p;
  }

  /** True when the plane's samples are already on the GPU. */
  has(key: string): boolean { return this.textures.has(key); }

  /** Put a plane on the GPU ahead of the frame that needs it (decode-ahead calls this). */
  upload(plane: LivePlane): void {
    const gl = this.gl;
    const cached = this.textures.get(plane.key);
    if (cached && cached.data === plane.data) { cached.used = ++this.tick; return; }
    if (cached) this.drop(plane.key);
    const kind = kindOf(plane.dtype);
    let data: ArrayBufferView = plane.data, internal: number, format: number, type: number, bytes: number;
    switch (plane.dtype) {
      case "uint8": internal = gl.R8UI; format = gl.RED_INTEGER; type = gl.UNSIGNED_BYTE; bytes = 1; break;
      case "int8": internal = gl.R8I; format = gl.RED_INTEGER; type = gl.BYTE; bytes = 1; break;
      case "uint16": internal = gl.R16UI; format = gl.RED_INTEGER; type = gl.UNSIGNED_SHORT; bytes = 2; break;
      case "int16": internal = gl.R16I; format = gl.RED_INTEGER; type = gl.SHORT; bytes = 2; break;
      case "uint32": internal = gl.R32UI; format = gl.RED_INTEGER; type = gl.UNSIGNED_INT; bytes = 4; break;
      case "int32": internal = gl.R32I; format = gl.RED_INTEGER; type = gl.INT; bytes = 4; break;
      case "float64": data = Float32Array.from(plane.data as Float64Array); internal = gl.R32F; format = gl.RED; type = gl.FLOAT; bytes = 4; break;
      default: internal = gl.R32F; format = gl.RED; type = gl.FLOAT; bytes = 4;
    }
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + 14);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, plane.width, plane.height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, plane.width, plane.height, format, type, data);
    this.nearest(gl.TEXTURE_2D);
    const size = plane.width * plane.height * bytes;
    this.textures.set(plane.key, { tex, bytes: size, used: ++this.tick, width: plane.width, height: plane.height, kind, data: plane.data });
    this.residentBytes += size;
  }

  private drop(key: string): void {
    const t = this.textures.get(key);
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.residentBytes -= t.bytes;
    this.textures.delete(key);
  }

  /** Release least-recently-used planes until the cache fits its budget; planes in `keep` stay. */
  trim(keep?: ReadonlySet<string>): void {
    if (this.residentBytes <= this.budgetBytes) return;
    const order = [...this.textures.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key] of order) {
      if (this.residentBytes <= this.budgetBytes) break;
      if (keep?.has(key)) continue;
      this.drop(key);
    }
  }

  get bytes(): number { return this.residentBytes; }

  private setLutRow(row: number, table: Uint8Array): void {
    if (this.lutRows[row] === table) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + 15);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, table.subarray(0, 1024));
    this.lutRows[row] = table;
  }

  /** Draw one frame. A channel or layer whose plane has not arrived yet is simply left out of this frame. */
  draw(frame: LiveFrame): void {
    const gl = this.gl;
    if (this.lost) return;
    const canvas = this.canvas;
    if (canvas.width !== frame.outWidth || canvas.height !== frame.outHeight) { canvas.width = frame.outWidth; canvas.height = frame.outHeight; }
    const channels = frame.channels.filter((c) => c.plane).slice(0, MAX_LIVE_CHANNELS);
    const layers = frame.layers.filter((l) => l.plane).slice(0, MAX_LIVE_LAYERS);
    const keep = new Set<string>();
    for (const c of [...channels, ...layers]) { this.upload(c.plane!); keep.add(c.plane!.key); }
    const { program, uniforms } = this.program(channels.map((c) => kindOf(c.plane!.dtype)), layers.map((l) => kindOf(l.plane!.dtype)));
    const u = (name: string): WebGLUniformLocation | null => {
      if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name));
      return uniforms.get(name)!;
    };
    gl.viewport(0, 0, frame.outWidth, frame.outHeight);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(u("uCrop"), frame.crop.x, frame.crop.y, frame.crop.width, frame.crop.height);
    gl.uniform2f(u("uOut"), frame.outWidth, frame.outHeight);
    gl.uniform2f(u("uSrc"), frame.width, frame.height);
    const bg = parseBackground(frame.background);
    gl.uniform4f(u("uBackground"), bg[0], bg[1], bg[2], bg[3]);
    // Bilinear only when magnifying, as in render.ts.
    gl.uniform1f(u("uSmooth"), frame.smooth && frame.crop.width / frame.outWidth < 1 ? 1 : 0);
    gl.uniform1i(u("uLut"), 15);
    const bind = (prefix: string, i: number, unit: number, row: number, c: LiveChannel, opacity: number, fromValue: boolean): void => {
      const t = this.textures.get(c.plane!.key)!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform1i(u(`${prefix}T${i}`), unit);
      const m = c.plane!.map;
      gl.uniform4f(u(`${prefix}M${i}`), m ? m.mul : 1, m ? m.add : 0, m ? m.sub : 0, m && m.nodata !== null ? m.nodata : 0);
      gl.uniform4f(u(`${prefix}W${i}`), c.range[0], c.range[1], c.gamma, c.norm === "log" ? 1 : c.norm === "gamma" ? 2 : 0);
      gl.uniform4f(u(`${prefix}O${i}`), m && m.nodata !== null ? 1 : 0, row, opacity, fromValue ? 1 : 0);
      this.setLutRow(row, c.table);
    };
    channels.forEach((c, i) => bind("c", i, i, i, c, 1, false));
    layers.forEach((l, i) => bind("l", i, MAX_LIVE_CHANNELS + i, MAX_LIVE_CHANNELS + i, l, l.opacity, l.opacityFromValue));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.trim(keep);
  }

  /** The drawing buffer as straight-alpha RGBA rows from the top (for gates; not on the interactive path). */
  readPixels(): Uint8ClampedArray {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4, dst = y * w * 4;
      for (let x = 0; x < w * 4; x += 4) {
        const a = raw[src + x + 3];
        // un-premultiply
        out[dst + x] = a ? Math.round((raw[src + x] * 255) / a) : 0;
        out[dst + x + 1] = a ? Math.round((raw[src + x + 1] * 255) / a) : 0;
        out[dst + x + 2] = a ? Math.round((raw[src + x + 2] * 255) / a) : 0;
        out[dst + x + 3] = a;
      }
    }
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    for (const key of [...this.textures.keys()]) this.drop(key);
    for (const p of this.programs.values()) gl.deleteProgram(p.program);
    this.programs.clear();
    gl.deleteTexture(this.lutTex);
    gl.deleteBuffer(this.quad);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function parseBackground(bg: string): [number, number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bg);
  if (!m) return [0, 0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255, 1];
}

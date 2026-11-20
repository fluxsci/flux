# fluximg/1: the on-disk contract

A **fluximg** is one N-dimensional scientific image and what is known about it: pixels, context, layers.
It is a directory. fluxplot writes it, Flux reads it, and Flux can also write it (conversions, tests).

This document is normative. Its executable half lives in the Flux repository:

- `src/lib/fluximg/` holds the reference reader, writer and validator (pure TypeScript);
- `scripts/fluximg-validate.ts` checks any bundle against this contract;
- `scripts/fluximg-fixtures.ts` writes reference bundles with the values a correct reader must return.

"MUST", "SHOULD" and "MAY" have their usual meaning. Paths inside a bundle are POSIX, relative to its root.

**Contract update 2 (fluximg/1, 2026-11-19).** Additive, so the version string stays `"fluximg/1"`: old bundles
stay valid and old readers read new ones. It changes the shard rule writers follow (section 3.3, so that no file
passes about 64 MiB whatever the dimension order), lets a channel start hidden (`channels[i].visible`, section 5),
states the `world.matrix` convention (section 2), refuses a labels-table row for label 0 or below (section 6), and
makes the validator warn about oversized shard files (section 10). Paragraphs that changed are marked
"(contract update 2)".

## 1. Layout

```
<stem>.fluximg/
  fluximg.json              the manifest (section 2). Written LAST: a directory without it is an unfinished write.
  pixels/                   a Zarr v3 group (section 3)
    zarr.json
    0/zarr.json             level 0: full resolution
    0/c/<i>/0/…/0           its shard files
    1/…                     overview levels, only for planes larger than 1024 px
  layers/<id>/              a raster layer: a Zarr v3 array on the image's pixel grid (section 6)
  layers/<id>.svg           a vector layer, or a label layer's outlines
  layers/<id>.table.json    one row per object
  preview.png               optional: a small picture of the default view
<stem>.recipe.json          optional, BESIDE the bundle: how to regenerate it (fluxplot's recipe format)
```

A reader MUST ignore files and manifest keys it does not know.

## 2. The manifest, `fluximg.json`

UTF-8 JSON. Every field below is required unless marked optional.

| Field | Meaning |
|---|---|
| `spec` | The string `"fluximg/1"`. A reader MUST refuse any other value. |
| `name` | A human-readable name. |
| `pixels` | Section 3. |
| `axes` | Object keyed by dimension name, one entry for every dimension except `c` (section 4). |
| `channels` | List, one entry per channel in stored order; exactly one entry when there is no `c` dimension (section 5). |
| `photometric` | Optional. `"rgb"` for a true-colour photograph: three channels shown as red, green and blue and adjusted together. |
| `profiles` | Required when there is a dimension other than `c`, `y`, `x` (section 5). |
| `defaults` | Optional. `{"index": {"<dim>": <int>}}`: where the image opens along each such dimension. |
| `layers` | List, possibly empty (section 6). |
| `regions` | List, possibly empty (section 7). |
| `world` | Optional. `{"matrix": [[…]], "unit": "µm", "note": "…"}`, kept verbatim; Flux does not interpret it in fluximg/1. (contract update 2) `matrix` maps homogeneous image coordinates `(x, y, 1)` (3 x 3, a 2-D mapping) or `(x, y, z, 1)` (4 x 4, when z is mapped) to world coordinates in `unit`. Image coordinates are the continuous pixel coordinates layers use (section 6): pixel (column `i`, row `j`) covers `[i, i+1) x [j, j+1)`, so the centre of the first pixel is `(0.5, 0.5)`; `z` is the plane index along `z`, 0 at the first plane. A validator checks the shape only (3 x 3 or 4 x 4, finite numbers). |
| `provenance` | Optional. `{"writer", "created" (ISO 8601), "source": [{"path", "bytes", "mtime"}], "meta": {…}, "recipe"}`. |

## 3. Pixels

```json
"pixels": {
  "path": "pixels",
  "dims": ["t", "c", "y", "x"],
  "shape": [816, 2, 213, 924],
  "dtype": "uint16",
  "levels": [{"path": "0", "shape": [816, 2, 213, 924], "downsample": 1}],
  "encoding": {"kind": "linear16", "channels": [{"scale": 0.0027, "offset": 0.0}, {"scale": 0.0038, "offset": 0.0}], "nodataCode": 0},
  "ome": true
}
```

### 3.1 Dimensions

- Names match `[a-z][a-z0-9_]*` and are unique. `y` and `x` are required and are the last two.
- The order is fixed: any extra dimensions first (in the order the author gave), then `t`, `c`, `z`, `y`, `x`,
  each only if present. A writer transposes its input into this order.
- `ome` is `true` exactly when every dimension is one of `t`, `c`, `z`, `y`, `x`.

### 3.2 Sample types

`dtype` is the STORED type: `uint8`, `int8`, `uint16`, `int16`, `uint32`, `int32`, `float32` or `float64`,
little-endian.

### 3.3 The Zarr profile

Every array in a bundle (each pixel level and each raster layer) is a Zarr v3 array with exactly this shape of
`zarr.json`:

```json
{
  "zarr_format": 3, "node_type": "array",
  "shape": [816, 2, 213, 924], "data_type": "uint16",
  "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [704, 2, 213, 924]}},
  "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
  "fill_value": 0,
  "codecs": [{"name": "sharding_indexed", "configuration": {
    "chunk_shape": [1, 1, 213, 924],
    "codecs": [{"name": "bytes", "configuration": {"endian": "little"}},
               {"name": "zstd", "configuration": {"level": 5, "checksum": false}}],
    "index_codecs": [{"name": "bytes", "configuration": {"endian": "little"}}, {"name": "crc32c"}],
    "index_location": "end"}}],
  "dimension_names": ["t", "c", "y", "x"],
  "attributes": {}
}
```

- **Inner chunks** (`codecs[0].configuration.chunk_shape`) are 1 along every leading dimension. Along `y` and
  `x` they are the whole plane when the plane is at most 1024 px on both sides, otherwise 512 x 512 tiles. An
  edge tile is padded to the full tile shape with the fill value.
- **Shards** (`chunk_grid…chunk_shape`) hold a whole number of inner chunks along every dimension. A writer
  SHOULD keep every shard file at or below about `M` = 64 MiB (67 108 864 bytes), whatever the order of the
  dimensions, by the shard rule below. A reader MUST NOT rely on it: it reads any regular `chunk_shape`.
  (contract update 2; the previous rule split only the first dimension, which made a channel-first stack one
  file per channel.)
- A shard file is the compressed inner chunks, in any order, followed by the index: for each inner chunk in C
  order, `offset` and `nbytes` as little-endian uint64, then the CRC-32C of those index bytes as a little-endian
  uint32. An inner chunk that is entirely fill is not stored: both its numbers are `2^64 - 1`. A shard with no
  stored chunk is not written at all.
- `fill_value` is `"NaN"` for float arrays stored `exact`, `0` for `linear16` arrays, and the manifest's
  `nodata` (else `0`) for integer arrays stored `exact`.
- zstd level is the writer's choice (5 by default). No other codec, filter or byte order is allowed.

#### The shard rule (contract update 2)

Write `n_i` for the number of inner chunks along dimension `i` (for a leading dimension, its length). A
**plane** is the inner chunks that share their leading coordinates; a **row** is the inner chunks of a plane
that share their `y` chunk coordinate. All arithmetic below is exact integer arithmetic (`9·M/10`, never a
rounded `0.9·M`).

1. A shard spans `x` whole, and `y` whole unless rule 3 applies.
2. The leading dimensions (those before `y`) are taken from the LAST one backwards, with `u` = the number of
   planes in one step along the dimension being judged (1 for the last leading dimension). The shard spans
   dimension `i` whole while its estimated size stays within the cap, `S·u·n_i <= q·M` (then `u` becomes
   `u·n_i`). The first leading dimension that does not fit whole is split into runs of
   `k = max(1, min(n_i, floor(9·M·q / (10·S·u))))` inner chunks, and every leading dimension before it has
   shard extent 1. So a shard is always "1, …, 1, k, whole, …, whole".
3. Only when one plane alone is over the cap (no complete plane was sampled, or `S > q·M`): every leading
   dimension has extent 1 and `y` is split into runs of `k = max(1, min(n_y, floor(9·M·r / (10·R))))` rows
   (`k = n_y` when `R = 0`).

**The estimate** (`q`, `S`, `r`, `R`) comes from the first inner chunks actually compressed, in C order. The writer
samples chunks until the end of the 8th plane (or of the last plane, when there are fewer), or, if that comes
first, until the end of the first row after which the sampled bytes exceed `M`. A chunk's bytes are its
compressed size; a chunk that is entirely fill counts 0; the shard index is ignored. Then `q` is the number of
complete planes sampled and `S` their bytes, and `r` the number of complete rows sampled and `R` their bytes
(the sample always ends at the end of a row). Shards of this shape are filled one after another when chunks
are written in C order, so a writer streams them to disk and holds at most the sample and one shard.

The cap is a writer parameter: the fixtures (section 10) use a small `maxShardBytes` to force splitting on
small data. Two writers that compress the sampled chunks to the same sizes choose the same `chunk_shape`; zstd
builds can differ by a few bytes, so near a boundary between two values of `k` they may differ, and both
results conform. Arrays that fit the cap are one shard, exactly as before contract update 2.

### 3.4 Levels

`levels[0]` is full resolution with `downsample` 1. Overview levels exist only when a plane is larger than
1024 px on either side (the same planes that are tiled). Their factors are 4, 8, 16, …, stopping at the first level whose longer side is at
most 512 px (there is deliberately no 2x level). Overviews let a viewer answer at once while it scrubs and
sharpen afterwards; tiles let it read only what a zoomed view shows. A level with factor `f` has the leading shape of level 0 and
spatial shape `ceil(H / f)` x `ceil(W / f)`. Each overview sample is the mean of the valid VALUES in its
`f` x `f` block of level 0 (fewer at the right and bottom edges), "no data" when the block has none, stored
under the same encoding as level 0 (integers rounded to nearest).

### 3.5 The group

`pixels/zarr.json` is a Zarr v3 group. When `ome` is true its attributes carry OME-Zarr 0.5 metadata under
`"ome"`: `version` `"0.5"`, one `multiscales` entry whose `axes` list the dimensions (type `time`, `channel`
or `space`, with a unit where known) and whose `datasets` list every level with a `scale` transform; and, when
there is a `c` dimension, `omero.channels` (`label`, `color` as `RRGGBB`, `window` in STORED units, `active`).
When `ome` is false there MUST be no `ome` attribute. OME-Zarr 0.5 cannot express more than these five
dimensions or a rotated field of view; that is why those live only in the manifest.

## 4. Encodings: stored numbers and values

`pixels.encoding` (and each intensity layer's `encoding`) says how stored numbers become VALUES. Everything else
in the manifest that is a pixel quantity (ranges, statistics, profiles) is in value units.

**`{"kind": "exact"}`.** The stored number is the value. "No data" is NaN for float types. For integer types it
is `pixels.nodata` when that is given, and there is no missing data otherwise. Optional fields: `sourceDtype`,
and `fallback: "guard"` with `guard` when a compact copy was refused (below).

**`{"kind": "linear16", "channels": [{"scale", "offset"}, …], "nodataCode": 0}`.** The stored type is `uint16`.
There is one `scale`/`offset` pair per channel (one pair when there is no `c` dimension). Code 0 means "no
data". For a code `k >= 1`:

```
value = offset + scale * (k - 1)        evaluated in float64, in exactly this order
```

A writer encodes a finite value `v` as `k = 1 + round((v - offset) / scale)`, clamped to 1..65535. Ties may
round either way, so two writers may differ by one code; the decode formula above is what is normative. The
writer's rule for the parameters is `offset = min`, `scale = (max - min) / 65534` over the channel's finite
values (`scale = 1` when they are all equal), which makes the largest rounding error `scale / 2`.

**The guard.** A writer given float data MUST store it `exact` unless both hold: the author did not ask for
lossless storage, and for EVERY channel

```
scale / m < 0.1      where m = median |v[y, x+1] - v[y, x]| over horizontally adjacent pairs of valid pixels
```

A channel with no such pair, or with `m = 0`, fails. A writer MAY estimate `m` from a deterministic subsample
(for example forty evenly spaced planes). The check and its outcome are recorded: `guard: {"stepOverNeighbour":
[r0, r1, …], "threshold": 0.1}` on either encoding, and `fallback: "guard"` on an `exact` encoding that the
guard forced. Integer data is always stored `exact`. A writer MUST tell the author which encoding it chose and why.

## 5. Channels, statistics, profiles, axes

**Channel.** `{"name", "color", "lut", "range", "stats"}` and optional `visible`. Exactly one of `color`
(`#rrggbb`: the ramp from black to that colour) and `lut` (a colour-map name such as `gray`, `viridis`,
`cmasher.ember`) is non-null. `range` is the default display window `[black, white]`, in values, with
`white > black`. The writer's default is the 1st to 99.8th percentile. (contract update 2) `visible` (boolean,
default `true`) says whether the channel starts shown; a placed image's own view still wins. When the group
carries `omero.channels`, their `active` equals it.

**Stats.** `{"count", "min", "max", "percentiles": {"0.1", "1", "50", "99", "99.8", "99.9"}, "hist": {"lo", "hi",
"counts": [256 integers]}}` over the channel's valid values. `hist` spans `lo`..`hi` (the 0.1 and 99.9
percentiles) in 256 equal bins. Statistics MAY be computed from a deterministic subsample of up to about a
million values per channel, so they are approximate; `min` and `max` are exact. They let a reader draw a
histogram and choose contrast without reading pixels.

**Profiles.** For every dimension `d` other than `c`, `y`, `x`: `profiles[d].mean[c][i]` is the mean of the valid
values of channel `c` at position `i` along `d` (over all other dimensions), or `null` when there are none.

**Axis.** `axes[d]` is `{"unit", "scale", "offset"}` (evenly spaced: position = offset + scale * index) or
`{"unit", "coords": [one number per index]}`. `x` and `y` MUST be evenly spaced, with `scale` the physical size
of a pixel. `unit` is a string such as `"µm"` or `"s"`, or null. An optional `labels` list names the positions
of a categorical dimension. There is no entry for `c`.

## 6. Layers

A layer shares the image's pixel grid: `H` x `W`, level 0. `id` matches `[a-z][a-z0-9_]*` and is unique in the
bundle. Common fields: `id`, `name`, `kind`, optional `visible` (whether it starts shown) and `from` (the bundle
it was borrowed from, informational).

**`intensity`**: another image. `path` is a Zarr array `layers/<id>` with dimensions `["y", "x"]`, in the
profile of section 3.3 (one level). Fields: `dtype`, `encoding` (section 4, one channel), exactly one of
`color` / `lut`, `range`, `stats`, and `opacity`: a number 0..1, or `"value"` (opacity follows the normalized
value).

**`labels`**: objects as an integer map. `path` is a Zarr array `layers/<id>` (`uint16` or `uint32`, dimensions
`["y", "x"]`, 0 = no object). Fields: `dtype`, `outlines` (`layers/<id>.svg`), `table`
(`layers/<id>.table.json`), `key` (the table column that names an object), `count`, optional `color`, and
optional `weights` (the id of an intensity layer holding per-pixel weights of these objects).

**`vector`**: shapes. `path` is `layers/<id>.svg`. Fields: `count`, optional `table`, `key`, `color`.

**Layer SVG.** Root `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H">` holding one `<g id="<layer
id>">` whose children are the shapes: `path`, `polyline`, `polygon`, `line`, `circle`, `ellipse` or `rect`.
Coordinates are level-0 pixels: pixel (row `r`, column `c`) covers `x` in `[c, c+1]`, `y` in `[r, r+1]`, so a
pixel centre is at `+0.5`. Every shape has `data-key="<key>"`, unique in the layer, and SHOULD have
`id="<layer id>/<key>"`. Presentation attributes on the group or the shapes are defaults that Flux may
override. Not allowed: `script`, `style`, `image`, `use`, `foreignObject`, event-handler attributes, `href`,
`url(…)`, entities.

**Label outlines** are one `path` per object with `data-label="<integer>"` as well. The path follows pixel edges
and encloses exactly the pixels carrying that label: one closed subpath per boundary loop, outer loops
clockwise on screen and holes counter-clockwise; where two parts of an object touch only at a corner they are
separate loops.

**Table.** `{"key": "<column>", "columns": {"<name>": [values…], …}}` with equal-length columns of numbers,
strings, booleans or nulls. A labels table MUST have an integer `label` column; the object with label `L` is
the row where `label == L`, and its key is that row's value in the layer's `key` column (which may be `label`
itself). When a vector layer has a table, every shape's `data-key` MUST appear in its key column.
(contract update 2) Every value of a labels table's `label` column MUST be an integer of at least 1: label 0 means
"no object", so a row for 0 (or below) is almost always a 0-based id column joined to 1-based labels, which
would silently give every object its neighbour's row. A validator refuses it. A row whose label has no object in
the map is allowed; a validator warns about it.

## 7. Regions

`{"id", "name", "rect": {"x", "y", "width", "height"}}` in level-0 pixels, inside the image, `id` as for layers.
A region is a named rectangle worth looking at (a scanned area, a cell).

## 8. Preview and recipe

`preview.png`, when present, is an 8-bit PNG of the default view, at most 512 px on its longer side. The
recipe sidecar beside the bundle is fluxplot's existing `.recipe.json`; its `output` names the bundle.

## 9. Versioning

Additive changes (new optional manifest keys, new layer fields) keep `"fluximg/1"`; readers ignore what they do
not know. A change an old reader would misread becomes `"fluximg/2"`, and a reader refuses a version it does
not implement rather than guess.

## 10. Conformance

From the Flux repository:

```sh
node --import tsx scripts/fluximg-validate.ts <bundle.fluximg> [--quick] [--json] [--values out.npy]
node --import tsx scripts/fluximg-fixtures.ts <outdir>
```

- `fluximg-validate` exits 0 when a bundle conforms and lists what is wrong otherwise. `--values` writes what a
  correct reader returns for level 0: float64 values in stored dimension order, NaN where there is no data.
  (contract update 2) It also prints WARNINGS, which do not change the exit status and are listed under
  `"warnings"` in `--json`: a shard file larger than 1.5 x the cap (`--max-shard-bytes N`, default 64 MiB), and
  labels-table rows with no object in the map.
- `fluximg-fixtures` writes reference bundles, plus `inputs/<name>.npy` (what the writer was given),
  `expected/<name>.npy` (what a reader must return) and `fixtures.json` (dims, encoding, the error bound
  `maxAbsError` per channel, the `maxShardBytes` option, and `chunkShapes`: each pixel level's shard shape).

A **writer** conforms when, for every fixture input, its bundle passes `fluximg-validate` and decodes to
values within `maxAbsError` of the input (exactly equal for `exact`), with "no data" in the same places, and
its encoding choice matches the fixture's; it SHOULD also produce each level's `chunkShapes`, given the
fixture's `maxShardBytes` as its cap. A **reader** conforms when it returns `expected/<name>.npy` for
every fixture bundle, exactly.

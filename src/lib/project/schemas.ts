// Versioned JSON Schemas (draft-07) for the Flux project file types. These are
// the machine contract an agent validates its writes against (AI_agent_considerations
// §4). One source: `validate` checks against them, and `scaffold` writes them into
// each project's `.meta/schema/` so the contract ships in-repo and is discoverable.
//
// Lenient by design (additionalProperties allowed, so the format can grow) but
// strict on the load-bearing fields (ids, types, required structure) — which is
// exactly what catches an agent's malformed write.

const draft = "http://json-schema.org/draft-07/schema#";

// ---------------------------------------------------------------------------
// WS-5.1: shared FIGURE/ELEMENT definitions — the element schema is a
// discriminated oneOf on `type` (one branch per element kind; the removed
// legacy "svg" kind is NOT here — migrate.ts converts it before validation,
// which is why loads validate AFTER migrateProject, never before). Geometry
// fields are typed `number`, which also rejects the JSON.stringify(NaN) →
// null corruption. additionalProperties stays permissive so hand-authored
// agent files with extra keys keep loading.
// ---------------------------------------------------------------------------

const GEO_REQ = ["id", "type", "x", "y", "width", "height", "rotation"];
const GEO_PROPS = {
  id: { type: "string" },
  x: { type: "number" },
  y: { type: "number" },
  width: { type: "number" },
  height: { type: "number" },
  rotation: { type: "number" },
  opacity: { type: "number" },
  groupId: { type: "string" },
  name: { type: "string" },
  locked: { type: "boolean" },
  hidden: { type: "boolean" },
  lockAspect: { type: "boolean" },
  flipX: { type: "boolean" },
  flipY: { type: "boolean" },
};
const elementBranch = (type: string, extraReq: string[], extraProps: Record<string, unknown>) => ({
  type: "object",
  required: [...GEO_REQ, ...extraReq],
  properties: { ...GEO_PROPS, type: { const: type }, ...extraProps },
});
const ELEMENT_DEF = {
  oneOf: [
    elementBranch("image", ["assetId"], { assetId: { type: "string" }, crop: { type: "object" } }),
    elementBranch("plot", ["assetId"], {
      assetId: { type: "string" },
      overrides: { type: "object" },
      crop: { type: "object" },
      contentScale: { type: "number" },
      source: { type: "object" },
      manifestRef: { type: "object" },
    }),
    elementBranch("text", ["text"], {
      text: { type: "string" },
      fontFamily: { type: "string" },
      fontSize: { type: "number" },
      fontWeight: { type: "number" },
      fontStyle: { type: "string" },
      align: { type: "string" },
      color: { type: "string" },
      sizing: { type: "string" },
      lines: { type: "array" },
      needsLayout: { type: "boolean" }, // WS-12: headless edit awaiting a GUI re-wrap
      lineHeight: { type: "number" },
      underline: { type: "boolean" },
      panelLabel: { type: "boolean" },
      styleId: { type: "string" },
    }),
    elementBranch("rect", [], {
      fill: { type: "string" },
      stroke: { type: "string" },
      strokeWidth: { type: "number" },
      cornerRadius: { type: "number" },
      dash: { type: "array" },
    }),
    elementBranch("ellipse", [], {
      fill: { type: "string" },
      stroke: { type: "string" },
      strokeWidth: { type: "number" },
      dash: { type: "array" },
    }),
    elementBranch("line", ["x1", "y1", "x2", "y2"], {
      x1: { type: "number" },
      y1: { type: "number" },
      x2: { type: "number" },
      y2: { type: "number" },
      stroke: { type: "string" },
      strokeWidth: { type: "number" },
      arrowStart: {}, // legacy-tolerant
      arrowEnd: {},
      dash: { type: "array" },
    }),
    elementBranch("path", ["d"], {
      d: { type: "string" },
      nodes: { type: "array" },
      closed: { type: "boolean" },
      fill: { type: "string" },
      stroke: { type: "string" },
      strokeWidth: { type: "number" },
      dash: { type: "array" },
      arrowStart: { type: "boolean" },
      arrowEnd: { type: "boolean" },
      arrowStyle: { type: "string" },
      arrowSize: { type: "number" },
    }),
  ],
};
const FIGURE_DEF = {
  type: "object",
  required: ["id", "canvasId", "x", "y", "width", "height", "elements"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    canvasId: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
    background: { type: "string" },
    elements: { type: "array", items: { $ref: "#/definitions/element" } },
    captions: { type: "object" },
    guides: { type: "object" },
    groups: { type: "object" },
  },
};

export const SCHEMAS: Record<string, Record<string, unknown>> = {
  project: {
    $schema: draft,
    $id: "flux/project.schema.json",
    title: "Flux project manifest (project.json)",
    type: "object",
    required: ["schemaVersion", "id", "title", "manuscript", "references", "figures"],
    properties: {
      schemaVersion: { type: "string" },
      id: { type: "string" },
      slug: { type: "string" },
      title: { type: "string" },
      created: { type: "string" },
      modified: { type: "string" },
      authors: {
        type: "array",
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            orcid: { type: ["string", "null"] },
            email: { type: ["string", "null"] },
          },
        },
      },
      manuscript: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, config: { type: "string" }, format: { type: "string" } },
      },
      supplementary: {
        type: "array",
        items: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
      },
      references: { type: "object", required: ["library"], properties: { library: { type: "string" } } },
      figures: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "label", "order", "canvas"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            label: { type: "string" },
            order: { type: "number" },
            kind: { type: "string", enum: ["main", "supplementary"] },
            canvas: { type: "string" },
            caption: { type: "string" },
          },
        },
      },
      slides: { type: "array" },
      capabilities: { type: "object" },
    },
  },

  figIndex: {
    $schema: draft,
    $id: "flux/fig-index.schema.json",
    title: "Flux figure index (fig/index.json)",
    type: "object",
    required: ["schemaVersion", "canvases", "figures"],
    properties: {
      schemaVersion: { type: "string" },
      canvases: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name"],
          properties: { id: { type: "string" }, name: { type: "string" }, order: { type: "number" } },
        },
      },
      figures: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "label", "canvas"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            label: { type: "string" },
            order: { type: "number" },
            kind: { type: "string" },
            canvas: { type: "string" },
            caption: { type: "string" },
          },
        },
      },
      assets: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "kind"],
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: ["png", "svg"] },
            path: { type: "string" },
            name: { type: "string" },
            naturalWidth: { type: "number" },
            naturalHeight: { type: "number" },
          },
        },
      },
      palette: { type: "array", items: { type: "string" } },
      colorGroups: { type: "array" },
    },
  },

  canvas: {
    $schema: draft,
    $id: "flux/canvas.schema.json",
    title: "Flux canvas (fig/canvases/<id>.json)",
    type: "object",
    required: ["id", "figures"],
    properties: {
      schemaVersion: { type: "string" },
      id: { type: "string" },
      name: { type: "string" },
      figures: { type: "array", items: { $ref: "#/definitions/figure" } },
    },
    definitions: {
      figure: FIGURE_DEF,
      element: ELEMENT_DEF,
    },
  },

  // WS-5.1: the ASSEMBLED in-memory figure model (post-migration) — what
  // validateModel gates at every load seam (standalone project files, the
  // assembled fig/ tree, flux-core loadFigModel).
  model: {
    $schema: draft,
    $id: "flux/model.schema.json",
    title: "Flux figure model (assembled, post-migration)",
    type: "object",
    required: ["canvases", "figures", "assets"],
    properties: {
      version: { type: "number" },
      name: { type: "string" },
      canvases: {
        type: "array",
        items: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } },
      },
      figures: { type: "array", items: { $ref: "#/definitions/figure" } },
      assets: { type: "array", items: { type: "object", required: ["id", "kind"] } },
      palette: { type: "array" },
      colorGroups: { type: "array" },
      textStyles: { type: "array" },
    },
    definitions: {
      figure: FIGURE_DEF,
      element: ELEMENT_DEF,
    },
  },

  manifest: {
    $schema: draft,
    $id: "flux/fluxplot-manifest.schema.json",
    title: "FluxPlot semantic-SVG manifest (*.fluxplot.json)",
    type: "object",
    // The FluxPlot library emits `schemaVersion` (+ spec:"fluxplot/manifest");
    // older hand-authored fixtures use `specVersion`. Accept either version key so
    // Flux validates the real library's output as well as the fixtures.
    anyOf: [{ required: ["specVersion"] }, { required: ["schemaVersion"] }],
    properties: {
      specVersion: { type: "string" },
      schemaVersion: { type: "string" },
      spec: { type: "string" },
      axes: { type: ["object", "array"] },
      series: {
        type: "array",
        items: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            role: { type: "string" },
            kind: { type: "string" },
            svg: { type: "object" },
            points: { type: "array" },
          },
        },
      },
      guides: { type: "array" },
      overlays: { type: "array" },
      parts: { type: ["array", "object"] },
      build: { type: "object" },
    },
  },

  recipe: {
    $schema: draft,
    $id: "flux/recipe.schema.json",
    title: "Plot recipe / provenance (*.recipe.json)",
    type: "object",
    required: ["command", "output"],
    properties: {
      command: { type: "string" },
      args: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      params: { type: "object" },
      output: { type: "string" },
      lastRun: { type: "string" },
    },
  },

  deck: {
    $schema: draft,
    $id: "flux/deck.schema.json",
    title: "Flux Slide deck (slides/<id>/deck.json)",
    type: "object",
    // Lenient (additionalProperties allowed everywhere so the format can grow),
    // strict only on the load-bearing fields: schemaVersion/id/slides and the
    // per-slide/element/track join keys an agent must get right.
    required: ["schemaVersion", "id", "slides"],
    properties: {
      schemaVersion: { type: "string" },
      id: { type: "string" },
      title: { type: "string" },
      created: { type: "string" },
      modified: { type: "string" },
      stage: {
        type: "object",
        properties: { width: { type: "number" }, height: { type: "number" } },
      },
      theme: { type: "string" },
      defaults: { type: "object" },
      assets: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "kind", "path"],
          properties: {
            id: { type: "string" },
            kind: { type: "string" },
            path: { type: "string" },
            naturalWidth: { type: "number" },
            naturalHeight: { type: "number" },
          },
        },
      },
      slides: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "elements", "beats"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            layout: { type: "string" },
            background: { type: "string" },
            transition: { type: "string" },
            notes: { type: "string" },
            camera: { type: "object" },
            elements: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "type"],
                properties: {
                  id: { type: "string" },
                  type: { type: "string" },
                  x: { type: "number" },
                  y: { type: "number" },
                  width: { type: "number" },
                  height: { type: "number" },
                  rotation: { type: "number" },
                  opacity: { type: "number" },
                },
              },
            },
            beats: {
              type: "array",
              items: {
                type: "object",
                required: ["id"],
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  advance: { type: "string", enum: ["click", "with-prev", "auto"] },
                  autoDelayMs: { type: "number" },
                  tracks: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["target"],
                      properties: {
                        target: { type: "string" },
                        part: { type: "string" },
                        selector: { type: "object" },
                        preset: { type: "string" },
                        params: { type: "object" },
                        start: { type: "number" },
                        duration: { type: "number" },
                        easing: { type: "string" },
                        influence: { type: "object" }, // AE-style velocity profile {in,out} 0–100
                        stagger: { type: "object" },
                        to: { type: "object" },
                        keyframes: { type: "array" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },

  comments: {
    $schema: draft,
    $id: "flux/comments.schema.json",
    title: "Manuscript comments (*.comments.json)",
    type: "object",
    required: ["version", "threads"],
    properties: {
      version: { type: "number" },
      threads: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "anchor"],
          properties: {
            id: { type: "string" },
            anchor: { type: "object" },
            resolved: { type: "boolean" },
            messages: { type: "array" },
          },
        },
      },
    },
  },
};

/** Map a project-relative file path to its schema key (or null if unknown). */
export function schemaForFile(rel: string): keyof typeof SCHEMAS | null {
  const f = rel.replace(/\\/g, "/");
  if (f.endsWith("project.json")) return "project";
  if (f.endsWith("fig/index.json")) return "figIndex";
  if (/fig\/canvases\/[^/]+\.json$/.test(f)) return "canvas";
  if (f.endsWith(".fluxplot.json")) return "manifest";
  if (f.endsWith(".recipe.json")) return "recipe";
  if (/slides\/[^/]+\/deck\.json$/.test(f)) return "deck";
  if (f.endsWith(".comments.json") || f.endsWith("comments.json")) return "comments";
  return null;
}

/** The on-disk filename a schema ships under in `.meta/schema/`. */
export const SCHEMA_FILENAMES: Record<keyof typeof SCHEMAS, string> = {
  project: "project.schema.json",
  figIndex: "fig-index.schema.json",
  canvas: "canvas.schema.json",
  manifest: "fluxplot-manifest.schema.json",
  recipe: "recipe.schema.json",
  deck: "deck.schema.json",
  comments: "comments.schema.json",
};

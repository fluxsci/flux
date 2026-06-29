// Versioned JSON Schemas (draft-07) for the Flux project file types. These are
// the machine contract an agent validates its writes against (AI_agent_considerations
// §4). One source: `validate` checks against them, and `scaffold` writes them into
// each project's `.meta/schema/` so the contract ships in-repo and is discoverable.
//
// Lenient by design (additionalProperties allowed, so the format can grow) but
// strict on the load-bearing fields (ids, types, required structure) — which is
// exactly what catches an agent's malformed write.

const draft = "http://json-schema.org/draft-07/schema#";

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
      figure: {
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
        },
      },
      element: {
        type: "object",
        required: ["id", "type"],
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["image", "svg", "text", "rect", "ellipse", "line", "path", "plot"] },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          rotation: { type: "number" },
          opacity: { type: "number" },
          groupId: { type: "string" },
          assetId: { type: "string" },
          overrides: { type: "object" },
        },
      },
    },
  },

  manifest: {
    $schema: draft,
    $id: "flux/fluxplot-manifest.schema.json",
    title: "FluxPlot semantic-SVG manifest (*.fluxplot.json)",
    type: "object",
    required: ["specVersion"],
    properties: {
      specVersion: { type: "string" },
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
  comments: "comments.schema.json",
};

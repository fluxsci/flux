// F1 MCP server: spawn flux-mcp over stdio with a real MCP client and exercise
// the verbs (list_project, get_figure_image, set_caption) — proving an MCP client
// (Claude Desktop/Code) can drive a Flux project.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as core from "../flux-core/index";

const REPO = path.resolve(import.meta.dirname, "..");
const TMP = path.join(REPO, "scratch-mcpproj");

await fs.rm(TMP, { recursive: true, force: true });
await core.scaffold(TMP, { title: "MCP Test", author: "Me" });
await fs.writeFile(
  path.join(TMP, "fig/index.json"),
  JSON.stringify({
    schemaVersion: "0.1.0",
    canvases: [{ id: "canvas-1", name: "Canvas 1", order: 1 }],
    figures: [{ id: "growth", name: "Growth", label: "fig-growth", order: 1, kind: "main", canvas: "canvas-1", caption: "" }],
    assets: [], palette: [], colorGroups: [],
  }, null, 2),
);
await fs.mkdir(path.join(TMP, "fig/canvases"), { recursive: true });
await fs.writeFile(
  path.join(TMP, "fig/canvases/canvas-1.json"),
  JSON.stringify({
    schemaVersion: "0.1.0", id: "canvas-1", name: "Canvas 1",
    figures: [{
      id: "growth", name: "Growth", canvasId: "canvas-1", x: 0, y: 0, width: 400, height: 300, background: "#ffffff",
      elements: [{ type: "rect", id: "r1", x: 20, y: 20, width: 360, height: 260, rotation: 0, fill: "#d95f02", stroke: "#222", strokeWidth: 1, cornerRadius: 4 }],
      captions: {},
    }],
  }, null, 2),
);

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "flux-mcp.ts", TMP],
  cwd: REPO,
  // never run the FluxConfig migration against the real HOME from a test (the
  // SDK strips inherited env, so the guard must be passed explicitly)
  env: { ...(process.env as Record<string, string>), FLUX_NO_MIGRATE: "1" },
});
const client = new Client({ name: "verify", version: "1.0.0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();

const lp = await client.callTool({ name: "list_project", arguments: {} });
const lpText = (lp.content as any[]).find((c) => c.type === "text")?.text ?? "";
const lpJson = JSON.parse(lpText);

const img = await client.callTool({ name: "get_figure_image", arguments: { id: "growth" } });
const imgBlock = (img.content as any[]).find((c) => c.type === "image");
const imgSvgText = (img.content as any[]).find((c) => c.type === "text")?.text ?? "";

const sc = await client.callTool({ name: "set_caption", arguments: { id: "growth", markdown: "An MCP-written caption." } });
const capWritten = (await fs.readFile(path.join(TMP, "fig/captions/growth.md"), "utf8")).trim();

await client.close();
await fs.rm(TMP, { recursive: true, force: true });

console.log(JSON.stringify({
  tools,
  list_project: { title: lpJson.title, figures: lpJson.figures?.length },
  get_figure_image: { hasImageBlock: !!imgBlock, mimeType: imgBlock?.mimeType, svgHasFill: imgSvgText.includes("#d95f02") },
  set_caption: { ack: (sc.content as any[])[0]?.text, fileWritten: capWritten },
}, null, 2));

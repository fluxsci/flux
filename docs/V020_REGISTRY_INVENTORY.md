# V0.2 CLI/MCP adapter inventory

Reviewed against current `flux-cli.ts`, `flux-mcp.ts`, `flux-core/registry.ts`, and `flux-core/verbs.ts` on2026-09-21. This inventory describes adapter boundaries; shared core I/O remains in flux-core and renderer I/O stays in its twin adapter.

The registered surface uses one Zod parameter contract, handler and error taxonomy. Registered command help and flag parsing come from that contract. Every coercion is exercised parser→invocation→handler in `verify-shell-contracts.ts`; `verify-registry-parity.ts` opens a real MCP stdio session and CLI child processes and verifies inventory, representative output, error classification and saved Slide/ Figure bytes.

This wave moved `add_to_library`/`lib-add`, `set_slide`/`set-slide`, `set_animation`/`set-animation`, and `search_fulltext`/`search-text` into the registry. These groups had divergent validation/coercion and equivalent underlying file behavior. Public MCP names remain unchanged. Registry renderers preserve CLI stdout data vs stderr progress/status and typed lock exit75.

## Explicit remaining adapters

| CLI surface | MCP surface | Why the wrapper remains distinct |
| --- | --- | --- |
| `new` | none | Scaffolds a project outside the MCP session's fixed project root. |
| `principal`, alias `agent`; `attend` | none | Interactive terminal ownership and long-lived worker/event streams. |
| `version`, help aliases | server identity / tool descriptions | Process metadata and command discovery, not project file operations. |
| `render-figure`, `render-canvas`, `render-figures` | `get_figure_image`, `get_canvas_image`, `render_figure` | CLI supports raw SVG stdout, destination-file writes, PNG switches and stale-source diagnostics. MCP image content and text warnings have different result contracts. Both delegate actual render to core; materialization is CLI-only. |
| `reset-crop` | `set_crop {crop:null}` | CLI-only spelling of an existing shared core/registry mutation. |
| `save-global-text-style` | none | CLI copies a selected project style to the machine library; MCP has no corresponding public tool. |
| `lib`, `keys` | none | Machine-library status and explicit masked credential configuration. |
| `discover`, `citing`, `similar` | `search_world`, `semantic_search`, `citing_works`, `similar_papers` | Network/provider dispatch has distinct flags and result policies, including MCP `source:both`; core provider/network contracts are shared. |
| `fetch-pdfs`, `fetch-supplements`, `assign-pdfs` | `fetch_pdfs`, `fetch_supplements`, `assign_pdfs` | CLI emits live per-file progress; MCP returns a completed summary. Network/file acquisition is shared core policy. |
| `missing-pdfs` | none | CLI CSV/stdout/file-output report; no corresponding MCP tool. |
| `annotations` | `list_annotations`, `search_annotations` | CLI multi-form search/list/Markdown router; MCP has separate typed tools and different empty-result/human formatting. Core annotation reads/search are shared. |
| `tag`, `set-status`, `collection` | `organize_paper` | CLI single-field additive/removal verbs versus MCP combined tags/status/collection replacement patch. Core fresh organization operations are shared. |
| none | `get_paper_text` | MCP-only extraction-on-demand with optional truncated text result. |
| none | `get_reading_context`, `get_app_context`, `dispatch_command`, `act_on_selection` | Explicit live-session ownership, observation and allow-listed GUI dispatch; not headless file mutations. |

These adapters are not a claim that all wrappers disappeared. Moving their surface-specific streaming/rendering/network routing into a single generic registry would require a separate contract change; this wave preserves those behaviors. Existing CLI aliases and root resolution remain. Non-registry CLI errors use the same error taxonomy; SDK-owned MCP wrappers retain SDK exception conversion. No blanket TypeScript suppression was added at these boundaries.

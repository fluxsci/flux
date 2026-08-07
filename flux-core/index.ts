// flux-core — the project format as a library, runnable under Node (CLI + MCP).
//
// "The file is the API" (Flux_Master_Plan.md §5, AI_agent_considerations.md): the
// GUI, the CLI, and the MCP server all drive a Flux project *through its files*.
// This module owns the read/write/reindex/render logic over Node's fs, reusing
// the GUI's pure functions (figureToSvg, composeCaption) so there is one source
// of truth for the figure format — no GUI-only capability.

// Reference hydration + whole-world lookups (OpenAlex) — see flux-core/enrich.ts.
export {
  hydrateLibrary,
  searchWorld,
  searchWorldSemantic,
  similarByKey,
  authorWorks,
  citingWorks,
  relatedWorks,
} from "./enrich";
export type { HydrateResult } from "./enrich";
export type { WorldBrief } from "../src/lib/references/openalex";
// Semantic Scholar — recommendations ("papers like this") + citation contexts.
export { s2Similar, s2Citing } from "./s2";
export { buildInfo } from "./buildInfo";
export type { BuildInfo } from "./buildInfo";
// FluxFinder — PDF acquisition + the items/ store.
export { fetchPdfForKey, fetchPdfs, fetchSupplements, ingestPdf, missingPdfs, toCsv } from "./acquire";
export type { FetchSummary, FetchOneResult } from "./acquire";
export { assignPdfs } from "./assign";
export type { AssignSummary, AssignItemResult, AssignAction } from "./assign";
export { hasPdf, readPdf, readSource, writePdf, readPdfLink, writeLinkedPdf, readFulltext, writeFulltext, loadItemsIndex, rebuildItemsIndex, itemStatus, readReaderContext } from "./items";
export { extractFulltext, getOrExtractFulltext } from "./fulltext";
// 2.3: full-text search across every stored PDF's extracted text.
export { searchFulltext } from "./fulltextSearch";
export type { FulltextResult, FulltextHit, FulltextSnippet } from "./fulltextSearch";
// FluxReader annotations (highlights/notes; searchable library-wide).
export { loadAnnotations, addAnnotation, deleteAnnotation, listAnnotations, searchAnnotations } from "./annotate";
export type { AnnotationHit } from "./annotate";
// Reference/config verbs (add/cite/import, DOI lookup, annotations digest,
// library/config info, reconcile) live in ./references.
export * from "./references";
// API keys (machine-global <FluxLib>/keys.json + env), shared by CLI/MCP/GUI.
export { loadKeys, saveKeys, getSecret, resolveFluxLibPath } from "./fluxlib";
export type { FluxKeys } from "./fluxlib";
// 3.3 library organization (tags / status / collections) sidecar.
export { loadOrganize, organizeSetTags, organizeSetStatus, organizeSetCollections } from "./fluxlib";

// WS6 — client identity + the provenance journal (see ./journal).
export { setClient, getClient, journal } from "./journal";

// The model layer — fs/path helpers, manifest + fig-index/canvas-file IO, and
// the W3 lock+journal load→mutate→save chokepoint — lives in ./model.
export * from "./model";

// SVG intrinsic sizing + extreme-coordinate hygiene live in ./coordscan.
export * from "./coordscan";

// Headless rendering (figure/canvas SVG+PNG, ensureDom,
// materializeRenders) lives in ./render.
export * from "./render";

// Paper snips (PDF page-region → provenance-carrying PNG) + citations
// live in ./snips.
export * from "./snips";

// The figure verbs (compose/create/arrange, captions, panel + plot
// import/sync, part overrides, styles + text system, groups/z-order/layout,
// scaffold) live in ./figures.
export * from "./figures";

// Manuscript + documents + compile (the Paper-side parity verbs) live in
// ./manuscript.
export * from "./manuscript";

// Review-comment threads (list/resolve) live in ./comments.
export * from "./comments";
export * from "./feedback";
export * from "./context";
export * from "./agents";

// WS2 JSON-schema validation + project lint + validate-plot live in ./validate.
export * from "./validate";

// Recipe re-runs (F2 reproducibility) live in ./recipe.
export * from "./recipe";

// Dissections (plots/_dissections/ companion material) live in ./dissect.
export { listDissections, listDissectionsFor, listAllDissections } from "./dissect";

// --------------------------------------------------------------------------
// Flux Slide — the deck verbs (load/save/list/create/validate a deck). Defined
// in ./slides (which reuses safeJoin/journal/loadManifest/getClient above) and
// re-exported here so the CLI + MCP reach them through one flux-core surface.
// --------------------------------------------------------------------------
export {
  loadDeck,
  saveDeck,
  listDecks,
  createDeck,
  addSlide,
  validateDeck,
  gatherDeckPayload,
  exportDeck,
  // W11b — slide authoring (agent parity for the Slides pillar)
  deleteSlide,
  duplicateSlide,
  reorderSlides,
  setSlide,
  setDeckTheme,
  addTextToSlide,
  addFigureToSlide,
  addBeat,
  setAnimation,
  // Slides overhaul WS2 — timeline + part-control verbs
  setBeat,
  reorderBeats,
  moveTrack,
  duplicateTrack,
  reorderTracks,
  setTrackEnabled,
  setPartVisibility,
  setPartStyle,
  animatePartVerb,
  animateElementVerb,
  setMorph,
  // Animation rework — transforms, track groups, template application
  setTransformTrack,
  groupTracksVerb,
  ungroupTracksVerb,
  applyAnimTemplateVerb,
  // Cascade — stepped timing deltas across tracks (⌃⇧C's headless twin)
  cascadeTracksVerb,
  type DeckSummary,
  type ValidateDeckResult,
} from "./slides";

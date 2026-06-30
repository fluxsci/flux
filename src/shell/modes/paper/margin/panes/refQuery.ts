// Structured reference-search query. The implementation now lives in the shared
// references module (src/lib/references/query.ts) so the GUI pane, the omnibox,
// the agent `search_references` tool, and `flux search` share identical semantics.
// Re-exported here to keep existing import sites stable.
export {
  parseQuery,
  runQuery,
  matchEntry,
  isStructured,
  type Field,
  type Clause,
} from "../../../../../lib/references/query";

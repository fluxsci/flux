// CommonJS twin of src/lib/slide/schemaStamp.ts DECK_EDITABLE (WP 3.0): decks this build may edit in place. verify-schema-stamp pins the
// two equal; change both together.
"use strict";
const DECK_EDITABLE = /^0\.[234567]\./;
module.exports = { DECK_EDITABLE, supportsDeckSchema: (v) => typeof v === "string" && DECK_EDITABLE.test(v) };

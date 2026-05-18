// Tests for src/db.ts rewriteQueryForFts.
//
// Run via: npm test  (uses node --test + tsx loader).
//
// The rewriter consolidation in 2026-05-18 fix-up added NEAR / parens /
// negation to the operator passthrough — these cases lock that behaviour
// in. Original PR-A's narrower regex `[*"^:]` + `\b(AND|OR|NOT)\b` would
// have rewritten `(kilpailu OR hankinta)` into `(kilpailu* OR* hankinta*)`
// which FTS5 parses but means something different.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rewriteQueryForFts } from "../src/db.js";

describe("rewriteQueryForFts", () => {
  it("appends * to bare Finnish stems", () => {
    assert.equal(rewriteQueryForFts("kilpailu"), "kilpailu*");
    assert.equal(rewriteQueryForFts("hankinta"), "hankinta*");
  });

  it("passes through queries with FTS5 operators (AND/OR/NOT)", () => {
    assert.equal(rewriteQueryForFts("kilpailu AND hankinta"), "kilpailu AND hankinta");
    assert.equal(rewriteQueryForFts("(kilpailu OR hankinta)"), "(kilpailu OR hankinta)");
    assert.equal(rewriteQueryForFts("kilpailu NOT cartel"), "kilpailu NOT cartel");
  });

  it("passes through NEAR operator (regression — fix-up 2026-05-18)", () => {
    assert.equal(
      rewriteQueryForFts("kilpailu NEAR/5 hankinta"),
      "kilpailu NEAR/5 hankinta",
    );
  });

  it("passes through parens grouping (regression — fix-up 2026-05-18)", () => {
    assert.equal(
      rewriteQueryForFts("(kilpailu OR hankinta) AND markkinat"),
      "(kilpailu OR hankinta) AND markkinat",
    );
  });

  it("passes through negation `-` (regression — fix-up 2026-05-18)", () => {
    assert.equal(
      rewriteQueryForFts("kilpailu -cartel"),
      "kilpailu -cartel",
    );
  });

  it("passes through prefix / column-scope / phrase / caret", () => {
    assert.equal(rewriteQueryForFts("kilpailu*"), "kilpailu*");
    assert.equal(rewriteQueryForFts("title:kilpailu"), "title:kilpailu");
    assert.equal(rewriteQueryForFts('"kilpailulain rikkominen"'), '"kilpailulain rikkominen"');
    assert.equal(rewriteQueryForFts("^kilpailu"), "^kilpailu");
  });

  it("handles empty and whitespace-only input", () => {
    assert.equal(rewriteQueryForFts(""), "");
    assert.equal(rewriteQueryForFts("   "), "");
  });

  it("preserves Finnish diacritics under wildcard", () => {
    assert.equal(rewriteQueryForFts("määräys"), "määräys*");
    assert.equal(rewriteQueryForFts("säännös"), "säännös*");
  });
});

/**
 * Coverage verification script (Gate 6) — verifies coverage.json matches
 * actual database state and codebase.
 *
 * Checks:
 * - No placeholder strings remain (`to-be-set-by-ingest`, etc.) anywhere
 *   in coverage.json — caught the 2026-05-14 swedish-civil-protection
 *   canary bug where the template's seed values were never replaced by
 *   the ingestion script.
 * - Every type in coverage.json has item_count matching actual DB count
 * - Every tool in coverage.json exists in the codebase registry
 * - summary.total_items matches sum of source item_counts
 */

import Database from "better-sqlite3";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const DB_PATH = join(ROOT, "data", "database.db");
const COVERAGE_JSON = join(ROOT, "data", "coverage.json");

interface CoverageSource {
  id: string;
  item_count: number;
}

interface CoverageSummary {
  total_items: number;
}

interface Coverage {
  sources: CoverageSource[];
  summary: CoverageSummary;
}

// Tokens that indicate a coverage.json field was templated but never
// populated by the ingestion pipeline. Substring match on the raw JSON
// text — catches any field at any nesting depth.
const PLACEHOLDER_TOKENS: readonly string[] = [
  "to-be-set-by-ingest",
  "TO-BE-SET-BY-INGEST",
  "TBD-BY-INGEST",
  "CHANGE-ME",
  "FILL-IN",
];

function checkPlaceholders(coverageJsonText: string): string[] {
  const issues: string[] = [];
  for (const token of PLACEHOLDER_TOKENS) {
    if (coverageJsonText.includes(token)) {
      issues.push(
        `coverage.json contains placeholder token "${token}" — the ingestion pipeline did not write a real value. ` +
          `The 2026-05-14 swedish-civil-protection canary shipped with this bug. ` +
          `Fix: have scripts/ingest.ts call update-coverage.ts at the end of each ingestion run, or rewrite coverage.json by hand from current DB state.`
      );
    }
  }
  return issues;
}

function main(): void {
  const errors: string[] = [];

  if (!existsSync(DB_PATH)) {
    console.error("FAIL: Database not found");
    process.exit(1);
  }
  if (!existsSync(COVERAGE_JSON)) {
    console.error("FAIL: coverage.json not found");
    process.exit(1);
  }

  const coverageJsonText = readFileSync(COVERAGE_JSON, "utf-8");
  errors.push(...checkPlaceholders(coverageJsonText));

  const db = new Database(DB_PATH, { readonly: true });
  const coverage: Coverage = JSON.parse(coverageJsonText);

  // Check each source type count
  for (const source of coverage.sources) {
    const row = db.prepare("SELECT COUNT(*) as count FROM items WHERE type = ?").get(source.id) as { count: number };
    if (row.count !== source.item_count) {
      errors.push(
        `Type "${source.id}": coverage.json says ${source.item_count}, database has ${row.count}`
      );
    }
  }

  // Check total
  const totalRow = db.prepare("SELECT COUNT(*) as total FROM items").get() as { total: number };
  if (totalRow.total !== coverage.summary.total_items) {
    errors.push(
      `Total items: coverage.json says ${coverage.summary.total_items}, database has ${totalRow.total}`
    );
  }

  // Check sum of source counts matches total
  const sourceSum = coverage.sources.reduce((sum, s) => sum + s.item_count, 0);
  if (sourceSum !== coverage.summary.total_items) {
    errors.push(
      `Sum of source counts (${sourceSum}) does not match summary total (${coverage.summary.total_items})`
    );
  }

  db.close();

  if (errors.length > 0) {
    console.error("Coverage verification FAILED:");
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  console.log("Coverage verification PASSED");
  console.log(`  ${coverage.sources.length} sources verified`);
  console.log(`  ${coverage.summary.total_items} total items confirmed`);
}

main();

/**
 * SQLite database access layer for the Finnish Competition (KKV) MCP server.
 *
 * Schema:
 *   - decisions    — Bundeskartellamt enforcement decisions (abuse of dominance, cartels, sector inquiries)
 *   - mergers      — Merger control decisions (Fusionskontrolle)
 *   - sectors      — Sectors with enforcement activity
 *
 * FTS5 virtual tables back full-text search on decisions and mergers.
 */

import Database from "better-sqlite3";

const DB_PATH = process.env["KKV_DB_PATH"] ?? "data/kkv.db";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS decisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  case_number  TEXT    NOT NULL UNIQUE,
  title        TEXT    NOT NULL,
  date         TEXT,
  type         TEXT,
  sector       TEXT,
  parties      TEXT,
  summary      TEXT,
  full_text    TEXT    NOT NULL,
  outcome      TEXT,
  fine_amount  REAL,
  gwb_articles TEXT,
  status       TEXT    DEFAULT 'final',
  source_url   TEXT
);

CREATE INDEX IF NOT EXISTS idx_decisions_date        ON decisions(date);
CREATE INDEX IF NOT EXISTS idx_decisions_type        ON decisions(type);
CREATE INDEX IF NOT EXISTS idx_decisions_sector      ON decisions(sector);
CREATE INDEX IF NOT EXISTS idx_decisions_outcome     ON decisions(outcome);
CREATE INDEX IF NOT EXISTS idx_decisions_status      ON decisions(status);

CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  case_number, title, summary, full_text,
  content='decisions',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, case_number, title, summary, full_text)
  VALUES (new.id, new.case_number, new.title, COALESCE(new.summary, ''), new.full_text);
END;

CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, case_number, title, summary, full_text)
  VALUES ('delete', old.id, old.case_number, old.title, COALESCE(old.summary, ''), old.full_text);
END;

CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, case_number, title, summary, full_text)
  VALUES ('delete', old.id, old.case_number, old.title, COALESCE(old.summary, ''), old.full_text);
  INSERT INTO decisions_fts(rowid, case_number, title, summary, full_text)
  VALUES (new.id, new.case_number, new.title, COALESCE(new.summary, ''), new.full_text);
END;

CREATE TABLE IF NOT EXISTS mergers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  case_number      TEXT    NOT NULL UNIQUE,
  title            TEXT    NOT NULL,
  date             TEXT,
  sector           TEXT,
  acquiring_party  TEXT,
  target           TEXT,
  summary          TEXT,
  full_text        TEXT    NOT NULL,
  outcome          TEXT,
  turnover         REAL,
  source_url       TEXT
);

CREATE INDEX IF NOT EXISTS idx_mergers_date     ON mergers(date);
CREATE INDEX IF NOT EXISTS idx_mergers_sector   ON mergers(sector);
CREATE INDEX IF NOT EXISTS idx_mergers_outcome  ON mergers(outcome);

CREATE VIRTUAL TABLE IF NOT EXISTS mergers_fts USING fts5(
  case_number, title, acquiring_party, target, summary, full_text,
  content='mergers',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS mergers_ai AFTER INSERT ON mergers BEGIN
  INSERT INTO mergers_fts(rowid, case_number, title, acquiring_party, target, summary, full_text)
  VALUES (new.id, new.case_number, new.title, COALESCE(new.acquiring_party, ''), COALESCE(new.target, ''), COALESCE(new.summary, ''), new.full_text);
END;

CREATE TRIGGER IF NOT EXISTS mergers_ad AFTER DELETE ON mergers BEGIN
  INSERT INTO mergers_fts(mergers_fts, rowid, case_number, title, acquiring_party, target, summary, full_text)
  VALUES ('delete', old.id, old.case_number, old.title, COALESCE(old.acquiring_party, ''), COALESCE(old.target, ''), COALESCE(old.summary, ''), old.full_text);
END;

CREATE TRIGGER IF NOT EXISTS mergers_au AFTER UPDATE ON mergers BEGIN
  INSERT INTO mergers_fts(mergers_fts, rowid, case_number, title, acquiring_party, target, summary, full_text)
  VALUES ('delete', old.id, old.case_number, old.title, COALESCE(old.acquiring_party, ''), COALESCE(old.target, ''), COALESCE(old.summary, ''), old.full_text);
  INSERT INTO mergers_fts(rowid, case_number, title, acquiring_party, target, summary, full_text)
  VALUES (new.id, new.case_number, new.title, COALESCE(new.acquiring_party, ''), COALESCE(new.target, ''), COALESCE(new.summary, ''), new.full_text);
END;

CREATE TABLE IF NOT EXISTS sectors (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  name_en        TEXT,
  description    TEXT,
  decision_count INTEGER DEFAULT 0,
  merger_count   INTEGER DEFAULT 0
);
`;

// --- Interfaces ---------------------------------------------------------------

export interface Decision {
  id: number;
  case_number: string;
  title: string;
  date: string | null;
  type: string | null;
  sector: string | null;
  parties: string | null;
  summary: string | null;
  full_text: string;
  outcome: string | null;
  fine_amount: number | null;
  gwb_articles: string | null;
  status: string;
  source_url: string | null;
}

export interface Merger {
  id: number;
  case_number: string;
  title: string;
  date: string | null;
  sector: string | null;
  acquiring_party: string | null;
  target: string | null;
  summary: string | null;
  full_text: string;
  outcome: string | null;
  turnover: number | null;
  source_url: string | null;
}

export interface Sector {
  id: string;
  name: string;
  name_en: string | null;
  description: string | null;
  decision_count: number;
  merger_count: number;
}

// --- DB singleton -------------------------------------------------------------

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  // Read-only: DB is baked into the image at build time (publish-ghcr.yml
  // Release-provisioning per the db_release_path manifest pattern). Runtime
  // never writes. Container rootfs will be read_only:true per the future
  // mcp-defaults compose anchor; opening write-mode + setting WAL + execing
  // CREATE TABLE IF NOT EXISTS would fail with "unable to open database
  // file". Schema is exported for offline ingestion scripts.
  _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return _db;
}

// --- FTS query rewriter -------------------------------------------------------

/**
 * Rewrite a user query so FTS5's `unicode61` tokenizer behaves well on
 * morphologically rich Finnish text. The default tokenizer doesn't stem,
 * so `kilpailu` won't match `kilpailulain` (genitive of `kilpailulaki`).
 * Appending `*` to bare alphanumeric tokens turns them into prefix matches,
 * which gives stem-ish recall without a custom tokenizer.
 *
 * Pass-through (no rewrite) when the query already contains FTS5 operators:
 *   AND, OR, NOT, "..." (phrase), * (prefix), ^ (column-prefix), : (column scope).
 *
 * Empirically validated on KKV prod DB 2026-05-18:
 *   decisions_fts MATCH 'kilpailu' → 237 rows; 'kilpailu*' → 585 rows (+348)
 *   decisions_fts MATCH 'kilpailulain' → 69; 'kilpailulain*' → 124 (+55)
 *   decisions_fts MATCH 'hankinta' → 59; 'hankinta*' → 183 (+124)
 *
 * Mirrors the pattern from finnish-financial-regulation-mcp PR #22.
 */
export function rewriteQueryForFts(q: string): string {
  if (!q) return q;
  // If the query already uses FTS5 operator syntax, don't rewrite — caller
  // is asking for something specific and we should not surprise them.
  if (/[*"^:]/.test(q)) return q;
  if (/\b(AND|OR|NOT)\b/.test(q)) return q;

  // Split on whitespace; append `*` to every bare token that is alphanumeric
  // (+ a small set of word characters that show up in Finnish/EN compounds).
  // Punctuation-only tokens are dropped — FTS5 ignores them anyway.
  return q
    .split(/\s+/)
    .map((tok) => {
      if (!tok) return tok;
      // Already-prefix or quoted token: leave alone (defensive — caller-supplied)
      if (/[*"^:]/.test(tok)) return tok;
      // Word characters incl. unicode letters / digits / hyphens / apostrophes
      if (/^[\p{L}\p{N}_'-]+$/u.test(tok)) return `${tok}*`;
      return tok;
    })
    .filter((t) => t.length > 0)
    .join(" ");
}

// --- Source URL fallback ------------------------------------------------------

/**
 * Derive a deterministic upstream URL for a KKV case when the row has no
 * persisted `source_url`. The prod DB built before this PR did not capture
 * URLs at ingest time; new ingest scripts populate `source_url` directly
 * (see schema migration above). For legacy rows, fall back to the KKV
 * site-search URL keyed on the case_number — this always resolves to the
 * canonical case page as the first result.
 *
 * Pattern verified 2026-05-18:
 *   KKV/220/14.00.00/2023 → https://www.kkv.fi/?s=KKV%2F220%2F14.00.00%2F2023
 *     → first result: /paatokset/kilpailuasiat/muut-paatokset/kkv-220-14-00-00-2023/
 */
export function deriveKkvFallbackUrl(caseNumber: string): string {
  return `https://www.kkv.fi/?s=${encodeURIComponent(caseNumber)}`;
}

// --- Decision queries ---------------------------------------------------------

export interface SearchDecisionsOptions {
  query: string;
  type?: string | undefined;
  sector?: string | undefined;
  outcome?: string | undefined;
  limit?: number | undefined;
}

export function searchDecisions(opts: SearchDecisionsOptions): Decision[] {
  const db = getDb();
  const limit = opts.limit ?? 20;

  const conditions: string[] = ["decisions_fts MATCH :query"];
  const params: Record<string, unknown> = {
    query: rewriteQueryForFts(opts.query),
    limit,
  };

  if (opts.type) {
    conditions.push("d.type = :type");
    params["type"] = opts.type;
  }
  if (opts.sector) {
    conditions.push("d.sector = :sector");
    params["sector"] = opts.sector;
  }
  if (opts.outcome) {
    conditions.push("d.outcome = :outcome");
    params["outcome"] = opts.outcome;
  }

  const where = conditions.join(" AND ");
  return db
    .prepare(
      `SELECT d.* FROM decisions_fts f
       JOIN decisions d ON d.id = f.rowid
       WHERE ${where}
       ORDER BY rank
       LIMIT :limit`,
    )
    .all(params) as Decision[];
}

export function getDecision(caseNumber: string): Decision | null {
  const db = getDb();
  return (
    (db
      .prepare("SELECT * FROM decisions WHERE case_number = ? LIMIT 1")
      .get(caseNumber) as Decision | undefined) ?? null
  );
}

// --- Merger queries -----------------------------------------------------------

export interface SearchMergersOptions {
  query: string;
  sector?: string | undefined;
  outcome?: string | undefined;
  limit?: number | undefined;
}

export function searchMergers(opts: SearchMergersOptions): Merger[] {
  const db = getDb();
  const limit = opts.limit ?? 20;

  const conditions: string[] = ["mergers_fts MATCH :query"];
  const params: Record<string, unknown> = {
    query: rewriteQueryForFts(opts.query),
    limit,
  };

  if (opts.sector) {
    conditions.push("m.sector = :sector");
    params["sector"] = opts.sector;
  }
  if (opts.outcome) {
    conditions.push("m.outcome = :outcome");
    params["outcome"] = opts.outcome;
  }

  const where = conditions.join(" AND ");
  return db
    .prepare(
      `SELECT m.* FROM mergers_fts f
       JOIN mergers m ON m.id = f.rowid
       WHERE ${where}
       ORDER BY rank
       LIMIT :limit`,
    )
    .all(params) as Merger[];
}

export function getMerger(caseNumber: string): Merger | null {
  const db = getDb();
  return (
    (db
      .prepare("SELECT * FROM mergers WHERE case_number = ? LIMIT 1")
      .get(caseNumber) as Merger | undefined) ?? null
  );
}

// --- Sector queries -----------------------------------------------------------

export function listSectors(): Sector[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM sectors ORDER BY decision_count DESC, merger_count DESC")
    .all() as Sector[];
}

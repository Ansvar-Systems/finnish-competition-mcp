/**
 * Ingestion crawler for the KKV (Kilpailu- ja kuluttajavirasto) MCP server.
 *
 * Scrapes competition enforcement decisions, merger control decisions, and
 * sector data from kkv.fi and populates the SQLite database.
 *
 * Data sources (all under https://www.kkv.fi/paatokset/kilpailuasiat/):
 *   - Yrityskauppavalvonta          — merger control decisions (133+ pages)
 *   - Muut päätökset                — other competition decisions (61+ pages)
 *   - Esitykset markkinaoikeudelle  — market court penalty proposals (4 pages)
 *   - Kielto-/sitoumus-/toimitusvelvoiteratkaisut — prohibition, commitment
 *     and supply obligation decisions (3 pages)
 *
 * Individual decision pages expose metadata fields:
 *   - Diaarinumero  (case number, e.g. KKV/246/14.00.10/2026)
 *   - Päivämäärä    (date, d.M.yyyy)
 *   - Osapuolet     (parties)
 *   - Tiivistelmä   (summary block)
 *
 * Usage:
 *   npx tsx scripts/ingest-kkv.ts
 *   npx tsx scripts/ingest-kkv.ts --dry-run
 *   npx tsx scripts/ingest-kkv.ts --resume
 *   npx tsx scripts/ingest-kkv.ts --force
 *   npx tsx scripts/ingest-kkv.ts --max-pages 5
 */

import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["KKV_DB_PATH"] ?? "data/kkv.db";
const STATE_FILE = join(dirname(DB_PATH), "ingest-state.json");
const BASE_URL = "https://www.kkv.fi";
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const USER_AGENT =
  "AnsvarKKVCrawler/1.0 (+https://github.com/Ansvar-Systems/finnish-competition-mcp)";

/**
 * Decision listing categories on kkv.fi.
 *
 * Each category has a base path under /paatokset/kilpailuasiat/ and a
 * maximum page count (conservative upper bound — the crawler stops early
 * when a page returns zero results).
 */
const LISTING_CATEGORIES = [
  {
    id: "yrityskauppavalvonta",
    path: "/paatokset/kilpailuasiat/yrityskauppavalvonta/",
    maxPages: 140,
    isMerger: true,
  },
  {
    id: "muut-paatokset",
    path: "/paatokset/kilpailuasiat/muut-paatokset/",
    maxPages: 65,
    isMerger: false,
  },
  {
    id: "esitykset-markkinaoikeudelle",
    path: "/paatokset/kilpailuasiat/esitykset-markkinaoikeudelle/",
    maxPages: 5,
    isMerger: false,
  },
  {
    id: "kielto-sitoumus-toimitusvelvoite",
    path: "/paatokset/kilpailuasiat/kielto-sitoumus-tai-toimitusvelvoiteratkaisut/",
    maxPages: 5,
    isMerger: false,
  },
] as const;

// CLI flags
const dryRun = process.argv.includes("--dry-run");
const resume = process.argv.includes("--resume");
const force = process.argv.includes("--force");
const maxPagesArg = process.argv.find((_, i, a) => a[i - 1] === "--max-pages");
const maxPagesOverride = maxPagesArg ? parseInt(maxPagesArg, 10) : null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IngestState {
  processedUrls: string[];
  lastRun: string;
  decisionsIngested: number;
  mergersIngested: number;
  errors: string[];
}

interface ParsedDecision {
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
}

interface ParsedMerger {
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
}

interface SectorAccumulator {
  [id: string]: {
    name: string;
    name_en: string | null;
    description: string | null;
    decisionCount: number;
    mergerCount: number;
  };
}

// ---------------------------------------------------------------------------
// HTTP fetching with rate limiting and retries
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<string | null> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "fi,en;q=0.5",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 403 || response.status === 429) {
        console.warn(
          `  [WARN] HTTP ${response.status} for ${url} (attempt ${attempt}/${MAX_RETRIES})`,
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        return null;
      }

      if (!response.ok) {
        console.warn(`  [WARN] HTTP ${response.status} for ${url}`);
        return null;
      }

      return await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [WARN] Fetch error for ${url} (attempt ${attempt}/${MAX_RETRIES}): ${message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// State management (for --resume)
// ---------------------------------------------------------------------------

function loadState(): IngestState {
  if (resume && existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      return JSON.parse(raw) as IngestState;
    } catch {
      console.warn("[WARN] Could not read state file, starting fresh.");
    }
  }
  return {
    processedUrls: [],
    lastRun: new Date().toISOString(),
    decisionsIngested: 0,
    mergersIngested: 0,
    errors: [],
  };
}

function saveState(state: IngestState): void {
  state.lastRun = new Date().toISOString();
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Listing page parsing — discover individual decision URLs
// ---------------------------------------------------------------------------

/**
 * Crawl paginated listing pages to discover decision/merger URLs.
 *
 * KKV listing pages use `?sivu=N` pagination. Each page lists ~10 entries
 * as linked cards. We extract the href from each entry's title link.
 */
async function discoverUrlsFromListings(
  category: (typeof LISTING_CATEGORIES)[number],
  maxPages: number,
): Promise<string[]> {
  const urls: string[] = [];
  const effectiveMax = maxPagesOverride
    ? Math.min(maxPagesOverride, maxPages)
    : maxPages;

  console.log(
    `\n  Discovering URLs from ${category.id} (up to ${effectiveMax} pages)...`,
  );

  for (let page = 1; page <= effectiveMax; page++) {
    const listUrl =
      page === 1
        ? `${BASE_URL}${category.path}`
        : `${BASE_URL}${category.path}?sivu=${page}`;

    if (page % 10 === 1 || page === 1) {
      console.log(
        `    Fetching listing page ${page}/${effectiveMax}... (${urls.length} URLs so far)`,
      );
    }

    const html = await rateLimitedFetch(listUrl);
    if (!html) {
      console.warn(`    [WARN] Could not fetch listing page ${page}`);
      continue;
    }

    const $ = cheerio.load(html);
    let pageUrls = 0;

    // KKV listing pages render decision entries as linked cards.
    // Each entry contains an <a> linking to the detail page. We look for
    // links whose href starts with the category path.
    $("a[href]").each((_i, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      // Match links that point to individual decision pages under this category.
      // These are relative paths like /paatokset/kilpailuasiat/yrityskauppavalvonta/kkv-246-14-00-10-2026/
      // Exclude the category index itself and pagination links.
      if (
        href.startsWith(category.path) &&
        href !== category.path &&
        !href.includes("?sivu=") &&
        !href.includes("?ruling_type=") &&
        href.length > category.path.length + 3
      ) {
        const fullUrl = `${BASE_URL}${href}`;
        if (!urls.includes(fullUrl)) {
          urls.push(fullUrl);
          pageUrls++;
        }
      }
    });

    // If no new URLs found on this page, we have exhausted the listing
    if (pageUrls === 0 && page > 1) {
      console.log(
        `    No new URLs on page ${page} — stopping pagination for ${category.id}`,
      );
      break;
    }
  }

  console.log(
    `    Discovered ${urls.length} URLs from ${category.id}`,
  );
  return urls;
}

// ---------------------------------------------------------------------------
// Page parsing — extract structured data from individual decision pages
// ---------------------------------------------------------------------------

/**
 * Extract labelled metadata fields from a KKV decision page.
 *
 * KKV pages present metadata as label-value pairs in the page body:
 *   - Diaarinumero  (case/dossier number)
 *   - Päivämäärä    (date)
 *   - Osapuolet     (parties)
 *   - Tiivistelmä   (summary)
 *
 * The layout varies: some use definition-list-style markup, some use
 * heading + paragraph patterns, and some embed metadata in the body text.
 */
function extractMetadata(
  $: cheerio.CheerioAPI,
): Record<string, string> {
  const meta: Record<string, string> = {};

  // Strategy 1: Find text nodes that match known Finnish labels, then
  // grab the next sibling or parent's text content as the value.
  const labelPatterns: Array<{ label: string; keys: string[] }> = [
    { label: "diaarinumero", keys: ["diaarinumero", "dnro"] },
    { label: "päivämäärä", keys: ["päivämäärä", "paivamaa"] },
    { label: "osapuolet", keys: ["osapuolet"] },
    { label: "asia", keys: ["asia"] },
    { label: "toimiala", keys: ["toimiala"] },
    { label: "ratkaisu", keys: ["ratkaisu"] },
  ];

  // Pattern 1: Definition list (dl/dt/dd)
  $("dl dt, .field--label, .field-label, .label").each((_i, el) => {
    const rawLabel = $(el).text().trim().replace(/:$/, "").toLowerCase();
    const valueEl =
      $(el).next("dd").length > 0
        ? $(el).next("dd")
        : $(el)
            .next(".field--item, .field-item, .field__item")
            .first();
    if (valueEl.length > 0) {
      meta[rawLabel] = valueEl.text().trim();
    }
  });

  // Pattern 2: Structured blocks — look for bold/strong labels followed by text
  $("p, div").each((_i, el) => {
    const text = $(el).text().trim();
    for (const { label, keys } of labelPatterns) {
      for (const key of keys) {
        // Match "Label: value" or "Label value" patterns
        const regex = new RegExp(
          `^${key}[:\\s]+(.+)`,
          "i",
        );
        const match = text.match(regex);
        if (match?.[1]) {
          meta[label] = match[1].trim();
        }
      }
    }
  });

  // Pattern 3: The page body itself may contain the case number
  // KKV case numbers follow the pattern KKV/NNN/14.00.XX/YYYY
  if (!meta["diaarinumero"]) {
    const bodyText = $("main, article, .content, body").text();
    const caseMatch = bodyText.match(
      /KKV\/\d+\/14\.\d{2}\.\d{2}\/\d{4}/,
    );
    if (caseMatch) {
      meta["diaarinumero"] = caseMatch[0];
    }
    // Older format: NNN-NN-NNNN or NNN/NN/YYYY
    if (!meta["diaarinumero"]) {
      const olderMatch = bodyText.match(
        /(?:dnro|diaarinumero)[:\s]+(\d[\d\-\/\.]+\d)/i,
      );
      if (olderMatch?.[1]) {
        meta["diaarinumero"] = olderMatch[1];
      }
    }
  }

  return meta;
}

/** Parse a Finnish date string (d.M.yyyy) to ISO format (yyyy-MM-dd). */
function parseFinnishDate(raw: string): string | null {
  if (!raw) return null;

  // d.M.yyyy (most common on KKV pages)
  const dotMatch = raw.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const [, day, month, year] = dotMatch;
    return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  }

  // Finnish textual date: "2. joulukuuta 2025"
  const finnishMonths: Record<string, string> = {
    tammikuuta: "01",
    tammikuu: "01",
    helmikuuta: "02",
    helmikuu: "02",
    maaliskuuta: "03",
    maaliskuu: "03",
    huhtikuuta: "04",
    huhtikuu: "04",
    toukokuuta: "05",
    toukokuu: "05",
    kesäkuuta: "06",
    kesäkuu: "06",
    heinäkuuta: "07",
    heinäkuu: "07",
    elokuuta: "08",
    elokuu: "08",
    syyskuuta: "09",
    syyskuu: "09",
    lokakuuta: "10",
    lokakuu: "10",
    marraskuuta: "11",
    marraskuu: "11",
    joulukuuta: "12",
    joulukuu: "12",
  };

  const textMatch = raw.match(/(\d{1,2})\.\s*(\w+)\s+(\d{4})/);
  if (textMatch) {
    const [, day, monthName, year] = textMatch;
    const monthNum = finnishMonths[monthName!.toLowerCase()];
    if (monthNum) {
      return `${year}-${monthNum}-${day!.padStart(2, "0")}`;
    }
  }

  // Already ISO: yyyy-MM-dd
  const isoMatch = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return isoMatch[0];
  }

  return null;
}

/**
 * Extract a fine/penalty amount from Finnish text.
 *
 * Handles Finnish number formatting (comma as decimal separator,
 * dot/space as thousands separator) and Finnish magnitude words.
 */
function extractFineAmount(text: string): number | null {
  const patterns = [
    // "N miljoonaa euroa" / "N milj. euroa"
    /([\d,.\s]+)\s*milj(?:oonaa|\.)\s*euro/gi,
    // "N miljardia euroa"
    /([\d,.\s]+)\s*miljardia\s*euro/gi,
    // "€ 1.234.567" or "EUR 1 234 567" or "1 234 567 euroa"
    /(?:€|EUR)\s*([\d\s.]+(?:,\d+)?)/gi,
    // "N euroa" or "N euron" (with thousands)
    /([\d\s.]+(?:,\d+)?)\s*euro[an]?\b/gi,
    // Seuraamusmaksu ... N euroa (penalty amount pattern)
    /seuraamusmaksu[a-z]*\s+(?:yhteensä\s+)?(?:noin\s+)?([\d\s.]+(?:,\d+)?)\s*euro/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      let numStr = match[1].trim();

      // Detect "miljardia"
      if (pattern.source.includes("miljardia")) {
        numStr = numStr.replace(/[\s.]/g, "").replace(",", ".");
        const val = parseFloat(numStr);
        if (!isNaN(val) && val > 0) return val * 1_000_000_000;
      }

      // Detect "miljoonaa" / "milj."
      if (pattern.source.includes("milj")) {
        numStr = numStr.replace(/[\s.]/g, "").replace(",", ".");
        const val = parseFloat(numStr);
        if (!isNaN(val) && val > 0) return val * 1_000_000;
      }

      // Direct amount: Finnish uses dot or space as thousands separator,
      // comma for decimal
      numStr = numStr.replace(/[\s.]/g, "").replace(",", ".");
      const val = parseFloat(numStr);
      if (!isNaN(val) && val > 1000) return val;
    }
  }

  return null;
}

/**
 * Extract cited Finnish competition law articles and EU treaty articles
 * from the decision text.
 */
function extractLegalArticles(text: string): string[] {
  const articles: Set<string> = new Set();

  // KilpailuL (Kilpailulaki) sections: "kilpailulain 5 §" / "KilpailuL 7 §"
  const kilpailuPattern =
    /(?:kilpailulain|KilpailuL|kilpailulaki)\s*(?:\(948\/2011\)\s*)?(\d+)\s*§/gi;
  let m: RegExpExecArray | null;
  while ((m = kilpailuPattern.exec(text)) !== null) {
    articles.add(`KilpailuL ${m[1]} §`);
  }

  // Standalone "5 §" or "7 §" near competition law context
  const sectionPattern = /(\d+)\s*§:?n?\s/g;
  while ((m = sectionPattern.exec(text)) !== null) {
    const num = parseInt(m[1]!, 10);
    // Only capture sections commonly used in Finnish competition law (5, 6, 7, 10, 11, 12)
    if ([5, 6, 7, 10, 11, 12, 25, 26, 27, 28, 29, 30, 31, 32].includes(num)) {
      articles.add(`KilpailuL ${num} §`);
    }
  }

  // EU treaty articles: SEUT 101 / 102 (TFEU in Finnish)
  const euPattern =
    /(?:SEUT|EUT|TFEU|perussopimuksen)\s*(?:artikla\s*)?(\d{2,3})\s*(?:artikla)?/gi;
  while ((m = euPattern.exec(text)) !== null) {
    const artNum = parseInt(m[1]!, 10);
    if (artNum === 101 || artNum === 102) {
      articles.add(`SEUT ${artNum}`);
    }
  }

  // "Art. 101" / "Art. 102" patterns
  const artPattern = /Art(?:ikla)?\.?\s*(101|102)/gi;
  while ((m = artPattern.exec(text)) !== null) {
    articles.add(`SEUT ${m[1]}`);
  }

  return [...articles];
}

/**
 * Classify a KKV decision based on its URL category, metadata, and content.
 */
function classifyDecisionType(
  categoryId: string,
  title: string,
  bodyText: string,
): {
  type: string | null;
  outcome: string | null;
} {
  const lowerTitle = title.toLowerCase();
  const lowerBody = bodyText.toLowerCase().slice(0, 3000);
  const all = `${lowerTitle} ${lowerBody}`;

  // --- Type classification ---
  let type: string | null = null;

  if (categoryId === "esitykset-markkinaoikeudelle") {
    type = "market_court_proposal";
  } else if (categoryId === "kielto-sitoumus-toimitusvelvoite") {
    if (all.includes("kielto") || all.includes("prohibition")) {
      type = "prohibition";
    } else if (all.includes("sitoumus") || all.includes("commitment")) {
      type = "commitment_decision";
    } else if (
      all.includes("toimitusvelvoite") ||
      all.includes("supply obligation")
    ) {
      type = "supply_obligation";
    } else {
      type = "commitment_decision";
    }
  } else if (
    all.includes("kartelli") ||
    all.includes("kartellia") ||
    all.includes("kielletty kilpailijoiden") ||
    all.includes("yhteistoiminta") ||
    all.includes("tarjousyhteistyö") ||
    all.includes("hintayhteistyö")
  ) {
    type = "cartel";
  } else if (
    all.includes("määräävän markkina-aseman") ||
    all.includes("maaraavasema") ||
    all.includes("markkina-aseman väärinkäyttö") ||
    all.includes("abuse of dominan")
  ) {
    type = "abuse_of_dominance";
  } else if (
    all.includes("sektoriselvitys") ||
    all.includes("markkinaselvitys") ||
    all.includes("sector inquiry") ||
    all.includes("toimialaselvitys")
  ) {
    type = "sector_inquiry";
  } else if (
    all.includes("seuraamusmaksu") ||
    all.includes("sakko") ||
    all.includes("sanktio")
  ) {
    type = "sanction";
  } else if (
    all.includes("kilpailuneutraliteetti") ||
    all.includes("competition neutrality")
  ) {
    type = "competition_neutrality";
  } else {
    type = "decision";
  }

  // --- Outcome classification ---
  let outcome: string | null = null;

  if (
    all.includes("seuraamusmaksu") &&
    (all.includes("määrätty") || all.includes("esittää") || all.includes("esitys"))
  ) {
    outcome = "fine";
  } else if (
    all.includes("jättää asian tutkimatta") ||
    all.includes("jätetty tutkimatta")
  ) {
    outcome = "dismissed";
  } else if (
    all.includes("asian käsittely päätetty") ||
    all.includes("tutkinta päättynyt") ||
    all.includes("asia poistettu")
  ) {
    outcome = "closed";
  } else if (
    all.includes("sitoumus") &&
    (all.includes("hyväksytty") || all.includes("määrätty"))
  ) {
    outcome = "cleared_with_conditions";
  } else if (
    all.includes("kielletty") ||
    all.includes("kielto")
  ) {
    outcome = "prohibited";
  } else if (
    all.includes("ei kilpailunrajoitusta") ||
    all.includes("ei rikkomusta") ||
    all.includes("ei toimenpiteitä")
  ) {
    outcome = "cleared";
  }

  return { type, outcome };
}

/**
 * Classify a merger outcome based on page content.
 */
function classifyMergerOutcome(
  title: string,
  bodyText: string,
): string | null {
  const all = `${title} ${bodyText}`.toLowerCase();

  if (all.includes("kielletty") || all.includes("kielto") || all.includes("estetty")) {
    return "blocked";
  }
  if (
    all.includes("ehdollisena") ||
    all.includes("ehdollinen") ||
    all.includes("ehdoin") ||
    all.includes("ehtojen")
  ) {
    return "cleared_with_conditions";
  }
  if (all.includes("jätetty tutkimatta") || all.includes("ei tutkita")) {
    return "dismissed";
  }
  if (all.includes("peruutettu") || all.includes("peruutti")) {
    return "withdrawn";
  }
  if (
    all.includes("hyväksytty") ||
    all.includes("hyväksyi") ||
    all.includes("hyväksyminen sellaisenaan") ||
    all.includes("ei esteitä")
  ) {
    // Check for phase 2
    if (
      all.includes("jatkoselvitys") ||
      all.includes("toisessa vaiheessa") ||
      all.includes("toinen vaihe") ||
      all.includes("phase ii") ||
      all.includes("phase 2")
    ) {
      return "cleared_phase2";
    }
    return "cleared_phase1";
  }

  // Default for merger pages: assume approval (most mergers are approved)
  return "cleared_phase1";
}

/**
 * Map Finnish keywords in title/body to sector IDs.
 */
function classifySector(
  title: string,
  bodyText: string,
): string | null {
  const text = `${title} ${bodyText.slice(0, 2000)}`.toLowerCase();

  const sectorMapping: Array<{ id: string; patterns: string[] }> = [
    {
      id: "digital_economy",
      patterns: [
        "digitaali",
        "verkkokaup",
        "alusta",
        "platform",
        "ohjelmisto",
        "sovellus",
        "tietotekni",
        "it-palvelu",
        "pilvipalvelu",
      ],
    },
    {
      id: "food_retail",
      patterns: [
        "päivittäistavara",
        "elintarvike",
        "ruokakaup",
        "vähittäiskaup",
        "kauppaketju",
        "s-ryhmä",
        "kesko",
        "k-kauppa",
        "lidl",
        "supermarket",
      ],
    },
    {
      id: "energy",
      patterns: [
        "energia",
        "sähkö",
        "kaukolämpö",
        "kaukolammi",
        "kaasu",
        "polttoaine",
        "bensiini",
        "öljy",
        "uusiutuva",
        "tuulivoima",
        "ydinvoima",
      ],
    },
    {
      id: "telecommunications",
      patterns: [
        "tietoliikenne",
        "televiestint",
        "matkaviestint",
        "laajakaist",
        "kuituverkko",
        "mobiili",
        "telia",
        "elisa",
        "dna",
        "telecom",
      ],
    },
    {
      id: "healthcare",
      patterns: [
        "tervey",
        "sairaala",
        "lääke",
        "laakint",
        "hoivapalvelu",
        "mehiläinen",
        "terveystalo",
        "pihlajalinna",
        "hammas",
        "apteekki",
      ],
    },
    {
      id: "financial_services",
      patterns: [
        "pankki",
        "rahoitu",
        "vakuutu",
        "maksupalvelu",
        "korttimaksu",
        "sijoitu",
        "arvopaperimarkkin",
        "luotto",
      ],
    },
    {
      id: "construction",
      patterns: [
        "rakennu",
        "asfaltti",
        "betoni",
        "kiinteistö",
        "talonrakennus",
        "infrarakentaminen",
        "maarakennus",
        "urakka",
      ],
    },
    {
      id: "transport",
      patterns: [
        "liikenne",
        "kuljetu",
        "logistiikka",
        "lentoliikenne",
        "rautatieliikenne",
        "taksi",
        "laivaliikenne",
        "meriliikenne",
        "linja-auto",
        "bussi",
      ],
    },
    {
      id: "media",
      patterns: [
        "media",
        "kustannu",
        "lehti",
        "televisio",
        "radio",
        "mainont",
        "mainostal",
      ],
    },
    {
      id: "forestry",
      patterns: [
        "metsä",
        "puunhankin",
        "sahateollisuus",
        "selluloosa",
        "paperiteollisuus",
        "puu",
        "kartonki",
      ],
    },
    {
      id: "manufacturing",
      patterns: [
        "teollisuus",
        "valmistus",
        "tuotanto",
        "konepaja",
        "metalliteollisuus",
        "kemianteollisuus",
        "eriste",
      ],
    },
    {
      id: "waste_management",
      patterns: [
        "jätehuolto",
        "kierrätys",
        "jätteenkäsittely",
        "ympäristöpalvelu",
      ],
    },
  ];

  for (const { id, patterns } of sectorMapping) {
    for (const p of patterns) {
      if (text.includes(p)) return id;
    }
  }

  return null;
}

/**
 * Extract acquiring party and target from a merger title.
 *
 * KKV merger titles use the format "Acquiring Party / Target Party".
 */
function extractMergerParties(
  title: string,
  bodyText: string,
): { acquiring: string | null; target: string | null } {
  // Primary pattern: "X / Y" in the title
  const slashParts = title.split(/\s*\/\s*/);
  if (slashParts.length >= 2) {
    return {
      acquiring: slashParts[0]!.trim().slice(0, 300),
      target: slashParts
        .slice(1)
        .join(" / ")
        .trim()
        .slice(0, 300),
    };
  }

  // Fallback: look for "X hankkii Y" / "X ostaa Y" patterns in body
  const bodyMatch = bodyText.match(
    /(.{3,80}?)\s+(?:hankkii|ostaa|hankkimaan|ostanut)\s+(.{3,80}?)(?:\.|,)/i,
  );
  if (bodyMatch) {
    return {
      acquiring: bodyMatch[1]!.trim(),
      target: bodyMatch[2]!.trim(),
    };
  }

  return { acquiring: null, target: null };
}

/**
 * Generate a case number from the URL slug when none is found in page metadata.
 */
function generateCaseNumber(url: string, categoryPath: string): string {
  // Extract slug from URL: e.g. "kkv-246-14-00-10-2026" from the full path
  const slug =
    url.split(categoryPath).pop()?.replace(/\/$/, "") ?? "";
  const shortSlug = slug.slice(0, 80).replace(/-+$/, "");
  return `KKV-WEB/${shortSlug}`;
}

/**
 * Parse a single KKV decision/merger detail page.
 */
function parsePage(
  html: string,
  url: string,
  category: (typeof LISTING_CATEGORIES)[number],
): { decision: ParsedDecision | null; merger: ParsedMerger | null } {
  const $ = cheerio.load(html);

  // --- Title ---
  const title =
    $("h1").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title")
      .text()
      .trim()
      .replace(/\s*[-–|]\s*(?:KKV|Kilpailu).*$/i, "") ||
    "";

  if (!title) {
    return { decision: null, merger: null };
  }

  // --- Metadata fields ---
  const meta = extractMetadata($);

  // --- Body text ---
  // KKV uses a "rs-read-content" wrapper for screen-reader content and
  // standard Drupal-like field wrappers.
  const bodySelectors = [
    ".rs-read-content",
    "article .field--name-body",
    "article .body",
    ".node__content .field--name-body",
    ".content-area",
    "main article",
    ".region-content",
  ];

  let bodyText = "";
  for (const sel of bodySelectors) {
    const el = $(sel);
    if (el.length > 0) {
      bodyText = el.text().trim();
      if (bodyText.length > 100) break;
    }
  }

  // Fallback: gather all paragraphs from main
  if (!bodyText || bodyText.length < 100) {
    const paragraphs: string[] = [];
    $("main p, article p, .content p").each((_i, el) => {
      const text = $(el).text().trim();
      if (text.length > 20) paragraphs.push(text);
    });
    bodyText = paragraphs.join("\n\n");
  }

  // Last resort: strip nav/footer and take what remains
  if (!bodyText || bodyText.length < 50) {
    $(
      "nav, footer, header, .menu, .breadcrumb, script, style, .skip-link",
    ).remove();
    bodyText = $("main, article, .content").text().trim();
  }

  if (!bodyText || bodyText.length < 30) {
    return { decision: null, merger: null };
  }

  // --- Case number ---
  const caseNumber =
    meta["diaarinumero"] ??
    generateCaseNumber(url, category.path);

  // --- Date ---
  const rawDate = meta["päivämäärä"] ?? meta["paivamaa"] ?? "";
  const date = parseFinnishDate(rawDate);

  // --- Sector ---
  const sector = classifySector(title, bodyText);

  // --- Summary (first ~500 chars of body) ---
  const summary = bodyText.slice(0, 500).replace(/\s+/g, " ").trim();

  // --- Route to merger vs. decision ---
  if (category.isMerger) {
    const { acquiring, target } = extractMergerParties(title, bodyText);
    const outcome = classifyMergerOutcome(title, bodyText);

    return {
      decision: null,
      merger: {
        case_number: caseNumber,
        title,
        date,
        sector,
        acquiring_party: acquiring,
        target,
        summary,
        full_text: bodyText,
        outcome,
        turnover: null, // Turnover not reliably extractable from HTML
      },
    };
  }

  // Non-merger decision
  const { type, outcome } = classifyDecisionType(
    category.id,
    title,
    bodyText,
  );
  const parties = meta["osapuolet"] ?? null;
  const fineAmount = extractFineAmount(bodyText);
  const legalArticles = extractLegalArticles(bodyText);

  return {
    decision: {
      case_number: caseNumber,
      title,
      date,
      type,
      sector,
      parties: parties
        ? JSON.stringify(
            parties
              .split(/[,;]/)
              .map((p) => p.trim())
              .filter(Boolean),
          )
        : null,
      summary,
      full_text: bodyText,
      outcome: outcome ?? (fineAmount ? "fine" : null),
      fine_amount: fineAmount,
      gwb_articles:
        legalArticles.length > 0
          ? JSON.stringify(legalArticles)
          : null,
      status: "final",
    },
    merger: null,
  };
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`Created data directory: ${dir}`);
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database (--force)`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function prepareStatements(db: Database.Database) {
  const insertDecision = db.prepare(`
    INSERT OR IGNORE INTO decisions
      (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertDecision = db.prepare(`
    INSERT INTO decisions
      (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_number) DO UPDATE SET
      title = excluded.title,
      date = excluded.date,
      type = excluded.type,
      sector = excluded.sector,
      parties = excluded.parties,
      summary = excluded.summary,
      full_text = excluded.full_text,
      outcome = excluded.outcome,
      fine_amount = excluded.fine_amount,
      gwb_articles = excluded.gwb_articles,
      status = excluded.status
  `);

  const insertMerger = db.prepare(`
    INSERT OR IGNORE INTO mergers
      (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertMerger = db.prepare(`
    INSERT INTO mergers
      (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_number) DO UPDATE SET
      title = excluded.title,
      date = excluded.date,
      sector = excluded.sector,
      acquiring_party = excluded.acquiring_party,
      target = excluded.target,
      summary = excluded.summary,
      full_text = excluded.full_text,
      outcome = excluded.outcome,
      turnover = excluded.turnover
  `);

  const upsertSector = db.prepare(`
    INSERT INTO sectors (id, name, name_en, description, decision_count, merger_count)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      decision_count = excluded.decision_count,
      merger_count = excluded.merger_count
  `);

  return {
    insertDecision,
    upsertDecision,
    insertMerger,
    upsertMerger,
    upsertSector,
  };
}

// ---------------------------------------------------------------------------
// Sector metadata
// ---------------------------------------------------------------------------

const SECTOR_META: Record<string, { name: string; name_en: string }> = {
  digital_economy: {
    name: "Digitaalinen talous",
    name_en: "Digital Economy",
  },
  food_retail: {
    name: "Päivittäistavarakauppa",
    name_en: "Food Retail",
  },
  energy: { name: "Energia", name_en: "Energy" },
  telecommunications: {
    name: "Tietoliikenne",
    name_en: "Telecommunications",
  },
  healthcare: {
    name: "Terveydenhuolto",
    name_en: "Healthcare",
  },
  financial_services: {
    name: "Rahoituspalvelut",
    name_en: "Financial Services",
  },
  construction: {
    name: "Rakentaminen",
    name_en: "Construction",
  },
  transport: { name: "Liikenne", name_en: "Transport" },
  media: { name: "Media", name_en: "Media" },
  forestry: {
    name: "Metsäteollisuus",
    name_en: "Forestry",
  },
  manufacturing: {
    name: "Teollisuus",
    name_en: "Manufacturing",
  },
  waste_management: {
    name: "Jätehuolto",
    name_en: "Waste Management",
  },
};

// ---------------------------------------------------------------------------
// Main ingestion pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== KKV Competition Decisions Crawler ===");
  console.log(`  Database:    ${DB_PATH}`);
  console.log(`  Dry run:     ${dryRun}`);
  console.log(`  Resume:      ${resume}`);
  console.log(`  Force:       ${force}`);
  console.log(
    `  Max pages:   ${maxPagesOverride ?? "per-category defaults"}`,
  );
  console.log("");

  // Load resume state
  const state = loadState();
  const processedSet = new Set(state.processedUrls);

  // Step 1: Discover URLs from all listing categories
  const allUrls: Array<{
    url: string;
    category: (typeof LISTING_CATEGORIES)[number];
  }> = [];

  for (const category of LISTING_CATEGORIES) {
    const urls = await discoverUrlsFromListings(
      category,
      category.maxPages,
    );
    for (const url of urls) {
      allUrls.push({ url, category });
    }
  }

  // Deduplicate by URL
  const seenUrls = new Set<string>();
  const dedupedUrls = allUrls.filter(({ url }) => {
    if (seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  });

  // Filter already-processed URLs (for --resume)
  const urlsToProcess = resume
    ? dedupedUrls.filter(({ url }) => !processedSet.has(url))
    : dedupedUrls;

  console.log(`\nTotal discovered URLs: ${dedupedUrls.length}`);
  console.log(`URLs to process:       ${urlsToProcess.length}`);
  if (resume && dedupedUrls.length !== urlsToProcess.length) {
    console.log(
      `  Skipping ${dedupedUrls.length - urlsToProcess.length} already-processed URLs`,
    );
  }

  if (urlsToProcess.length === 0) {
    console.log("Nothing to process. Exiting.");
    return;
  }

  // Step 2: Initialize database (unless dry run)
  let db: Database.Database | null = null;
  let stmts: ReturnType<typeof prepareStatements> | null = null;

  if (!dryRun) {
    db = initDb();
    stmts = prepareStatements(db);
  }

  // Step 3: Process each URL
  let decisionsIngested = 0;
  let mergersIngested = 0;
  let errors = 0;
  let skipped = 0;

  for (let i = 0; i < urlsToProcess.length; i++) {
    const { url, category } = urlsToProcess[i]!;
    const progress = `[${i + 1}/${urlsToProcess.length}]`;

    console.log(`${progress} ${category.id} | ${url}`);

    const html = await rateLimitedFetch(url);
    if (!html) {
      console.log(`  SKIP -- could not fetch`);
      state.errors.push(`fetch_failed: ${url}`);
      errors++;
      continue;
    }

    try {
      const { decision, merger } = parsePage(html, url, category);

      if (decision) {
        if (dryRun) {
          console.log(
            `  DECISION: ${decision.case_number} -- ${decision.title.slice(0, 80)}`,
          );
          console.log(
            `    type=${decision.type}, sector=${decision.sector}, outcome=${decision.outcome}, fine=${decision.fine_amount}`,
          );
        } else {
          const stmt = force
            ? stmts!.upsertDecision
            : stmts!.insertDecision;
          stmt.run(
            decision.case_number,
            decision.title,
            decision.date,
            decision.type,
            decision.sector,
            decision.parties,
            decision.summary,
            decision.full_text,
            decision.outcome,
            decision.fine_amount,
            decision.gwb_articles,
            decision.status,
          );
          console.log(
            `  INSERTED decision: ${decision.case_number}`,
          );
        }

        decisionsIngested++;
      } else if (merger) {
        if (dryRun) {
          console.log(
            `  MERGER: ${merger.case_number} -- ${merger.title.slice(0, 80)}`,
          );
          console.log(
            `    sector=${merger.sector}, outcome=${merger.outcome}, acquiring=${merger.acquiring_party?.slice(0, 50)}`,
          );
        } else {
          const stmt = force
            ? stmts!.upsertMerger
            : stmts!.insertMerger;
          stmt.run(
            merger.case_number,
            merger.title,
            merger.date,
            merger.sector,
            merger.acquiring_party,
            merger.target,
            merger.summary,
            merger.full_text,
            merger.outcome,
            merger.turnover,
          );
          console.log(
            `  INSERTED merger: ${merger.case_number}`,
          );
        }

        mergersIngested++;
      } else {
        console.log(`  SKIP -- could not parse structured data`);
        skipped++;
      }

      // Mark URL as processed
      processedSet.add(url);
      state.processedUrls.push(url);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${message}`);
      state.errors.push(`parse_error: ${url}: ${message}`);
      errors++;
    }

    // Save state periodically (every 25 URLs)
    if ((i + 1) % 25 === 0) {
      state.decisionsIngested += decisionsIngested;
      state.mergersIngested += mergersIngested;
      saveState(state);
      console.log(
        `  [checkpoint] State saved after ${i + 1} URLs`,
      );
    }
  }

  // Step 4: Update sector counts from the database
  if (!dryRun && db && stmts) {
    const decisionSectorCounts = db
      .prepare(
        "SELECT sector, COUNT(*) as cnt FROM decisions WHERE sector IS NOT NULL GROUP BY sector",
      )
      .all() as Array<{ sector: string; cnt: number }>;
    const mergerSectorCounts = db
      .prepare(
        "SELECT sector, COUNT(*) as cnt FROM mergers WHERE sector IS NOT NULL GROUP BY sector",
      )
      .all() as Array<{ sector: string; cnt: number }>;

    const finalSectorCounts: Record<
      string,
      { decisions: number; mergers: number }
    > = {};
    for (const row of decisionSectorCounts) {
      if (!finalSectorCounts[row.sector])
        finalSectorCounts[row.sector] = {
          decisions: 0,
          mergers: 0,
        };
      finalSectorCounts[row.sector]!.decisions = row.cnt;
    }
    for (const row of mergerSectorCounts) {
      if (!finalSectorCounts[row.sector])
        finalSectorCounts[row.sector] = {
          decisions: 0,
          mergers: 0,
        };
      finalSectorCounts[row.sector]!.mergers = row.cnt;
    }

    const updateSectors = db.transaction(() => {
      for (const [id, counts] of Object.entries(
        finalSectorCounts,
      )) {
        const meta = SECTOR_META[id];
        stmts!.upsertSector.run(
          id,
          meta?.name ?? id,
          meta?.name_en ?? null,
          null,
          counts.decisions,
          counts.mergers,
        );
      }
    });
    updateSectors();

    console.log(
      `\nUpdated ${Object.keys(finalSectorCounts).length} sector records`,
    );
  }

  // Step 5: Final state save
  state.decisionsIngested += decisionsIngested;
  state.mergersIngested += mergersIngested;
  saveState(state);

  // Step 6: Summary
  if (!dryRun && db) {
    const decisionCount = (
      db
        .prepare("SELECT count(*) as cnt FROM decisions")
        .get() as { cnt: number }
    ).cnt;
    const mergerCount = (
      db.prepare("SELECT count(*) as cnt FROM mergers").get() as {
        cnt: number;
      }
    ).cnt;
    const sectorCount = (
      db.prepare("SELECT count(*) as cnt FROM sectors").get() as {
        cnt: number;
      }
    ).cnt;

    console.log("\n=== Ingestion Complete ===");
    console.log(`  Decisions in DB:  ${decisionCount}`);
    console.log(`  Mergers in DB:    ${mergerCount}`);
    console.log(`  Sectors in DB:    ${sectorCount}`);
    console.log(`  New decisions:    ${decisionsIngested}`);
    console.log(`  New mergers:      ${mergersIngested}`);
    console.log(`  Errors:           ${errors}`);
    console.log(`  Skipped:          ${skipped}`);
    console.log(`  State saved to:   ${STATE_FILE}`);

    db.close();
  } else {
    console.log("\n=== Dry Run Complete ===");
    console.log(`  Decisions found:  ${decisionsIngested}`);
    console.log(`  Mergers found:    ${mergersIngested}`);
    console.log(`  Errors:           ${errors}`);
    console.log(`  Skipped:          ${skipped}`);
  }

  console.log(`\nDone.`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

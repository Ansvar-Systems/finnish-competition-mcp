#!/usr/bin/env node

/**
 * Finnish Competition MCP — stdio entry point.
 *
 * Provides MCP tools for querying KKV (Kilpailu- ja kuluttajavirasto —
 * Finnish Competition and Consumer Authority) enforcement decisions,
 * merger control cases, and sector enforcement activity under Finnish
 * competition law (KilpailuL).
 *
 * Tool prefix: fi_comp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchMergers,
  getMerger,
  listSectors,
  deriveKkvFallbackUrl,
} from "./db.js";
import { buildCitation } from "./citation.js";

// Publisher / license metadata for the `_meta` envelope on tool responses.
// Mirrors the manifest attribution contract (Phase 1 PR #673):
//   publisher: kkv.fi
//   license:   FI-Statutory-PD (Finnish Statutory PD §9 point 4 — KKV
//              decisions are administrative decisions; not copyrightable
//              under Finnish copyright law)
const META = {
  publisher: "kkv.fi",
  license: "FI-Statutory-PD",
  source_url_base: "https://www.kkv.fi/",
} as const;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "finnish-competition-mcp";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "fi_comp_search_decisions",
    description:
      "Full-text search across KKV (Kilpailu- ja kuluttajavirasto) enforcement decisions (abuse of dominance, cartel, sector inquiries). Returns matching decisions with case number, parties, outcome, fine amount, and KilpailuL articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in Finnish or English (e.g., 'määräävä markkina-asema', 'kartelli', 'hintayhteistyö', 'abuse of dominance')",
        },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "merger", "sector_inquiry"],
          description: "Filter by decision type. Optional.",
        },
        sector: {
          type: "string",
          description: "Filter by sector ID (e.g., 'digital_economy', 'food_retail', 'energy'). Optional.",
        },
        outcome: {
          type: "string",
          enum: ["prohibited", "cleared", "cleared_with_conditions", "fine"],
          description: "Filter by outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fi_comp_get_decision",
    description:
      "Get a specific KKV decision by case number (e.g., 'KKV/123/14.00.00/2022', 'KKV/456/14.00.00/2021').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description: "KKV case number",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "fi_comp_search_mergers",
    description:
      "Search KKV merger control decisions (yrityskauppavalvonta). Returns merger cases with acquiring party, target, sector, and outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in Finnish or English (e.g., 'yrityskauppa', 'fuusio', 'teleoperaattori', 'merger')",
        },
        sector: {
          type: "string",
          description: "Filter by sector ID. Optional.",
        },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fi_comp_get_merger",
    description:
      "Get a specific KKV merger control decision by case number.",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description: "KKV merger case number",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "fi_comp_list_sectors",
    description:
      "List all sectors with KKV enforcement activity, including decision counts and merger counts per sector.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "fi_comp_about",
    description:
      "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["abuse_of_dominance", "cartel", "merger", "sector_inquiry"]).optional(),
  sector: z.string().optional(),
  outcome: z.enum(["prohibited", "cleared", "cleared_with_conditions", "fine"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  case_number: z.string().min(1),
});

const SearchMergersArgs = z.object({
  query: z.string().min(1),
  sector: z.string().optional(),
  outcome: z.enum(["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetMergerArgs = z.object({
  case_number: z.string().min(1),
});

// --- Helper ------------------------------------------------------------------

function textContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "fi_comp_search_decisions": {
        const parsed = SearchDecisionsArgs.parse(args);
        const results = searchDecisions({
          query: parsed.query,
          type: parsed.type,
          sector: parsed.sector,
          outcome: parsed.outcome,
          limit: parsed.limit,
        });
        const enriched = results.map((d) => {
          const sourceUrl = d.source_url ?? deriveKkvFallbackUrl(d.case_number);
          return {
            ...d,
            _citation: buildCitation(
              d.case_number,
              d.title || d.case_number,
              "fi_comp_get_decision",
              { case_number: d.case_number },
              sourceUrl,
            ),
          };
        });
        return textContent({
          results: enriched,
          count: enriched.length,
          _meta: { ...META, tool_name: "fi_comp_search_decisions" },
        });
      }

      case "fi_comp_get_decision": {
        const parsed = GetDecisionArgs.parse(args);
        const decision = getDecision(parsed.case_number);
        if (!decision) {
          return errorContent(`Decision not found: ${parsed.case_number}`);
        }
        const sourceUrl = decision.source_url ?? deriveKkvFallbackUrl(decision.case_number);
        return textContent({
          ...decision,
          _citation: buildCitation(
            decision.case_number,
            decision.title || decision.case_number,
            "fi_comp_get_decision",
            { case_number: parsed.case_number },
            sourceUrl,
          ),
          _meta: { ...META, tool_name: "fi_comp_get_decision" },
        });
      }

      case "fi_comp_search_mergers": {
        const parsed = SearchMergersArgs.parse(args);
        const results = searchMergers({
          query: parsed.query,
          sector: parsed.sector,
          outcome: parsed.outcome,
          limit: parsed.limit,
        });
        const enriched = results.map((m) => {
          const sourceUrl = m.source_url ?? deriveKkvFallbackUrl(m.case_number);
          return {
            ...m,
            _citation: buildCitation(
              m.case_number,
              m.title || m.case_number,
              "fi_comp_get_merger",
              { case_number: m.case_number },
              sourceUrl,
            ),
          };
        });
        return textContent({
          results: enriched,
          count: enriched.length,
          _meta: { ...META, tool_name: "fi_comp_search_mergers" },
        });
      }

      case "fi_comp_get_merger": {
        const parsed = GetMergerArgs.parse(args);
        const merger = getMerger(parsed.case_number);
        if (!merger) {
          return errorContent(`Merger case not found: ${parsed.case_number}`);
        }
        const sourceUrl = merger.source_url ?? deriveKkvFallbackUrl(merger.case_number);
        return textContent({
          ...merger,
          _citation: buildCitation(
            merger.case_number,
            merger.title || merger.case_number,
            "fi_comp_get_merger",
            { case_number: parsed.case_number },
            sourceUrl,
          ),
          _meta: { ...META, tool_name: "fi_comp_get_merger" },
        });
      }

      case "fi_comp_list_sectors": {
        const sectors = listSectors();
        return textContent({ sectors, count: sectors.length });
      }

      case "fi_comp_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "KKV (Kilpailu- ja kuluttajavirasto — Finnish Competition and Consumer Authority) MCP server. Provides access to Finnish competition law enforcement decisions, merger control cases, and sector enforcement data under the KilpailuL (Kilpailulaki / Competition Act).",
          data_source: "KKV (https://www.kkv.fi/)",
          coverage: {
            decisions: "Abuse of dominance (maaraavasema), cartel enforcement (kartelli), and sector inquiries",
            mergers: "Merger control decisions (yrityskauppavalvonta) — Phase I and Phase II",
            sectors: "Digital economy, food retail, energy, telecommunications, financial services, healthcare, transport",
          },
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`);
  }
});

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

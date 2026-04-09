#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchMergers,
  getMerger,
  listSectors,
  getDataFreshness,
} from "./db.js";
import { buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "finnish-competition-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- _meta block shared across all responses ---------------------------------

const RESPONSE_META = {
  disclaimer:
    "This data is provided for informational purposes only and does not constitute legal advice. Always verify decisions against official KKV publications.",
  copyright: "KKV (Kilpailu- ja kuluttajavirasto) — Finnish Competition and Consumer Authority",
  source_url: "https://www.kkv.fi/",
};

// --- Tool definitions (shared with index.ts) ---------------------------------

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
          description:
            "Search query in Finnish or English (e.g., 'määräävä markkina-asema', 'kartelli', 'hintayhteistyö', 'abuse of dominance')",
        },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "merger", "sector_inquiry"],
          description: "Filter by decision type. Optional.",
        },
        sector: {
          type: "string",
          description:
            "Filter by sector ID (e.g., 'digital_economy', 'food_retail', 'energy'). Optional.",
        },
        outcome: {
          type: "string",
          enum: ["prohibited", "cleared", "cleared_with_conditions", "fine"],
          description: "Filter by outcome. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
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
          description: "KKV case number (e.g., 'KKV/123/14.00.00/2022')",
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
          description:
            "Search query in Finnish or English (e.g., 'yrityskauppa', 'fuusio', 'teleoperaattori', 'merger')",
        },
        sector: { type: "string", description: "Filter by sector ID. Optional." },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
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
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "fi_comp_list_sources",
    description:
      "List the official KKV source URLs used to populate this dataset, including enforcement decisions and merger control registers.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "fi_comp_check_data_freshness",
    description:
      "Return data freshness metadata: record counts and latest decision/merger dates ingested. Useful for determining how current the dataset is.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "fi_comp_about",
    description:
      "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

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

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

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
          return textContent({ results, count: results.length, _meta: RESPONSE_META });
        }

        case "fi_comp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.case_number);
          if (!decision) {
            return errorContent(`Decision not found: ${parsed.case_number}`);
          }
          const decisionRecord = decision as Record<string, unknown>;
          return textContent({
            ...decisionRecord,
            _citation: buildCitation(
              String(decisionRecord.case_number ?? parsed.case_number),
              String(decisionRecord.title ?? decisionRecord.case_number ?? parsed.case_number),
              "fi_comp_get_decision",
              { case_number: parsed.case_number },
              decisionRecord.url as string | undefined,
            ),
            _meta: RESPONSE_META,
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
          return textContent({ results, count: results.length, _meta: RESPONSE_META });
        }

        case "fi_comp_get_merger": {
          const parsed = GetMergerArgs.parse(args);
          const merger = getMerger(parsed.case_number);
          if (!merger) {
            return errorContent(`Merger case not found: ${parsed.case_number}`);
          }
          const mergerRecord = merger as Record<string, unknown>;
          return textContent({
            ...mergerRecord,
            _citation: buildCitation(
              String(mergerRecord.case_number ?? parsed.case_number),
              String(mergerRecord.title ?? mergerRecord.case_number ?? parsed.case_number),
              "fi_comp_get_merger",
              { case_number: parsed.case_number },
              mergerRecord.url as string | undefined,
            ),
            _meta: RESPONSE_META,
          });
        }

        case "fi_comp_list_sectors": {
          const sectors = listSectors();
          return textContent({ sectors, count: sectors.length, _meta: RESPONSE_META });
        }

        case "fi_comp_list_sources": {
          return textContent({
            sources: [
              {
                name: "KKV enforcement decisions",
                url: "https://www.kkv.fi/ratkaisut-ja-julkaisut/ratkaisut/kilpailuasiat/",
                description: "Abuse of dominance, cartel, and sector inquiry decisions",
              },
              {
                name: "KKV merger control decisions",
                url: "https://www.kkv.fi/ratkaisut-ja-julkaisut/ratkaisut/yrityskaupat/",
                description: "Merger control (yrityskauppavalvonta) Phase I and Phase II decisions",
              },
              {
                name: "KKV official website",
                url: "https://www.kkv.fi/",
                description: "Kilpailu- ja kuluttajavirasto — Finnish Competition and Consumer Authority",
              },
            ],
            _meta: RESPONSE_META,
          });
        }

        case "fi_comp_check_data_freshness": {
          const freshness = getDataFreshness();
          return textContent({ ...freshness, _meta: RESPONSE_META });
        }

        case "fi_comp_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "KKV (Kilpailu- ja kuluttajavirasto — Finnish Competition and Consumer Authority) MCP server. Provides access to Finnish competition law enforcement decisions, merger control cases, and sector enforcement data under the KilpailuL (Kilpailulaki / Competition Act).",
            data_source: "KKV (https://www.kkv.fi/)",
            coverage: {
              decisions:
                "Abuse of dominance (määräävä markkina-asema), cartel enforcement (kartelli), and sector inquiries",
              mergers:
                "Merger control decisions (yrityskauppavalvonta) — Phase I and Phase II",
              sectors:
                "Digital economy, food retail, energy, telecommunications, financial services, healthcare, transport",
            },
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
            _meta: RESPONSE_META,
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

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

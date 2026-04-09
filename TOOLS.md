# Tools Reference

All tools use the `fi_comp_` prefix. Available via both stdio (index.ts) and HTTP (http-server.ts) transports.

## fi_comp_search_decisions

Full-text search across KKV enforcement decisions.

**Inputs:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search query in Finnish or English (e.g., `määräävä markkina-asema`, `kartelli`, `abuse of dominance`) |
| `type` | string | No | Filter by type: `abuse_of_dominance`, `cartel`, `merger`, `sector_inquiry` |
| `sector` | string | No | Filter by sector ID (e.g., `digital_economy`, `food_retail`) |
| `outcome` | string | No | Filter by outcome: `prohibited`, `cleared`, `cleared_with_conditions`, `fine` |
| `limit` | number | No | Maximum results to return (default 20, max 100) |

**Returns:** Array of matching decisions with case number, parties, outcome, fine amount, and KilpailuL articles cited.

---

## fi_comp_get_decision

Retrieve a specific KKV decision by case number.

**Inputs:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `case_number` | string | Yes | KKV case number (e.g., `KKV/123/14.00.00/2022`) |

**Returns:** Full decision record including `_citation` metadata for citation pipeline integration and `_meta` block.

---

## fi_comp_search_mergers

Search KKV merger control decisions (yrityskauppavalvonta).

**Inputs:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Search query in Finnish or English (e.g., `yrityskauppa`, `fuusio`, `teleoperaattori`) |
| `sector` | string | No | Filter by sector ID |
| `outcome` | string | No | Filter by outcome: `cleared`, `cleared_phase1`, `cleared_with_conditions`, `prohibited` |
| `limit` | number | No | Maximum results to return (default 20, max 100) |

**Returns:** Array of merger cases with acquiring party, target, sector, and outcome.

---

## fi_comp_get_merger

Retrieve a specific KKV merger control decision by case number.

**Inputs:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `case_number` | string | Yes | KKV merger case number |

**Returns:** Full merger record including `_citation` metadata and `_meta` block.

---

## fi_comp_list_sectors

List all sectors with KKV enforcement activity.

**Inputs:** None

**Returns:** Array of sectors with `decision_count` and `merger_count`.

---

## fi_comp_list_sources

List the official KKV source URLs used to populate this dataset.

**Inputs:** None

**Returns:** Array of source objects with `name`, `url`, and `description`.

---

## fi_comp_check_data_freshness

Return data freshness metadata for the ingested dataset.

**Inputs:** None

**Returns:**

| Field | Description |
|---|---|
| `decisions_count` | Total number of decisions in the database |
| `mergers_count` | Total number of merger cases in the database |
| `decisions_latest_date` | ISO date of the most recently ingested decision |
| `mergers_latest_date` | ISO date of the most recently ingested merger case |
| `sources` | Official KKV source URLs |

---

## fi_comp_about

Return metadata about this MCP server.

**Inputs:** None

**Returns:** Server name, version, description, data source, coverage summary, and full tool list.

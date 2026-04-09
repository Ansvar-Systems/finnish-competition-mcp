# Data Coverage

This document describes the completeness of the corpus served by the Finnish Competition MCP.

## Enforcement Decisions

**Source:** [KKV kilpailuasiat](https://www.kkv.fi/ratkaisut-ja-julkaisut/ratkaisut/kilpailuasiat/)

| Category | Coverage | Notes |
|---|---|---|
| Abuse of dominance (määräävä markkina-asema) | Partial | Major published decisions |
| Cartel enforcement (kartelli) | Partial | Major published decisions |
| Sector inquiries (toimialatutkimus) | Partial | Selected published reports |

## Merger Control

**Source:** [KKV yrityskaupat](https://www.kkv.fi/ratkaisut-ja-julkaisut/ratkaisut/yrityskaupat/)

| Category | Coverage | Notes |
|---|---|---|
| Phase I clearances | Partial | Decisions with published summaries |
| Phase II (in-depth) investigations | Partial | Full decisions where published |
| Conditional clearances | Partial | Conditions/remedies included where available |
| Prohibited mergers | Partial | Published prohibitions |

## Sectors Covered

- Digital economy (digitaalinen talous)
- Food retail (päivittäistavarakauppa)
- Energy (energia)
- Telecommunications (televiestintä)
- Financial services (rahoituspalvelut)
- Healthcare (terveydenhuolto)
- Transport (liikenne)

## Limitations

- **Not exhaustive:** KKV publishes summaries and selected decisions; some proceedings are confidential or unpublished.
- **Language:** Decisions are primarily in Finnish; some include Swedish or English summaries.
- **Temporal coverage:** The dataset covers major decisions available at the time of last ingest. Use `fi_comp_check_data_freshness` to determine how current the data is.
- **gwb_articles field:** The database schema contains a `gwb_articles` column (a legacy artefact from a copy of the German MCP template). This column is unused for Finnish decisions; the relevant Finnish law reference is KilpailuL (Kilpailulaki 948/2011). The column will be renamed to `kilpailul_articles` in a future ingest rebuild.
- **No real-time updates:** This is a static dataset rebuilt periodically. For the latest decisions, consult [kkv.fi](https://www.kkv.fi/) directly.

## Data Quality

Decisions are ingested from official KKV publications. Summaries and party names are taken directly from published documents. Fine amounts are recorded in EUR where published.

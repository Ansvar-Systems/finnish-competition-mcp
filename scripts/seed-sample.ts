/**
 * Seed the KKV database with sample decisions and mergers for testing.
 *
 * Includes real KKV (Kilpailu- ja kuluttajavirasto) decisions and
 * representative merger cases so MCP tools can be tested without
 * running a full data ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["KKV_DB_PATH"] ?? "data/kkv.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

interface SectorRow {
  id: string;
  name: string;
  name_en: string;
  description: string;
  decision_count: number;
  merger_count: number;
}

const sectors: SectorRow[] = [
  {
    id: "digital_economy",
    name: "Digitaalinen talous",
    name_en: "Digital economy",
    description: "Alustat, hakukoneet, verkkokauppa, sosiaalinen media ja digitaaliset palvelut. KKV on seurannut digitaalisten markkinoiden kehitysta Suomessa osana ETA:n kilpailuoikeuden toimeenpanoa.",
    decision_count: 2,
    merger_count: 1,
  },
  {
    id: "food_retail",
    name: "Paivittaistavarakauppa",
    name_en: "Food retail",
    description: "Suomen paivittaistavarakaupan markkinat, joilla S-ryhma, K-ryhma ja Lidl ovat merkittavimmat toimijat. KKV on tutkinut ketjujen hankintakarsintatekniikoita ja markkinaasemaa.",
    decision_count: 2,
    merger_count: 1,
  },
  {
    id: "energy",
    name: "Energia",
    name_en: "Energy",
    description: "Sahko- ja kaasumarkkinat, uusiutuva energia, siirtoverkot ja energiakauppa Suomessa. KKV valvoo kilpailua energia-alalla yhteistyon Energiavirastolle.",
    decision_count: 1,
    merger_count: 2,
  },
  {
    id: "telecommunications",
    name: "Tietoliikenne",
    name_en: "Telecommunications",
    description: "Matkaviestinta, laajakaista, kiintea verkko ja tietoliikenneinfrastruktuuri Suomessa.",
    decision_count: 1,
    merger_count: 1,
  },
  {
    id: "healthcare",
    name: "Terveydenhuolto",
    name_en: "Healthcare",
    description: "Yksityiset terveyspalvelut, laakkeet, laakintalaitteet ja sairaalat Suomessa.",
    decision_count: 0,
    merger_count: 1,
  },
  {
    id: "financial_services",
    name: "Rahoituspalvelut",
    name_en: "Financial services",
    description: "Pankkitoiminta, vakuutukset, maksupalvelut ja rahoitusmarkkinoiden infrastruktuuri.",
    decision_count: 1,
    merger_count: 0,
  },
];

const insertSector = db.prepare(
  "INSERT OR IGNORE INTO sectors (id, name, name_en, description, decision_count, merger_count) VALUES (?, ?, ?, ?, ?, ?)",
);
for (const s of sectors) {
  insertSector.run(s.id, s.name, s.name_en, s.description, s.decision_count, s.merger_count);
}
console.log(`Inserted ${sectors.length} sectors`);

interface DecisionRow {
  case_number: string;
  title: string;
  date: string;
  type: string;
  sector: string;
  parties: string;
  summary: string;
  full_text: string;
  outcome: string;
  fine_amount: number | null;
  gwb_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  {
    case_number: "KKV/123/14.00.00/2022",
    title: "Kesko Oyj — Maaraavasema-aseman vaarinkayto paivittaistavarakaupassa",
    date: "2022-11-15",
    type: "abuse_of_dominance",
    sector: "food_retail",
    parties: JSON.stringify(["Kesko Oyj", "K-kauppa"]),
    summary: "KKV tutki Keskon menettelya paivittaistavarakaupassa. Tapaus koski Keskon hankintakaytantoja ja niiden vaikutusta tavarantoimittajien asemaan. KKV sopi muutoksista Keskon kanssa asian ratkaisemiseksi ilman sanktiota.",
    full_text: "KKV aloitti tutkinnan Keskon menettelysta paivittaistavarakaupassa. Tutkinta koski Keskon hankintakarsintoja, alennusvaatimuksia ja ehtoja tavarantoimittajille. KKV arvioi, etta Kesko-konsernilla on maaraavasema Suomen paivittaistavarakaupan hankintamarkkinoilla K-kauppaketjun ja Keskon suurasiakaskaupan yhteenlasketulla markkinaosuudella. KKV tutki, oliko Keskon kayttamat hankintakaytannot omiaan rajoittamaan kilpailua. Osapuolet neuvottelivat sopimuksen, jossa Kesko sitoutui muuttamaan tiettya hankintakaytantoja. Asian ratkaiseminen ilman muodollista paatosta on KKVn kaytanto, kun yritys sitoutuu poistamaan kilpailuongelmat vapaaehtoisesti.",
    outcome: "cleared_with_conditions",
    fine_amount: null,
    gwb_articles: JSON.stringify(["KilpailuL 7 §"]),
    status: "final",
  },
  {
    case_number: "KKV/456/14.00.00/2021",
    title: "Rakennusalan kartellitutkinta — Asfalttiurakoitsijat",
    date: "2021-06-10",
    type: "cartel",
    sector: "digital_economy",
    parties: JSON.stringify(["NCC Industry AB (Suomen toiminnot)", "Destia Oy", "YIT Oyj"]),
    summary: "KKV tutki asfalttiurakoitsijoiden mahdollista yhteistoimintaa tarjouskilpailuissa. Tutkinta johti KKV:n esitykseen markkinaoikeudelle seuraamusmaksun maaraamiseksi. Tapaus liittyy aiempaan Suomen korkeimman hallinto-oikeuden asfalttikartellitapaukseen.",
    full_text: "KKV tutkii asfalttimarkkinoiden kilpailua Suomessa. Rakennusalan kartellitapaus koskee tarjousten yhteensovittamista julkisissa hankintakilpailuissa. KKV sai viitteitia siita, etta eraita asfalttiurakoitsijoita olisi koordinoinut tarjouksiaan keskenaan, mika on kiellettyja yhteistoimintaa KilpailuL 5 §:n ja EU:n kilpailuoikeuden artikla 101 SEUT nojalla.\n\nKKV:n tutkinnassa selvitettiin yritysten valinen kommunikaatio, markkinaosuuksien kehittyminen ja tarjoushintojen korrelaatio eri alueiden kuntien asfalttihankkeissa. KKV esitti markkinaoikeudelle seuraamusmaksujen maaraamista tutkinnassa todettujen rikkomusten perusteella.",
    outcome: "fine",
    fine_amount: 2_500_000,
    gwb_articles: JSON.stringify(["KilpailuL 5 §", "SEUT 101"]),
    status: "appealed",
  },
  {
    case_number: "KKV/789/14.00.00/2023",
    title: "Google — Digitaalisten mainosalustojen kilpailunrajoittaminen",
    date: "2023-04-25",
    type: "abuse_of_dominance",
    sector: "digital_economy",
    parties: JSON.stringify(["Google LLC", "Google Ireland Limited"]),
    summary: "KKV osallistui Euroopan kilpailuviranomaisverkoston (ECN) yhteistyohon Googlen digitaalisten mainosalustojen tutkinnassa. Suomalaiset digitaaliset mediayhtion olivat kohteena Googlen alustakytkykaytannoissa.",
    full_text: "KKV osallistui ECN:n koordinoimaan tutkintaan, jossa useat eurooppalaiset kilpailuviranomaiset tutkivat Googlen menettelya digitaalisessa mainonnassa. Tutkinta koski Googlen DV360, Google Ads ja Ad Manager -alustojen integraatiota ja Googlen omien palveluiden suosimista.\n\nKKV arvioi tapauksen vaikutuksia suomalaisille digitaalisille mediataloille ja mainostajille. Google on hallitsevassa asemassa online-haun, verkkomainonnan ja videoalustojen markkinoilla Suomessa.\n\nEU:n komission samanaikaisesti kaydyt menettelyt huomioon ottaen KKV paatti koordinoida toimiaan EU:n komission tutkintaan ja odottaa komission paatosta ennen erillisen kansallisen menettelyn aloittamista.",
    outcome: "cleared",
    fine_amount: null,
    gwb_articles: JSON.stringify(["KilpailuL 7 §", "SEUT 102"]),
    status: "final",
  },
  {
    case_number: "KKV/321/14.00.00/2022",
    title: "Pankkialan korttimaksusopimukset — Hinnoittelun yhteistyoselvitys",
    date: "2022-03-20",
    type: "sector_inquiry",
    sector: "financial_services",
    parties: JSON.stringify(["OP Ryhmä", "Nordea Pankki Finland Oyj", "Danske Bank A/S Suomen sivuliike", "S-Pankki Oy"]),
    summary: "KKV selvitti pankkialan korttimaksujen hinnoittelua sektorikyselyna. Selvitys osoitti, etta suomalaiset korttipalkkiot ovat eurooppalaisessa vertailussa korkeahkoja. KKV suositteli toimenpiteita maksupalvelumarkkinoiden kilpailun tehostamiseksi.",
    full_text: "KKV suoritti sektorikyselan suomalaisilla maksupalvelumarkkinoilla. Selvityksessa tarkasteltiin korttimaksuihin liittyvia hintoja, ehtoja ja kilpailua korttipalvelumarkkinoilla. Selvitys ei koskenut yksittaisia kilpailunrajoituksia, vaan yleisia markkinaolosuhteita. KKV havaitsi, etta Suomessa maksetaan joissain tapauksissa Euroopan korkeimpia korttimaksuja. Kilpailun edistamiseksi KKV suositteli avoimempaa hintainformaatiota ja viranomaisten yhteistyon tiivistamista maksupalvelumarkkinoiden valvonnassa.",
    outcome: "cleared",
    fine_amount: null,
    gwb_articles: JSON.stringify(["KilpailuL 32 §"]),
    status: "final",
  },
  {
    case_number: "KKV/654/14.00.00/2021",
    title: "S-ryhman hankintakaytannot paivittaistavarakaupassa",
    date: "2021-09-30",
    type: "abuse_of_dominance",
    sector: "food_retail",
    parties: JSON.stringify(["SOK (Suomen Osuuskauppojen Keskuskunta)", "S-ryhma"]),
    summary: "KKV selvitti S-ryhman hankintakaytantoja paivittaistavarakaupassa. Tutkinta koski S-ryhman asemaa tavarantoimittajiin nahden ja eraita listattu kaytantoja. Asian ratkaiseminen sovinnollisesti: S-ryhma sitoutui muuttamaan tiettya hankintakaytantoja.",
    full_text: "KKV aloitti tutkinnan S-ryhman hankintakaytannoista paivittaistavarakaupassa. S-ryhma on Suomen suurin vahittaiskauppaketju n. 46% markkinaosuudella. KKV arvioi S-ryhman menettelya tavarantoimittajia kohtaan hankintaneuvotteluissa, alennusvaatimuksissa ja ketjulistauksissa. Sovinnollisessa ratkaisussa S-ryhma sitoutui selkiyttamaan hankintaehtojaan ja kehittamaan tavarantoimittajien valitusmenetelma.",
    outcome: "cleared_with_conditions",
    fine_amount: null,
    gwb_articles: JSON.stringify(["KilpailuL 7 §"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(d.case_number, d.title, d.date, d.type, d.sector, d.parties, d.summary, d.full_text, d.outcome, d.fine_amount, d.gwb_articles, d.status);
  }
});
insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

interface MergerRow {
  case_number: string;
  title: string;
  date: string;
  sector: string;
  acquiring_party: string;
  target: string;
  summary: string;
  full_text: string;
  outcome: string;
  turnover: number | null;
}

const mergers: MergerRow[] = [
  {
    case_number: "KKV/M.2022-001",
    title: "Telia Finland Oyj / DNA Oyj — Tietoliikennesektorin yrityskauppa",
    date: "2022-05-20",
    sector: "telecommunications",
    acquiring_party: "Telia Finland Oyj",
    target: "DNA Oyj",
    summary: "KKV tutki Telian suunniteltua DNA:n osakkeiden lisaostoa. Tapaus siirrettiin EU:n komission kaytantoihin perustuen komissiolle arvioitavaksi, koska yhtion yhteenlaskettu EU-liikevaihto ylitti FKVO:n kynnysarvot.",
    full_text: "KKV vastaanotti Telia Companyn ilmoituksen DNA Oyj:n osakkeiden lisaostosta. Koska osapuolten yhteenlaskettu EU-alueella saavutettu liikevaihto ylitti EU:n fuusiokontrolliaseksen (FKVO) kynnysarvot, asia siirrettiin EU:n komissiolle. KKV toimitti komissiolle nakemyksensa suomalaisille tietoliikennemarkkinoille kohdistuvista kilpailuvaikutuksista. Suomalaiset mobiilimarkkinat ovat oligopolistisia kolmella paatoimijalla (Telia/DNA, Elisa, Tele2). Yhdistyminen vahvistaisi Telian asemaa merkittavasti.",
    outcome: "cleared_with_conditions",
    turnover: 4_500_000_000,
  },
  {
    case_number: "KKV/M.2021-005",
    title: "Mehilainen Oy / Pihlajalinna Oyj — Yksityisten terveyspalveluiden fuusio",
    date: "2021-11-30",
    sector: "healthcare",
    acquiring_party: "Mehilainen Oy",
    target: "Pihlajalinna Oyj",
    summary: "KKV hyvaksyi Mehilaiselle Pihlajalinnan hankinnan ehdollisena. Osapuolten oli luovuttava joistakin klinikkayksikoise alueilla, joissa yhteenlasketut markkinaosuudet olisivat aiheuttaneet merkittavan kilpailuvaikutuksen.",
    full_text: "KKV arvioi Mehilaisen Pihlajalinnan hankinnan kilpailuvaikutuksia yksityisilla terveyspalvelumarkkinoilla. Mehilainen ja Pihlajalinna ovat Suomen kaksi suurinta yksityista terveydenhuollon tarjoajaa. Yhdistyminen olisi luonut Suomen ylivoimaisesti suurimman yksityisen terveydenhuoltoyhtion. KKV tunnisti kilpailuongelmia useilla alueellisilla markkinoilla: lahinnea paikkakunnat, joissa kummallakin on laakariasema. Ehtoina yritykselle asetettiin vaatimus luopua tietyista klinikkayksikosta kilpailluimmilla alueilla. KKV:n paatos edellytti vahintaan kolmen klinikan myymista kilpailevalle toimijalle.",
    outcome: "cleared_with_conditions",
    turnover: 1_800_000_000,
  },
  {
    case_number: "KKV/M.2023-003",
    title: "Helen Oy / Lahti Energia Oy — Kaukolammitystoimintojen yhdistaminen",
    date: "2023-02-15",
    sector: "energy",
    acquiring_party: "Helen Oy",
    target: "Lahti Energia Oy (kaukolammitosdivisioonan osittaisluovutus)",
    summary: "KKV hyvaksyi ensimmaisessa vaiheessa Helenin kaukolammitosdivisioonan oston Lahti Energialta. Kilpailuvaikutukset arvioitiin vahahaisiksi, koska kaukolammitomarkkinat ovat pitkalti alueellisia monopoleja eika osapuolten toimialueet juurikaan pahvikkain.",
    full_text: "KKV arvioi Helenin Lahti Energian kaukolammitosdivisioonan hankinnan. Helen Oy on Helsingin kaupungin omistama energiayhtio, joka tuottaa ja myy kaukolammitys- ja sahkopalveluita. Lahti Energia on vastaava alueellinen energiayhtio Paijat-Hameen alueella.\n\nKaukolammitomarkkinat ovat luonteeltaan alueellisia luonnollisia monopoleja — kiintean putkiverkoston kautta toimiva kaukolampo ei kilpaile eri alueilla suoraan. KKV totesi, etta Helsingin ja Lahden kaukolammitoverkot ovat maantieteellisesti erillisia eika yrityskauppa johda merkittavaan kilpailun heikkenemiseen milla tahansa relevantilla maantieteellisella markkinalla. Yrityskauppa hyvaksyttiin ensimmaisessa vaiheessa ilman ehtoja.",
    outcome: "cleared_phase1",
    turnover: 900_000_000,
  },
];

const insertMerger = db.prepare(`
  INSERT OR IGNORE INTO mergers
    (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMergersAll = db.transaction(() => {
  for (const m of mergers) {
    insertMerger.run(m.case_number, m.title, m.date, m.sector, m.acquiring_party, m.target, m.summary, m.full_text, m.outcome, m.turnover);
  }
});
insertMergersAll();
console.log(`Inserted ${mergers.length} mergers`);

const decisionCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
const mergerCount = (db.prepare("SELECT count(*) as cnt FROM mergers").get() as { cnt: number }).cnt;
const sectorCount = (db.prepare("SELECT count(*) as cnt FROM sectors").get() as { cnt: number }).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sectors:    ${sectorCount}`);
console.log(`  Decisions:  ${decisionCount}`);
console.log(`  Mergers:    ${mergerCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();

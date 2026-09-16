// Builds sweden-data.wgsl beside this file: the 2026 Riksdag election, one result per
// municipality, laid over Sweden's municipality boundaries as a lookup table the
// world program reads (sweden.wgsl), and results.json, the numbers the page's legend
// and detail card show. `deno task sweden` runs it from the repo root. The world and
// this script live with their page (docs/sweden-2026.html) rather than in src/ or the
// root, because they are a page's content that happens to be a world, and the page
// builds it through the packaged API the way any host would; nothing in the engine or
// the build reads them.
//
// Sources, both fetched into data/sweden/ (gitignored) and reused from there after:
// - Valmyndigheten's result files behind resultat.val.se, one JSON per municipality
//   (`RD_<valkrets>_<kommun>_P.json`, the preliminary count; `_S` is the final one and
//   404s until it is published). The geography file lists which municipality is in
//   which constituency, which the file name needs.
// - Municipality polygons from okfse/sweden-geojson (WGS 84, simplified with mapshaper).
//
// The map is rasterised on a CELL_KM grid in a sinusoidal projection about LON0, which
// keeps a kilometre a kilometre at every latitude Sweden spans, and stored as runs
// along each row: a municipality index and a length per word. The result itself is a
// marker per municipality, placed on its own cell nearest its centre, listed in row
// order with an index by 16 km band so a sample tests only the markers near it, with
// every party's share there in a stack, biggest first, for the bubbles the world piles
// over the marker. A word
// table is what a world program can hold, because the world contract is WGSL and
// nothing else (design-formats.md "World program"); the size is the constraint, since
// Tint compiles a 5,000-word `const` array in about 2 s and a 22,000-word one in 35
// (measured in Chrome 152). Runs at 4 km come to about 4,800 words and the markers to
// 400. The shader indexes the tables at run time, which reads as fast as a storage
// buffer once compiled.
//
// The generated file is committed, so the world works from a checkout without running
// this; run it again when the final count is published and the header will say so.

// What is fetched goes to the repo's gitignored data/; what is generated sits beside
// this file, where the page fetches it.
const DATA = new URL("../../data/sweden/", import.meta.url);
const OUT = new URL("./sweden-data.wgsl", import.meta.url);
const SUMMARY = new URL("./results.json", import.meta.url);
const ELECTION = "val2026";
const RESULTS = `https://resultat.val.se/data/resultat/${ELECTION}/`;
const GEOGRAPHY = `https://resultat.val.se/data/valgeografi/valgeografi_${ELECTION}.json`;
const GEOJSON = "https://raw.githubusercontent.com/okfse/sweden-geojson/master/swedish_municipalities.geojson";

// The grid. One voxel is one kilometre in the world; a cell is CELL_KM voxels square.
// X0/Z0 are the grid's north-west corner in world voxels, chosen so the country sits
// about the origin: north is -Z, east is +X.
const CELL_KM = 4;
const LAT0 = 69.1; // the north edge, degrees
const LON0 = 17.5; // the central meridian, where x = 0
const KM_PER_DEG = 111.32;
// Bohuslän's coast is 376 km west of the meridian at its latitude and Skåne's tip
// 1,533 km south of the north edge, so both have a little room.
const X0 = -380;
const Z0 = -800;
const WIDTH_KM = 760;
const LENGTH_KM = 1540;
const COLS = WIDTH_KM / CELL_KM;
const ROWS = LENGTH_KM / CELL_KM;
const RUN_MAX = 255; // a run's length field is 8 bits
const BAND_ROWS = 4; // marker index bands, 16 km
// Parties a stack holds: every party in PARTIES, biggest share first. Two entries to
// a word, each a party in 3 bits and its share in tenths of a percent in the 10 above.
const STACK_WORDS = 4;

// Party order, which is the index the muni word carries and the order the world's
// `party_block()` switches on. Everything else in the results is folded into "other".
const PARTIES = ["S", "M", "SD", "V", "C", "KD", "L", "MP"] as const;

// Four municipalities are constituencies of their own, so their results are the
// constituency's file and the geography lists districts under them, not municipalities.
// County names by code, for the page's detail card; the boundaries carry only the code.
const COUNTIES: Readonly<Record<number, string>> = {
  1: "Stockholms län", 3: "Uppsala län", 4: "Södermanlands län", 5: "Östergötlands län",
  6: "Jönköpings län", 7: "Kronobergs län", 8: "Kalmar län", 9: "Gotlands län",
  10: "Blekinge län", 12: "Skåne län", 13: "Hallands län", 14: "Västra Götalands län",
  17: "Värmlands län", 18: "Örebro län", 19: "Västmanlands län", 20: "Dalarnas län",
  21: "Gävleborgs län", 22: "Västernorrlands län", 23: "Jämtlands län",
  24: "Västerbottens län", 25: "Norrbottens län",
};

const OWN_CONSTITUENCY: Readonly<Record<string, string>> = {
  "Stockholms kommun": "0180",
  "Göteborgs kommun": "1480",
  "Malmö kommun": "1280",
  "Gotlands län": "0980",
};

interface Node {
  typ: string;
  namn: string;
  kod: string;
  valgeografi: Node[] | null;
}

interface PartyVotes {
  partiforkortning: string | null;
  antalRoster: number;
  andelRoster: number;
}

interface Result {
  namn: string;
  antalValdistriktRaknade: number;
  antalValdistriktSomSkaRaknas: number;
  valdeltagande: string; // "81,1 %"
  senasteUppdateringstid: string;
  rosterPaverkaMandat: { antalRoster: number; partiroster: PartyVotes[] };
}

interface Municipality {
  code: string;
  name: string;
  county: number; // the county code, 1..25
  winner: number; // index into PARTIES
  share10: number; // the winner's share in tenths of a percent
  shares10: number[]; // every party's, in PARTIES order
  turnout10: number;
  votes: number;
  counted: number;
  toCount: number;
}

type Ring = [number, number][];
interface Feature {
  properties: { id: string; kom_namn: string; lan_code: string; geo_point_2d: [number, number] }; // [lat, lon]
  geometry: { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };
}

async function cached(name: string, url: string): Promise<string> {
  const file = new URL(name, DATA);
  try {
    return await Deno.readTextFile(file);
  } catch {
    // not there yet
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  await Deno.mkdir(new URL(name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "./", DATA), { recursive: true });
  await Deno.writeTextFile(file, text);
  return text;
}

// (constituency code, municipality code) for every municipality, from the geography.
function municipalities(root: Node): [string, string][] {
  const rd = root.valgeografi!.find((n) => n.kod === "RD")!;
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const vk of rd.valgeografi ?? []) {
    const own = OWN_CONSTITUENCY[vk.namn];
    if (own !== undefined) {
      out.push([vk.kod, own]);
      seen.add(own);
      continue;
    }
    for (const k of vk.valgeografi ?? []) {
      if (k.typ !== "KOMMUN" || seen.has(k.kod)) continue;
      seen.add(k.kod);
      out.push([vk.kod, k.kod]);
    }
  }
  return out;
}

function tenths(text: string): number {
  return Math.round(parseFloat(text.replace(",", ".")) * 10);
}

function parseResult(code: string, r: Result): Municipality {
  const rows = r.rosterPaverkaMandat.partiroster;
  let winner = -1;
  let best = -1;
  for (const p of rows) {
    const i = PARTIES.indexOf(p.partiforkortning as typeof PARTIES[number]);
    if (i >= 0 && p.antalRoster > best) {
      best = p.antalRoster;
      winner = i;
    }
  }
  if (winner < 0) throw new Error(`${code}: no party in the result`);
  const shares10 = PARTIES.map((name) => Math.round((rows.find((p) => p.partiforkortning === name)?.andelRoster ?? 0) * 10));
  return {
    code,
    name: r.namn,
    county: 0, // filled in from the geometry
    winner,
    share10: shares10[winner],
    shares10,
    turnout10: tenths(r.valdeltagande),
    votes: r.rosterPaverkaMandat.antalRoster,
    counted: r.antalValdistriktRaknade,
    toCount: r.antalValdistriktSomSkaRaknas,
  };
}

// --- the raster --------------------------------------------------------------------

function rings(f: Feature): Ring[][] {
  return f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
}

// Even-odd point in polygon over every ring of one polygon (holes included).
function inside(lon: number, lat: number, polygon: Ring[]): boolean {
  let inn = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[j];
      if ((y1 > lat) !== (y2 > lat) && lon < x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1)) inn = !inn;
    }
  }
  return inn;
}

// The cell grid: 0 for sea, else 1 + the municipality's index in `order`.
function rasterise(features: Feature[], order: Map<string, number>): Uint16Array {
  const grid = new Uint16Array(COLS * ROWS);
  const boxes = features.map((f) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const polygon of rings(f)) {
      for (const ring of polygon) {
        for (const [x, y] of ring) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return [x0, y0, x1, y1];
  });
  for (let r = 0; r < ROWS; r++) {
    const z = Z0 + (r + 0.5) * CELL_KM;
    const lat = LAT0 - (z - Z0) / KM_PER_DEG;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    for (let c = 0; c < COLS; c++) {
      const x = X0 + (c + 0.5) * CELL_KM;
      const lon = LON0 + x / (KM_PER_DEG * cosLat);
      for (let i = 0; i < features.length; i++) {
        const b = boxes[i];
        if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
        if (rings(features[i]).some((polygon) => inside(lon, lat, polygon))) {
          const index = order.get(features[i].properties.id);
          if (index === undefined) throw new Error(`no result for ${features[i].properties.kom_namn}`);
          grid[r * COLS + c] = index + 1;
          break;
        }
      }
    }
  }
  // A municipality smaller than a cell (Sundbyberg is 9 km²) can miss every cell
  // centre; give it the cell its own centre point is in, over whoever holds it.
  const claimed = new Set(grid);
  for (const f of features) {
    const index = order.get(f.properties.id)!;
    if (claimed.has(index + 1)) continue;
    const [lat, lon] = f.properties.geo_point_2d;
    const z = Z0 + (LAT0 - lat) * KM_PER_DEG;
    const x = (lon - LON0) * KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
    const c = Math.floor((x - X0) / CELL_KM);
    const r = Math.floor((z - Z0) / CELL_KM);
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) throw new Error(`${f.properties.kom_namn} is off the grid`);
    grid[r * COLS + c] = index + 1;
  }
  return grid;
}

// Grid cell of a point, or null off the grid.
function cellOf(lat: number, lon: number): [number, number] | null {
  const z = Z0 + (LAT0 - lat) * KM_PER_DEG;
  const x = (lon - LON0) * KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const c = Math.floor((x - X0) / CELL_KM);
  const r = Math.floor((z - Z0) / CELL_KM);
  return c < 0 || r < 0 || c >= COLS || r >= ROWS ? null : [c, r];
}

// One marker per municipality: the municipality's own cell nearest its centre point,
// which keeps an archipelago's marker on land and a crescent's inside it.
interface Marker {
  muni: number;
  col: number;
  row: number;
}

function placeMarkers(features: Feature[], order: Map<string, number>, munis: Municipality[], grid: Uint16Array): Marker[] {
  const markers: Marker[] = [];
  for (const f of features) {
    const index = order.get(f.properties.id)!;
    const [lat, lon] = f.properties.geo_point_2d;
    const centre = cellOf(lat, lon);
    if (centre === null) throw new Error(`${f.properties.kom_namn}'s centre is off the grid`);
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (grid[r * COLS + c] !== index + 1) continue;
        const d = (c - centre[0]) ** 2 + (r - centre[1]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = [c, r];
        }
      }
    }
    if (best === null) throw new Error(`${f.properties.kom_namn} has no cell`);
    markers.push({ muni: index, col: best[0], row: best[1] });
  }
  markers.sort((a, b) => a.row - b.row || a.col - b.col);
  return markers;
}

// Runs along each row: value | length << 9, lengths capped at RUN_MAX.
function runLength(grid: Uint16Array): { runs: number[]; rowStart: number[] } {
  const runs: number[] = [];
  const rowStart: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    rowStart.push(runs.length);
    let c = 0;
    while (c < COLS) {
      const v = grid[r * COLS + c];
      let n = 1;
      while (c + n < COLS && grid[r * COLS + c + n] === v && n < RUN_MAX) n++;
      runs.push(v | (n << 9));
      c += n;
    }
  }
  rowStart.push(runs.length);
  return { runs, rowStart };
}

function wgslArray(name: string, words: number[]): string {
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 16) {
    lines.push("  " + words.slice(i, i + 16).map((w) => `${w}u`).join(", ") + ",");
  }
  return `const ${name} = array<u32, ${words.length}>(\n${lines.join("\n")}\n);`;
}

async function main(): Promise<void> {
  await Deno.mkdir(DATA, { recursive: true });
  const geography = JSON.parse(await cached("valgeografi.json", GEOGRAPHY)) as Node;
  const national = JSON.parse(await cached("kommun/RD_P.json", RESULTS + "RD_P.json")) as Result;
  const geojson = JSON.parse(await cached("kommuner.geojson", GEOJSON)) as { features: Feature[] };
  const pairs = municipalities(geography);
  const munis: Municipality[] = [];
  for (const [vk, code] of pairs) {
    const own = Object.values(OWN_CONSTITUENCY).includes(code);
    const name = own ? `RD_${vk}_P.json` : `RD_${vk}_${code}_P.json`;
    munis.push(parseResult(code, JSON.parse(await cached(`kommun/${name}`, RESULTS + name)) as Result));
  }
  munis.sort((a, b) => a.code.localeCompare(b.code));
  const order = new Map(munis.map((m, i) => [m.code, i]));
  const missing = geojson.features.filter((f) => !order.has(f.properties.id)).map((f) => f.properties.kom_namn);
  if (missing.length > 0) throw new Error(`geometry without a result: ${missing.join(", ")}`);
  for (const f of geojson.features) munis[order.get(f.properties.id)!].county = parseInt(f.properties.lan_code, 10);
  const grid = rasterise(geojson.features, order);
  const { runs, rowStart } = runLength(grid);
  const words = munis.map((m) => m.winner | (m.share10 << 4) | (m.turnout10 << 14) | (m.county << 24));
  const markers = placeMarkers(geojson.features, order, munis, grid);
  const markerWords = markers.map((m) => (m.muni | (m.col << 9) | (m.row << 17)) >>> 0);
  const votes = munis.map((m) => m.votes);
  const stack: number[] = [];
  for (const m of munis) {
    const entries = [...m.shares10.keys()].sort((a, b) => m.shares10[b] - m.shares10[a]).map((party) => party | (m.shares10[party] << 3));
    for (let k = 0; k < STACK_WORDS; k++) stack.push((entries[2 * k] | (entries[2 * k + 1] << 16)) >>> 0);
  }
  const bands = Math.ceil(ROWS / BAND_ROWS);
  const bandStart: number[] = [];
  for (let b = 0; b <= bands; b++) {
    let i = 0;
    while (i < markers.length && Math.floor(markers[i].row / BAND_ROWS) < b) i++;
    bandStart.push(i);
  }
  const counted = munis.reduce((n, m) => n + m.counted, 0);
  const toCount = munis.reduce((n, m) => n + m.toCount, 0);
  const wins = PARTIES.map((p, i) => `${p} ${munis.filter((m) => m.winner === i).length}`).filter((s) => !s.endsWith(" 0"));
  const updated = national.senasteUppdateringstid;
  const today = new Date().toISOString().slice(0, 10);
  const header = `// Generated by \`deno task sweden\` (docs/sweden/sweden-election.ts) on ${today}. Do not edit.
//
// Riksdag election of 13 September 2026, the preliminary count as Valmyndigheten
// published it at resultat.val.se (last updated ${updated}; ${counted} of ${toCount}
// districts counted, the rest being the postal and late votes the municipalities count
// in the days after). One entry per municipality: the party with most votes and its
// share. Municipalities won: ${wins.join(", ")}.
//
// Boundaries: okfse/sweden-geojson, rasterised on a ${CELL_KM} km grid in a sinusoidal
// projection about ${LON0} E, north edge ${LAT0} N. One voxel is one kilometre.
//
// Layout (read by sweden.wgsl, checked by src/worlds/sweden_test.ts):
//   SWEDEN_ROW_START[row] .. SWEDEN_ROW_START[row + 1]: that row's runs, west to east
//   SWEDEN_RUNS[i]: municipality index + 1 in bits 0..8 (0 is sea), run length << 9
//   SWEDEN_MUNI[index]: party (PARTIES order in sweden-election.ts) in bits 0..3,
//     the winner's share in tenths of a percent << 4, turnout in tenths << 14,
//     county code << 24
//   SWEDEN_VOTES[index]: votes cast for the parties, the number a bubble's area follows
//   SWEDEN_STACK[index * ${STACK_WORDS} + k]: the parties there in order of share, biggest first,
//     two to a word: party in 3 bits, its share in tenths of a percent << 3, the second
//     entry << 16
//   SWEDEN_MARKERS[i]: one per municipality, in row order: municipality index in bits
//     0..8, the marker's cell column << 9 and row << 17
//   SWEDEN_BAND_START[b] .. [b + 1]: the markers whose row is in band b, ${BAND_ROWS} rows
//     (${BAND_ROWS * CELL_KM} km) to a band
`;
  const table = munis.map((m, i) =>
    `// ${i} ${m.code} ${m.name}: ${PARTIES[m.winner]} ${(m.share10 / 10).toFixed(1)}%, turnout ${(m.turnout10 / 10).toFixed(1)}%`
  ).join("\n");
  const code = `${header}
const SWEDEN_CELL: f32 = ${CELL_KM}.0;
const SWEDEN_COLS: i32 = ${COLS};
const SWEDEN_ROWS: i32 = ${ROWS};
const SWEDEN_X0: f32 = ${X0}.0;
const SWEDEN_Z0: f32 = ${Z0}.0;
const SWEDEN_MUNIS: u32 = ${munis.length}u;
const SWEDEN_PARTIES: u32 = ${PARTIES.length}u;

${wgslArray("SWEDEN_ROW_START", rowStart)}

${wgslArray("SWEDEN_RUNS", runs)}

${table}
${wgslArray("SWEDEN_MUNI", words)}

${wgslArray("SWEDEN_VOTES", votes)}

const SWEDEN_STACK_WORDS: u32 = ${STACK_WORDS}u;
${wgslArray("SWEDEN_STACK", stack)}

const SWEDEN_BAND_ROWS: i32 = ${BAND_ROWS};
const SWEDEN_BANDS: i32 = ${bands};
${wgslArray("SWEDEN_MARKERS", markerWords)}

${wgslArray("SWEDEN_BAND_START", bandStart)}

// The municipality under a grid cell: 0 for sea, else index + 1. A walk along the row's
// runs, which is a dozen steps at most.
fn sweden_muni_at(col: i32, row: i32) -> u32 {
  if (col < 0 || row < 0 || col >= SWEDEN_COLS || row >= SWEDEN_ROWS) {
    return 0u;
  }
  let end = SWEDEN_ROW_START[row + 1];
  var x = 0;
  for (var i = SWEDEN_ROW_START[row]; i < end; i++) {
    let w = SWEDEN_RUNS[i];
    x += i32(w >> 9u);
    if (col < x) {
      return w & 0x1ffu;
    }
  }
  return 0u;
}
`;
  await Deno.writeTextFile(OUT, code);
  // The legend's numbers: the whole country's shares and how many municipalities each
  // party took, from the same count.
  const summary = {
    election: "Riksdagsvalet 13 september 2026",
    count: "preliminär",
    updated,
    districtsCounted: national.antalValdistriktRaknade,
    districtsToCount: national.antalValdistriktSomSkaRaknas,
    turnout: national.valdeltagande.trim(),
    source: "https://resultat.val.se/val2026/RD?r=P",
    fetched: today,
    parties: PARTIES.map((code, i) => {
      const row = national.rosterPaverkaMandat.partiroster.find((p) => p.partiforkortning === code);
      return { code, share: row?.andelRoster ?? 0, votes: row?.antalRoster ?? 0, won: munis.filter((m) => m.winner === i).length };
    }),
    // One entry per municipality for the detail card a click opens, with the marker cell
    // the stack stands on so the page can tell which stack was clicked.
    municipalities: munis.map((m, i) => {
      const marker = markers.find((k) => k.muni === i)!;
      return {
        code: m.code,
        name: m.name,
        county: COUNTIES[m.county] ?? `län ${m.county}`,
        votes: m.votes,
        turnout: m.turnout10 / 10,
        counted: m.counted,
        toCount: m.toCount,
        marker: [marker.col, marker.row],
        shares: Object.fromEntries(PARTIES.map((code, p) => [code, m.shares10[p] / 10])),
      };
    }),
  };
  await Deno.writeTextFile(SUMMARY, JSON.stringify(summary, null, 2) + "\n");
  const land = grid.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
  console.log(`${munis.length} municipalities, ${runs.length} runs over ${ROWS} rows, ${land} land cells, ${markers.length} markers in ${bands} bands; wrote ${OUT.pathname}`);
  console.log(`won: ${wins.join(", ")}; ${counted} of ${toCount} districts counted`);
}

if (import.meta.main) await main();

/** Sanity check for the shade graph + routing. Run: npx tsx scripts/verify.ts */
import * as fs from "fs";
import * as path from "path";

import {
  boundedPreferenceRoute,
  buildGraph,
  GraphData,
  nearestNode,
  shortestRoute,
  seasonDate,
} from "../src/graph";
import { meltPct } from "../src/melt";

const dataPath = path.join(__dirname, "..", "assets", "singapore.json");
const graphData: GraphData = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const g = buildGraph(graphData);
const { bbox, hours, dates } = graphData.meta;

console.log(`graph: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);
console.log(`bbox: ${bbox.map((x) => x.toFixed(4)).join(", ")}`);

// exposure distribution at noon for each date
for (const d of dates) {
  const noonIdx = hours.indexOf(12);
  const vals = graphData.edges.map((e) => e.exp[d]?.[noonIdx] ?? -1).filter((v) => v >= 0);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const shaded = vals.filter((v) => v < 30).length;
  console.log(
    `${d} 12:00 — mean exposure ${mean.toFixed(0)}%, ${((100 * shaded) / vals.length).toFixed(0)}% of edges mostly shaded (n=${vals.length})`,
  );
}

// route across the tile: pick two far-apart nodes via bbox corners
const a = nearestNode(g, bbox[1] + (bbox[3] - bbox[1]) * 0.15, bbox[0] + (bbox[2] - bbox[0]) * 0.15);
const b = nearestNode(g, bbox[1] + (bbox[3] - bbox[1]) * 0.85, bbox[0] + (bbox[2] - bbox[0]) * 0.85);
const date = seasonDate(dates, new Date());
const hourIdx = hours.indexOf(13);

const fastest = shortestRoute(g, a.node, b.node, date, hourIdx, 0);
if (!fastest) {
  throw new Error("ROUTE FAILED — graph may be disconnected");
}
const sunny = boundedPreferenceRoute(g, a.node, b.node, date, hourIdx, -1, fastest);
const shady = boundedPreferenceRoute(g, a.node, b.node, date, hourIdx, 1, fastest);

console.log(`\nroute test (${date} 13:00):`);
console.log(
  `  fastest: ${fastest.distM.toFixed(0)} m, ${fastest.walkMin.toFixed(1)} min, ` +
    `${fastest.sunMin.toFixed(1)} sun-min, unknown ${fastest.unknownMin.toFixed(1)} min, ` +
    `melt ${meltPct(fastest.sunMin)}%`,
);
console.log(
  `  sunny:   ${sunny.distM.toFixed(0)} m, ${sunny.walkMin.toFixed(1)} min, ` +
    `${sunny.sunMin.toFixed(1)} sun-min, unknown ${sunny.unknownMin.toFixed(1)} min`,
);
console.log(
  `  shady:   ${shady.distM.toFixed(0)} m, ${shady.walkMin.toFixed(1)} min, ` +
    `${shady.sunMin.toFixed(1)} sun-min, unknown ${shady.unknownMin.toFixed(1)} min`,
);

const ok =
  sunny.sunMin >= fastest.sunMin - 1e-9 &&
  sunny.distM >= fastest.distM - 1e-9 &&
  shady.sunMin <= fastest.sunMin + 1e-9 &&
  shady.distM >= fastest.distM - 1e-9 &&
  sunny.unknownMin <= fastest.unknownMin + 1e-9 &&
  shady.unknownMin <= fastest.unknownMin + 1e-9 &&
  fastest.segments.length > 0;
console.log(ok ? "\nOK: both light preferences move in the expected direction" : "\nWARN: unexpected route relation");
process.exit(ok ? 0 : 1);

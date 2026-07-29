/** Unit test for shade-weighted Dijkstra on a synthetic graph. Run: npx tsx scripts/test-routing.ts */
import {
  boundedPreferenceRoute,
  buildGraph,
  GraphData,
  shortestRoute,
  nearestNode,
  preferenceEdgeCost,
  seasonDate,
  supportsSunPreference,
} from "../src/graph";
import { meltPct, savingsCopy } from "../src/melt";

// Square: A(0)--B(1) direct sunny 100m; A--C(2)--B shaded detour 140m
//   A=(0,0) B=(0.001,0) C=(0.0005,0.0005)
const data: GraphData = {
  meta: {
    city: "test",
    bbox: [0, 0, 0.001, 0.001],
    hours: [8, 9, 10],
    dates: ["06-21"],
    tz_offset_hours: 8,
    sun: { "06-21": [[8, 90, 30], [9, 90, 45], [10, 90, 60]] },
  },
  nodes: [
    [0, 0],
    [0.001, 0],
    [0.0005, 0.0005],
  ],
  edges: [
    { u: 0, v: 1, len: 100, pts: [[0, 0], [0.001, 0]], exp: { "06-21": [100, 100, 100] } },
    { u: 0, v: 2, len: 70, pts: [[0, 0], [0.0005, 0.0005]], exp: { "06-21": [5, 5, 5] } },
    { u: 2, v: 1, len: 70, pts: [[0.0005, 0.0005], [0.001, 0]], exp: { "06-21": [5, 5, 5] } },
  ],
};

const g = buildGraph(data);

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok: ${msg}`);
};

// fastest ignores sun -> direct edge
const fastest = shortestRoute(g, 0, 1, "06-21", 0, 0)!;
assert(fastest.distM === 100, `fastest takes direct edge (${fastest.distM} m)`);
assert(Math.abs(fastest.sunMin - (100 / 1.4 / 60) * 1.0) < 1e-9, "fastest sunMin = full exposure");

// Most shade: direct cost 100*(1+15)=1600, detour 140*(1+0.75)=245 -> detour
const shady = shortestRoute(g, 0, 1, "06-21", 0, 1)!;
assert(shady.distM === 140, `shady takes shaded detour (${shady.distM} m)`);
assert(shady.sunMin < fastest.sunMin, "shady has fewer sun-minutes");
assert(shady.nodePath.join(",") === "0,2,1", `path via C (${shady.nodePath})`);

// Mild shade (+0.1) keeps the shorter direct route.
const mild = shortestRoute(g, 0, 1, "06-21", 0, 0.1)!;
assert(mild.distM === 100, "mild aversion keeps direct route");

// Mirror the exposure: the direct route is shaded and the longer detour is sunny.
const sunnyData: GraphData = {
  ...data,
  edges: data.edges.map((edge, index) => ({
    ...edge,
    exp: { "06-21": index === 0 ? [5, 5, 5] : [100, 100, 100] },
  })),
};
const sunnyGraph = buildGraph(sunnyData);
const sunnyFastest = shortestRoute(sunnyGraph, 0, 1, "06-21", 0, 0)!;
const sunnier = shortestRoute(sunnyGraph, 0, 1, "06-21", 0, -1)!;
assert(sunnyFastest.distM === 100, "neutral preference keeps the shortest shaded route");
assert(sunnier.distM === 140, "most sun takes the sunnier detour");
assert(sunnier.sunMin > sunnyFastest.sunMin, "sun preference adds modeled sun");

const longDetourData: GraphData = {
  ...data,
  edges: data.edges.map((edge, index) => ({
    ...edge,
    len: index === 0 ? 100 : 150,
  })),
};
const longDetourGraph = buildGraph(longDetourData);
const longDetourFastest = shortestRoute(longDetourGraph, 0, 1, "06-21", 0, 0)!;
const boundedShade = boundedPreferenceRoute(
  longDetourGraph,
  0,
  1,
  "06-21",
  0,
  1,
  longDetourFastest,
);
assert(boundedShade.distM === 100, "extreme preference rejects a 3x walking detour");
assert(
  boundedPreferenceRoute(g, 0, 1, "06-21", 0, 1, fastest).distM === 140,
  "extreme preference keeps a useful detour inside the walking budget",
);

for (const preference of [-1, -0.5, 0, 0.5, 1]) {
  for (const exposure of [0, 0.5, 1]) {
    const cost = preferenceEdgeCost(100, exposure, preference);
    assert(Number.isFinite(cost) && cost >= 100, `edge cost stays non-negative at p=${preference}, e=${exposure}`);
    const mirror = preferenceEdgeCost(100, 1 - exposure, -preference);
    assert(Math.abs(cost - mirror) < 1e-9, `edge cost is symmetric at p=${preference}, e=${exposure}`);
  }
}
assert(preferenceEdgeCost(100, 1, -1, false) > 100, "sun preference avoids unknown exposure");
assert(preferenceEdgeCost(100, 1, 1, false) > 100, "shade preference avoids unknown exposure");

const legacyUnknownData: GraphData = {
  ...data,
  meta: {
    ...data.meta,
    graph: { unknown_edge_sample_count: 1, unknown_exposure_fallback_pct: 100 },
  },
};
assert(!supportsSunPreference(legacyUnknownData), "legacy unknown fallback locks sun preference");
assert(
  supportsSunPreference({
    ...legacyUnknownData,
    meta: {
      ...legacyUnknownData.meta,
      graph: { unknown_edge_sample_count: 1, unknown_exposure_sentinel: -1 },
    },
  }),
  "explicit unknown sentinel unlocks sun preference",
);
assert(supportsSunPreference(data), "a graph without unknown samples supports sun preference");

// segment orientation: first segment starts at node 0's coords
assert(
  shady.segments[0].coords[0][0] === 0 && shady.segments[0].coords[0][1] === 0,
  "segments oriented along travel direction",
);

// nearest node
assert(nearestNode(g, 0.00051, 0.00049).node === 2, "nearestNode finds C");

// season picker
assert(seasonDate(["03-21", "06-21", "12-21"], new Date("2026-07-07")) === "06-21", "July -> June solstice");
assert(seasonDate(["03-21", "06-21", "12-21"], new Date("2026-01-15")) === "12-21", "January -> Dec solstice");
assert(seasonDate(["03-21", "06-21", "12-21"], new Date("2026-09-21")) === "03-21", "September equinox -> equinox model");

// melt sanity
assert(meltPct(0) === 0 && meltPct(1000) === 100, "melt bounds");
console.log(`melt(5)=${meltPct(5)}% melt(15)=${meltPct(15)}% melt(30)=${meltPct(30)}%`);
console.log("copy:", savingsCopy(2.4, 9.1));

console.log("\nALL ROUTING TESTS PASSED");

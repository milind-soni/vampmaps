/** Unit test for shade-weighted Dijkstra on a synthetic graph. Run: npx tsx scripts/test-routing.ts */
import { buildGraph, GraphData, shortestRoute, nearestNode, seasonDate } from "../src/graph";
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

// shady with weight 4: direct cost 100*(1+4)=500, detour 140*(1+0.2)=168 -> detour
const shady = shortestRoute(g, 0, 1, "06-21", 0, 4)!;
assert(shady.distM === 140, `shady takes shaded detour (${shady.distM} m)`);
assert(shady.sunMin < fastest.sunMin, "shady has fewer sun-minutes");
assert(shady.nodePath.join(",") === "0,2,1", `path via C (${shady.nodePath})`);

// weight 0.1: direct 100*1.1=110 < detour 140*1.005 -> stays direct
const mild = shortestRoute(g, 0, 1, "06-21", 0, 0.1)!;
assert(mild.distM === 100, "mild aversion keeps direct route");

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

// melt sanity
assert(meltPct(0) === 0 && meltPct(1000) === 100, "melt bounds");
console.log(`melt(5)=${meltPct(5)}% melt(15)=${meltPct(15)}% melt(30)=${meltPct(30)}%`);
console.log("copy:", savingsCopy(2.4, 9.1));

console.log("\nALL ROUTING TESTS PASSED");

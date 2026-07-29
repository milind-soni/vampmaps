# Accuracy, uncertainty, and validation

## Current status

ShadeMax is an **experimental clear-sky screening model**, not a field-validated
measurement system. It can compare two modeled walking routes, but there is not
yet an evidence-based end-to-end “route accuracy” percentage. The app should not
promise guaranteed shade, exact time in sunlight, thermal comfort, or heat
safety.

## What the model actually estimates

The precompute pipeline currently:

1. Builds an OpenStreetMap walking graph and a VoxCity model from OSM buildings
   and land cover, a flat terrain model, and—when `--meta-canopy` is enabled—the
   Meta/WRI canopy-height map.
2. Voxelizes the scene at a default 2 m resolution. The requested pedestrian
   height is 1.5 m; at this resolution VoxCity can represent it only as one
   vertical voxel, so the ray origin is 2.0 m. Both values and the quantization
   rule are written to output metadata.
3. Computes solar azimuth and elevation with Astral through VoxCity, converting
   local civil time with the city’s IANA timezone. It samples 08:00–19:00 at
   whole hours on March 21, June 21, and December 21. The app chooses the stored
   date with the closest solar declination and uses one stored hourly sample; it
   does not interpolate to the exact date or minute.
4. Ray-traces **direct-beam transmittance**, including partial attenuation
   through tree voxels. It does not model diffuse sky radiation, reflections,
   clouds, weather, or temporary obstacles. Samples at or below the horizon, and
   samples with solar elevation between 0° and the 4° cutoff, are assigned zero
   direct exposure. OSM-tagged tunnels, covered ways, and building passages are
   also assigned zero direct exposure.
5. Aggregates the raster result onto OSM centerline edges. An edge sample that
   cannot be mapped is exported with an explicit `-1` sentinel; each artifact
   reports the number and fraction of these unknowns in `meta.graph`. Routing
   treats unknowns as undesirable for either sun or shade preference, while
   displayed sun totals conservatively count them as exposed.
6. Routes use a signed preference from `-1` (Most sun) through `0` (fastest) to
   `+1` (Most shade). A sun preference adds a non-negative penalty for
   `1 - transmittance`; a shade preference adds one for `transmittance`.
   The app reduces preference strength when needed to keep the result within
   50% and 1.2 km of the fastest path (using the smaller distance budget).
   Reported “sun minutes” are **direct-sun-equivalent minutes**: walking time on
   each edge multiplied by modeled transmittance, using a fixed 1.4 m/s walking
   speed. They are not literal stopwatch minutes spent in a binary sun/shade
   state.

## What has been verified locally

The current automated checks pass:

- `./.venv/bin/python -m unittest discover -s tests -v` runs the Python suite
  covering observer-height quantization, enclosed OSM tags,
  below-horizon versus low-angle states, conservative unknown-data handling,
  quality metadata, IANA timezones, DST, fractional offsets, southern-hemisphere
  seasons, and UTC date rollover.
- `cd app && npx tsx scripts/test-routing.ts` verifies symmetric sun/shade
  routing, non-negative edge costs, unknown-data avoidance, route geometry
  orientation, nearest-node selection, and the representative seasonal-date
  choice on a synthetic graph.

These checks establish implementation behavior, not physical accuracy. As one
coverage example, the current Singapore precompute artifact records 2,574 of
128,376 edge-time samples (2.005%) as unmapped and preserves them explicitly.
That is a coverage statistic—not 97.995% accuracy.

The pipeline’s solar samples have now been independently cross-checked with
`pipeline/validate_solar.py` against pvlib’s implementation of [NREL’s Solar
Position Algorithm](https://midcdmz.nrel.gov/spa/). Across the 251 samples at
or above ShadeMax’s 4° modeling cutoff in all eight city presets, Astral differed
from SPA by a mean/maximum of 0.0039°/0.0581° in azimuth and
0.0025°/0.0048° in apparent elevation. The comparison uses standard atmosphere
inputs and passes declared limits of 0.1° azimuth and 0.02° elevation. This
validates only sampled sun direction—not shadows, exposure, or routes. NREL
reports ±0.0003° uncertainty for *its algorithm*; ShadeMax does not inherit that
figure.

The [Meta canopy-height study](https://doi.org/10.1016/j.rse.2023.113888)
reports average held-out lidar MAE of 2.8 m and mean error of 0.6 m for its canopy
product. Those are canopy-height errors over the evaluated study data, not
street-shadow error, not a guarantee for every city, and not route accuracy.
The delivered canopy layer is documented in the [WRI Data Explorer](https://datasets.wri.org/datasets/meta-tree-canopy-height).

## Why there is no honest accuracy percentage yet

“Accuracy” requires a defined outcome and paired ground truth. This product has
several different outcomes: sun/shade state at a point, direct-beam
transmittance, equivalent sun minutes over a route, and whether the recommended
route is actually shadier than the fastest route. A component benchmark cannot
be converted into one end-to-end percentage, and the errors are correlated.

The [VoxCity paper](https://arxiv.org/abs/2504.13934) demonstrates open-data 3D
model generation, ray-traced solar simulations, and aggregation onto OSM road
networks. It does not establish a field-validated accuracy percentage for
ShadeMax’s inputs, temporal sampling, routing objective, or route recommendations.
Paired observations of ShadeMax’s predicted routes have not yet been collected.

## Principal error sources

| Source | Likely effect |
| --- | --- |
| OSM network, footprints, heights, and enclosure tags | Missing, stale, or incorrect geometry can create false shade, omit shade, or produce an infeasible route. OSM itself cautions that completeness and accuracy vary. |
| Canopy height and shape | Height error, imagery age, crown extent, trunk-height assumptions, and unmodeled seasonal foliage can move or soften a shadow. The published canopy MAE is not a shadow-error bound. |
| Flat terrain | Hills, cuttings, embankments, and terrain shadows are omitted. |
| 2 m voxels and 2 m observer height | Thin objects, façade detail, narrow gaps, and a nominal 1.5 m pedestrian viewpoint are discretized. |
| Three dates and hourly samples | Shadow position between samples can differ substantially, especially at low sun angles. The 4° cutoff sets low-angle direct sun to zero and can understate exposure. |
| Direct-beam-only physics | Diffuse light, reflections, cloud cover, heat, humidity, wind, and surface temperature are outside the estimate. “More shade” is not necessarily “cooler” or “safer.” |
| Edge aggregation | An OSM centerline does not distinguish opposite sidewalks or a pedestrian’s lateral position. Raster-to-edge averaging can hide short sun/shade transitions. |
| Conservative unknown handling and enclosure rules | Unmapped samples are avoided by both preference directions and counted as sunny in displayed totals; tagged covered edges are biased fully shaded, including locations near openings or partial cover. |
| Route presentation | Walking time assumes 1.4 m/s. Distances from selected pins to their snapped graph nodes are displayed as connectors but are not included in route time or sun-minute totals. |

See OpenStreetMap’s own [usage and safety disclaimer](https://wiki.openstreetmap.org/wiki/Using_OpenStreetMap#License_and_safety_disclaimer)
and [completeness guidance](https://wiki.openstreetmap.org/wiki/Completeness).

## Required field-validation protocol

1. **Pre-register the questions and thresholds.** Separately define acceptable
   error for point sun/shade, transmittance, route-equivalent sun minutes, route
   ranking, walking-network feasibility, and endpoint snapping. Do this before
   inspecting results.
2. **Create a stratified pilot.** In each city, begin with at least 400
   space-time point observations across open sky, building shade, tree shade,
   street canyons, covered ways, different sun angles, seasons, and times of
   day. Add paired fastest/shadier route trials. Treat 400 as a pilot target,
   then calculate the final sample size from observed variance and the desired
   confidence-interval width.
3. **Collect synchronized ground truth.** Freeze model inputs and predictions
   first. At surveyed locations, record precise timestamp and position,
   synchronized hemispherical imagery or video, and calibrated irradiance/direct-
   beam measurements at pedestrian height. Log sky conditions and analyze the
   clear-sky subset for the product’s stated claim. Repeat observations on
   different days; do not treat adjacent points as independent samples.
4. **Score the whole chain.** Report sun/shade precision, recall, and balanced
   accuracy; transmittance MAE/RMSE and bias; route sun-minute MAE and bias;
   pairwise ranking agreement; and route regret (extra observed exposure caused
   by choosing the recommendation). Measure snap distance and route feasibility
   separately.
5. **Quantify uncertainty without hiding variation.** Use route/day-clustered
   bootstrap 95% confidence intervals. Report results by city, shade type,
   season, hour, and solar-elevation band as well as overall; a pooled number can
   conceal a failing city or condition.
6. **Hold out the final evaluation.** Use separate cities, routes, and dates for
   calibration and evaluation. Publish the frozen model version, input dates,
   coverage/fallback rates, protocol, and de-identified observations. Only make
   a numerical accuracy claim after the pre-registered thresholds pass on this
   holdout set.

## Product-language boundary

Appropriate language now:

- “Experimental clear-sky estimate of direct-beam exposure.”
- “This route may reduce modeled direct-sun-equivalent minutes compared with
  the fastest route.”
- “Coverage and uncertainty vary by place and time.”

Do not claim yet:

- “X% accurate,” “guaranteed shaded,” or “exact minutes in the sun.”
- “Cooler,” “heat-safe,” or any medical or safety benefit.
- Uniform worldwide accuracy or superiority over another routing product.

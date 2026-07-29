import type { GraphData } from "./graph";
import type { CoverageAreaMetadata } from "./coverage-model";

export type CityDefinition = {
  id: string;
  name: string;
  district: string;
  timezone: string;
  coverage: string;
  searchBias: string;
};

const singapore: GraphData = require("../assets/singapore.json");

export type LoadedCityDefinition = CityDefinition & { data: GraphData };
export const BUNDLED_CITY_ID = "singapore-cbd";

export const CITIES: readonly CityDefinition[] = [
  {
    id: "singapore-cbd",
    name: "Singapore",
    district: "CBD · Chinatown · Marina Bay",
    timezone: "Asia/Singapore",
    coverage: "2 km test area",
    searchBias: "Singapore CBD, Singapore",
  },
  {
    id: "new-york-midtown",
    name: "New York",
    district: "Midtown Manhattan",
    timezone: "America/New_York",
    coverage: "600 m evaluation tile",
    searchBias: "Midtown Manhattan, New York, USA",
  },
  {
    id: "sydney-cbd",
    name: "Sydney",
    district: "CBD",
    timezone: "Australia/Sydney",
    coverage: "600 m evaluation tile",
    searchBias: "Sydney CBD, Australia",
  },
] as const;

export function cityById(id: string): CityDefinition {
  return CITIES.find((city) => city.id === id) ?? CITIES[0];
}

/** Build a routable area definition without assuming it belongs to the curated city list. */
export function cityFromCoverageArea(area: CoverageAreaMetadata): CityDefinition {
  return {
    id: area.id,
    name: area.name,
    district: area.district,
    timezone: area.timezone,
    coverage: area.coverage,
    searchBias: area.searchBias,
  };
}

export function bundledCity(): LoadedCityDefinition {
  return { ...cityById(BUNDLED_CITY_ID), data: singapore };
}

export function loadCity(city: CityDefinition, data: GraphData): LoadedCityDefinition {
  return { ...city, data };
}

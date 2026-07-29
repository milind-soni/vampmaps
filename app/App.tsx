import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Slider from "@react-native-community/slider";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import MapView, { Marker, Polyline, type Region } from "react-native-maps";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { BottomSheet } from "./src/bottom-sheet";
import {
  BUNDLED_CITY_ID,
  CITIES,
  bundledCity,
  cityById,
  cityFromCoverageArea,
  loadCity,
  type CityDefinition,
  type LoadedCityDefinition,
} from "./src/cities";
import {
  AppSymbol,
  GlassSurface,
  LightPreferenceSlider,
  RouteLegend,
  RouteRow,
  StartDot,
  EndDot,
} from "./src/components";
import {
  buildGraph,
  boundedPreferenceRoute,
  dateInTimezone,
  Graph,
  nearestNode,
  Route,
  seasonDate,
  shortestRoute,
  solarElevation,
  supportsSunPreference,
  type LonLat,
} from "./src/graph";
import type { CoverageAreaState, CoverageLoadResult, CoverageSnapshot } from "./src/coverage-client";
import { CoverageBrowserOverlay } from "./src/coverage-browser";
import {
  coverageOperationArea,
  coverageProgressPresentation,
  type CoverageProgressAction,
} from "./src/coverage-progress";
import { createExpoCoverageClient } from "./src/coverage-expo";
import { CoverageError } from "./src/coverage-model";
import { BoltIcon, FlagIcon, GpsIcon, LeafIcon, SunIcon } from "./src/icons";
import { LIGHT_PREFERENCES } from "./src/melt";
import { AccuracySheet, CityPicker, type CityPickerStatus } from "./src/modals";
import { WelcomeScreen } from "./src/onboarding";
import { F, R, T, useShadeMaxTheme, type ShadeMaxTheme } from "./src/theme";
import {
  CoverageViewportError,
  matchCoverageViewport,
  requestCoverageViewport,
  viewportFromBoundaries,
  viewportFromRegion,
  type CoverageViewport,
} from "./src/viewport-coverage";

const ONBOARDING_KEY = "shademax:onboarding:v1";
const CITY_KEY = "shademax:selected-city:v1";
const BUNDLED_COVERAGE_VERSION = "34a2b97ce5b8ef67274984b427fc6186984ef340818307eb19332c33f3293cd3";
const CONFIGURED_COVERAGE_MANIFEST_URL = process.env.EXPO_PUBLIC_COVERAGE_MANIFEST_URL;
const COVERAGE_REQUEST_URL = process.env.EXPO_PUBLIC_COVERAGE_REQUEST_URL;
if (!__DEV__ && !CONFIGURED_COVERAGE_MANIFEST_URL) {
  throw new Error("EXPO_PUBLIC_COVERAGE_MANIFEST_URL must be set to the production HTTPS catalog.");
}
const COVERAGE_MANIFEST_URL =
  CONFIGURED_COVERAGE_MANIFEST_URL ?? "http://127.0.0.1:8791/manifest.json";
const BUNDLED_STARTER = bundledCity();
const [bundledWest, bundledSouth, bundledEast, bundledNorth] = BUNDLED_STARTER.data.meta.bbox;

const coverageClient = createExpoCoverageClient({
  manifestUrl: COVERAGE_MANIFEST_URL,
  allowInsecureHttp: __DEV__,
  maxBundleBytes: 8 * 1024 * 1024,
  bundled: [
    {
      area: {
        ...cityById(BUNDLED_CITY_ID),
        version: BUNDLED_COVERAGE_VERSION,
        bbox: BUNDLED_STARTER.data.meta.bbox,
        center: [(bundledWest + bundledEast) / 2, (bundledSouth + bundledNorth) / 2],
      },
      load: () => BUNDLED_STARTER.data,
    },
  ],
});

type Pt = { latitude: number; longitude: number };
type PickMode = "start" | "end" | null;
type LocationState = "idle" | "loading" | "denied" | "outside" | "error";
type RouteState =
  | null
  | { kind: "outside" }
  | { kind: "unavailable" }
  | {
      kind: "ready";
      fastest: Route;
      preferred: Route;
      snapA: Pt;
      snapB: Pt;
    };

const toPt = ([longitude, latitude]: LonLat): Pt => ({ latitude, longitude });

function formatHour(hour: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2025, 0, 1, hour)));
}

function mapRegion(city: LoadedCityDefinition) {
  const [west, south, east, north] = city.data.meta.bbox;
  return {
    latitude: (south + north) / 2,
    longitude: (west + east) / 2,
    latitudeDelta: (north - south) * 1.2,
    longitudeDelta: (east - west) * 1.2,
  };
}

function bboxCoordinates(bbox: [number, number, number, number]): Pt[] {
  const [west, south, east, north] = bbox;
  return [
    { latitude: south, longitude: west },
    { latitude: north, longitude: west },
    { latitude: north, longitude: east },
    { latitude: south, longitude: east },
    { latitude: south, longitude: west },
  ];
}

function compactBytes(bytes?: number): string {
  if (!bytes) return "Download available";
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB download`;
  return `${(bytes / 1_000_000).toFixed(1)} MB download`;
}

function pickerStatus(snapshot: CoverageSnapshot, cityId: string): CityPickerStatus {
  const state = snapshot.areas.find((candidate) => candidate.area.id === cityId);
  if (!state) return snapshot.manifestError ? { kind: "offline" } : { kind: "checking" };
  switch (state.phase) {
    case "ready":
      return { kind: "ready" };
    case "update-available":
      return { kind: "update", bytes: state.downloadBytes };
    case "available":
      return { kind: "available", bytes: state.downloadBytes };
    case "downloading":
      return { kind: "downloading", progress: state.progress?.fraction ?? undefined, usable: state.usable };
    case "verifying":
      return { kind: "verifying", usable: state.usable };
    case "error":
      return { kind: "error", usable: state.usable };
  }
}

function expColor(exposure: number, theme: ShadeMaxTheme): string {
  const t = Math.min(1, Math.max(0, exposure));
  const shade = theme.isDark ? [88, 194, 174] : [14, 116, 106];
  const sun = theme.isDark ? [240, 174, 93] : [180, 95, 29];
  const rgb = shade.map((channel, index) => Math.round(channel + (sun[index] - channel) * t));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ShadeMax />
    </SafeAreaProvider>
  );
}

function ShadeMax() {
  const theme = useShadeMaxTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const { height, fontScale } = useWindowDimensions();
  const largeText = fontScale >= 1.35;
  const mapRef = useRef<MapView>(null);
  const fittedRouteRef = useRef("");
  const coverageBrowseRequestRef = useRef(0);
  const viewportRegionRef = useRef<Region>(mapRegion(BUNDLED_STARTER));
  const coverageOriginRegionRef = useRef<Region>(mapRegion(BUNDLED_STARTER));
  const nowRef = useRef(new Date());

  const [fontsLoaded] = useFonts({
    [F.regular]: require("./assets/fonts/OpenRunde-Regular.otf"),
    [F.medium]: require("./assets/fonts/OpenRunde-Medium.otf"),
    [F.semibold]: require("./assets/fonts/OpenRunde-Semibold.otf"),
    [F.bold]: require("./assets/fonts/OpenRunde-Bold.otf"),
  });

  const [onboarding, setOnboarding] = useState<"loading" | "show" | "hidden">("loading");
  const [city, setCity] = useState<LoadedCityDefinition>(() => BUNDLED_STARTER);
  const [coverageSnapshot, setCoverageSnapshot] = useState<CoverageSnapshot>(() => coverageClient.getSnapshot());
  const [viewportRegion, setViewportRegion] = useState<Region>(() => mapRegion(BUNDLED_STARTER));
  const graph = useMemo(() => buildGraph(city.data), [city]);
  const cityNow = useMemo(() => dateInTimezone(nowRef.current, city.timezone), [city]);
  const { bbox, hours, dates } = city.data.meta;
  const defaultHour = Math.min(hours[hours.length - 1], Math.max(hours[0], cityNow.getHours()));

  const [start, setStart] = useState<Pt | null>(null);
  const [end, setEnd] = useState<Pt | null>(null);
  const [startQuery, setStartQuery] = useState("");
  const [endQuery, setEndQuery] = useState("");
  const [hour, setHour] = useState(defaultHour);
  const [preferenceIdx, setPreferenceIdx] = useState(2);
  const [focus, setFocus] = useState<"auto" | "preferred" | "fastest">("auto");
  const [pickMode, setPickMode] = useState<PickMode>(null);
  const [locationState, setLocationState] = useState<LocationState>("idle");
  const [showsUserLocation, setShowsUserLocation] = useState(false);
  const [geocoding, setGeocoding] = useState<"start" | "end" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [visibleSheetHeight, setVisibleSheetHeight] = useState(320);
  const [cityPickerVisible, setCityPickerVisible] = useState(false);
  const [accuracyVisible, setAccuracyVisible] = useState(false);
  const [coverageBrowse, setCoverageBrowse] = useState(false);
  const [coverageAction, setCoverageAction] = useState<CoverageProgressAction>("idle");
  const [coverageNotice, setCoverageNotice] = useState<string | null>(null);
  const [coverageFetchTargetId, setCoverageFetchTargetId] = useState<string | null>(null);
  const [coverageLocationBusy, setCoverageLocationBusy] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const cityPickerStatuses = useMemo(
    () =>
      Object.fromEntries(
        CITIES.map((candidate) => [candidate.id, pickerStatus(coverageSnapshot, candidate.id)]),
      ) as Record<string, CityPickerStatus>,
    [coverageSnapshot],
  );
  const previewViewport = useMemo(() => {
    try {
      return viewportFromRegion(viewportRegion);
    } catch {
      return null;
    }
  }, [viewportRegion]);
  const previewMatch = useMemo(
    () =>
      previewViewport
        ? matchCoverageViewport(coverageSnapshot.areas, previewViewport)
        : ({ kind: "zoom-in" } as const),
    [coverageSnapshot.areas, previewViewport],
  );
  const previewArea = previewMatch.kind === "match" ? previewMatch.state : undefined;

  useEffect(() => coverageClient.subscribe(setCoverageSnapshot), []);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      const [seen, savedCity] = await Promise.all([
        AsyncStorage.getItem(ONBOARDING_KEY),
        AsyncStorage.getItem(CITY_KEY),
      ]).catch(() => [null, null] as const);

      let initialCity = BUNDLED_STARTER;
      try {
        await coverageClient.initialize();
        if (savedCity) {
          try {
            const restored = await coverageClient.load(savedCity);
            initialCity = loadCity(cityFromCoverageArea(restored.area), restored.data);
          } catch {
            AsyncStorage.removeItem(CITY_KEY).catch(() => undefined);
          }
        }
      } catch {
        // The bundled starter area remains available if persistent storage fails.
      }

      if (!active) return;
      setCity(initialCity);
      setOnboarding(seen ? "hidden" : "show");
    };
    void boot();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!cityPickerVisible && !coverageBrowse) return;
    void coverageClient.refreshManifest().catch(() => undefined);
  }, [cityPickerVisible, coverageBrowse]);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    setHour(defaultHour);
    fittedRouteRef.current = "";
    const nextRegion = mapRegion(city);
    viewportRegionRef.current = nextRegion;
    setViewportRegion(nextRegion);
    requestAnimationFrame(() => mapRef.current?.animateToRegion(nextRegion, reduceMotion ? 0 : 450));
  }, [city, defaultHour, reduceMotion]);

  const date = useMemo(() => seasonDate(dates, cityNow), [cityNow, dates]);
  const hourIdx = Math.max(0, hours.indexOf(hour));
  const currentSolarElevation = solarElevation(city.data, date, hour);
  const sampleState = city.data.meta.sun_model?.sample_states?.[date]?.[hourIdx];
  const cutoff = city.data.meta.sun_model?.minimum_modeled_elevation_deg ?? 4;
  const sunBelowHorizon = sampleState === "below_horizon" || (currentSolarElevation !== null && currentSolarElevation <= 0);
  const lowSunNotModeled =
    !sunBelowHorizon &&
    (sampleState === "low_sun_cutoff" ||
      (currentSolarElevation !== null && currentSolarElevation < cutoff));
  const sunPreferenceAvailable = supportsSunPreference(city.data);
  const safePreferenceIdx = sunPreferenceAvailable ? preferenceIdx : Math.max(2, preferenceIdx);
  const lightPreference = LIGHT_PREFERENCES[safePreferenceIdx];

  useEffect(() => {
    if (sunPreferenceAvailable || preferenceIdx >= 2) return;
    setPreferenceIdx(2);
    setFocus("auto");
  }, [preferenceIdx, sunPreferenceAvailable]);

  const routes: RouteState = useMemo(() => {
    if (!start || !end) return null;
    const a = nearestNode(graph, start.latitude, start.longitude);
    const b = nearestNode(graph, end.latitude, end.longitude);
    const maximumSnap = city.id === "singapore-cbd" ? 400 : 220;
    if (a.distM > maximumSnap || b.distM > maximumSnap) return { kind: "outside" };
    const fastest = shortestRoute(graph, a.node, b.node, date, hourIdx, 0);
    if (!fastest) return { kind: "unavailable" };
    const preferred = boundedPreferenceRoute(
      graph,
      a.node,
      b.node,
      date,
      hourIdx,
      lightPreference.value,
      fastest,
    );
    return {
      kind: "ready",
      fastest,
      preferred,
      snapA: toPt(graph.data.nodes[a.node]),
      snapB: toPt(graph.data.nodes[b.node]),
    };
  }, [city.id, date, end, graph, hourIdx, lightPreference.value, start]);

  const ready = routes?.kind === "ready" ? routes : null;
  const fastest = ready?.fastest ?? null;
  const preferred = ready?.preferred ?? null;
  const routesDiffer = Boolean(fastest && preferred && !sameRoute(fastest, preferred));
  const lightBenefit = fastest && preferred
    ? lightPreference.value < 0
      ? Math.max(0, preferred.sunMin - fastest.sunMin)
      : lightPreference.value > 0
        ? Math.max(0, fastest.sunMin - preferred.sunMin)
        : 0
    : 0;
  const noModeledDirectSun = Boolean(fastest && preferred && fastest.sunMin < 0.05 && preferred.sunMin < 0.05);
  const recommendation: "preferred" | "fastest" =
    !routesDiffer || lightPreference.value === 0
      ? "preferred"
      : sunBelowHorizon || lowSunNotModeled || noModeledDirectSun || lightBenefit <= 0.05
        ? "fastest"
        : "preferred";
  const activeFocus = focus === "auto" ? recommendation : focus;
  const canShowRoutes = Boolean(
    (start || startQuery.trim()) && (end || endQuery.trim()) && !geocoding,
  );

  useEffect(() => {
    if (!ready || !start || !end) return;
    const key = `${city.id}:${start.latitude}:${start.longitude}:${end.latitude}:${end.longitude}`;
    if (fittedRouteRef.current === key) return;
    fittedRouteRef.current = key;
    requestAnimationFrame(() => {
      mapRef.current?.fitToCoordinates(routeCoords(ready.preferred), {
        animated: !reduceMotion,
        edgePadding: {
          top: Math.max(insets.top + 92, 120),
          right: 46,
          bottom: visibleSheetHeight + 32,
          left: 46,
        },
      });
    });
  }, [city.id, end, insets.top, ready, reduceMotion, start, visibleSheetHeight]);

  const resetRoute = useCallback(() => {
    fittedRouteRef.current = "";
    setStart(null);
    setEnd(null);
    setStartQuery("");
    setEndQuery("");
    setFocus("auto");
    setPickMode(null);
    setNotice(null);
    setSheetExpanded(false);
  }, []);

  const editRoute = useCallback(() => {
    fittedRouteRef.current = "";
    setEnd(null);
    setFocus("auto");
    setPickMode(null);
    setNotice(null);
    setSheetExpanded(false);
  }, []);

  const startCoverageBrowse = () => {
    const browseSession = ++coverageBrowseRequestRef.current;
    coverageOriginRegionRef.current = viewportRegionRef.current;
    setPickMode(null);
    setSheetExpanded(false);
    setCoverageAction("idle");
    setCoverageNotice(null);
    setCoverageFetchTargetId(null);
    setCoverageBrowse(true);
    void mapRef.current
      ?.getMapBoundaries()
      .then((boundaries) => {
        if (coverageBrowseRequestRef.current !== browseSession) return;
        const exact = viewportFromBoundaries(boundaries);
        const nextRegion: Region = {
          latitude: exact.center[1],
          longitude: exact.center[0],
          latitudeDelta: exact.bbox[3] - exact.bbox[1],
          longitudeDelta: exact.bbox[2] - exact.bbox[0],
        };
        coverageOriginRegionRef.current = nextRegion;
        viewportRegionRef.current = nextRegion;
        setViewportRegion(nextRegion);
      })
      .catch(() => undefined);
    Haptics.selectionAsync();
    AccessibilityInfo.announceForAccessibility(
      "Choose an area. Pan and zoom the map, then activate Fetch this area.",
    );
  };

  const closeCoverageBrowse = (restoreCamera = true) => {
    coverageBrowseRequestRef.current += 1;
    setCoverageBrowse(false);
    setCoverageAction("idle");
    setCoverageNotice(null);
    setCoverageFetchTargetId(null);
    if (restoreCamera) {
      const origin = coverageOriginRegionRef.current;
      requestAnimationFrame(() => mapRef.current?.animateToRegion(origin, reduceMotion ? 0 : 350));
    }
  };

  const activateCity = (nextCity: CityDefinition, loaded: CoverageLoadResult) => {
    resetRoute();
    setCity(loadCity(nextCity, loaded.data));
    setLocationState("idle");
    setShowsUserLocation(false);
    coverageBrowseRequestRef.current += 1;
    setCoverageBrowse(false);
    setCoverageAction("idle");
    setCoverageNotice(null);
    setCoverageFetchTargetId(null);
    setCityPickerVisible(false);
    AsyncStorage.setItem(CITY_KEY, nextCity.id).catch(() => undefined);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const previewCoverageCity = (nextCity: CityDefinition) => {
    const state = coverageClient
      .getSnapshot()
      .areas.find((candidate) => candidate.area.id === nextCity.id);
    const areaBbox = state?.area.bbox;
    if (!areaBbox) {
      AccessibilityInfo.announceForAccessibility(`${nextCity.name} is not available right now.`);
      return;
    }
    const [west, south, east, north] = areaBbox;
    const nextRegion: Region = {
      latitude: (south + north) / 2,
      longitude: (west + east) / 2,
      latitudeDelta: (north - south) * 1.2,
      longitudeDelta: (east - west) * 1.2,
    };
    setCityPickerVisible(false);
    setCoverageAction("idle");
    setCoverageNotice(null);
    viewportRegionRef.current = nextRegion;
    setViewportRegion(nextRegion);
    requestAnimationFrame(() => mapRef.current?.animateToRegion(nextRegion, reduceMotion ? 0 : 450));
    Haptics.selectionAsync();
    AccessibilityInfo.announceForAccessibility(`${nextCity.name}. Activate Fetch this area to continue.`);
  };

  const closeCityPicker = () => {
    setCityPickerVisible(false);
  };

  const loadViewportArea = async (state: CoverageAreaState): Promise<CoverageLoadResult> => {
    if (state.phase === "update-available" && state.canDownload) {
      return coverageClient.download(state.area.id);
    }
    if (state.phase === "error") return coverageClient.retry(state.area.id);
    if (state.usable) return coverageClient.load(state.area.id);
    if (state.canDownload || state.phase === "downloading" || state.phase === "verifying") {
      return coverageClient.download(state.area.id);
    }
    throw new CoverageError("not-available", "This area isn’t available to fetch yet.");
  };

  const currentCoverageViewport = async (): Promise<CoverageViewport> => {
    const fallback = viewportFromRegion(viewportRegionRef.current);
    try {
      const boundaries = await mapRef.current?.getMapBoundaries();
      return boundaries ? viewportFromBoundaries(boundaries) : fallback;
    } catch {
      // `getMapBoundaries` is Fabric-only on some react-native-maps builds.
      return fallback;
    }
  };

  const fetchCoverageViewport = async () => {
    if (coverageAction === "checking" || coverageAction === "fetching" || coverageAction === "requesting") return;
    const requestId = ++coverageBrowseRequestRef.current;
    setCoverageAction("checking");
    setCoverageNotice(null);
    setCoverageFetchTargetId(null);

    try {
      // Snapshot the requested geometry before any network work so a later map
      // movement cannot silently retarget the operation.
      const viewport = await currentCoverageViewport();
      let refreshFailed = false;
      try {
        await coverageClient.refreshManifest();
      } catch {
        refreshFailed = true;
      }
      if (coverageBrowseRequestRef.current !== requestId) return;

      const match = matchCoverageViewport(coverageClient.getSnapshot().areas, viewport);
      if (match.kind === "zoom-in" || Math.max(viewport.widthMeters, viewport.heightMeters) > 5_000) {
        setCoverageAction("idle");
        setCoverageNotice("Zoom in a little, then try again.");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }

      if (match.kind === "match") {
        const state = match.state;
        if (state.area.id === city.id && state.usable && state.phase !== "update-available") {
          setCoverageAction("idle");
          closeCoverageBrowse(true);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          return;
        }

        setCoverageFetchTargetId(state.area.id);
        setCoverageAction("fetching");
        const loaded = await loadViewportArea(state);
        if (coverageBrowseRequestRef.current !== requestId) return;
        activateCity(cityFromCoverageArea(loaded.area), loaded);
        return;
      }

      if (refreshFailed && coverageClient.getSnapshot().manifestError) {
        setCoverageAction("idle");
        setCoverageNotice("Couldn’t check new areas. Check your connection and try again.");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }

      if (!COVERAGE_REQUEST_URL) {
        setCoverageAction("idle");
        setCoverageNotice("This area isn’t ready yet.");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }

      setCoverageAction("requesting");
      const receipt = await requestCoverageViewport({
        endpoint: COVERAGE_REQUEST_URL,
        viewport,
        allowInsecureHttp: __DEV__,
      });
      if (coverageBrowseRequestRef.current !== requestId) return;

      if (receipt.status === "ready" && receipt.areaId) {
        await coverageClient.refreshManifest();
        const state = coverageClient
          .getSnapshot()
          .areas.find((candidate) => candidate.area.id === receipt.areaId);
        if (state) {
          setCoverageFetchTargetId(state.area.id);
          setCoverageAction("fetching");
          const loaded = await loadViewportArea(state);
          if (coverageBrowseRequestRef.current !== requestId) return;
          activateCity(cityFromCoverageArea(loaded.area), loaded);
          return;
        }
      }

      setCoverageAction("requested");
      setCoverageNotice("Request sent. This area will appear after it’s processed.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      AccessibilityInfo.announceForAccessibility("Area request sent.");
    } catch (error) {
      if (coverageBrowseRequestRef.current !== requestId) return;
      setCoverageAction("idle");
      setCoverageFetchTargetId(null);
      if (error instanceof CoverageError && error.code === "cancelled") {
        setCoverageNotice("Fetch cancelled.");
        return;
      }
      const message =
        error instanceof CoverageViewportError || error instanceof CoverageError || error instanceof Error
          ? error.message
          : "Couldn’t fetch this area. Try again.";
      setCoverageNotice(message);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      AccessibilityInfo.announceForAccessibility(message);
    }
  };

  const cancelCoverageFetch = () => {
    coverageBrowseRequestRef.current += 1;
    if (coverageFetchTargetId) coverageClient.cancel(coverageFetchTargetId);
    setCoverageFetchTargetId(null);
    setCoverageAction("idle");
    setCoverageNotice("Fetch cancelled.");
  };

  const locateCoverageViewport = async () => {
    if (coverageLocationBusy) return;
    setCoverageLocationBusy(true);
    setCoverageNotice(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        setCoverageNotice("Location access is off.");
        return;
      }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      setShowsUserLocation(true);
      mapRef.current?.animateToRegion(
        { ...point, latitudeDelta: 0.02, longitudeDelta: 0.02 },
        reduceMotion ? 0 : 450,
      );
    } catch {
      setCoverageNotice("ShadeMax couldn’t get your location.");
    } finally {
      setCoverageLocationBusy(false);
    }
  };

  const applySample = useCallback(() => {
    const sample = findSamplePoints(graph, date, Math.max(0, city.data.meta.hours.indexOf(13)));
    if (!sample) {
      setNotice("Example route unavailable.");
      return;
    }
    setHour(city.data.meta.hours.includes(13) ? 13 : city.data.meta.hours[0]);
    setStart(sample.start);
    setEnd(sample.end);
    setStartQuery("Example start");
    setEndQuery("Example destination");
    setFocus("auto");
    setPickMode(null);
    setSheetExpanded(false);
    fittedRouteRef.current = "";
  }, [city.data.meta.hours, date, graph]);

  const finishOnboarding = async (sample: boolean) => {
    setOnboarding("hidden");
    AsyncStorage.setItem(ONBOARDING_KEY, "seen").catch(() => undefined);
    if (sample) requestAnimationFrame(applySample);
  };

  const replayOnboarding = () => {
    resetRoute();
    setOnboarding("show");
    AsyncStorage.removeItem(ONBOARDING_KEY).catch(() => undefined);
  };

  const setPickedPoint = (kind: "start" | "end", point: Pt, label: string) => {
    fittedRouteRef.current = "";
    setFocus("auto");
    setNotice(null);
    if (kind === "start") {
      setStart(point);
      setStartQuery(label);
    } else {
      setEnd(point);
      setEndQuery(label);
    }
  };

  const onMapPress = (point: Pt) => {
    if (!pickMode) return;
    const nearest = nearestNode(graph, point.latitude, point.longitude);
    const maximumSnap = city.id === "singapore-cbd" ? 400 : 220;
    if (nearest.distM > maximumSnap) {
      setNotice("Tap inside the dotted area.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPickedPoint(pickMode, point, "Chosen on map");
    setPickMode(pickMode === "start" && !end ? "end" : null);
  };

  const resolveAddress = async (query: string): Promise<Pt | null> => {
    try {
      if (Platform.OS === "android") {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== "granted") throw new Error("permission");
      }
      const results = await Location.geocodeAsync(`${query}, ${city.searchBias}`);
      const inside = results.find(
        ({ latitude, longitude }) =>
          longitude >= bbox[0] && longitude <= bbox[2] && latitude >= bbox[1] && latitude <= bbox[3],
      );
      if (!inside) {
        setNotice("That place is outside this area. Pick a point inside the dotted line.");
        return null;
      }
      return { latitude: inside.latitude, longitude: inside.longitude };
    } catch {
      setNotice("Search isn’t available. Tap the map instead.");
      return null;
    }
  };

  const geocodePlace = async (kind: "start" | "end") => {
    const query = (kind === "start" ? startQuery : endQuery).trim();
    if (!query || (kind === "start" ? start : end)) return;
    setGeocoding(kind);
    setNotice(null);
    const point = await resolveAddress(query);
    if (point) setPickedPoint(kind, point, query);
    setGeocoding(null);
  };

  const showRoutes = async () => {
    const from = startQuery.trim();
    const to = endQuery.trim();
    if ((!start && !from) || (!end && !to) || geocoding) return;
    setNotice(null);

    let resolvedStart = start;
    if (!resolvedStart) {
      setGeocoding("start");
      resolvedStart = await resolveAddress(from);
      if (!resolvedStart) {
        setGeocoding(null);
        return;
      }
    }

    let resolvedEnd = end;
    if (!resolvedEnd) {
      setGeocoding("end");
      resolvedEnd = await resolveAddress(to);
      if (!resolvedEnd) {
        setGeocoding(null);
        return;
      }
    }

    fittedRouteRef.current = "";
    setFocus("auto");
    setStart(resolvedStart);
    setEnd(resolvedEnd);
    setStartQuery(from || startQuery);
    setEndQuery(to || endQuery);
    setGeocoding(null);
  };

  const locateMe = async () => {
    Haptics.selectionAsync();
    setLocationState("loading");
    setNotice(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        setLocationState("denied");
        setNotice("Location access is off.");
        return;
      }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      setShowsUserLocation(true);
      mapRef.current?.animateToRegion(
        { ...point, latitudeDelta: 0.008, longitudeDelta: 0.008 },
        reduceMotion ? 0 : 450,
      );
      const nearest = nearestNode(graph, point.latitude, point.longitude);
      if (nearest.distM > (city.id === "singapore-cbd" ? 400 : 220)) {
        setLocationState("outside");
        setNotice("You’re outside this coverage area.");
        return;
      }
      setPickedPoint("start", point, "Current location");
      setLocationState("idle");
    } catch {
      setLocationState("error");
      setNotice("ShadeMax couldn’t get your location. Search or choose a start on the map.");
    }
  };

  const shareRoute = async () => {
    if (!fastest || !preferred) return;
    const selected = activeFocus === "preferred" ? preferred : fastest;
    await Share.share({
      message: `ShadeMax found a ${Math.round(selected.walkMin)} min walk in ${city.name} with about ${selected.sunMin.toFixed(1)} direct-sun-equivalent minutes. Experimental clear-sky estimate.`,
    });
  };

  const coverage = bboxCoordinates(bbox);
  const coverageOutlines = coverageSnapshot.areas.filter(
    (state): state is CoverageAreaState & { area: { bbox: [number, number, number, number] } } =>
      Boolean(state.area.bbox),
  );
  const operationArea = coverageOperationArea(
    coverageSnapshot.areas,
    coverageFetchTargetId,
    previewArea,
  );
  const coverageProgress = coverageProgressPresentation(coverageAction, operationArea);
  const coverageOperationBusy =
    coverageAction === "checking" || coverageAction === "fetching" || coverageAction === "requesting";
  const passiveCoverageBusy =
    operationArea?.phase === "downloading" || operationArea?.phase === "verifying";
  const coveragePanelTitle = operationArea?.area.name ?? (coverageAction === "requested" ? "Request sent" : "Move the map");
  let coverageStatus = "Move the map, then fetch this area.";
  if (operationArea) {
    switch (operationArea.phase) {
      case "ready":
        coverageStatus = "Ready on this phone";
        break;
      case "update-available":
        coverageStatus = "Update available";
        break;
      case "available":
        coverageStatus = compactBytes(operationArea.downloadBytes);
        break;
      case "downloading":
        coverageStatus = "Saving for offline use";
        break;
      case "verifying":
        coverageStatus = "Almost ready";
        break;
      case "error":
        coverageStatus = "Fetch stopped. Try again.";
        break;
    }
    if (operationArea.area.district) {
      coverageStatus = `${operationArea.area.district} · ${coverageStatus}`;
    }
  } else if (previewMatch.kind === "zoom-in") {
    coverageStatus = "Zoom in a little.";
  } else if (coverageSnapshot.refreshing) {
    coverageStatus = "Checking available areas…";
  }
  if (coverageAction === "checking") coverageStatus = "Looking for coverage here";
  if (coverageAction === "requesting") coverageStatus = "Sending this map view";
  if (coverageNotice) coverageStatus = coverageNotice;

  const coveragePrimaryLabel =
    coverageAction === "checking"
      ? "Checking…"
      : operationArea?.phase === "verifying"
        ? "Preparing…"
        : coverageAction === "fetching" && operationArea?.phase === "ready"
          ? "Opening…"
          : coverageAction === "fetching"
            ? "Fetching…"
            : coverageAction === "requesting"
              ? "Requesting…"
              : coverageAction === "requested"
                ? "Request sent"
                : operationArea?.phase === "update-available"
                  ? "Update area"
                  : operationArea?.usable
                    ? "Use this area"
                    : operationArea?.phase === "error"
                      ? "Try again"
                      : previewMatch.kind === "none" && COVERAGE_REQUEST_URL
                        ? "Request this area"
                        : "Fetch this area";
  const coveragePrimaryDisabled =
    coverageOperationBusy || passiveCoverageBusy || coverageAction === "requested";

  const visibleHeightCallback = useCallback((value: number) => setVisibleSheetHeight(value), []);

  if (!fontsLoaded || onboarding === "loading") {
    return (
      <View style={[styles.loading, { backgroundColor: theme.canvas }]}>
        <StatusBar style={theme.isDark ? "light" : "dark"} />
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  if (onboarding === "show") {
    return (
      <>
        <StatusBar style={theme.isDark ? "light" : "dark"} />
        <WelcomeScreen
          onTrySample={() => finishOnboarding(true)}
          onExplore={() => finishOnboarding(false)}
        />
      </>
    );
  }

  const collapsedHeight = largeText
    ? ready
      ? Math.min(470, height - insets.top - 88)
      : Math.min(410, height - insets.top - 88)
    : ready
      ? 300
      : 330;

  return (
    <View style={styles.container}>
      <StatusBar style={theme.isDark ? "light" : "dark"} />
      <MapView
        ref={mapRef}
        accessibilityLabel={
          coverageBrowse
            ? "Interactive map for choosing coverage. Pan and zoom, then use Fetch this area."
            : `Interactive map of ${city.name}. Route points change only while Choose on Map mode is active.`
        }
        style={StyleSheet.absoluteFill}
        initialRegion={mapRegion(city)}
        mapType="mutedStandard"
        rotateEnabled={false}
        pitchEnabled={false}
        scrollEnabled={!coverageOperationBusy}
        zoomEnabled={!coverageOperationBusy}
        showsCompass={false}
        showsScale={false}
        showsUserLocation={showsUserLocation}
        legalLabelInsets={{
          top: 0,
          left: 0,
          right: 0,
          bottom: coverageBrowse ? Math.max(insets.bottom + 180, 190) : visibleSheetHeight + 12,
        }}
        onRegionChangeComplete={(nextRegion) => {
          viewportRegionRef.current = nextRegion;
          setViewportRegion(nextRegion);
          if (coverageBrowse && !coverageOperationBusy) {
            if (coverageAction === "requested") setCoverageAction("idle");
            if (coverageNotice) setCoverageNotice(null);
          }
        }}
        onPress={(event) => onMapPress(event.nativeEvent.coordinate)}
      >
        {coverageBrowse ? (
          coverageOutlines.map((state) => {
            const selected = previewArea?.area.id === state.area.id;
            return (
              <Polyline
                key={`coverage-${state.area.id}`}
                coordinates={bboxCoordinates(state.area.bbox)}
                strokeColor={selected ? theme.accent : theme.routeDim}
                strokeWidth={selected ? 4 : 2}
                lineDashPattern={selected ? undefined : [7, 8]}
                zIndex={selected ? 4 : 1}
              />
            );
          })
        ) : (
          <Polyline
            coordinates={coverage}
            strokeColor={theme.routeDim}
            strokeWidth={2}
            lineDashPattern={[7, 8]}
          />
        )}

        {!coverageBrowse && (
          <>
            {ready && start && (
              <Polyline coordinates={[start, ready.snapA]} strokeColor={theme.routeDim} strokeWidth={2} lineDashPattern={[2, 5]} />
            )}
            {ready && end && (
              <Polyline coordinates={[end, ready.snapB]} strokeColor={theme.routeDim} strokeWidth={2} lineDashPattern={[2, 5]} />
            )}

            {fastest && routesDiffer && (
              <>
                <Polyline
                  coordinates={routeCoords(fastest)}
                  strokeColor={theme.routeCasing}
                  strokeWidth={activeFocus === "fastest" ? 10 : 8}
                  zIndex={activeFocus === "fastest" ? 4 : 1}
                />
                <Polyline
                  coordinates={routeCoords(fastest)}
                  strokeColor={activeFocus === "fastest" ? theme.routeFast : theme.routeDim}
                  strokeWidth={activeFocus === "fastest" ? 6 : 5}
                  lineDashPattern={[9, 7]}
                  zIndex={activeFocus === "fastest" ? 5 : 2}
                />
              </>
            )}

            {preferred &&
              preferred.segments.flatMap((segment, index) => [
                <Polyline
                  key={`case-${index}-${activeFocus}`}
                  coordinates={segment.coords.map(toPt)}
                  strokeColor={theme.routeCasing}
                  strokeWidth={activeFocus === "preferred" ? 11 : 9}
                  zIndex={activeFocus === "preferred" ? 6 : 1}
                />,
                <Polyline
                  key={`route-${index}-${activeFocus}`}
                  coordinates={segment.coords.map(toPt)}
                  strokeColor={segment.known ? expColor(segment.exposure, theme) : theme.routeDim}
                  strokeWidth={activeFocus === "preferred" ? 7 : 5}
                  lineDashPattern={segment.exposure > 0.58 ? [3, 4] : undefined}
                  zIndex={activeFocus === "preferred" ? 7 : 2}
                />,
              ])}

            {start && (
              <Marker coordinate={start} anchor={{ x: 0.5, y: 0.5 }} accessibilityLabel="Route start">
                <StartDot />
              </Marker>
            )}
            {end && (
              <Marker coordinate={end} anchor={{ x: 0.5, y: 0.5 }} accessibilityLabel="Route destination">
                <EndDot>
                  <FlagIcon size={16} color={theme.onAccent} />
                </EndDot>
              </Marker>
            )}
          </>
        )}
      </MapView>

      {!coverageBrowse && (
        <View pointerEvents="box-none" style={[styles.topOverlay, { paddingTop: insets.top + 8 }]}>
          <GlassSurface style={styles.topBar} clear>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Change coverage area. Current area: ${city.name}, ${city.district}`}
              accessibilityHint="Opens the map area picker"
              onPress={startCoverageBrowse}
              style={({ pressed }) => [styles.cityButton, pressed && styles.pressed]}
            >
              <Text maxFontSizeMultiplier={1.4} numberOfLines={1} style={[T.headline, styles.flex, { color: theme.ink }]}>{city.name}</Text>
              <AppSymbol name="map.fill" size={16} color={theme.accent} />
            </Pressable>
            <View style={[styles.topDivider, { backgroundColor: theme.separator }]} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="How ShadeMax estimates sun and shade"
              onPress={() => setAccuracyVisible(true)}
              style={({ pressed }) => [styles.topIconButton, pressed && styles.pressed]}
            >
              <AppSymbol name="info.circle" size={21} color={theme.inkSoft} />
            </Pressable>
          </GlassSurface>

          {pickMode && (
            <GlassSurface style={styles.pickBanner}>
              <AppSymbol name="hand.tap.fill" size={18} color={theme.accentDeep} />
              <Text style={[T.headline, styles.flex, { color: theme.ink }]}>
                Tap the map to set your {pickMode === "start" ? "start" : "destination"}
              </Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Cancel map selection" onPress={() => setPickMode(null)} style={styles.cancelPick}>
                <AppSymbol name="xmark" size={15} color={theme.inkSoft} />
              </Pressable>
            </GlassSurface>
          )}
        </View>
      )}

      {!coverageBrowse && (
        <View
          pointerEvents="box-none"
          style={[styles.mapUtilities, { bottom: Math.min(visibleSheetHeight + 12, height - insets.top - 170) }]}
        >
          {ready ? <RouteLegend /> : <View />}
          <GlassSurface style={styles.mapControlCluster} clear>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Use my location as the route start"
              accessibilityState={{ busy: locationState === "loading" }}
              onPress={locateMe}
              style={({ pressed }) => [styles.mapControlButton, pressed && styles.pressed]}
            >
              {locationState === "loading" ? (
                <ActivityIndicator size="small" color={theme.accent} />
              ) : (
                <GpsIcon size={22} color={theme.accent} />
              )}
            </Pressable>
            <View style={[styles.controlDivider, { backgroundColor: theme.separator }]} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show all ${city.name} coverage`}
              onPress={() => mapRef.current?.animateToRegion(mapRegion(city), reduceMotion ? 0 : 450)}
              style={({ pressed }) => [styles.mapControlButton, pressed && styles.pressed]}
            >
              <AppSymbol name="viewfinder" size={20} color={theme.inkSoft} />
            </Pressable>
          </GlassSurface>
        </View>
      )}

      {!coverageBrowse && (
        <BottomSheet
          expanded={sheetExpanded}
          collapsedHeight={collapsedHeight}
          collapsedLabel={`Preference · ${lightPreference.label}`}
          expandedLabel="Hide options"
          onExpandedChange={setSheetExpanded}
          onVisibleHeightChange={visibleHeightCallback}
        >
          <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.sheetContent}
              showsVerticalScrollIndicator={false}
            >
              {!ready && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canShowRoutes, busy: geocoding !== null }}
                  disabled={!canShowRoutes}
                  onPress={showRoutes}
                  style={({ pressed }) => [
                    styles.showRoutesButton,
                    !canShowRoutes && styles.showRoutesButtonDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {geocoding ? (
                    <ActivityIndicator
                      size="small"
                      color={canShowRoutes ? theme.onAccent : theme.accentDeep}
                    />
                  ) : (
                    <>
                      <Text
                        style={[
                          T.headline,
                          { color: canShowRoutes ? theme.onAccent : theme.accentDeep },
                        ]}
                      >
                        Show routes
                      </Text>
                      <AppSymbol
                        name="arrow.right"
                        size={18}
                        color={canShowRoutes ? theme.onAccent : theme.accentDeep}
                      />
                    </>
                  )}
                </Pressable>
              )}

              {ready ? (
                <RouteResults
                  activeFocus={activeFocus}
                  fastest={ready.fastest}
                  preferred={ready.preferred}
                  preference={lightPreference.value}
                  lightBenefit={lightBenefit}
                  routesDiffer={routesDiffer}
                  sunBelowHorizon={sunBelowHorizon}
                  lowSunNotModeled={lowSunNotModeled}
                  noModeledDirectSun={noModeledDirectSun}
                  onFocus={(next) => {
                    Haptics.selectionAsync();
                    setFocus(next);
                  }}
                  onEdit={editRoute}
                />
              ) : (
                <View style={styles.setupHeader}>
                  <Text accessibilityRole="header" style={[T.title, styles.flex, { color: theme.ink }]}>Where are you going?</Text>
                </View>
              )}

              {!ready && (
                <View style={styles.placeFields}>
                  <PlaceField
                    label="From"
                    value={startQuery}
                    placeholder="Where from?"
                    busy={geocoding === "start"}
                    onChangeText={(value) => {
                      fittedRouteRef.current = "";
                      setStartQuery(value);
                      setStart(null);
                      setNotice(null);
                    }}
                    onSubmit={() => geocodePlace("start")}
                    onChooseMap={() => {
                      setPickMode("start");
                      setSheetExpanded(false);
                    }}
                    onLocation={locateMe}
                  />
                  <PlaceField
                    label="To"
                    value={endQuery}
                    placeholder="Where to?"
                    busy={geocoding === "end"}
                    onChangeText={(value) => {
                      fittedRouteRef.current = "";
                      setEndQuery(value);
                      setEnd(null);
                      setNotice(null);
                    }}
                    onSubmit={showRoutes}
                    onChooseMap={() => {
                      setPickMode("end");
                      setSheetExpanded(false);
                    }}
                  />
                </View>
              )}

              {routes?.kind === "outside" && (
                <InlineNotice text="Choose both points inside the dotted area." tone="warning" />
              )}
              {routes?.kind === "unavailable" && (
                <InlineNotice text="No walking route found. Try nearby points." tone="warning" />
              )}
              {notice && <InlineNotice text={notice} tone="info" />}

              {sheetExpanded && (
                <View style={[styles.section, { borderTopColor: theme.separator }]}>
                  <View style={[styles.sectionHeader, largeText && styles.sectionHeaderLarge]}>
                    <Text style={[T.headline, { color: theme.ink }]}>Leave at {formatHour(hour)}</Text>
                  </View>
                  <Slider
                    accessibilityLabel="Departure time"
                    accessibilityValue={{ min: hours[0], max: hours[hours.length - 1], now: hour, text: formatHour(hour) }}
                    minimumValue={hours[0]}
                    maximumValue={hours[hours.length - 1]}
                    step={1}
                    value={hour}
                    onValueChange={(value) => {
                      setHour(value);
                      setFocus("auto");
                    }}
                    onSlidingComplete={() => Haptics.selectionAsync()}
                    minimumTrackTintColor={theme.accent}
                    maximumTrackTintColor={theme.separator}
                    thumbTintColor={theme.accent}
                  />
                  <View style={styles.sliderLabels}>
                    <Text style={[T.caption, { color: theme.inkMuted }]}>{formatHour(hours[0])}</Text>
                    <Text style={[T.caption, { color: theme.inkMuted }]}>{formatHour(hours[hours.length - 1])}</Text>
                  </View>
                  {sunBelowHorizon && <InlineNotice text="No direct sun at this time." tone="info" />}
                  {lowSunNotModeled && <InlineNotice text="Light estimates are limited near sunrise or sunset." tone="warning" />}
                </View>
              )}

              {sheetExpanded && (
                <View style={[styles.section, { borderTopColor: theme.separator }]}>
                  <View style={styles.sectionHeader}>
                    <Text style={[T.headline, { color: theme.ink }]}>Route preference</Text>
                  </View>
                  <LightPreferenceSlider
                    options={LIGHT_PREFERENCES}
                    selectedIdx={safePreferenceIdx}
                    minimumIdx={sunPreferenceAvailable ? 0 : 2}
                    disabled={sunBelowHorizon || lowSunNotModeled}
                    onSelect={(index) => {
                      if (index === preferenceIdx) return;
                      Haptics.selectionAsync();
                      setPreferenceIdx(index);
                      setFocus("auto");
                    }}
                  />
                  {!sunPreferenceAvailable && (
                    <InlineNotice text="Update this area to unlock sun routes." tone="info" />
                  )}
                </View>
              )}

              {ready && sheetExpanded && (
                <View style={styles.expandedActions}>
                  <Pressable accessibilityRole="button" onPress={shareRoute} style={[styles.secondaryAction, { backgroundColor: theme.field }]}>
                    <AppSymbol name="square.and.arrow.up" size={17} color={theme.inkSoft} />
                    <Text style={[T.headline, { color: theme.ink }]}>Share route</Text>
                  </Pressable>
                </View>
              )}
            </ScrollView>
          </KeyboardAvoidingView>
        </BottomSheet>
      )}

      {coverageBrowse && (
        <CoverageBrowserOverlay
          topInset={insets.top}
          bottomInset={insets.bottom}
          title={coveragePanelTitle}
          detail={coverageStatus}
          progress={coverageProgress}
          primaryLabel={coveragePrimaryLabel}
          busy={coverageOperationBusy || passiveCoverageBusy}
          primaryDisabled={coveragePrimaryDisabled}
          canCancelFetch={
            coverageAction === "fetching" &&
            operationArea?.phase === "downloading" &&
            Boolean(coverageFetchTargetId)
          }
          locationBusy={coverageLocationBusy}
          onFetch={fetchCoverageViewport}
          onCancelFetch={cancelCoverageFetch}
          onUseLocation={locateCoverageViewport}
          onOpenAreas={() => setCityPickerVisible(true)}
          onClose={() => closeCoverageBrowse()}
        />
      )}

      <CityPicker
        visible={cityPickerVisible}
        selected={city}
        statuses={cityPickerStatuses}
        onSelect={previewCoverageCity}
        onClose={closeCityPicker}
      />
      <AccuracySheet
        visible={accuracyVisible}
        city={city}
        onClose={() => setAccuracyVisible(false)}
        onReplay={replayOnboarding}
      />
    </View>
  );
}

function RouteResults({
  activeFocus,
  fastest,
  preferred,
  preference,
  lightBenefit,
  routesDiffer,
  sunBelowHorizon,
  lowSunNotModeled,
  noModeledDirectSun,
  onFocus,
  onEdit,
}: {
  activeFocus: "preferred" | "fastest";
  fastest: Route;
  preferred: Route;
  preference: number;
  lightBenefit: number;
  routesDiffer: boolean;
  sunBelowHorizon: boolean;
  lowSunNotModeled: boolean;
  noModeledDirectSun: boolean;
  onFocus: (focus: "preferred" | "fastest") => void;
  onEdit: () => void;
}) {
  const theme = useShadeMaxTheme();
  const status = sunBelowHorizon
    ? "No direct sun right now"
    : lowSunNotModeled
      ? "Sun estimate limited at this time"
      : noModeledDirectSun
        ? "No direct sun on either route"
        : preference === 0
          ? "Fastest route, with sun and shade shown"
          : !routesDiffer
            ? `Fastest already matches your ${preference < 0 ? "sun" : "shade"} preference`
            : lightBenefit >= 1
              ? `About ${Math.round(lightBenefit)} min ${preference < 0 ? "more" : "less"} sun than fastest`
              : lightBenefit > 0.05
                ? `Slightly ${preference < 0 ? "more" : "less"} sun than fastest`
                : "Both routes have similar sun";
  const preferredOption = {
    key: "preferred" as const,
    icon:
      preference < 0 ? (
        <SunIcon size={20} color={theme.sun} />
      ) : preference > 0 ? (
        <LeafIcon size={20} color={theme.shade} />
      ) : (
        <BoltIcon size={20} color={theme.inkSoft} />
      ),
    title: preference < 0 ? "Sunnier" : preference > 0 ? "Shadier" : "Fastest",
    route: preferred,
  };
  const options = routesDiffer && preference !== 0
    ? [
        preferredOption,
        {
          key: "fastest" as const,
          icon: <BoltIcon size={20} color={theme.inkSoft} />,
          title: "Fastest",
          route: fastest,
        },
      ]
    : [preferredOption];
  const statusColor = preference < 0 ? theme.sun : preference > 0 ? theme.shade : theme.inkSoft;

  return (
    <>
      <View style={resultStyles.header}>
        <View style={resultStyles.flex}>
          <Text accessibilityRole="header" style={[T.title, { color: theme.ink }]}>{options.length > 1 ? "Choose a route" : "Your route"}</Text>
          <Text style={[T.footnote, { color: statusColor }]}>{status}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Edit route" onPress={onEdit} style={[resultStyles.edit, { backgroundColor: theme.accentSoft }]}>
          <AppSymbol name="pencil" size={16} color={theme.accentDeep} />
          <Text style={[T.footnote, { color: theme.accentDeep }]}>Edit</Text>
        </Pressable>
      </View>
      <View accessibilityRole="radiogroup" accessibilityLabel="Walking route choices" style={resultStyles.routes}>
        {options.map((option) => (
          <RouteRow
            key={option.key}
            icon={option.icon}
            title={option.title}
            minutes={Math.round(option.route.walkMin)}
            sunMin={option.route.sunMin}
            selected={activeFocus === option.key}
            onPress={() => onFocus(option.key)}
          />
        ))}
      </View>
    </>
  );
}

function PlaceField({
  label,
  value,
  placeholder,
  busy,
  onChangeText,
  onSubmit,
  onChooseMap,
  onLocation,
}: {
  label: string;
  value: string;
  placeholder: string;
  busy: boolean;
  onChangeText: (value: string) => void;
  onSubmit: () => void;
  onChooseMap: () => void;
  onLocation?: () => void;
}) {
  const theme = useShadeMaxTheme();
  return (
    <View style={[fieldStyles.field, { backgroundColor: theme.field, borderColor: theme.separator }]}>
      <View style={[fieldStyles.labelCircle, { backgroundColor: label === "From" ? theme.accent : theme.accentSoft }]}>
        {label === "From" ? (
          <View style={[fieldStyles.startDot, { backgroundColor: theme.onAccent }]} />
        ) : (
          <AppSymbol name="flag.fill" size={13} color={theme.accentDeep} />
        )}
      </View>
      <TextInput
        accessibilityLabel={`${label} address`}
        autoCapitalize="words"
        clearButtonMode="while-editing"
        enterKeyHint="search"
        placeholder={placeholder}
        placeholderTextColor={theme.inkMuted}
        returnKeyType="search"
        selectionColor={theme.accent}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        style={[T.body, fieldStyles.input, { color: theme.ink }]}
      />
      {busy ? (
        <ActivityIndicator size="small" color={theme.accent} />
      ) : (
        <View style={fieldStyles.accessories}>
          {onLocation && (
            <Pressable accessibilityRole="button" accessibilityLabel="Use my location" hitSlop={6} onPress={onLocation} style={fieldStyles.accessory}>
              <AppSymbol name="location.fill" size={18} color={theme.accent} fallback={<GpsIcon size={18} color={theme.accent} />} />
            </Pressable>
          )}
          <Pressable accessibilityRole="button" accessibilityLabel={`Choose ${label.toLowerCase()} on map`} hitSlop={6} onPress={onChooseMap} style={fieldStyles.accessory}>
            <AppSymbol name="map.fill" size={18} color={theme.accent} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

function InlineNotice({ text, tone }: { text: string; tone: "info" | "warning" }) {
  const theme = useShadeMaxTheme();
  const warning = tone === "warning";
  return (
    <View
      accessibilityRole={warning ? "alert" : "text"}
      style={[
        noticeStyles.notice,
        { backgroundColor: warning ? theme.sunSoft : theme.accentSoft },
      ]}
    >
      <AppSymbol
        name={warning ? "exclamationmark.triangle.fill" : "info.circle.fill"}
        size={17}
        color={warning ? theme.sun : theme.accentDeep}
      />
      <Text style={[T.footnote, noticeStyles.flex, { color: theme.ink }]}>{text}</Text>
    </View>
  );
}

function findSamplePoints(graph: Graph, date: string, hourIdx: number): { start: Pt; end: Pt } | null {
  const [west, south, east, north] = graph.data.meta.bbox;
  const fractions = [
    [0.18, 0.2, 0.82, 0.8],
    [0.2, 0.75, 0.8, 0.25],
    [0.15, 0.5, 0.85, 0.5],
    [0.5, 0.15, 0.5, 0.85],
  ];
  for (const [ax, ay, bx, by] of fractions) {
    const a = nearestNode(graph, south + (north - south) * ay, west + (east - west) * ax);
    const b = nearestNode(graph, south + (north - south) * by, west + (east - west) * bx);
    const route = shortestRoute(graph, a.node, b.node, date, hourIdx, 0);
    if (route && route.distM > 120) {
      return { start: toPt(graph.data.nodes[a.node]), end: toPt(graph.data.nodes[b.node]) };
    }
  }
  return null;
}

function routeCoords(route: Route): Pt[] {
  return route.segments.flatMap((segment) => segment.coords.map(toPt));
}

function sameRoute(a: Route, b: Route): boolean {
  return a.edgePath.length === b.edgePath.length && a.edgePath.every((edge, index) => edge === b.edgePath[index]);
}

function makeStyles(theme: ShadeMaxTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.canvas },
    loading: { flex: 1, alignItems: "center", justifyContent: "center" },
    flex: { flex: 1 },
    topOverlay: { position: "absolute", top: 0, left: 14, right: 14, gap: 10 },
    topBar: {
      width: 230,
      minHeight: 48,
      borderRadius: R.pill,
      flexDirection: "row",
      alignItems: "center",
      paddingLeft: 6,
      paddingRight: 3,
    },
    cityButton: { minHeight: 46, flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10 },
    topDivider: { width: StyleSheet.hairlineWidth, height: 24 },
    topIconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
    pickBanner: {
      minHeight: 54,
      borderRadius: R.control,
      flexDirection: "row",
      alignItems: "center",
      gap: 9,
      paddingHorizontal: 14,
    },
    cancelPick: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
    mapUtilities: {
      position: "absolute",
      left: 14,
      right: 14,
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-between",
    },
    mapControlCluster: { width: 50, borderRadius: R.pill },
    mapControlButton: { width: 50, height: 50, alignItems: "center", justifyContent: "center" },
    controlDivider: { width: 30, height: StyleSheet.hairlineWidth, alignSelf: "center" },
    pressed: { opacity: 0.68 },
    sheetContent: { paddingHorizontal: 16, paddingBottom: 24, gap: 10 },
    setupHeader: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 10 },
    placeFields: { gap: 8 },
    showRoutesButton: {
      minHeight: 54,
      borderRadius: R.control,
      backgroundColor: theme.accent,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 9,
    },
    showRoutesButtonDisabled: { backgroundColor: theme.accentSoft },
    section: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 14, gap: 10 },
    sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    sectionHeaderLarge: { flexDirection: "column", alignItems: "flex-start", gap: 2 },
    sliderLabels: { flexDirection: "row", justifyContent: "space-between", marginTop: -8 },
    expandedActions: { gap: 9, marginTop: 2 },
    secondaryAction: {
      minHeight: 52,
      borderRadius: R.control,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
  });
}

const resultStyles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 10 },
  flex: { flex: 1, gap: 3 },
  edit: { minWidth: 72, height: 44, paddingHorizontal: 12, borderRadius: R.pill, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  routes: { gap: 8 },
});

const fieldStyles = StyleSheet.create({
  field: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    borderRadius: R.control,
    borderWidth: 1,
  },
  labelCircle: { width: 24, height: 24, borderRadius: R.pill, alignItems: "center", justifyContent: "center" },
  startDot: { width: 8, height: 8, borderRadius: R.pill },
  input: { flex: 1, minHeight: 44, paddingVertical: 6 },
  accessories: { flexDirection: "row", alignItems: "center" },
  accessory: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
});

const noticeStyles = StyleSheet.create({
  notice: { minHeight: 44, flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 11, borderRadius: R.small },
  flex: { flex: 1 },
});

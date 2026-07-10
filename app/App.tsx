import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";
import Slider from "@react-native-community/slider";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { useFonts } from "expo-font";

import {
  buildGraph,
  GraphData,
  LonLat,
  nearestNode,
  Route,
  seasonDate,
  shortestRoute,
} from "./src/graph";
import { meltPct, MOODS, savingsCopy } from "./src/melt";
import { C, R, T, shadow } from "./src/theme";
import { BoltIcon, FlagIcon, GpsIcon, LeafIcon, MapPointIcon, ShareIcon, SunIcon } from "./src/icons";
import { Card, EndDot, MoodPills, RouteRow, StartDot } from "./src/components";

const graphData: GraphData = require("./assets/singapore.json");

const MONTH: Record<string, string> = { "03-21": "March", "06-21": "June", "12-21": "December" };

function expColor(exposure: number, alpha = 1): string {
  const t = Math.min(1, Math.max(0, exposure));
  const a = [14, 149, 148];
  const b = [255, 122, 47];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * t));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

function formatHour(h: number): string {
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:00 ${ampm}`;
}

type Pt = { latitude: number; longitude: number };
const toPt = ([lon, lat]: LonLat): Pt => ({ latitude: lat, longitude: lon });

export default function App() {
  const [fontsLoaded] = useFonts({
    "OpenRunde-Regular": require("./assets/fonts/OpenRunde-Regular.otf"),
    "OpenRunde-Medium": require("./assets/fonts/OpenRunde-Medium.otf"),
    "OpenRunde-Semibold": require("./assets/fonts/OpenRunde-Semibold.otf"),
    "OpenRunde-Bold": require("./assets/fonts/OpenRunde-Bold.otf"),
  });

  const graph = useMemo(() => buildGraph(graphData), []);
  const { bbox, hours, dates, tz_offset_hours } = graphData.meta;
  const mapRef = useRef<MapView>(null);

  const initialRegion = {
    latitude: (bbox[1] + bbox[3]) / 2,
    longitude: (bbox[0] + bbox[2]) / 2,
    latitudeDelta: (bbox[3] - bbox[1]) * 1.15,
    longitudeDelta: (bbox[2] - bbox[0]) * 1.15,
  };

  const nowLocal = new Date(
    Date.now() + (tz_offset_hours * 60 + new Date().getTimezoneOffset()) * 60_000,
  );
  const defaultHour = Math.min(hours[hours.length - 1], Math.max(hours[0], nowLocal.getHours()));

  const [start, setStart] = useState<Pt | null>(null);
  const [end, setEnd] = useState<Pt | null>(null);
  const [hour, setHour] = useState(defaultHour);
  const [moodIdx, setMoodIdx] = useState(1);
  const [focus, setFocus] = useState<"shady" | "fastest">("shady");

  const date = useMemo(() => seasonDate(dates, nowLocal), [dates]);
  const hourIdx = hours.indexOf(hour);

  const routes = useMemo(() => {
    if (!start || !end) return null;
    const a = nearestNode(graph, start.latitude, start.longitude);
    const b = nearestNode(graph, end.latitude, end.longitude);
    if (a.distM > 400 || b.distM > 400) return { outside: true } as const;
    const fastest = shortestRoute(graph, a.node, b.node, date, hourIdx, 0);
    const shady = shortestRoute(graph, a.node, b.node, date, hourIdx, MOODS[moodIdx].weight);
    if (!fastest || !shady) return null;
    return {
      outside: false,
      fastest,
      shady,
      snapA: toPt(graph.data.nodes[a.node]),
      snapB: toPt(graph.data.nodes[b.node]),
    } as const;
  }, [graph, start, end, date, hourIdx, moodIdx]);

  const onTap = (pt: Pt) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (!start || (start && end)) {
      setStart(pt);
      setEnd(null);
    } else {
      setEnd(pt);
    }
  };

  const locateMe = async () => {
    Haptics.selectionAsync();
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return;
    const pos = await Location.getCurrentPositionAsync({});
    const { latitude, longitude } = pos.coords;
    mapRef.current?.animateToRegion(
      { latitude, longitude, latitudeDelta: 0.008, longitudeDelta: 0.008 },
      600,
    );
    const margin = 0.002;
    const inside =
      longitude > bbox[0] - margin &&
      longitude < bbox[2] + margin &&
      latitude > bbox[1] - margin &&
      latitude < bbox[3] + margin;
    if (inside) {
      setStart({ latitude, longitude });
      setEnd(null);
    }
  };

  const fastest = routes && !routes.outside ? routes.fastest : null;
  const shady = routes && !routes.outside ? routes.shady : null;
  const fastMelt = fastest ? meltPct(fastest.sunMin) : 0;
  const shadyMelt = shady ? meltPct(shady.sunMin) : 0;

  const shareRoute = async () => {
    if (!fastest || !shady) return;
    const saved = Math.max(0, Math.round(fastest.sunMin - shady.sunMin));
    await Share.share({
      message:
        `I'm taking the shady route 🌴 ${Math.round(shady.walkMin)} min and only ` +
        `${shadyMelt}% melted (the fast way: ${fastMelt}% 🫠). ` +
        `${saved} sun-minutes dodged. — vampmaps 🧛`,
    });
  };

  const coverage: Pt[] = [
    { latitude: bbox[1], longitude: bbox[0] },
    { latitude: bbox[3], longitude: bbox[0] },
    { latitude: bbox[3], longitude: bbox[2] },
    { latitude: bbox[1], longitude: bbox[2] },
    { latitude: bbox[1], longitude: bbox[0] },
  ];

  if (!fontsLoaded) {
    return (
      <View style={[styles.container, styles.loading]}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        mapType="mutedStandard"
        showsPointsOfInterest={false}
        showsCompass={false}
        onPress={(e) => onTap(e.nativeEvent.coordinate)}
        onLongPress={() => {
          setStart(null);
          setEnd(null);
        }}
      >
        <Polyline
          coordinates={coverage}
          strokeColor="rgba(18,33,31,0.18)"
          strokeWidth={1.5}
          lineDashPattern={[6, 8]}
        />

        {/* snap connectors: tap point -> network */}
        {routes && !routes.outside && start && (
          <Polyline
            coordinates={[start, routes.snapA]}
            strokeColor={C.routeDim}
            strokeWidth={2}
            lineDashPattern={[2, 5]}
          />
        )}
        {routes && !routes.outside && end && (
          <Polyline
            coordinates={[end, routes.snapB]}
            strokeColor={C.routeDim}
            strokeWidth={2}
            lineDashPattern={[2, 5]}
          />
        )}

        {fastest && (
          <Polyline
            coordinates={routeCoords(fastest)}
            strokeColor={focus === "fastest" ? C.ink : C.routeDim}
            strokeWidth={focus === "fastest" ? 5 : 4}
            lineDashPattern={focus === "fastest" ? undefined : [8, 7]}
          />
        )}
        {shady &&
          shady.segments.map((seg, i) => (
            <Polyline
              key={`${i}-${focus}`}
              coordinates={seg.coords.map(toPt)}
              strokeColor={expColor(seg.exposure, focus === "shady" ? 1 : 0.3)}
              strokeWidth={focus === "shady" ? 6 : 4}
              zIndex={focus === "shady" ? 2 : 1}
            />
          ))}

        {start && (
          <Marker coordinate={start} anchor={{ x: 0.5, y: 0.5 }}>
            <StartDot />
          </Marker>
        )}
        {end && (
          <Marker coordinate={end} anchor={{ x: 0.5, y: 0.5 }}>
            <EndDot>
              <FlagIcon size={15} color={C.paper} />
            </EndDot>
          </Marker>
        )}
      </MapView>

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        {/* time card */}
        <Card style={{ ...shadow, paddingVertical: 14 }}>
          <View style={styles.timeHeader}>
            <SunIcon size={20} color={C.sun} />
            <Text style={T.body}>{formatHour(hour)}</Text>
            <Text style={[T.caption, { marginLeft: "auto" }]}>
              {MONTH[date]} sun · Singapore
            </Text>
          </View>
          <Slider
            minimumValue={hours[0]}
            maximumValue={hours[hours.length - 1]}
            step={1}
            value={hour}
            onValueChange={setHour}
            minimumTrackTintColor={C.accent}
            maximumTrackTintColor={C.hairline}
            thumbTintColor={C.accent}
          />
        </Card>

        <View pointerEvents="box-none" style={{ flex: 1 }} />

        {/* locate me */}
        <View pointerEvents="box-none" style={styles.fabRow}>
          <Pressable onPress={locateMe} style={[styles.fab, shadow]}>
            <GpsIcon size={22} color={C.accent} />
          </Pressable>
        </View>

        {/* bottom panel */}
        <Card style={{ ...shadow, gap: 14 }}>
          {!routes && (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <MapPointIcon size={22} color={C.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={T.body}>{!start ? "Tap the map to set your start" : "Now tap your destination"}</Text>
                <Text style={[T.caption, { marginTop: 2 }]}>
                  {!start ? "Anywhere inside the dashed area" : "Long-press to start over"}
                </Text>
              </View>
            </View>
          )}

          {routes?.outside && (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <MapPointIcon size={22} color={C.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={T.body}>Outside the demo area</Text>
                <Text style={[T.caption, { marginTop: 2 }]}>
                  Try inside the dashed rectangle — CBD & Marina Bay
                </Text>
              </View>
            </View>
          )}

          {fastest && shady && (
            <>
              <RouteRow
                icon={<LeafIcon size={19} color={C.accent} />}
                title="Shady"
                minutes={Math.round(shady.walkMin)}
                meltPct={shadyMelt}
                selected={focus === "shady"}
                onPress={() => setFocus("shady")}
              />
              <RouteRow
                icon={<BoltIcon size={19} color={C.accent} />}
                title="Fastest"
                minutes={Math.round(fastest.walkMin)}
                meltPct={fastMelt}
                selected={focus === "fastest"}
                onPress={() => setFocus("fastest")}
              />
              <View style={styles.footerRow}>
                <Text style={[T.caption, { flex: 1 }]}>
                  {savingsCopy(shady.walkMin - fastest.walkMin, fastest.sunMin - shady.sunMin)}
                </Text>
                <Pressable onPress={shareRoute} style={styles.shareBtn}>
                  <ShareIcon size={15} color={C.accent} />
                  <Text style={[T.caption, { color: C.accent }]}>Share</Text>
                </Pressable>
              </View>
            </>
          )}

          <MoodPills moods={MOODS} selectedIdx={moodIdx} onSelect={(i) => {
            Haptics.selectionAsync();
            setMoodIdx(i);
          }} />
        </Card>
      </SafeAreaView>
    </View>
  );
}

function routeCoords(r: Route): Pt[] {
  const out: Pt[] = [];
  for (const s of r.segments) for (const c of s.coords) out.push(toPt(c));
  return out;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.paper },
  loading: { alignItems: "center", justifyContent: "center" },
  overlay: { flex: 1, margin: 16 },
  timeHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  fabRow: { alignItems: "flex-end", marginBottom: 14 },
  fab: {
    width: 48,
    height: 48,
    borderRadius: 999,
    backgroundColor: C.scrim,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 4 },
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: C.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  footerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: C.accentSoft,
  },
});

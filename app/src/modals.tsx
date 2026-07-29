import React, { useMemo } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { CITIES, type CityDefinition, type LoadedCityDefinition } from "./cities";
import { AppSymbol } from "./components";
import { CheckIcon } from "./icons";
import { R, T, useShadeMaxTheme, type ShadeMaxTheme } from "./theme";

const worldMascot = require("../assets/mascot-vamp-world.png");
const accuracyMascot = require("../assets/mascot-vamp-accuracy.png");

export type CityPickerStatus =
  | { kind: "ready" }
  | { kind: "available"; bytes?: number }
  | { kind: "update"; bytes?: number }
  | { kind: "checking" }
  | { kind: "downloading"; progress?: number; usable?: boolean }
  | { kind: "verifying"; usable?: boolean }
  | { kind: "error"; usable?: boolean }
  | { kind: "offline" };

export function CityPicker({
  visible,
  selected,
  statuses,
  onSelect,
  onClose,
}: {
  visible: boolean;
  selected: CityDefinition;
  statuses: Readonly<Record<string, CityPickerStatus>>;
  onSelect: (city: CityDefinition) => void;
  onClose: () => void;
}) {
  const theme = useShadeMaxTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      visible={visible}
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <ScrollView contentContainerStyle={styles.content}>
          <SheetHeader title="Available areas" onClose={onClose} />
          <View style={styles.worldScene}>
            <View style={styles.mascotMoon} />
            <Image
              accessibilityIgnoresInvertColors
              source={worldMascot}
              resizeMode="contain"
              style={styles.worldMascot}
              accessible={false}
            />
          </View>
          <View style={styles.cityList}>
            {CITIES.map((city) => {
              const active = city.id === selected.id;
              const status = statuses[city.id] ?? { kind: "checking" as const };
              const statusLabel = cityStatusLabel(status, active);
              return (
                <Pressable
                  key={city.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${city.name}, ${city.district}. ${statusLabel}`}
                  accessibilityState={{ selected: active, busy: status.kind === "checking" || status.kind === "downloading" || status.kind === "verifying" }}
                  accessibilityHint="Moves the map to this area. Use Fetch this area to continue."
                  onPress={() => onSelect(city)}
                  style={({ pressed }) => [
                    styles.cityRow,
                    active && styles.cityRowActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.cityPin}>
                    <AppSymbol name="mappin.and.ellipse" size={21} color={active ? theme.accent : theme.inkSoft} />
                  </View>
                  <View style={styles.cityCopy}>
                    <Text style={[T.headline, { color: theme.ink }]}>{city.name}</Text>
                    <Text style={[T.footnote, { color: theme.inkSoft }]}>{city.district}</Text>
                  </View>
                  {active && status.kind === "ready" ? (
                    <View style={styles.activeCheck}>
                      <CheckIcon size={14} color={theme.onAccent} />
                    </View>
                  ) : (
                    <CityStatus status={status} />
                  )}
                </Pressable>
              );
            })}
          </View>
          <View style={styles.experimentalBox}>
            <AppSymbol name="arrow.down.circle.fill" size={20} color={theme.shade} />
            <Text style={[T.footnote, styles.flex, { color: theme.inkSoft }]}>Downloaded areas work offline.</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function cityStatusLabel(status: CityPickerStatus, active: boolean): string {
  if (active && status.kind !== "update") return "Selected and ready offline";
  switch (status.kind) {
    case "ready":
      return "Downloaded and ready offline";
    case "available":
      return status.bytes ? `Available, ${formatBytes(status.bytes)}` : "Available";
    case "update":
      return `${active ? "Selected, " : ""}update available${status.bytes ? `, ${formatBytes(status.bytes)}` : ""}`;
    case "checking":
      return "Checking availability";
    case "downloading":
      return `${status.usable ? "Ready offline; updating" : "Downloading"}${status.progress === undefined ? "" : `, ${Math.round(status.progress * 100)} percent`}`;
    case "verifying":
      return status.usable ? "Ready offline; verifying update" : "Verifying download";
    case "error":
      return status.usable ? "Ready offline; update failed, retry" : "Download failed, retry";
    case "offline":
      return "Not downloaded, offline";
  }
}

function CityStatus({ status }: { status: CityPickerStatus }) {
  const theme = useShadeMaxTheme();
  if (status.kind === "checking" || status.kind === "downloading" || status.kind === "verifying") {
    return (
      <View style={shared.statusBusy}>
        <ActivityIndicator size="small" color={theme.accent} />
        {status.kind === "downloading" && status.progress !== undefined && (
          <Text style={[T.caption, { color: theme.inkSoft }]}>{Math.round(status.progress * 100)}%</Text>
        )}
      </View>
    );
  }
  if (status.kind === "ready") {
    return <AppSymbol name="checkmark.circle.fill" size={22} color={theme.shade} />;
  }
  const label =
    status.kind === "error"
      ? "Retry"
      : status.kind === "offline"
        ? "Offline"
        : status.kind === "update"
          ? "Update"
          : status.bytes
            ? formatBytes(status.bytes)
            : "Available";
  return (
    <View style={[shared.statusPill, { backgroundColor: status.kind === "error" ? theme.dangerSoft : theme.accentSoft }]}>
      <Text style={[T.caption, { color: status.kind === "error" ? theme.danger : theme.accentDeep }]}>{label}</Text>
    </View>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function AccuracySheet({
  visible,
  city,
  onClose,
  onReplay,
}: {
  visible: boolean;
  city: LoadedCityDefinition;
  onClose: () => void;
  onReplay: () => void;
}) {
  const theme = useShadeMaxTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const meta = city.data.meta;
  const modelDate = meta.solar_year ?? 2025;

  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      visible={visible}
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <ScrollView contentContainerStyle={styles.content}>
          <SheetHeader title="Accuracy" onClose={onClose} />
          <View style={styles.accuracyScene}>
            <View style={styles.mascotMoon} />
            <Image
              accessibilityIgnoresInvertColors
              source={accuracyMascot}
              resizeMode="contain"
              style={styles.accuracyMascot}
              accessible={false}
            />
          </View>
          <Text accessibilityRole="header" style={[T.title, { color: theme.ink }]}>Experimental. Not field-validated.</Text>
          <Text style={[T.body, { color: theme.inkSoft }]}>Clear-sky route estimates based on buildings, tree canopy and the sun’s position.</Text>

          <View style={styles.detailGrid}>
            <Detail label="MODEL DATES" value="Mar 21 · Jun 21 · Dec 21" />
            <Detail label="TIME STEP" value="1 hour" />
            <Detail label="GRID" value={`${meta.mesh_m ?? 2} m voxels`} />
            <Detail label="SOLAR YEAR" value={String(modelDate)} />
          </View>

          <Text accessibilityRole="header" style={[T.headline, { color: theme.ink }]}>What the estimate does not include</Text>
          <Bullet>Clouds, diffuse heat, humidity, wind, UV dose, or thermal comfort.</Bullet>
          <Bullet>Sidewalk-side detail, terrain, temporary scaffolding, or every covered passage.</Bullet>
          <Bullet>Perfect building or tree heights—source completeness and imagery dates vary by city.</Bullet>
          <Bullet>Field-measured route accuracy. “Direct sun” is a model-equivalent estimate, not literal exposure time.</Bullet>

          <View style={styles.warningBox}>
            <AppSymbol name="exclamationmark.triangle.fill" size={20} color={theme.sun} />
            <Text style={[T.footnote, styles.flex, { color: theme.ink }]}>Not medical, UV, heat-safety or emergency guidance. Check real conditions.</Text>
          </View>

          <Text accessibilityRole="header" style={[T.headline, { color: theme.ink }]}>Data and methods</Text>
          <SourceLink label="Meta/WRI canopy-height dataset" url="https://datasets.wri.org/datasets/meta-tree-canopy-height" />
          <SourceLink label="OpenStreetMap data quality" url="https://wiki.openstreetmap.org/wiki/Accuracy" />
          <SourceLink label="VoxCity research" url="https://arxiv.org/abs/2504.13934" />

          <Pressable
            accessibilityRole="button"
            onPress={() => {
              onClose();
              onReplay();
            }}
            style={({ pressed }) => [styles.replayButton, pressed && styles.pressed]}
          >
            <AppSymbol name="arrow.counterclockwise" size={18} color={theme.accentDeep} />
            <Text style={[T.headline, { color: theme.accentDeep }]}>Replay introduction</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const theme = useShadeMaxTheme();
  return (
    <View style={shared.header}>
      <Text accessibilityRole="header" style={[T.largeTitle, { color: theme.ink }]}>{title}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        hitSlop={8}
        onPress={onClose}
        style={[shared.closeButton, { backgroundColor: theme.field }]}
      >
        <AppSymbol name="xmark" size={17} color={theme.inkSoft} />
      </Pressable>
    </View>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  const theme = useShadeMaxTheme();
  return (
    <View style={[shared.detail, { backgroundColor: theme.field }]}>
      <Text style={[T.caption, { color: theme.inkMuted }]}>{label}</Text>
      <Text style={[T.headline, { color: theme.ink }]}>{value}</Text>
    </View>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  const theme = useShadeMaxTheme();
  return (
    <View style={shared.bulletRow}>
      <View style={[shared.bullet, { backgroundColor: theme.inkMuted }]} />
      <Text style={[T.body, shared.flex, { color: theme.inkSoft }]}>{children}</Text>
    </View>
  );
}

function SourceLink({ label, url }: { label: string; url: string }) {
  const theme = useShadeMaxTheme();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => Linking.openURL(url)}
      style={({ pressed }) => [shared.sourceLink, { borderColor: theme.separator }, pressed && shared.pressed]}
    >
      <Text style={[T.body, shared.flex, { color: theme.ink }]}>{label}</Text>
      <AppSymbol name="arrow.up.right" size={16} color={theme.accent} />
    </Pressable>
  );
}

function makeStyles(theme: ShadeMaxTheme) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: theme.canvas },
    content: { padding: 22, paddingBottom: 40, gap: 16 },
    worldScene: {
      height: 176,
      borderRadius: R.card,
      overflow: "hidden",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.accentSoft,
    },
    accuracyScene: {
      height: 210,
      borderRadius: R.card,
      overflow: "hidden",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.shadeSoft,
    },
    mascotMoon: {
      position: "absolute",
      width: 156,
      height: 156,
      borderRadius: R.pill,
      backgroundColor: theme.surface,
      opacity: theme.isDark ? 0.32 : 0.74,
    },
    worldMascot: { width: 190, height: 190, marginTop: 12 },
    accuracyMascot: { width: 224, height: 224, marginTop: 14 },
    cityList: { gap: 10 },
    cityRow: {
      minHeight: 72,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 14,
      borderRadius: R.control,
      borderWidth: 1,
      borderColor: theme.separator,
      backgroundColor: theme.surface,
    },
    cityRowActive: { borderWidth: 2, borderColor: theme.accent, backgroundColor: theme.accentSoft },
    cityPin: {
      width: 42,
      height: 42,
      borderRadius: 13,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.field,
    },
    cityCopy: { flex: 1, gap: 1 },
    activeCheck: {
      width: 26,
      height: 26,
      borderRadius: R.pill,
      backgroundColor: theme.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    experimentalBox: {
      flexDirection: "row",
      gap: 10,
      padding: 14,
      borderRadius: R.control,
      backgroundColor: theme.accentSoft,
    },
    detailGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    warningBox: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
      padding: 14,
      borderRadius: R.control,
      backgroundColor: theme.sunSoft,
    },
    replayButton: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      borderRadius: R.control,
      backgroundColor: theme.accentSoft,
    },
    flex: { flex: 1 },
    pressed: { opacity: 0.7 },
  });
}

const shared = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  closeButton: {
    width: 44,
    height: 44,
    borderRadius: R.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  detail: { width: "47%", minHeight: 76, padding: 12, borderRadius: R.small, gap: 3 },
  bulletRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  bullet: { width: 5, height: 5, borderRadius: R.pill, marginTop: 9 },
  sourceLink: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderRadius: R.control,
  },
  statusBusy: { minWidth: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
  statusAction: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  statusPill: { minHeight: 30, minWidth: 72, paddingHorizontal: 10, borderRadius: R.pill, alignItems: "center", justifyContent: "center" },
  flex: { flex: 1 },
  pressed: { opacity: 0.7 },
});

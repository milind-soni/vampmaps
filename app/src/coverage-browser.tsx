import React, { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { AppSymbol, GlassSurface } from "./components";
import type { CoverageProgressPresentation } from "./coverage-progress";
import { GpsIcon, MapPointIcon } from "./icons";
import { R, T, shadow, useShadeMaxTheme, type ShadeMaxTheme } from "./theme";

export function CoverageBrowserOverlay({
  topInset,
  bottomInset,
  title,
  detail,
  progress,
  primaryLabel,
  busy,
  primaryDisabled,
  canCancelFetch,
  locationBusy,
  onFetch,
  onCancelFetch,
  onUseLocation,
  onOpenAreas,
  onClose,
}: {
  topInset: number;
  bottomInset: number;
  title: string;
  detail: string;
  progress: CoverageProgressPresentation | null;
  primaryLabel: string;
  busy: boolean;
  primaryDisabled: boolean;
  canCancelFetch: boolean;
  locationBusy: boolean;
  onFetch: () => void;
  onCancelFetch: () => void;
  onUseLocation: () => void;
  onOpenAreas: () => void;
  onClose: () => void;
}) {
  const theme = useShadeMaxTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <View pointerEvents="box-none" style={[styles.topWrap, { paddingTop: topInset + 8 }]}>
        <GlassSurface style={styles.topBar} clear>
          <Text accessibilityRole="header" numberOfLines={1} style={[T.headline, styles.flex, { color: theme.ink }]}>Choose area</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Use my location"
            accessibilityState={{ busy: locationBusy }}
            onPress={onUseLocation}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            {locationBusy ? (
              <ActivityIndicator size="small" color={theme.accent} />
            ) : (
              <AppSymbol name="location.fill" size={19} color={theme.accent} fallback={<GpsIcon size={19} color={theme.accent} />} />
            )}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show available areas"
            onPress={onOpenAreas}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            <AppSymbol name="list.bullet" size={19} color={theme.inkSoft} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel choosing an area"
            accessibilityHint={busy ? "The current area operation continues in the background" : undefined}
            onPress={onClose}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            <AppSymbol name="xmark" size={17} color={theme.inkSoft} />
          </Pressable>
        </GlassSurface>
      </View>

      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={styles.target}
      >
        <View style={styles.targetCrossHorizontal} />
        <View style={styles.targetCrossVertical} />
        <View style={styles.targetBubble}>
          <MapPointIcon size={29} color={theme.accent} />
        </View>
      </View>

      <GlassSurface style={[styles.panel, { paddingBottom: Math.max(bottomInset, 12) + 14 }]}>
        <View style={styles.copy}>
          <Text accessibilityRole="header" numberOfLines={1} style={[T.title, { color: theme.ink }]}>{title}</Text>
          <Text accessibilityLiveRegion="polite" style={[T.footnote, { color: theme.inkSoft }]}>{detail}</Text>
        </View>
        {progress && <CoverageProgress progress={progress} />}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={primaryLabel}
            accessibilityState={{ busy, disabled: primaryDisabled }}
            disabled={primaryDisabled}
            onPress={onFetch}
            style={({ pressed }) => [
              styles.primary,
              primaryDisabled && !busy && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {busy && !progress && <ActivityIndicator size="small" color={theme.onAccent} />}
            <Text numberOfLines={1} style={[T.headline, { color: theme.onAccent }]}>{primaryLabel}</Text>
          </Pressable>
          {canCancelFetch && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel area fetch"
              onPress={onCancelFetch}
              style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
            >
              <AppSymbol name="xmark" size={15} color={theme.inkSoft} />
              <Text style={[T.footnote, { color: theme.inkSoft }]}>Cancel</Text>
            </Pressable>
          )}
        </View>
      </GlassSurface>
    </View>
  );
}

function CoverageProgress({ progress }: { progress: CoverageProgressPresentation }) {
  const theme = useShadeMaxTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const fraction = progress.fraction === null
    ? null
    : Math.max(0, Math.min(1, progress.fraction));
  const percent = fraction === null ? null : Math.round(fraction * 100);
  const byteText = progress.bytesWritten !== null && progress.totalBytes !== null
    ? `${formatBytes(progress.bytesWritten)} of ${formatBytes(progress.totalBytes)}`
    : null;
  const accessibilityText = progress.stage === "verifying" || progress.stage === "opening"
    ? "Download complete. Preparing area."
    : percent === null
      ? progress.label
      : `${progress.label}, ${percent} percent${byteText ? `, ${byteText}` : ""}`;

  return (
    <View style={[styles.progressCard, { backgroundColor: theme.field }]}>
      <View style={styles.progressHeader}>
        {progress.indicator === "indeterminate" ? (
          <ActivityIndicator size="small" color={theme.accent} />
        ) : (
          <AppSymbol name="arrow.down.circle.fill" size={18} color={theme.accent} />
        )}
        <Text
          accessibilityLiveRegion="polite"
          style={[T.footnote, styles.flex, { color: theme.ink }]}
        >
          {progress.label}
        </Text>
        {progress.stage === "downloading" && percent !== null && (
          <Text style={[T.headline, { color: theme.accentDeep }]}>{percent}%</Text>
        )}
      </View>
      {progress.stage === "downloading" && fraction !== null && (
        <View
          accessibilityLabel="Area download progress"
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: percent ?? 0, text: accessibilityText }}
          style={[styles.progressTrack, { backgroundColor: theme.accentSoft }]}
        >
          <View
            style={[
              styles.progressFill,
              { backgroundColor: theme.accent, width: `${percent ?? 0}%` },
            ]}
          />
        </View>
      )}
      {progress.stage === "downloading" && byteText && (
        <Text style={[T.caption, { color: theme.inkSoft }]}>{byteText}</Text>
      )}
    </View>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function makeStyles(theme: ShadeMaxTheme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    topWrap: { position: "absolute", left: 14, right: 14, top: 0 },
    topBar: {
      minHeight: 52,
      borderRadius: R.pill,
      flexDirection: "row",
      alignItems: "center",
      paddingLeft: 17,
      paddingRight: 4,
    },
    iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
    target: {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: 62,
      height: 62,
      marginLeft: -31,
      marginTop: -31,
      alignItems: "center",
      justifyContent: "center",
    },
    targetBubble: {
      width: 50,
      height: 50,
      borderRadius: 25,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surface,
      borderWidth: 2,
      borderColor: theme.accent,
      ...shadow,
    },
    targetCrossHorizontal: {
      position: "absolute",
      left: 0,
      right: 0,
      top: 30,
      height: 2,
      backgroundColor: theme.accent,
    },
    targetCrossVertical: {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 30,
      width: 2,
      backgroundColor: theme.accent,
    },
    panel: {
      position: "absolute",
      left: 12,
      right: 12,
      bottom: 10,
      borderRadius: R.card,
      paddingTop: 17,
      paddingHorizontal: 16,
      gap: 14,
      ...shadow,
    },
    copy: { gap: 3 },
    progressCard: { borderRadius: R.small, padding: 11, gap: 7 },
    progressHeader: { minHeight: 22, flexDirection: "row", alignItems: "center", gap: 8 },
    progressTrack: { height: 7, borderRadius: R.pill, overflow: "hidden" },
    progressFill: { height: "100%", borderRadius: R.pill },
    actions: { flexDirection: "row", alignItems: "center", gap: 9 },
    primary: {
      minHeight: 54,
      flex: 1,
      borderRadius: R.control,
      backgroundColor: theme.accent,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 9,
      paddingHorizontal: 14,
    },
    cancel: {
      minHeight: 54,
      minWidth: 82,
      borderRadius: R.control,
      backgroundColor: theme.field,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: 5,
      paddingHorizontal: 10,
    },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.68 },
  });
}

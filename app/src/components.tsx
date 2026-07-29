import React, { useEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  ViewStyle,
} from "react-native";
import Slider from "@react-native-community/slider";
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import { SymbolView, type SymbolViewProps } from "expo-symbols";

import { CheckIcon, LeafIcon, SunIcon } from "./icons";
import { R, T, useVampTheme, type VampTheme } from "./theme";

export function AppSymbol({
  name,
  size = 20,
  color,
  fallback,
}: {
  name: SymbolViewProps["name"];
  size?: number;
  color: string;
  fallback?: React.ReactNode;
}) {
  return (
    <View
      accessibilityElementsHidden
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      <SymbolView
        accessible={false}
        name={name}
        size={size}
        tintColor={color}
        weight="semibold"
        fallback={fallback ?? <View style={{ width: size, height: size }} />}
      />
    </View>
  );
}

export function GlassSurface({
  children,
  style,
  clear = false,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  clear?: boolean;
}) {
  const theme = useVampTheme();
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceTransparencyEnabled().then(setReduceTransparency);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      setReduceTransparency,
    );
    return () => subscription.remove();
  }, []);

  const canUseGlass =
    Platform.OS === "ios" && isGlassEffectAPIAvailable() && !reduceTransparency;

  if (canUseGlass) {
    return (
      <GlassView
        colorScheme="auto"
        glassEffectStyle={clear ? "clear" : "regular"}
        style={[s.glassBase, style]}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View
      style={[
        s.glassBase,
        { backgroundColor: theme.elevated, borderColor: theme.separator, borderWidth: 1 },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function RouteRow({
  icon,
  title,
  minutes,
  sunMin,
  selected,
  onPress,
}: {
  icon: React.ReactNode;
  title: string;
  minutes: number;
  sunMin: number;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useVampTheme();
  const { fontScale } = useWindowDimensions();
  const largeText = fontScale >= 1.35;
  const styles = useMemo(() => routeStyles(theme), [theme]);
  const normalizedSun = Math.max(0, sunMin);
  const sunText = normalizedSun < 0.5 ? "<1" : String(Math.round(normalizedSun));
  const sunLabel = normalizedSun < 0.5 ? "<1 min sun" : `~${sunText} min sun`;

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${title} route, about ${minutes} minutes, about ${sunMin.toFixed(1)} estimated minutes in direct sun`}
      accessibilityHint="Brings this route forward on the map"
      accessibilityState={{ checked: selected, selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.route,
        largeText && styles.routeLarge,
        selected && styles.routeSelected,
        pressed && s.pressed,
      ]}
    >
      {largeText ? (
        <>
          <View style={s.routeLargeTitleRow}>
            <View style={[styles.routeIcon, selected && styles.routeIconSelected]}>{icon}</View>
            <Text style={[T.headline, s.routeLargeTitle, { color: theme.ink }]}>{title}</Text>
            {selected && (
              <View style={styles.checkCircle}>
                <CheckIcon size={13} color={theme.onAccent} />
              </View>
            )}
          </View>
          <View style={s.routeLargeMeta}>
            <Text style={[T.footnote, { color: theme.inkSoft }]}>{sunLabel}</Text>
            <Text style={[T.headline, { color: theme.ink }]}>{minutes} min</Text>
          </View>
        </>
      ) : (
        <View style={s.routeTop}>
          <View style={[styles.routeIcon, selected && styles.routeIconSelected]}>{icon}</View>
          <View style={s.routeCopy}>
            <Text style={[T.headline, { color: theme.ink }]}>{title}</Text>
            <Text style={[T.footnote, { color: theme.inkSoft }]}>{sunLabel}</Text>
          </View>
          <Text style={[T.headline, { color: theme.ink }]}>{minutes} min</Text>
          {selected && (
            <View style={styles.checkCircle}>
              <CheckIcon size={13} color={theme.onAccent} />
            </View>
          )}
        </View>
      )}
    </Pressable>
  );
}

export function LightPreferenceSlider({
  options,
  selectedIdx,
  onSelect,
  minimumIdx = 0,
  disabled = false,
}: {
  options: readonly { key: string; label: string; value: number }[];
  selectedIdx: number;
  onSelect: (i: number) => void;
  minimumIdx?: number;
  disabled?: boolean;
}) {
  const theme = useVampTheme();
  const selected = options[selectedIdx] ?? options[Math.floor(options.length / 2)];
  const sunUnavailable = minimumIdx > 0;
  const selectedColor = selectedIdx < Math.floor(options.length / 2)
    ? theme.sun
    : selectedIdx > Math.floor(options.length / 2)
      ? theme.shade
      : theme.accent;

  return (
    <View style={[s.lightPreference, disabled && s.lightPreferenceDisabled]}>
      <View style={[s.currentPreference, { backgroundColor: theme.field }]}>
        <Text accessibilityLiveRegion="polite" style={[T.headline, { color: selectedColor }]}>{selected.label}</Text>
      </View>
      <View style={s.lightSliderRow}>
        <View
          style={[
            s.lightEndpointIcon,
            { backgroundColor: theme.sunSoft },
            sunUnavailable && s.lightEndpointUnavailable,
          ]}
        >
          <SunIcon size={20} color={theme.sun} />
        </View>
        <Slider
          accessibilityLabel="Sun and shade preference"
          accessibilityHint={
            sunUnavailable
              ? "Update this area to enable sun preferences"
              : "Adjusts the route from most sun to most shade"
          }
          accessibilityState={{ disabled }}
          accessibilityValue={{
            min: minimumIdx + 1,
            max: options.length,
            now: selectedIdx + 1,
            text: selected.label,
          }}
          disabled={disabled}
          minimumValue={minimumIdx + 1}
          maximumValue={options.length}
          step={1}
          tapToSeek
          value={selectedIdx + 1}
          onValueChange={(value) => onSelect(Math.max(minimumIdx, Math.round(value) - 1))}
          minimumTrackTintColor={theme.sun}
          maximumTrackTintColor={theme.shade}
          thumbTintColor={theme.accent}
          style={s.lightSlider}
        />
        <View style={[s.lightEndpointIcon, { backgroundColor: theme.shadeSoft }]}>
          <LeafIcon size={20} color={theme.shade} />
        </View>
      </View>
      <View style={s.lightEndpointLabels}>
        <Text
          maxFontSizeMultiplier={1.5}
          style={[
            T.caption,
            s.lightEndpointLabel,
            { color: theme.sun },
            sunUnavailable && s.lightEndpointUnavailable,
          ]}
        >
          Most sun
        </Text>
        <Text maxFontSizeMultiplier={1.5} style={[T.caption, s.lightEndpointLabel, s.lightEndpointLabelRight, { color: theme.shade }]}>Most shade</Text>
      </View>
    </View>
  );
}

export function RouteLegend() {
  const theme = useVampTheme();
  return (
    <GlassSurface style={s.legend} clear>
      <View style={[s.legendLine, { backgroundColor: theme.routeShade }]} />
      <Text maxFontSizeMultiplier={1.4} style={[T.caption, { color: theme.inkSoft }]}>Shaded</Text>
      <View style={[s.legendLine, { backgroundColor: theme.routeSun }]} />
      <Text maxFontSizeMultiplier={1.4} style={[T.caption, { color: theme.inkSoft }]}>Sunny</Text>
    </GlassSurface>
  );
}

export function StartDot() {
  const theme = useVampTheme();
  return (
    <View style={[s.startOuter, { borderColor: theme.accent, backgroundColor: theme.surface }]}>
      <View style={[s.startInner, { backgroundColor: theme.accent }]} />
    </View>
  );
}

export function EndDot({ children }: { children?: React.ReactNode }) {
  const theme = useVampTheme();
  return (
    <View style={[s.endCircle, { backgroundColor: theme.accentDeep, borderColor: theme.surface }]}>
      {children}
    </View>
  );
}

function routeStyles(theme: VampTheme) {
  return StyleSheet.create({
    route: {
      minHeight: 66,
      borderRadius: R.control,
      borderWidth: 1,
      borderColor: theme.separator,
      backgroundColor: theme.surface,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    routeLarge: { minHeight: 120, padding: 14 },
    routeSelected: { borderWidth: 2, borderColor: theme.accent, backgroundColor: theme.accentSoft },
    routeIcon: {
      width: 36,
      height: 36,
      borderRadius: 12,
      backgroundColor: theme.field,
      alignItems: "center",
      justifyContent: "center",
    },
    routeIconSelected: { backgroundColor: theme.accentTint },
    checkCircle: {
      width: 22,
      height: 22,
      borderRadius: R.pill,
      backgroundColor: theme.accent,
      alignItems: "center",
      justifyContent: "center",
    },
  });
}

const s = StyleSheet.create({
  glassBase: { overflow: "hidden" },
  pressed: { opacity: 0.72 },
  routeTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  routeCopy: { flex: 1, gap: 1 },
  routeLargeTitleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  routeLargeTitle: { flex: 1 },
  routeLargeMeta: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 8,
  },
  lightPreference: { gap: 1 },
  lightPreferenceDisabled: { opacity: 0.48 },
  currentPreference: {
    minHeight: 30,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: R.pill,
  },
  lightSliderRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 5 },
  lightEndpointIcon: {
    width: 36,
    height: 36,
    borderRadius: R.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  lightEndpointUnavailable: { opacity: 0.32 },
  lightSlider: { flex: 1, height: 48 },
  lightEndpointLabels: { flexDirection: "row", justifyContent: "space-between", gap: 16 },
  lightEndpointLabel: { flex: 1 },
  lightEndpointLabelRight: { textAlign: "right" },
  legend: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: R.pill,
  },
  legendLine: { width: 18, height: 4, borderRadius: R.pill },
  startOuter: {
    width: 28,
    height: 28,
    borderRadius: R.pill,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  startInner: { width: 9, height: 9, borderRadius: R.pill },
  endCircle: {
    width: 36,
    height: 36,
    borderRadius: R.pill,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
  },
});

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";

import { AppSymbol } from "./components";
import { R, T, useShadeMaxTheme, type ShadeMaxTheme } from "./theme";

const pages = [
  {
    key: "route",
    mascot: require("../assets/mascot-vamp-walk.png"),
    title: "Choose sun or shade.",
    body: "Find your kind of light on every walk.",
  },
  {
    key: "download",
    mascot: require("../assets/mascot-vamp-world.png"),
    title: "Use areas offline.",
    body: "Download an area once, then use it anytime.",
  },
  {
    key: "accuracy",
    mascot: require("../assets/mascot-vamp-accuracy.png"),
    title: "Check real conditions.",
    body: "ShadeMax estimates direct sun—not heat or UV.",
  },
] as const;

export function WelcomeScreen({
  onTrySample,
  onExplore,
}: {
  onTrySample: () => void;
  onExplore: () => void;
}) {
  const theme = useShadeMaxTheme();
  const { height, fontScale } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const compact = height < 760;
  const largeText = fontScale >= 1.35;
  const [pageIndex, setPageIndex] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(true);
  const entrance = useRef(new Animated.Value(0)).current;
  const floatY = useRef(new Animated.Value(0)).current;
  const direction = useRef(1);
  const page = pages[pageIndex];

  const goTo = (nextIndex: number) => {
    const bounded = Math.max(0, Math.min(pages.length - 1, nextIndex));
    if (bounded === pageIndex) return;
    direction.current = bounded > pageIndex ? 1 : -1;
    entrance.setValue(reduceMotion ? 1 : 0);
    setPageIndex(bounded);
  };

  const pagerPan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.25,
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dx < -42 || gesture.vx < -0.45) goTo(pageIndex + 1);
          if (gesture.dx > 42 || gesture.vx > 0.45) goTo(pageIndex - 1);
        },
      }),
    // The responder intentionally follows the current page and motion setting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageIndex, reduceMotion],
  );

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    entrance.stopAnimation();
    floatY.stopAnimation();
    if (reduceMotion) {
      entrance.setValue(1);
      floatY.setValue(0);
      return;
    }

    entrance.setValue(0);
    Animated.spring(entrance, {
      toValue: 1,
      damping: 18,
      stiffness: 150,
      mass: 0.8,
      useNativeDriver: true,
    }).start();

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(floatY, {
          toValue: -6,
          duration: 1800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(floatY, {
          toValue: 0,
          duration: 1800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [entrance, floatY, pageIndex, reduceMotion]);

  const tilt = floatY.interpolate({
    inputRange: [-6, 0],
    outputRange: ["-1deg", "1deg"],
  });
  const entranceScale = entrance.interpolate({
    inputRange: [0, 1],
    outputRange: [0.96, 1],
  });
  const entranceX = entrance.interpolate({
    inputRange: [0, 1],
    outputRange: [direction.current * 22, 0],
  });
  const isLastPage = pageIndex === pages.length - 1;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={[styles.content, compact && styles.contentCompact]}>
        <View style={styles.wordmarkRow}>
          <View style={styles.wordmarkIdentity}>
            <View style={styles.wordmarkIcon}>
              <AppSymbol name="moon.stars.fill" size={20} color={theme.accentDeep} />
            </View>
            <Text
              accessibilityRole="header"
              maxFontSizeMultiplier={1.6}
              style={[T.title, largeText && styles.wordmarkLargeText, { color: theme.ink }]}
            >
              ShadeMax
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Skip introduction and plan a walk"
            onPress={onExplore}
            style={({ pressed }) => [styles.skipButton, pressed && styles.pressed]}
          >
            <Text style={[T.footnote, { color: theme.accentDeep }]}>Skip</Text>
          </Pressable>
        </View>

        <View {...pagerPan.panHandlers} style={styles.story}>
          <View
            style={[
              styles.heroFrame,
              compact && styles.heroCompact,
              largeText && styles.heroLargeText,
              {
                backgroundColor:
                  page.key === "download"
                    ? theme.shadeSoft
                    : page.key === "accuracy"
                      ? theme.sunSoft
                      : theme.accentSoft,
              },
            ]}
          >
            <View style={styles.heroMoon} />
            {page.key === "route" && (
              <>
                <Svg accessible={false} pointerEvents="none" style={StyleSheet.absoluteFill} viewBox="0 0 360 320">
                  <Path
                    d="M 28 278 C 92 252, 108 210, 164 228 S 255 244, 332 152"
                    fill="none"
                    stroke={theme.surface}
                    strokeLinecap="round"
                    strokeWidth={17}
                  />
                  <Path
                    d="M 28 278 C 92 252, 108 210, 164 228 S 255 244, 332 152"
                    fill="none"
                    stroke={theme.sun}
                    strokeLinecap="round"
                    strokeWidth={9}
                  />
                  <Path
                    d="M 28 278 C 92 252, 108 210, 164 228 S 255 244, 332 152"
                    fill="none"
                    stroke={theme.shade}
                    strokeDasharray="88 22 24 18"
                    strokeLinecap="round"
                    strokeWidth={9}
                  />
                </Svg>
                <View style={styles.sceneIcon}>
                  <AppSymbol name="sun.max.fill" size={22} color={theme.sun} />
                </View>
              </>
            )}
            {page.key === "download" && (
              <View style={styles.sceneIcon}>
                <AppSymbol name="arrow.down.circle.fill" size={22} color={theme.shade} />
              </View>
            )}
            {page.key === "accuracy" && (
              <View style={styles.sceneIcon}>
                <AppSymbol name="checkmark.shield.fill" size={22} color={theme.sun} />
              </View>
            )}
            <Animated.Image
              key={page.key}
              accessibilityIgnoresInvertColors
              accessible={false}
              source={page.mascot}
              resizeMode="contain"
              style={[
                styles.mascot,
                page.key !== "route" && styles.mascotStill,
                {
                  opacity: entrance,
                  transform: [
                    { translateX: entranceX },
                    { translateY: floatY },
                    { rotate: tilt },
                    { scale: entranceScale },
                  ],
                },
              ]}
            />
          </View>

          <View accessibilityLiveRegion="polite" style={styles.copy}>
            <Text
              accessibilityRole="header"
              maxFontSizeMultiplier={1.8}
              style={[T.largeTitle, styles.title, largeText && styles.titleLargeText, { color: theme.ink }]}
            >
              {page.title}
            </Text>
            <Text
              maxFontSizeMultiplier={1.8}
              style={[T.body, styles.body, largeText && styles.bodyLargeText, { color: theme.inkSoft }]}
            >
              {page.body}
            </Text>
          </View>
        </View>

        <View style={styles.pagerRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous introduction page"
            accessibilityState={{ disabled: pageIndex === 0 }}
            disabled={pageIndex === 0}
            hitSlop={6}
            onPress={() => goTo(pageIndex - 1)}
            style={({ pressed }) => [
              styles.pagerArrow,
              { backgroundColor: theme.field },
              pageIndex === 0 && styles.pagerArrowHidden,
              pressed && styles.pressed,
            ]}
          >
            <AppSymbol name="chevron.left" size={17} color={theme.inkSoft} />
            <Text style={[T.footnote, { color: theme.inkSoft }]}>Back</Text>
          </Pressable>

          <View accessibilityRole="radiogroup" accessibilityLabel="Introduction pages" style={styles.pageToggle}>
            {pages.map((item, index) => {
              const selected = index === pageIndex;
              return (
                <Pressable
                  key={item.key}
                  accessibilityRole="radio"
                  accessibilityLabel={`${item.title} Page ${index + 1} of ${pages.length}`}
                  accessibilityState={{ checked: selected, selected }}
                  hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
                  onPress={() => goTo(index)}
                  style={styles.pageSegmentButton}
                >
                  <View
                    style={[
                      styles.pageSegment,
                      { backgroundColor: selected ? theme.accent : theme.separator },
                    ]}
                  />
                </Pressable>
              );
            })}
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next introduction page"
            accessibilityState={{ disabled: isLastPage }}
            disabled={isLastPage}
            hitSlop={6}
            onPress={() => goTo(pageIndex + 1)}
            style={({ pressed }) => [
              styles.pagerArrow,
              { backgroundColor: theme.accent },
              isLastPage && styles.pagerArrowHidden,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[T.footnote, { color: theme.onAccent }]}>Next</Text>
            <AppSymbol name="chevron.right" size={17} color={theme.onAccent} />
          </Pressable>
        </View>

        {isLastPage && (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              onPress={onTrySample}
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
            >
              <Text
                maxFontSizeMultiplier={1.7}
                style={[T.headline, largeText && styles.actionTextLarge, { color: theme.onAccent }]}
              >
                See an example
              </Text>
              <AppSymbol name="arrow.right" size={18} color={theme.onAccent} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={onExplore}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              <Text
                maxFontSizeMultiplier={1.7}
                style={[T.headline, largeText && styles.actionTextLarge, { color: theme.accentDeep }]}
              >
                Plan a walk
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

function makeStyles(theme: ShadeMaxTheme) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: theme.canvas },
    content: { flex: 1, paddingHorizontal: 24, paddingTop: 8, paddingBottom: 16 },
    contentCompact: { paddingTop: 2 },
    wordmarkRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    wordmarkIdentity: { flexDirection: "row", alignItems: "center", gap: 9 },
    wordmarkIcon: {
      width: 38,
      height: 38,
      borderRadius: 13,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.accentSoft,
    },
    skipButton: { minWidth: 56, minHeight: 44, alignItems: "center", justifyContent: "center" },
    story: { flex: 1, justifyContent: "center" },
    heroFrame: {
      height: 360,
      marginTop: 6,
      marginHorizontal: -8,
      overflow: "hidden",
      borderRadius: R.card,
    },
    heroCompact: { height: 255 },
    heroLargeText: { height: 245, marginHorizontal: 0 },
    heroMoon: {
      position: "absolute",
      width: 265,
      height: 265,
      borderRadius: R.pill,
      top: 20,
      alignSelf: "center",
      backgroundColor: theme.surface,
      opacity: theme.isDark ? 0.34 : 0.72,
    },
    sceneIcon: {
      position: "absolute",
      top: 24,
      right: 26,
      width: 48,
      height: 48,
      borderRadius: R.pill,
      backgroundColor: theme.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    mascot: {
      position: "absolute",
      width: "94%",
      height: "94%",
      left: "3%",
      bottom: 0,
    },
    mascotStill: { width: "88%", height: "88%", left: "6%", bottom: "1%" },
    copy: { alignItems: "center", gap: 8, marginTop: 8, minHeight: 92 },
    wordmarkLargeText: { fontSize: 28, lineHeight: 34 },
    title: { textAlign: "center", letterSpacing: -0.7 },
    titleLargeText: { fontSize: 38, lineHeight: 45 },
    body: { textAlign: "center", maxWidth: 460 },
    bodyLargeText: { fontSize: 20, lineHeight: 27 },
    actionTextLarge: { fontSize: 19, lineHeight: 24 },
    pagerRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 14 },
    pagerArrow: {
      width: 80,
      height: 44,
      borderRadius: R.pill,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
    },
    pagerArrowHidden: { opacity: 0 },
    pageToggle: {
      flex: 1,
      height: 36,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: 8,
      borderRadius: R.pill,
      backgroundColor: theme.field,
    },
    pageSegmentButton: { flex: 1, height: 36, alignItems: "center", justifyContent: "center" },
    pageSegment: { width: "100%", height: 6, borderRadius: R.pill },
    actions: { gap: 8, marginTop: 8 },
    primary: {
      minHeight: 54,
      paddingHorizontal: 20,
      borderRadius: R.control,
      backgroundColor: theme.accent,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 9,
    },
    secondary: {
      minHeight: 48,
      paddingHorizontal: 20,
      borderRadius: R.control,
      backgroundColor: theme.accentSoft,
      alignItems: "center",
      justifyContent: "center",
    },
    pressed: { opacity: 0.7 },
  });
}

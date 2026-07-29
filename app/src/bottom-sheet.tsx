import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppSymbol } from "./components";
import { R, T, useVampTheme } from "./theme";

export function BottomSheet({
  expanded,
  collapsedHeight,
  collapsedLabel = "Route options",
  expandedLabel = "Hide options",
  onExpandedChange,
  onVisibleHeightChange,
  children,
}: {
  expanded: boolean;
  collapsedHeight: number;
  collapsedLabel?: string;
  expandedLabel?: string;
  onExpandedChange: (expanded: boolean) => void;
  onVisibleHeightChange?: (height: number) => void;
  children: React.ReactNode;
}) {
  const theme = useVampTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const maxHeight = Math.max(collapsedHeight, Math.min(height - insets.top - 72, 720));
  // `collapsedHeight` already describes the visible sheet, including the
  // home-indicator area. Adding the inset again makes Expo-hosted sheets much
  // taller than their intended detent.
  const safeCollapsedHeight = Math.min(collapsedHeight, maxHeight);
  const collapsedY = maxHeight - safeCollapsedHeight;
  const translateY = useRef(new Animated.Value(expanded ? 0 : collapsedY)).current;
  const startY = useRef(expanded ? 0 : collapsedY);
  const currentY = useRef(expanded ? 0 : collapsedY);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const id = translateY.addListener(({ value }) => {
      currentY.current = value;
    });
    return () => translateY.removeListener(id);
  }, [translateY]);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => subscription.remove();
  }, []);

  const snap = (nextExpanded: boolean) => {
    const toValue = nextExpanded ? 0 : collapsedY;
    onExpandedChange(nextExpanded);
    onVisibleHeightChange?.(nextExpanded ? maxHeight : safeCollapsedHeight);
    if (reduceMotion) {
      translateY.setValue(toValue);
      return;
    }
    Animated.spring(translateY, {
      toValue,
      useNativeDriver: true,
      damping: 24,
      stiffness: 240,
      mass: 0.9,
    }).start();
  };

  useEffect(() => {
    const toValue = expanded ? 0 : collapsedY;
    translateY.setValue(toValue);
    currentY.current = toValue;
    onVisibleHeightChange?.(expanded ? maxHeight : safeCollapsedHeight);
  }, [collapsedY, expanded, maxHeight, onVisibleHeightChange, safeCollapsedHeight, translateY]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 5,
        onPanResponderGrant: () => {
          translateY.stopAnimation((value) => {
            startY.current = value;
          });
        },
        onPanResponderMove: (_, gesture) => {
          const next = Math.max(0, Math.min(collapsedY, startY.current + gesture.dy));
          translateY.setValue(next);
        },
        onPanResponderRelease: (_, gesture) => {
          const shouldExpand = gesture.vy < -0.35 || (gesture.vy < 0.35 && currentY.current < collapsedY * 0.55);
          snap(shouldExpand);
        },
        onPanResponderTerminate: () => snap(expanded),
      }),
    // `snap` intentionally reads the latest render values through this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collapsedY, expanded, reduceMotion],
  );

  return (
    <Animated.View
      style={[
        styles.sheet,
        {
          height: maxHeight,
          backgroundColor: theme.surface,
          borderColor: theme.separator,
          transform: [{ translateY }],
        },
      ]}
    >
      <View {...panResponder.panHandlers} style={styles.handleZone}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? expandedLabel : collapsedLabel}
          accessibilityHint="Tap to show or hide detailed route controls. Swiping is optional."
          accessibilityState={{ expanded }}
          hitSlop={8}
          onPress={() => snap(!expanded)}
          style={[styles.handleButton, { backgroundColor: theme.field }]}
        >
          <Text maxFontSizeMultiplier={1.5} style={[T.footnote, { color: theme.inkSoft }]}>
            {expanded ? expandedLabel : collapsedLabel}
          </Text>
          <AppSymbol
            name={expanded ? "chevron.down" : "chevron.up"}
            size={13}
            color={theme.inkSoft}
          />
        </Pressable>
      </View>
      <View style={[styles.content, { paddingBottom: Math.max(insets.bottom, 10) }]}>{children}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: R.sheet,
    borderTopRightRadius: R.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#241F23",
    shadowOpacity: 0.17,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -8 },
    elevation: 12,
    overflow: "hidden",
  },
  handleZone: { height: 50, alignItems: "center", justifyContent: "center" },
  handleButton: {
    minWidth: 132,
    height: 44,
    paddingHorizontal: 14,
    borderRadius: R.pill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  content: { flex: 1 },
});

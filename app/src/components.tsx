import React from "react";
import { Pressable, StyleSheet, Text, View, ViewStyle } from "react-native";
import { C, R, T } from "./theme";
import { meltEmoji } from "./melt";

/** Thin exposure progress bar — the only place the sun color appears in chrome. */
export function MeltBar({ pct }: { pct: number }) {
  return (
    <View style={s.meltRow}>
      <View style={s.meltTrack}>
        <View style={[s.meltFill, { width: `${Math.max(pct, 3)}%` }]} />
      </View>
      <Text style={[T.caption, s.meltPct]}>
        {meltEmoji(pct)} {pct}%
      </Text>
    </View>
  );
}

export function RouteRow({
  icon,
  title,
  minutes,
  meltPct: pct,
  selected,
  onPress,
}: {
  icon: React.ReactNode;
  title: string;
  minutes: number;
  meltPct: number;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[s.row, selected && s.rowSelected]}>
      <View style={s.rowTop}>
        <View style={[s.iconCircle, selected && s.iconCircleSelected]}>{icon}</View>
        <Text style={[T.body, s.rowTitle]}>{title}</Text>
        <Text style={T.display}>
          {minutes}
          <Text style={[T.caption, { color: C.inkSoft }]}> min</Text>
        </Text>
      </View>
      <MeltBar pct={pct} />
    </Pressable>
  );
}

export function MoodPills({
  moods,
  selectedIdx,
  onSelect,
}: {
  moods: readonly { key: string; emoji: string; label: string }[];
  selectedIdx: number;
  onSelect: (i: number) => void;
}) {
  return (
    <View style={s.moodRow}>
      {moods.map((m, i) => (
        <Pressable
          key={m.key}
          onPress={() => onSelect(i)}
          style={[s.moodPill, i === selectedIdx && s.moodPillSelected]}
        >
          <Text style={{ fontSize: 15 }}>{m.emoji}</Text>
          <Text style={[T.caption, i === selectedIdx && s.moodTextSelected]}>{m.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Map markers */
export function StartDot() {
  return (
    <View style={s.startOuter}>
      <View style={s.startInner} />
    </View>
  );
}

export function EndDot({ children }: { children?: React.ReactNode }) {
  return <View style={s.endCircle}>{children}</View>;
}

export function Card({ style, children }: { style?: ViewStyle; children: React.ReactNode }) {
  return <View style={[s.card, style]}>{children}</View>;
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.scrim,
    borderRadius: R,
    padding: 20,
  },
  meltRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 },
  meltTrack: {
    flex: 1,
    height: 6,
    borderRadius: 999,
    backgroundColor: C.sunSoft,
    overflow: "hidden",
  },
  meltFill: { height: 6, borderRadius: 999, backgroundColor: C.sun },
  meltPct: { minWidth: 52, textAlign: "right" },

  row: {
    borderRadius: R,
    borderWidth: 1.5,
    borderColor: C.hairline,
    padding: 16,
  },
  rowSelected: { borderColor: C.accent, backgroundColor: C.accentSoft },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowTitle: { flex: 1 },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 999,
    backgroundColor: C.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  iconCircleSelected: { backgroundColor: C.accentTint },

  moodRow: { flexDirection: "row", gap: 8 },
  moodPill: {
    flex: 1,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "rgba(18,33,31,0.04)",
  },
  moodPillSelected: { backgroundColor: C.accentSoft, borderWidth: 1.5, borderColor: C.accentTint },
  moodTextSelected: { color: C.accent },

  startOuter: {
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: C.paper,
    borderWidth: 2.5,
    borderColor: C.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  startInner: { width: 8, height: 8, borderRadius: 999, backgroundColor: C.accent },
  endCircle: {
    width: 30,
    height: 30,
    borderRadius: 999,
    backgroundColor: C.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2.5,
    borderColor: C.paper,
  },
});

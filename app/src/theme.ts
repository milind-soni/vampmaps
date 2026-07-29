import { useColorScheme } from "react-native";

/** Data colors stay stable across appearances; interface colors are semantic. */
export const DATA = {
  shade: "#166D62",
  shadeBright: "#0E746A",
  sun: "#A65B1B",
  sunBright: "#B45F1D",
  action: "#62305E",
  success: "#166D62",
} as const;

export const LIGHT = {
  isDark: false,
  accent: DATA.action,
  onAccent: "#FFFFFF",
  accentSoft: "#F3EAF1",
  accentTint: "#E5D1E1",
  accentDeep: "#4E234B",
  shade: DATA.shade,
  shadeSoft: "#E7F1EE",
  shadeTint: "#CDE4DE",
  ink: "#241F23",
  inkSoft: "#655D63",
  inkMuted: "#746C72",
  separator: "rgba(36,31,35,0.12)",
  canvas: "#F7F5F2",
  surface: "#FFFEFC",
  elevated: "rgba(255,254,252,0.94)",
  field: "#F0EEEB",
  sun: DATA.sun,
  sunSoft: "#F8EBDD",
  routeShade: "#0E746A",
  routeSun: "#B45F1D",
  routeFast: "#4D474C",
  routeCasing: "#FFFEFC",
  routeDim: "rgba(77,71,76,0.64)",
  success: DATA.success,
  successSoft: "#E7F1EE",
  danger: "#A54139",
  dangerSoft: "#F7E9E7",
} as const;

export const DARK = {
  isDark: true,
  accent: "#D7AAD3",
  onAccent: "#2A1627",
  accentSoft: "#332631",
  accentTint: "#4B3748",
  accentDeep: "#E8C7E5",
  shade: "#69C5B2",
  shadeSoft: "#17332E",
  shadeTint: "#244D45",
  ink: "#F5F0F4",
  inkSoft: "#C9C1C7",
  inkMuted: "#A69EA4",
  separator: "rgba(245,240,244,0.14)",
  canvas: "#141214",
  surface: "#1C191C",
  elevated: "rgba(28,25,28,0.94)",
  field: "#272327",
  sun: "#F1B166",
  sunSoft: "#3A2B1C",
  routeShade: "#58C2AE",
  routeSun: "#F0AE5D",
  routeFast: "#D8D1D7",
  routeCasing: "#141214",
  routeDim: "rgba(216,209,215,0.62)",
  success: "#69C5B2",
  successSoft: "#17332E",
  danger: "#FFB0A8",
  dangerSoft: "#402624",
} as const;

export type ShadeMaxTheme = typeof LIGHT | typeof DARK;

export function useShadeMaxTheme(): ShadeMaxTheme {
  return useColorScheme() === "dark" ? DARK : LIGHT;
}

/** Light aliases retained for map data helpers and non-React code. */
export const C = {
  accent: LIGHT.accent,
  accentRoute: LIGHT.routeShade,
  accentSoft: LIGHT.accentSoft,
  accentTint: LIGHT.accentTint,
  accentDeep: LIGHT.accentDeep,
  ink: LIGHT.ink,
  inkSoft: LIGHT.inkSoft,
  inkMuted: LIGHT.inkMuted,
  hairline: LIGHT.separator,
  paper: LIGHT.surface,
  canvas: LIGHT.canvas,
  scrim: LIGHT.elevated,
  sun: LIGHT.sun,
  sunRoute: LIGHT.routeSun,
  sunSoft: LIGHT.sunSoft,
  routeDim: LIGHT.routeDim,
  success: LIGHT.success,
  successSoft: LIGHT.successSoft,
} as const;

export const R = { sheet: 30, card: 22, control: 16, small: 12, pill: 999 } as const;

export const F = {
  regular: "OpenRunde-Regular",
  medium: "OpenRunde-Medium",
  semibold: "OpenRunde-Semibold",
  bold: "OpenRunde-Bold",
} as const;

/** Semantic iOS-scale typography. Open Runde is reserved for ShadeMax's voice. */
export const T = {
  caption: { fontSize: 12, lineHeight: 16, fontFamily: F.medium } as const,
  footnote: { fontSize: 13, lineHeight: 18, fontFamily: F.medium } as const,
  subheadline: { fontSize: 15, lineHeight: 20, fontFamily: F.medium } as const,
  body: { fontSize: 17, lineHeight: 22, fontFamily: F.medium } as const,
  headline: { fontSize: 17, lineHeight: 22, fontFamily: F.semibold } as const,
  title: { fontSize: 22, lineHeight: 27, fontFamily: F.bold } as const,
  largeTitle: { fontSize: 34, lineHeight: 40, fontFamily: F.bold } as const,
  metric: { fontSize: 28, lineHeight: 32, fontFamily: F.bold } as const,
};

export const shadow = {
  shadowColor: "#241F23",
  shadowOpacity: 0.14,
  shadowRadius: 20,
  shadowOffset: { width: 0, height: 9 },
  elevation: 8,
} as const;

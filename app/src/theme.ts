/** Design tokens. One accent + tints, one radius, three type sizes. */

export const C = {
  accent: "#0E9594",
  accentSoft: "rgba(14,149,148,0.10)",
  accentTint: "rgba(14,149,148,0.22)",

  ink: "#12211F",
  inkSoft: "#5F6E6C",
  hairline: "rgba(18,33,31,0.08)",

  paper: "#FFFFFF",
  scrim: "rgba(255,255,255,0.96)",

  // data colors — reserved for sun exposure, never UI chrome
  sun: "#FF7A2F",
  sunSoft: "rgba(255,122,47,0.14)",

  routeDim: "rgba(18,33,31,0.28)",
} as const;

/** The one corner radius. Pills use 999. */
export const R = 20;

export const F = {
  regular: "OpenRunde-Regular",
  medium: "OpenRunde-Medium",
  semibold: "OpenRunde-Semibold",
  bold: "OpenRunde-Bold",
} as const;

/** Three sizes only. */
export const T = {
  caption: { fontSize: 13, fontFamily: F.medium, color: C.inkSoft } as const,
  body: { fontSize: 15, fontFamily: F.semibold, color: C.ink } as const,
  display: { fontSize: 24, fontFamily: F.bold, color: C.ink } as const,
};

export const shadow = {
  shadowColor: "#0A1514",
  shadowOpacity: 0.12,
  shadowRadius: 16,
  shadowOffset: { width: 0, height: 6 },
  elevation: 6,
} as const;

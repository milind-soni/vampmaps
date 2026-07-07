/** Playful melt scoring: sun-minutes -> melt percentage + emoji + copy. */

export function meltPct(sunMin: number): number {
  return Math.min(100, Math.round(100 * (1 - Math.exp(-sunMin / 12))));
}

export function meltEmoji(pct: number): string {
  if (pct < 15) return "🧊";
  if (pct < 35) return "🍦";
  if (pct < 60) return "🫠";
  if (pct < 85) return "🥵";
  return "💀";
}

export function meltLabel(pct: number): string {
  if (pct < 15) return "fresh out of the freezer";
  if (pct < 35) return "lightly toasted";
  if (pct < 60) return "getting drippy";
  if (pct < 85) return "seriously melting";
  return "a puddle with shoes";
}

export function savingsCopy(extraMin: number, sunSavedMin: number): string {
  const extra = Math.max(0, Math.round(extraMin));
  const saved = Math.max(0, Math.round(sunSavedMin));
  if (saved <= 0) return "Same sun either way — it's your call ☁️";
  if (extra <= 0) return `Shady route saves ${saved} sun-min and it's not even slower 😎`;
  return `+${extra} min buys you ${saved} fewer minutes in the sun 🧊`;
}

/** Sun-aversion presets. Weight multiplies exposure in the edge cost. */
export const MOODS = [
  { key: "chill", emoji: "😎", label: "Chill", weight: 1 },
  { key: "melting", emoji: "🥵", label: "Melting", weight: 2.5 },
  { key: "vampire", emoji: "🧛", label: "Vampire", weight: 15 },
] as const;

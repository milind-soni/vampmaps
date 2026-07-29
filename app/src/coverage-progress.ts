import type { CoverageAreaState, CoverageDownloadProgress } from "./coverage-client";

export type CoverageProgressAction =
  | "idle"
  | "checking"
  | "fetching"
  | "requesting"
  | "requested";

export type CoverageProgressPresentation = {
  stage: "checking" | "downloading" | "verifying" | "opening" | "requesting";
  label: string;
  indicator: "indeterminate" | "determinate";
  fraction: number | null;
  bytesWritten: number | null;
  totalBytes: number | null;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function normalizeCoverageProgress(
  progress: CoverageDownloadProgress | undefined,
  expectedBytes: number | undefined,
): Pick<CoverageProgressPresentation, "fraction" | "bytesWritten" | "totalBytes"> {
  const expected = typeof expectedBytes === "number" && Number.isFinite(expectedBytes) && expectedBytes > 0
    ? Math.round(expectedBytes)
    : null;
  const reportedTotalValue = progress?.totalBytes;
  const reportedTotal = typeof reportedTotalValue === "number" &&
    Number.isFinite(reportedTotalValue) &&
    reportedTotalValue > 0
    ? Math.round(reportedTotalValue)
    : null;
  const totalBytes = reportedTotal ?? expected;
  const reportedBytesWritten = progress?.bytesWritten;
  const rawWritten = typeof reportedBytesWritten === "number" && Number.isFinite(reportedBytesWritten)
    ? Math.max(0, Math.round(reportedBytesWritten))
    : 0;
  const bytesWritten = totalBytes === null ? rawWritten : Math.min(rawWritten, totalBytes);
  const reportedFractionValue = progress?.fraction;
  const reportedFraction = typeof reportedFractionValue === "number" && Number.isFinite(reportedFractionValue)
    ? clamp01(reportedFractionValue)
    : null;
  const fraction = totalBytes === null
    ? reportedFraction
    : clamp01(bytesWritten / totalBytes);
  return { fraction, bytesWritten, totalBytes };
}

/** Keep an in-flight operation attached to its original area as map state changes. */
export function coverageOperationArea(
  areas: readonly CoverageAreaState[],
  targetAreaId: string | null,
  previewArea: CoverageAreaState | undefined,
): CoverageAreaState | undefined {
  if (!targetAreaId) return previewArea;
  return areas.find((state) => state.area.id === targetAreaId);
}

export function coverageProgressPresentation(
  action: CoverageProgressAction,
  area: CoverageAreaState | undefined,
): CoverageProgressPresentation | null {
  if (action === "checking") {
    return {
      stage: "checking",
      label: "Checking area",
      indicator: "indeterminate",
      fraction: null,
      bytesWritten: null,
      totalBytes: null,
    };
  }
  if (action === "requesting") {
    return {
      stage: "requesting",
      label: "Requesting area",
      indicator: "indeterminate",
      fraction: null,
      bytesWritten: null,
      totalBytes: null,
    };
  }
  if (area?.phase === "verifying") {
    const normalized = normalizeCoverageProgress(area.progress, area.downloadBytes);
    return {
      stage: "verifying",
      label: "Preparing area",
      indicator: "indeterminate",
      ...normalized,
    };
  }
  if (action === "fetching" && area?.phase === "ready") {
    return {
      stage: "opening",
      label: "Opening area",
      indicator: "indeterminate",
      fraction: null,
      bytesWritten: null,
      totalBytes: area.downloadBytes ?? null,
    };
  }
  if (action === "fetching" || area?.phase === "downloading") {
    const normalized = normalizeCoverageProgress(area?.progress, area?.downloadBytes);
    return {
      stage: "downloading",
      label: "Fetching area",
      indicator: normalized.fraction === null ? "indeterminate" : "determinate",
      ...normalized,
    };
  }
  return null;
}

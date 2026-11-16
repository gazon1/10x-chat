export type RoundTripCombination = { ok: boolean; detail?: unknown };

export type RoundTripState = {
  status: 'done' | 'failed' | 'partial' | 'unfinished';
  mandatory: number | null;
  attempted: number;
  passed: number;
  failed: number;
  combinations: Record<string, RoundTripCombination>;
  reason?: string;
};

export function roundTripState(
  combos: Record<string, RoundTripCombination>,
  mandatory: number | null,
  reason?: string | null,
): RoundTripState;

export function mergeRoundTrip(
  existing: RoundTripState | null | undefined,
  current: RoundTripState | null | undefined,
  mandatory: number | null,
): RoundTripState;

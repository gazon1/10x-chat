export type ReportSettings = { proxy: string | null; headless: boolean };

export function savedSettings(name: string, report: Record<string, unknown>): ReportSettings | null;

export function compatibilityIssues(
  name: string,
  report: Record<string, unknown>,
  now?: Record<string, unknown>,
): string[];

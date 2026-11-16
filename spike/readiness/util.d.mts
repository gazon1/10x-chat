export type EnvInfo = {
  node: string;
  platform: string;
  host: string;
  camoufoxPackage: string | null;
  camoufoxBrowser: string | null;
  camoufoxBrowserSha256: string | null;
  playwrightCoreSpike: string | null;
  playwrightCoreRepo: string | null;
  cloakbrowser: string | null;
  versionSources: Record<string, string | null>;
  proxyEnv: { HTTPS_PROXY: string | null; HTTP_PROXY: string | null; NO_PROXY: string | null };
};

export const REPO_ROOT: string;

export function envInfo(): EnvInfo;
export function pids(pattern: string): number[];
export function newPids(pattern: string, before?: number[]): number[];
export function alivePids(pidList: number[]): number[];
export function rssKbOfPids(pidList: number[]): number;
export function rssKb(pattern: string): number;
export function harnessSettings(matrix: string): { proxy: string | null; headless: boolean };
export function assert(cond: unknown, message: string): void;
export function sleep(ms: number): Promise<void>;

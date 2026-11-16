export function resolveDisplay(env?: Record<string, string | undefined>): string;
export function displaySocket(display: string): string;
export function displayAvailable(display: string, exists?: (p: string) => boolean): boolean;
export function harnessDisplay(options: {
  headless: boolean;
  display: string;
  exists?: (p: string) => boolean;
}): string | null;

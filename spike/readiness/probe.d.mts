export type Outcome =
  | 'infra-error'
  | 'cloudflare'
  | 'auth-wall'
  | 'composer-visible'
  | 'provider-error';

export type ClassifyInput = {
  status?: number;
  title?: string;
  url?: string;
  cfVisible?: boolean;
  loginVisible?: boolean;
  composerVisible?: boolean;
};

export const LOGIN_URL: RegExp;
export const CF_TITLE: RegExp;
export const SIGNUP_WALL: RegExp;

export function classifyOutcome(input?: ClassifyInput): Outcome;
export function newMarker(prefix?: string): string;
export function probePrompt(marker: string): string;
export function newAnswerIndex(before: number, after: number): number;
export function containsMarker(text: unknown, marker: unknown): boolean;

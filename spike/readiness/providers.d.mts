export type Provider = {
  name: string;
  url: string;
  runs: number;
  cloudflare: boolean;
  composer: string;
  send: string;
  response: string;
  login: string;
};

export const PROVIDERS: Provider[];

export function selectorAlternatives(selector: string): string[];
export function alternativeContainer(alternative: string): string;

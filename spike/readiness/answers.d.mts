export type MatchedElement = {
  /** The path of the element from the document root, e.g. `0.5.1`. */
  path: string;
  /** The text of the element. */
  text: string;
};

export function topLevelAnswers(entries: MatchedElement[]): MatchedElement[];
export function answerSnapshot(entries: MatchedElement[]): { count: number; texts: string[] };

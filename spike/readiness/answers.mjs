/**
 * Counting the answers on a provider page.
 *
 * A provider selector can match two DOM levels of the same answer: the
 * container of the answer and the text inside it. Every matched element is
 * therefore reduced to the outermost one — the answer container — so that one
 * answer is counted once and not twice.
 */

/**
 * @typedef {{path: string, text: string}} MatchedElement
 *   a matched element with its path from the document root
 */

/**
 * Keep the outermost of the matched elements.
 *
 * The elements arrive in document order, so a container always comes before
 * its descendants. An element whose path starts with the path of an already
 * kept element is inside it and therefore part of the same answer.
 *
 * @param {MatchedElement[]} entries the matched elements
 * @returns {MatchedElement[]} one entry per answer
 */
export function topLevelAnswers(entries) {
  const kept = [];
  for (const entry of entries) {
    const nested = kept.some((outer) => entry.path.startsWith(`${outer.path}.`));
    if (nested) continue;
    kept.push(entry);
  }
  return kept;
}

/**
 * The answers of a provider page: how many and what they say.
 *
 * @param {MatchedElement[]} entries the matched elements of the page
 * @returns {{count: number, texts: string[]}} the answers of the page
 */
export function answerSnapshot(entries) {
  const answers = topLevelAnswers(entries);
  return { count: answers.length, texts: answers.map((answer) => answer.text.trim()) };
}

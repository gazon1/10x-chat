/**
 * The cost/coverage profiles of a review.
 *
 * A profile selects the **stages** of the pipeline and the **gate** of the
 * verdict. It never changes a stage: the prompts, the schema and the
 * verification are the same under every profile, and no profile merges two
 * reviewer roles into one prompt.
 *
 * The model-backed stages dominate the latency of a review
 * (`docs/review-pipeline.md`), and the context collection is negligible: a
 * cheaper profile omits model work, and says so — it never shortcuts a stage
 * it still runs.
 */

import type { ReviewProfile, ReviewRole } from './types.js';

/** The profiles, from the cheapest to the most demanding. */
export const REVIEW_PROFILES: readonly ReviewProfile[] = ['quick', 'standard', 'deep', 'critical'];

/** The profile of a review that names none — today's full review. */
export const DEFAULT_REVIEW_PROFILE: ReviewProfile = 'standard';

/** What a profile runs, and what its verdict gate asks. */
export interface ReviewProfileCoverage {
  /** The reviewer passes of the profile. */
  roles: ReviewRole[];
  /** Whether the candidate findings are verified against the source. */
  verification: boolean;
  /** Whether the advisory post-review assessment runs. */
  assessment: boolean;
  /** Whether a finding the verification left unverified asks for changes. */
  settleEveryFinding: boolean;
  /** Whether the change must have the Issue that governs it. */
  requiresIssue: boolean;
}

/**
 * The coverage of every profile.
 *
 * `deep` and `critical` add no stage on purpose: the pipeline has no further
 * reviewer pass that would not repeat a role or turn a retry into a "second
 * review" — they raise the gate instead, so that no hypothesis leaves the
 * review unsettled. `critical` additionally requires the governing Issue: a
 * change nobody wrote the requirements for cannot be judged critically.
 */
export const REVIEW_PROFILE_COVERAGE: Record<ReviewProfile, ReviewProfileCoverage> = {
  quick: {
    roles: ['correctness'],
    verification: false,
    assessment: false,
    settleEveryFinding: false,
    requiresIssue: false,
  },
  standard: {
    roles: ['correctness', 'architecture', 'tests'],
    verification: true,
    assessment: true,
    settleEveryFinding: false,
    requiresIssue: false,
  },
  deep: {
    roles: ['correctness', 'architecture', 'tests'],
    verification: true,
    assessment: true,
    settleEveryFinding: true,
    requiresIssue: false,
  },
  critical: {
    roles: ['correctness', 'architecture', 'tests'],
    verification: true,
    assessment: true,
    settleEveryFinding: true,
    requiresIssue: true,
  },
};

/** Whether a value names a profile. */
export function isReviewProfile(value: string): value is ReviewProfile {
  return (REVIEW_PROFILES as readonly string[]).includes(value);
}

/**
 * The profile a record names, when this version knows it.
 *
 * A record arrives from outside the type system: another version wrote it, or
 * a hand edited it. Three cases, and they do not mean the same thing:
 *
 * - **absent** — a record from before the profiles existed, and it ran the
 *   full review: `standard`, and named so.
 * - **known** — its own profile.
 * - **unknown** — a name this version cannot read, which may be a cheaper
 *   profile of a newer version. It stays `undefined`: reading it as `standard`
 *   would present a review of unknown coverage as the full review.
 *
 * The live pipeline refuses an unknown name outright (see `runReviewPipeline`).
 */
export function knownProfile(profile: string | undefined): ReviewProfile | undefined {
  if (profile === undefined) return DEFAULT_REVIEW_PROFILE;
  return isReviewProfile(profile) ? profile : undefined;
}

/** The coverage of one of the four profiles of this version. */
export function coverageOf(profile: ReviewProfile): ReviewProfileCoverage {
  return REVIEW_PROFILE_COVERAGE[profile];
}

/**
 * The profile a run of an unknown name is refused with.
 *
 * A typo must not quietly become the full review any more than it may become
 * a cheap one: the pipeline names the value and the four profiles it accepts.
 */
export function invalidProfileError(value: unknown): Error {
  return new Error(
    `Unknown review profile: ${JSON.stringify(value)} (expected one of: ${REVIEW_PROFILES.join(', ')})`,
  );
}

/**
 * What a profile covers, in one line — the omitted stages are named.
 *
 * A reader of the report has to know what the verdict is worth: a quick run
 * that found nothing has not approved the change, and the line says why.
 */
export function profileCoverage(profile: ReviewProfile): string {
  switch (profile) {
    case 'quick':
      return 'the correctness pass only — the architecture and tests passes, the verification of the findings and the advisory assessment are not run, so this review cannot approve a change';
    case 'deep':
      return 'the full review, with a stricter gate — a finding the verification leaves unverified asks for changes, whatever its severity';
    case 'critical':
      return 'the full review against the Issue that governs the change, with a stricter gate — a finding the verification leaves unverified asks for changes, whatever its severity';
    default:
      return 'the full review — three isolated passes, the verification of every finding and the advisory assessment';
  }
}

/**
 * State of the §4 criterion: the authorized prompt/response round-trip.
 *
 * The criterion covers every provider on every engine, so it is only "done"
 * when every mandatory combination passed. Pure logic, kept apart from the
 * browser code so it can be unit-tested without launching anything.
 *
 * A combination can be *skipped*: a provider without credentials cannot be
 * measured at all (the browser is sent to the login page). A skipped
 * combination is not a pass and not a failure — it keeps the criterion from
 * being "done" and is counted separately.
 */

/**
 * @param {Record<string, {ok: boolean, skipped?: boolean, detail?: unknown}>} combos
 * @param {number|null} mandatory how many combinations the criterion requires
 * @param {string|null} reason why the criterion is not attemptable (e.g. no credentials)
 */
export function roundTripState(combos, mandatory, reason = null) {
  const values = Object.values(combos ?? {});
  const skipped = values.filter((c) => c?.skipped).length;
  const measured = values.filter((c) => !c?.skipped);
  const passed = measured.filter((c) => c.ok).length;
  const failed = measured.filter((c) => !c.ok).length;
  const attempted = passed + failed;
  let status;
  if (attempted === 0) {
    // Nothing could be measured: either the criterion cannot be attempted at
    // all (no credentials) or it was interrupted.
    status = reason || skipped > 0 ? 'unfinished' : 'partial';
  } else if (failed > 0) {
    status = 'failed';
  } else if (skipped > 0) {
    // Everything that could be measured passed, but the criterion needs all
    // mandatory combinations.
    status = 'partial';
  } else if (mandatory && attempted < mandatory) {
    status = 'partial';
  } else {
    status = 'done';
  }
  return {
    status,
    mandatory: mandatory ?? null,
    attempted,
    passed,
    failed,
    skipped,
    combinations: combos ?? {},
    // The reason belongs to an attempt that could not be made; once something
    // was attempted it would be misleading (e.g. a stale "no credentials").
    ...(reason && attempted === 0 ? { reason } : {}),
  };
}

/**
 * Merge the combinations of two runs (a per-engine run must not erase the
 * other engine's data) and derive the criterion state.
 */
export function mergeRoundTrip(existing, current, mandatory) {
  const combinations = {
    ...(existing?.combinations ?? {}),
    ...(current?.combinations ?? {}),
  };
  const measured = Object.values(combinations).filter((c) => !c?.skipped).length;
  // The reason belongs to a criterion that could not be attempted at all.
  // As soon as the merged set contains a measurement, an older reason ("no
  // storage state found") would be stale and misleading.
  const reason = measured > 0 ? null : (current?.reason ?? existing?.reason ?? null);
  return roundTripState(
    combinations,
    mandatory ?? current?.mandatory ?? existing?.mandatory ?? null,
    reason,
  );
}

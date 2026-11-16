/**
 * State of the §4 criterion: the authorized prompt/response round-trip.
 *
 * The criterion covers every provider on every engine, so it is only "done"
 * when every mandatory combination passed. Pure logic, kept apart from the
 * browser code so it can be unit-tested without launching anything.
 */

/**
 * @param {Record<string, {ok: boolean, detail?: unknown}>} combos
 * @param {number|null} mandatory how many combinations the criterion requires
 * @param {string|null} reason why the criterion is not attemptable (e.g. no credentials)
 */
export function roundTripState(combos, mandatory, reason = null) {
  const values = Object.values(combos ?? {});
  const passed = values.filter((c) => c.ok).length;
  const failed = values.filter((c) => !c.ok).length;
  const attempted = passed + failed;
  let status;
  if (attempted === 0) {
    // Nothing was attempted: either the criterion cannot be attempted at all
    // (no credentials) or it was interrupted.
    status = reason ? 'unfinished' : 'partial';
  } else if (failed > 0) {
    status = 'failed';
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
  return roundTripState(
    combinations,
    mandatory ?? current?.mandatory ?? existing?.mandatory ?? null,
    current?.reason ?? existing?.reason ?? null,
  );
}

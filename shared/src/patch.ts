/**
 * The keys of `patch` whose value differs from `current`. An absent key means
 * "leave unchanged" and `null` means "clear", so only present keys are compared.
 *
 * The API uses this to decide whether a save is a real edit (bumps the
 * follow-up clock and the version) or a no-op (does neither).
 */
export function changedFields<T extends object>(current: T, patch: Partial<T>): (keyof T)[] {
  const changed: (keyof T)[] = [];
  for (const key of Object.keys(patch) as (keyof T)[]) {
    if (patch[key] === undefined) continue; // an explicit undefined is the same as absent
    if (!Object.is(current[key], patch[key])) changed.push(key);
  }
  return changed;
}

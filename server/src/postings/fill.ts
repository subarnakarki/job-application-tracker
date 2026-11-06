import type { WorkMode } from '@jat/shared';
import type { Details } from './details';

/** Placeholder when an email names no role: `role` is required on an application. */
export const UNKNOWN_ROLE = 'Role not stated';

/** The fields a posting can fill. */
export interface Fillable {
  role: string;
  jobLink: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  location: string | null;
  workMode: WorkMode | null;
  postedOn: string | null;
}

export type FillPatch = Partial<Fillable>;

/** What a posting gave: its details and link (the company is never changed by a posting). */
export type Found = Omit<Details, 'company'> & { jobLink: string | null };

/**
 * The changes that fill a record's empty fields from a posting; never overwrites a value (the
 * "Role not stated" placeholder counts as empty). The salary goes in as a whole, and only when both
 * amounts are empty. `filled` names what changed, for the user.
 */
export function fillEmpty(current: Fillable, found: Found): { patch: FillPatch; filled: string[] } {
  const patch: FillPatch = {};
  const filled: string[] = [];
  const blank = (value: string | null) => value === null || value.trim() === '';

  if (found.role && (blank(current.role) || current.role === UNKNOWN_ROLE)) {
    patch.role = found.role;
    filled.push('role');
  }
  if (found.jobLink && blank(current.jobLink)) {
    patch.jobLink = found.jobLink;
    filled.push('job link');
  }
  if (found.salary && current.salaryMin === null && current.salaryMax === null) {
    patch.salaryMin = found.salary.min;
    patch.salaryMax = found.salary.max;
    patch.salaryCurrency = found.salary.currency;
    filled.push('salary');
  }
  if (found.location && blank(current.location)) {
    patch.location = found.location;
    filled.push('location');
  }
  if (found.workMode && current.workMode === null) {
    patch.workMode = found.workMode;
    filled.push('work mode');
  }
  if (found.postedOn && current.postedOn === null) {
    patch.postedOn = found.postedOn;
    filled.push('posting date');
  }
  return { patch, filled };
}

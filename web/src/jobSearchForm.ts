import {
  CADENCES,
  DEFAULT_EEO_ANSWER,
  JobSearchProfileSchema,
  PROFILE_DEFAULTS,
  WORK_MODES,
  type Cadence,
  type JobSearchProfile,
  type WorkMode,
} from '@jat/shared';

/** The setup form's values: text as typed, lists one per line. */
export interface SetupValues {
  fullName: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  workAuthorization: string;
  needsSponsorship: boolean;
  salaryMin: string;
  salaryMax: string;
  linkedin: string;
  portfolio: string;
  website: string;
  workModes: WorkMode[];
  usOnly: boolean;
  queries: string;
  includeTitles: string;
  skipTitles: string;
  timeframeDays: '1' | '3' | '7';
  cadence: Cadence;
  runHour: string;
  runWeekday: string;
  scheduleOn: boolean;
  willingToRelocate: string;
  startDate: string;
  howHeard: string;
  over18: boolean;
  gender: string;
  hispanicLatino: JobSearchProfile['hispanicLatino'];
  raceEthnicity: string;
  veteranStatus: JobSearchProfile['veteranStatus'];
  disabilityStatus: JobSearchProfile['disabilityStatus'];
  eeoAnswer: string;
}

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
export const CADENCE_LABELS: Record<Cadence, string> = {
  daily: 'Every day',
  weekdays: 'Every weekday',
  weekly: 'Once a week',
};
export { CADENCES, WORK_MODES };

const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

export function emptySetup(prefill: { name?: string | null; email?: string }): SetupValues {
  return {
    fullName: prefill.name ?? '',
    email: prefill.email ?? '',
    phone: '',
    city: '',
    state: '',
    workAuthorization: '',
    needsSponsorship: false,
    salaryMin: '',
    salaryMax: '',
    linkedin: '',
    portfolio: '',
    website: '',
    workModes: PROFILE_DEFAULTS.workModes,
    usOnly: PROFILE_DEFAULTS.usOnly,
    queries: PROFILE_DEFAULTS.queries.join('\n'),
    includeTitles: '',
    skipTitles: '',
    timeframeDays: '1',
    cadence: PROFILE_DEFAULTS.cadence,
    runHour: String(PROFILE_DEFAULTS.runHour),
    runWeekday: String(PROFILE_DEFAULTS.runWeekday),
    scheduleOn: PROFILE_DEFAULTS.scheduleOn,
    willingToRelocate: PROFILE_DEFAULTS.willingToRelocate,
    startDate: PROFILE_DEFAULTS.startDate,
    howHeard: PROFILE_DEFAULTS.howHeard,
    over18: PROFILE_DEFAULTS.over18,
    gender: PROFILE_DEFAULTS.gender,
    hispanicLatino: PROFILE_DEFAULTS.hispanicLatino,
    raceEthnicity: PROFILE_DEFAULTS.raceEthnicity,
    veteranStatus: PROFILE_DEFAULTS.veteranStatus,
    disabilityStatus: PROFILE_DEFAULTS.disabilityStatus,
    eeoAnswer: DEFAULT_EEO_ANSWER,
  };
}

export function toSetupValues(profile: JobSearchProfile): SetupValues {
  return {
    ...profile,
    salaryMin: String(profile.salaryMin),
    salaryMax: profile.salaryMax === null ? '' : String(profile.salaryMax),
    queries: profile.queries.join('\n'),
    includeTitles: profile.includeTitles.join('\n'),
    skipTitles: profile.skipTitles.join('\n'),
    timeframeDays: String(profile.timeframeDays) as SetupValues['timeframeDays'],
    runHour: String(profile.runHour),
    runWeekday: String(profile.runWeekday),
  };
}

const amount = (value: string): number | null => {
  const cleaned = value.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? Math.round(number) : NaN;
};

/** The profile, or the problem with each field (field name -> message). */
export function fromSetupValues(
  values: SetupValues,
): { ok: true; profile: JobSearchProfile } | { ok: false; errors: Record<string, string> } {
  const result = JobSearchProfileSchema.safeParse({
    ...values,
    salaryMin: amount(values.salaryMin) ?? NaN,
    salaryMax: amount(values.salaryMax),
    queries: lines(values.queries),
    includeTitles: lines(values.includeTitles),
    skipTitles: lines(values.skipTitles),
    timeframeDays: Number(values.timeframeDays),
    runHour: Number(values.runHour),
    runWeekday: Number(values.runWeekday),
  });
  if (result.success) return { ok: true, profile: result.data };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? 'form');
    errors[field] ??=
      field === 'salaryMin' || field === 'salaryMax' ? 'Enter a number' : issue.message;
  }
  return { ok: false, errors };
}

export function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${String(hour % 12 === 0 ? 12 : hour % 12)}:00 ${suffix}`;
}

/** "Every weekday at 8:00 AM", for the confirm step and the overview. */
export function scheduleText(profile: JobSearchProfile): string {
  if (!profile.scheduleOn) return 'Off (run by hand only)';
  const when = hourLabel(profile.runHour);
  return profile.cadence === 'weekly'
    ? `Every ${WEEKDAYS[profile.runWeekday] ?? ''} at ${when}`
    : `${CADENCE_LABELS[profile.cadence]} at ${when}`;
}

export const HISPANIC_LABELS: Record<JobSearchProfile['hispanicLatino'], string> = {
  decline: 'Decline to self-identify',
  yes: 'Yes',
  no: 'No',
};
export const VETERAN_LABELS: Record<JobSearchProfile['veteranStatus'], string> = {
  decline: 'Decline to self-identify',
  not_veteran: 'I am not a protected veteran',
  protected_veteran: 'I am a protected veteran',
};
export const DISABILITY_LABELS: Record<JobSearchProfile['disabilityStatus'], string> = {
  decline: 'Decline to self-identify',
  no: 'No disability',
  yes: 'Yes, I have (or had) a disability',
};

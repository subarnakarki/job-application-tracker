import {
  CADENCES,
  DEFAULT_EEO_ANSWER,
  EMPTY_MORE_ANSWERS,
  JobSearchProfileSchema,
  PROFILE_DEFAULTS,
  searchQueries,
  WORK_MODES,
  type Cadence,
  type SearchSource,
  type JobSearchProfile,
  type MoreAnswers,
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
  /** The lowest pay worth a job; blank for none. */
  salaryFloor: string;
  linkedin: string;
  portfolio: string;
  website: string;
  workModes: WorkMode[];
  usOnly: boolean;
  queries: string;
  includeTitles: string;
  sites: SearchSource[];
  skipTitles: string;
  timeframeDays: '1' | '3' | '7' | '14' | '30';
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
  /** Optional answers to more screening questions, kept as they are. */
  more: MoreAnswers;
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
    salaryFloor: '',
    linkedin: '',
    portfolio: '',
    website: '',
    workModes: PROFILE_DEFAULTS.workModes,
    usOnly: PROFILE_DEFAULTS.usOnly,
    queries: PROFILE_DEFAULTS.queries.join('\n'),
    includeTitles: '',
    sites: PROFILE_DEFAULTS.sites,
    skipTitles: '',
    timeframeDays: String(PROFILE_DEFAULTS.timeframeDays) as SetupValues['timeframeDays'],
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
    more: EMPTY_MORE_ANSWERS,
  };
}

export function toSetupValues(profile: JobSearchProfile): SetupValues {
  return {
    ...profile,
    salaryMin: String(profile.salaryMin),
    salaryMax: profile.salaryMax === null ? '' : String(profile.salaryMax),
    salaryFloor: profile.salaryFloor === null ? '' : String(profile.salaryFloor),
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
    salaryFloor: amount(values.salaryFloor),
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
    const [first, second] = issue.path;
    const field =
      first === 'more' && second !== undefined ? `more.${String(second)}` : String(first ?? 'form');
    errors[field] ??=
      field === 'salaryMin' || field === 'salaryMax' || field === 'salaryFloor'
        ? 'Enter a number'
        : issue.message;
  }
  // The schema checks this only once every field is valid; the form says it at once.
  if (lines(values.includeTitles).length === 0 && lines(values.queries).length === 0)
    errors['includeTitles'] ??= 'Add at least one title to search for';
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

/** The searches the form's current values would make (for the live preview). */
export function previewSearches(values: Pick<SetupValues, 'queries' | 'includeTitles' | 'sites'>) {
  return searchQueries({
    queries: lines(values.queries),
    includeTitles: lines(values.includeTitles),
    sites: values.sites,
  });
}

// ---------------------------------------------------------------------------------------------
// More answers (optional)

type YesNoKey = {
  [K in keyof MoreAnswers]: MoreAnswers[K] extends 'yes' | 'no' | null
    ? 'yes' | 'no' extends MoreAnswers[K]
      ? K
      : never
    : never;
}[keyof MoreAnswers];
type TextKey = {
  [K in keyof MoreAnswers]: MoreAnswers[K] extends string ? K : never;
}[keyof MoreAnswers];
type ChoiceKey = Exclude<keyof MoreAnswers, YesNoKey | TextKey>;

export type MoreField =
  | { kind: 'yes_no'; key: YesNoKey; label: string }
  | {
      kind: 'choice';
      key: ChoiceKey;
      label: string;
      options: { value: string; label: string }[];
    }
  | { kind: 'text'; key: TextKey; label: string; hint?: string };

export interface MoreGroup {
  title: string;
  note?: string;
  fields: MoreField[];
}

const yesNo = (key: YesNoKey, label: string): MoreField => ({ kind: 'yes_no', key, label });
const text = (key: TextKey, label: string, hint?: string): MoreField =>
  hint === undefined ? { kind: 'text', key, label } : { kind: 'text', key, label, hint };
const choice = <K extends ChoiceKey>(
  key: K,
  label: string,
  labels: Record<NonNullable<MoreAnswers[K]>, string>,
): MoreField => ({
  kind: 'choice',
  key,
  label,
  options: Object.entries<string>(labels).map(([value, optionLabel]) => ({
    value,
    label: optionLabel,
  })),
});

/** The optional answers on the setup page, in their groups. Every one starts as Not set. */
export const MORE_GROUPS: MoreGroup[] = [
  {
    title: 'Work authorization and export control',
    fields: [
      yesNo('authorizedUs', 'Authorized to work in the U.S.?'),
      yesNo('locatedInUs', 'Currently located in the U.S.?'),
      yesNo('usCitizen', 'U.S. citizen?'),
      choice('exportStatus', 'Export control status', {
        citizen: 'U.S. citizen or national',
        green_card: 'Green card holder (permanent resident)',
        refugee: 'Refugee',
        asylee: 'Asylee',
        none: 'None of these',
      }),
      choice('usPerson', '"U.S. Person" (ITAR)', {
        yes: 'Yes, I am a U.S. Person',
        soon: 'I will soon become one',
        licensable: 'No, but I am eligible for licensing',
      }),
      text('legalFirstName', 'Legal first name', 'Blank: from your full name'),
      text('legalLastName', 'Legal last name', 'Blank: from your full name'),
      text('birthCountry', 'Country of birth'),
      text('citizenships', 'Countries of citizenship', 'e.g. United States'),
      text('otherResidencies', 'Other countries of permanent residence', 'e.g. None'),
    ],
  },
  {
    title: 'Security clearance',
    fields: [
      choice('clearance', 'Security clearance', {
        active: 'I hold an active U.S. clearance',
        eligible: 'I am eligible for one',
        not_eligible: 'I am not eligible',
      }),
      choice('clearanceHeld', 'Highest clearance held', {
        never: 'Never held one',
        confidential: 'Confidential',
        secret: 'Secret',
        top_secret: 'Top Secret',
      }),
    ],
  },
  {
    title: 'Company history (applies to any company)',
    note: 'Answered the same way for every company that asks.',
    fields: [
      yesNo('workedForCompanyBefore', 'Worked for the company before (employee or contractor)?'),
      yesNo('historyWithCompany', 'Any other history with the company?'),
      yesNo('relativeAtCompany', 'Relative or close relationship at the company?'),
      yesNo('conflictOfInterest', 'Any conflict of interest?'),
      yesNo('employerRestrictions', 'Non-compete or other employer restrictions?'),
    ],
  },
  {
    title: 'Logistics',
    fields: [
      choice('startTimeline', 'Timeline for starting', {
        immediately: 'Immediately',
        two_weeks: 'About 2 weeks',
        month_plus: 'More than a month',
        flexible: 'Flexible',
      }),
      yesNo('w2Contract', 'Open to a W2 contract?'),
      text('w2Rate', 'W2 hourly rate', 'e.g. $85/hr'),
      yesNo('canTravel', 'Able to meet the travel requirements?'),
      yesNo('canPerformFunctions', 'Able to perform the job functions?'),
      yesNo('smsConsent', 'Agree to recruiting text messages (SMS)?'),
      yesNo('otherOpenings', 'Consider me for other openings?'),
      yesNo('certifyTrue', 'Certify my application is true and complete?'),
    ],
  },
  {
    title: 'Self-identification additions',
    note: 'Optional, and employers must keep them out of hiring decisions. Blank: your "other demographic questions" answer.',
    fields: [
      text('pronouns', 'Pronouns', 'As forms list them, e.g. She/Her'),
      text('sexualOrientation', 'Sexual orientation'),
    ],
  },
  {
    title: 'Just for fun',
    fields: [text('funAnswer', '"Just for fun" answer', 'e.g. your favorite food')],
  },
];

/** How a set answer reads; null when it is not set. */
export function moreAnswerText(field: MoreField, more: MoreAnswers): string | null {
  const value = more[field.key];
  if (value === null || value === '') return null;
  if (field.kind === 'yes_no') return value === 'yes' ? 'Yes' : 'No';
  if (field.kind === 'choice')
    return field.options.find((option) => option.value === value)?.label ?? value;
  return value;
}

/** The answers that are set, for the confirm step. */
export function moreAnswerRows(more: MoreAnswers): [string, string][] {
  return MORE_GROUPS.flatMap((group) => group.fields).flatMap((field) => {
    const answer = moreAnswerText(field, more);
    return answer === null ? [] : [[field.label, answer] as [string, string]];
  });
}

/** Sets one optional answer from a form control: an empty value means Not set. */
export function setMoreAnswer(more: MoreAnswers, field: MoreField, value: string): MoreAnswers {
  return { ...more, [field.key]: field.kind === 'text' ? value : value || null };
}

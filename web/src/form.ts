import {
  ApplicationInputSchema,
  type ApplicationDetail,
  type ApplicationInput,
  type ApplicationPatch,
  type Source,
  type Status,
} from '@jat/shared';

/** What the form inputs hold: always strings, '' meaning "empty". */
export interface FormValues {
  company: string;
  role: string;
  status: Status;
  source: Source;
  dateApplied: string;
  salaryMin: string;
  salaryMax: string;
  salaryCurrency: string;
  jobLink: string;
  contact: string;
  nextStep: string;
  nextStepDate: string;
  notes: string;
  /** '' means no lead. */
  leadId: string;
}

export const EMPTY_FORM: FormValues = {
  company: '',
  role: '',
  status: 'Saved',
  source: 'Other',
  dateApplied: '',
  salaryMin: '',
  salaryMax: '',
  salaryCurrency: 'USD',
  jobLink: '',
  contact: '',
  nextStep: '',
  nextStepDate: '',
  notes: '',
  leadId: '',
};

export function toFormValues(application: ApplicationDetail): FormValues {
  return {
    company: application.company,
    role: application.role,
    status: application.status,
    source: application.source,
    dateApplied: application.dateApplied ?? '',
    salaryMin: application.salaryMin?.toString() ?? '',
    salaryMax: application.salaryMax?.toString() ?? '',
    salaryCurrency: application.salaryCurrency ?? 'USD',
    jobLink: application.jobLink ?? '',
    contact: application.contact ?? '',
    nextStep: application.nextStep ?? '',
    nextStepDate: application.nextStepDate ?? '',
    notes: application.notes,
    leadId: application.leadId ?? '',
  };
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());
const amount = (value: string): number | null => (value.trim() === '' ? null : Number(value));

/** The API input for these values. The currency is only sent when there is a salary. */
export function toRaw(values: FormValues): Record<string, unknown> {
  const salaryMin = amount(values.salaryMin);
  const salaryMax = amount(values.salaryMax);
  const hasSalary = salaryMin !== null || salaryMax !== null;
  return {
    company: values.company,
    role: values.role,
    status: values.status,
    source: values.source,
    dateApplied: orNull(values.dateApplied),
    salaryMin,
    salaryMax,
    salaryCurrency: hasSalary ? (orNull(values.salaryCurrency)?.toUpperCase() ?? 'USD') : null,
    jobLink: orNull(values.jobLink),
    contact: orNull(values.contact),
    nextStep: orNull(values.nextStep),
    nextStepDate: orNull(values.nextStepDate),
    notes: values.notes,
    leadId: orNull(values.leadId),
  };
}

export type FieldErrors = Partial<Record<keyof FormValues, string>>;

/** Validates with the same schema the server uses; field -> first problem. */
export function validate(
  values: FormValues,
): { input: ApplicationInput } | { errors: FieldErrors } {
  const result = ApplicationInputSchema.safeParse(toRaw(values));
  if (result.success) return { input: result.data };
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? '') as keyof FormValues;
    errors[field] ??=
      issue.code === 'invalid_type' && field.startsWith('salary')
        ? 'Must be a whole number'
        : issue.message;
  }
  return { errors };
}

/** Only the fields that changed, so an edit never overwrites what it did not touch. */
export function toPatch(original: ApplicationDetail, input: ApplicationInput): ApplicationPatch {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (original[key as keyof ApplicationDetail] !== value) patch[key] = value;
  }
  return patch;
}

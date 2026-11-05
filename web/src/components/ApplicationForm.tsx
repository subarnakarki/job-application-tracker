import { SOURCES, STATUSES, type ApplicationInput } from '@jat/shared';
import { useId, useState, type ReactNode } from 'react';
import { validate, type FieldErrors, type FormValues } from '../form';

interface Props {
  initial: FormValues;
  submitLabel: string;
  busy: boolean;
  /** Errors from the server (field -> message), shown like client-side ones. */
  serverErrors?: FieldErrors;
  /** A message for the whole form, e.g. an edit conflict. */
  formError?: string | null;
  onSubmit: (input: ApplicationInput) => void;
  onCancel: () => void;
}

/**
 * Create and edit. Validates with the same zod schema as the server before
 * sending; every field has a label, and errors are linked to their field and
 * focused, so the form works with a keyboard and a screen reader.
 */
export function ApplicationForm({
  initial,
  submitLabel,
  busy,
  serverErrors,
  formError,
  onSubmit,
  onCancel,
}: Props) {
  const [values, setValues] = useState<FormValues>(initial);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const errors = { ...serverErrors, ...clientErrors };
  const id = useId();

  const set = (field: keyof FormValues) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [field]: event.target.value }));

  const field = (
    name: keyof FormValues,
    label: string,
    control: (props: ControlProps) => ReactNode,
    hint?: string,
  ) => {
    const controlId = `${id}-${name}`;
    const errorId = `${controlId}-error`;
    const error = errors[name];
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={controlId} className="text-sm font-medium">
          {label}
        </label>
        {control({
          id: controlId,
          name,
          value: values[name],
          onChange: set(name),
          'aria-invalid': error ? true : undefined,
          'aria-describedby': error ? errorId : undefined,
          className: `input ${error ? 'border-rose-600' : ''}`,
        })}
        {hint && !error && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
        {error && (
          <p id={errorId} className="text-sm text-rose-700 dark:text-rose-400">
            {error}
          </p>
        )}
      </div>
    );
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = validate(values);
        if ('errors' in result) {
          setClientErrors(result.errors);
          const first = Object.keys(result.errors)[0];
          if (first) document.getElementById(`${id}-${first}`)?.focus();
          return;
        }
        setClientErrors({});
        onSubmit(result.input);
      }}
    >
      {formError && (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
        >
          {formError}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {field('company', 'Company *', (props) => (
          <input {...props} autoComplete="organization" />
        ))}
        {field('role', 'Role *', (props) => (
          <input {...props} />
        ))}
        {field('status', 'Status', (props) => (
          <select {...props}>
            {STATUSES.map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        ))}
        {field('source', 'Source', (props) => (
          <select {...props}>
            {SOURCES.map((source) => (
              <option key={source}>{source}</option>
            ))}
          </select>
        ))}
        {field(
          'dateApplied',
          'Date applied',
          (props) => (
            <input {...props} type="date" />
          ),
          'Filled in automatically when you first mark it Applied',
        )}
        {field('jobLink', 'Job link', (props) => (
          <input {...props} type="url" inputMode="url" placeholder="https://" />
        ))}
        {field('salaryMin', 'Salary from', (props) => (
          <input {...props} type="number" inputMode="numeric" min={0} step={1} />
        ))}
        {field('salaryMax', 'Salary to', (props) => (
          <input {...props} type="number" inputMode="numeric" min={0} step={1} />
        ))}
        {field(
          'salaryCurrency',
          'Currency',
          (props) => (
            <input {...props} maxLength={3} />
          ),
          '3 letters, e.g. USD',
        )}
        {field('contact', 'Contact', (props) => (
          <input {...props} />
        ))}
        {field('nextStep', 'Next step', (props) => (
          <input {...props} />
        ))}
        {field('nextStepDate', 'Next step date', (props) => (
          <input {...props} type="date" />
        ))}
      </div>
      {field('notes', 'Notes', (props) => (
        <textarea {...props} rows={5} />
      ))}
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className="btn-primary">
          {busy ? 'Saving…' : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

interface ControlProps {
  id: string;
  name: string;
  value: string;
  onChange: (event: { target: { value: string } }) => void;
  'aria-invalid': true | undefined;
  'aria-describedby': string | undefined;
  className: string;
}

import { SOURCES, STATUSES, WORK_MODES, type ApplicationInput } from '@jat/shared';
import { useId, useState, type ReactNode } from 'react';
import { ApiRequestError } from '../api/client';
import { useLeads, usePostingPreview } from '../api/hooks';
import { useSpotlight } from '../useSpotlight';
import { fillEmpty, validate, type FieldErrors, type FormValues } from '../form';

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
  /** Show "Fill from link" (on Add application). */
  fillFromLink?: boolean;
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
  fillFromLink = false,
}: Props) {
  const [values, setValues] = useState<FormValues>(initial);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const errors = { ...serverErrors, ...clientErrors };
  const id = useId();
  const spotlight = useSpotlight();
  // Fields the posting just filled flash once, so it is clear what changed.
  const [flashed, setFlashed] = useState<ReadonlySet<string>>(new Set());
  const leads = useLeads();
  const preview = usePostingPreview();
  const [postingUrl, setPostingUrl] = useState('');
  const [fillMessage, setFillMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const fill = () => {
    setFillMessage(null);
    preview.mutate(postingUrl.trim(), {
      onSuccess: (found) => {
        const result = fillEmpty(values, found);
        setValues(result.values);
        setFlashed(
          new Set(
            (Object.keys(result.values) as (keyof FormValues)[]).filter(
              (name) => result.values[name] !== values[name],
            ),
          ),
        );
        setFillMessage({
          ok: true,
          text:
            result.filled === 0
              ? 'Nothing new to fill: those fields already have values.'
              : `Filled ${result.filled} ${result.filled === 1 ? 'field' : 'fields'} from the posting. Check them, then save.`,
        });
      },
      onError: (error) =>
        setFillMessage({
          ok: false,
          text:
            error instanceof ApiRequestError
              ? (error.fieldErrors?.['url'] ?? error.message)
              : "The link couldn't be read. Fill in the details by hand.",
        }),
    });
  };
  const leadOptions = leads.data?.items ?? [];

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
      <div className="flex flex-col gap-1.5">
        <label htmlFor={controlId} className="text-[0.8125rem] font-medium text-fg-2">
          {label}
        </label>
        {control({
          id: controlId,
          name,
          value: values[name],
          onChange: set(name),
          'aria-invalid': error ? true : undefined,
          'aria-describedby': error ? errorId : undefined,
          className: `inp select-chevron ${flashed.has(name) ? 'inp-filled' : ''}`,
        })}
        {hint && !error && <p className="text-xs text-fg-3">{hint}</p>}
        {error && (
          <p id={errorId} className="text-sm text-red">
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
      {fillFromLink && (
        <div {...spotlight} className="glow fill-wash flex flex-col gap-2 p-5">
          <label htmlFor={`${id}-posting`} className="text-[0.8125rem] font-medium text-fg-2">
            Job posting link
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={`${id}-posting`}
              type="url"
              inputMode="url"
              placeholder="https://"
              className="inp min-w-0 flex-1"
              value={postingUrl}
              onChange={(event) => setPostingUrl(event.target.value)}
              onKeyDown={(event) => {
                // Enter here fills from the link; it must not save the form.
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (postingUrl.trim()) fill();
                }
              }}
            />
            <button
              type="button"
              className="btn-d"
              disabled={preview.isPending || postingUrl.trim() === ''}
              onClick={fill}
            >
              {preview.isPending ? 'Reading…' : 'Fill from link'}
            </button>
          </div>
          <p aria-live="polite" className="text-sm">
            {fillMessage && (
              <span className={fillMessage.ok ? 'text-green' : 'text-red'}>{fillMessage.text}</span>
            )}
          </p>
          <p className="text-xs text-fg-3">
            Works with most company career sites, Greenhouse, Lever and Ashby. Not LinkedIn. Only
            empty fields are filled.
          </p>
        </div>
      )}
      {formError && (
        <p role="alert" className="rounded-xl bg-red/10 p-3 text-sm text-red">
          {formError}
        </p>
      )}
      <div {...spotlight} className="glow flex flex-col gap-4 p-5 sm:p-6">
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
          {field(
            'leadId',
            'Lead',
            (props) => (
              <select {...props}>
                <option value="">No lead</option>
                {/* Keep the current choice selectable while the list loads. */}
                {values.leadId && !leadOptions.some((lead) => lead.id === values.leadId) && (
                  <option value={values.leadId}>Current lead</option>
                )}
                {leadOptions.map((lead) => (
                  <option key={lead.id} value={lead.id}>
                    {lead.company ? `${lead.name} (${lead.company})` : lead.name}
                  </option>
                ))}
              </select>
            ),
            'The person who helped you get here',
          )}
          {field('nextStep', 'Next step', (props) => (
            <input {...props} />
          ))}
          {field('nextStepDate', 'Next step date', (props) => (
            <input {...props} type="date" />
          ))}
          {field('location', 'Location', (props) => (
            <input {...props} placeholder="e.g. Boston, MA or Remote (US)" />
          ))}
          {field('workMode', 'Work mode', (props) => (
            <select {...props}>
              <option value="">Not stated</option>
              {WORK_MODES.map((mode) => (
                <option key={mode}>{mode}</option>
              ))}
            </select>
          ))}
          {field('postedOn', 'Posted on', (props) => (
            <input {...props} type="date" />
          ))}
        </div>
        {field('notes', 'Notes', (props) => (
          <textarea {...props} rows={5} />
        ))}
        <div className="flex flex-wrap gap-3 pt-1">
          <button type="submit" disabled={busy} className="btn-w min-h-12 px-6 text-[0.9375rem]">
            {busy ? 'Saving…' : submitLabel}
          </button>
          <button type="button" onClick={onCancel} className="btn-d min-h-12 px-6 text-[0.9375rem]">
            Cancel
          </button>
        </div>
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

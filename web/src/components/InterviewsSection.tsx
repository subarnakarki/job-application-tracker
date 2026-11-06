import {
  InterviewInputSchema,
  localDateIn,
  type ApplicationDetail,
  type Interview,
} from '@jat/shared';
import { useId, useState } from 'react';
import { ApiRequestError } from '../api/client';
import { useAddInterview, useDeleteInterview, useMe, useUpdateInterview } from '../api/hooks';
import { formatDate, formatMonthShort } from '../format';
import { ConfirmDialog } from './ConfirmDialog';
import { Glow } from './ui/Glow';
import { Pill } from './ui/Pill';

interface Values {
  heldOn: string;
  label: string;
  notes: string;
}

const linkClass = 'link flex min-h-11 items-center px-2 text-[0.8125rem] underline';

function problemOf(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ApiRequestError && error.code === 'limit_reached') return error.message;
  if (error instanceof ApiRequestError && error.code === 'rate_limited')
    return 'Too many changes in a short time. Try again in a while.';
  return 'Could not save the interview. Try again.';
}

/** The day (any day: past, or scheduled ahead), an optional label and notes. */
function InterviewForm({
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial: Values;
  submitLabel: string;
  busy: boolean;
  error: unknown;
  onSubmit: (values: { heldOn: string; label: string | null; notes: string }) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const id = useId();
  const message = problemOf(error);
  const set = (field: keyof Values) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [field]: event.target.value }));

  return (
    <form
      noValidate
      className="flex flex-col gap-3 rounded-2xl bg-s2 p-3.5 shadow-line"
      onSubmit={(event) => {
        event.preventDefault();
        const result = InterviewInputSchema.safeParse(values);
        if (!result.success) {
          const found: Record<string, string> = {};
          for (const issue of result.error.issues)
            found[String(issue.path[0] ?? '')] ??= issue.message;
          setFieldErrors(found);
          return;
        }
        setFieldErrors({});
        onSubmit(result.data);
      }}
    >
      {message && (
        <p role="alert" className="text-sm text-red">
          {message}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-day`} className="text-[0.8125rem] font-medium text-fg-2">
            Day
          </label>
          <input
            id={`${id}-day`}
            type="date"
            className="inp"
            value={values.heldOn}
            onChange={set('heldOn')}
            aria-invalid={fieldErrors['heldOn'] ? true : undefined}
            aria-describedby={fieldErrors['heldOn'] ? `${id}-day-error` : undefined}
          />
          {fieldErrors['heldOn'] && (
            <p id={`${id}-day-error`} className="text-sm text-red">
              {fieldErrors['heldOn']}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-label`} className="text-[0.8125rem] font-medium text-fg-2">
            Round
          </label>
          <input
            id={`${id}-label`}
            className="inp"
            placeholder="e.g. Hiring manager"
            value={values.label}
            onChange={set('label')}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-notes`} className="text-[0.8125rem] font-medium text-fg-2">
          Interview notes
        </label>
        <textarea
          id={`${id}-notes`}
          rows={3}
          className="inp"
          value={values.notes}
          onChange={set('notes')}
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className="btn-w">
          {busy ? 'Saving…' : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="btn-d">
          Cancel
        </button>
      </div>
    </form>
  );
}

function InterviewItem({
  applicationId,
  interview,
  today,
}: {
  applicationId: string;
  interview: Interview;
  today: string;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const update = useUpdateInterview(applicationId);
  const remove = useDeleteInterview(applicationId);
  if (editing) {
    return (
      <li>
        <InterviewForm
          initial={{
            heldOn: interview.heldOn,
            label: interview.label ?? '',
            notes: interview.notes,
          }}
          submitLabel="Save interview"
          busy={update.isPending}
          error={update.error}
          onCancel={() => setEditing(false)}
          onSubmit={(patch) =>
            update.mutate(
              { interviewId: interview.id, patch },
              { onSuccess: () => setEditing(false) },
            )
          }
        />
      </li>
    );
  }
  const upcoming = interview.heldOn >= today;
  return (
    <li className="flex gap-3.5 border-t border-line py-3 first:border-t-0">
      <time dateTime={interview.heldOn} className="w-11 flex-none text-center">
        <span className="sr-only">{formatDate(interview.heldOn)}</span>
        <b
          aria-hidden="true"
          className="block text-[1.375rem] leading-none font-semibold tracking-[-0.04em]"
        >
          {Number(interview.heldOn.slice(8, 10))}
        </b>
        <small aria-hidden="true" className="text-[0.6875rem] text-fg-3">
          {formatMonthShort(interview.heldOn)}
        </small>
      </time>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="flex flex-wrap items-center gap-1.5 text-[0.9375rem]">
            {interview.label ?? 'Interview'}
            {upcoming && <Pill tone="iv">Upcoming</Pill>}
          </span>
          <span className="flex gap-1 text-sm">
            <button type="button" className={linkClass} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className={linkClass} onClick={() => setConfirming(true)}>
              Remove
            </button>
          </span>
        </div>
        {interview.notes && (
          <p className="mt-1 text-[0.8125rem] whitespace-pre-wrap text-fg-2">{interview.notes}</p>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        title="Remove this interview?"
        message="The interview and its notes will be removed. This cannot be undone."
        confirmLabel="Remove interview"
        busy={remove.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => remove.mutate(interview.id, { onSuccess: () => setConfirming(false) })}
      />
    </li>
  );
}

/** "Add interview" and the application's interviews, newest first. */
export function InterviewsSection({ application }: { application: ApplicationDetail }) {
  const me = useMe();
  const add = useAddInterview(application.id);
  const [adding, setAdding] = useState(false);
  const today = localDateIn(new Date(), me.data?.timeZone ?? 'UTC');
  const interviews = [...application.interviews].reverse();

  return (
    <Glow
      as="section"
      aria-labelledby="interviews-heading"
      className="rise rise-4 flex flex-col gap-3 p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="interviews-heading" className="text-[0.8125rem] font-medium text-fg-2">
          Interviews
        </h2>
        {!adding && (
          <button type="button" className="btn-d" onClick={() => setAdding(true)}>
            Add interview
          </button>
        )}
      </div>
      {adding && (
        <InterviewForm
          initial={{ heldOn: today, label: '', notes: '' }}
          submitLabel="Save interview"
          busy={add.isPending}
          error={add.error}
          onCancel={() => setAdding(false)}
          onSubmit={(input) => add.mutate(input, { onSuccess: () => setAdding(false) })}
        />
      )}
      {interviews.length === 0 && !adding ? (
        <p className="text-sm text-fg-2">
          None yet. Log each interview, or schedule the next one ahead.
        </p>
      ) : (
        <ul className="flex flex-col">
          {interviews.map((interview) => (
            <InterviewItem
              key={interview.id}
              applicationId={application.id}
              interview={interview}
              today={today}
            />
          ))}
        </ul>
      )}
    </Glow>
  );
}

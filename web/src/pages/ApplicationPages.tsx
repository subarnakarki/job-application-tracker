import type { ApplicationDetail } from '@jat/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiRequestError } from '../api/client';
import {
  useApplication,
  useCreateApplication,
  useDeleteApplication,
  useUpdateApplication,
} from '../api/hooks';
import { ApplicationForm } from '../components/ApplicationForm';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FollowUpFlag, StatusBadge } from '../components/StatusBadge';
import { EMPTY_FORM, toFormValues, toPatch, type FieldErrors } from '../form';

function serverErrors(error: unknown): FieldErrors | undefined {
  return error instanceof ApiRequestError ? error.fieldErrors : undefined;
}

function formMessage(error: unknown): string | null {
  if (!(error instanceof ApiRequestError)) return error ? 'Something went wrong. Try again.' : null;
  if (error.code === 'version_conflict')
    return 'This application was changed somewhere else. Reload the page to see the latest version, then try again.';
  if (error.code === 'limit_reached') return error.message;
  if (error.code === 'rate_limited')
    return 'Too many changes in a short time. Try again in a while.';
  return error.code === 'validation_error' ? 'Please fix the highlighted fields.' : error.message;
}

export function NewApplicationPage() {
  const create = useCreateApplication();
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Add application</h1>
      <ApplicationForm
        initial={EMPTY_FORM}
        submitLabel="Save application"
        busy={create.isPending}
        serverErrors={serverErrors(create.error)}
        formError={formMessage(create.error)}
        onCancel={() => void navigate('/')}
        onSubmit={(input) =>
          create.mutate(input, {
            onSuccess: (created) => void navigate(`/applications/${created.id}`),
          })
        }
      />
    </div>
  );
}

function useApplicationOrMessage() {
  const { id = '' } = useParams();
  const query = useApplication(id);
  let message: string | null = null;
  if (query.isPending) message = 'Loading…';
  else if (query.error instanceof ApiRequestError && query.error.status === 404)
    message = 'This application does not exist.';
  else if (query.isError) message = 'Could not load this application.';
  return { id, application: query.data, message };
}

export function EditApplicationPage() {
  const { id, application, message } = useApplicationOrMessage();
  const update = useUpdateApplication(id);
  const navigate = useNavigate();
  if (!application) return <p>{message}</p>;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Edit {application.company}</h1>
      <ApplicationForm
        initial={toFormValues(application)}
        submitLabel="Save changes"
        busy={update.isPending}
        serverErrors={serverErrors(update.error)}
        formError={formMessage(update.error)}
        onCancel={() => void navigate(`/applications/${id}`)}
        onSubmit={(input) =>
          update.mutate(
            { version: application.version, patch: toPatch(application, input) },
            { onSuccess: () => void navigate(`/applications/${id}`) },
          )
        }
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </dt>
      <dd className="mt-0.5 break-words">
        {children || <span className="text-slate-400">–</span>}
      </dd>
    </div>
  );
}

function salary(application: ApplicationDetail): string {
  const { salaryMin: min, salaryMax: max, salaryCurrency: currency } = application;
  if (min === null && max === null) return '';
  const format = (value: number) => value.toLocaleString();
  const range =
    min !== null && max !== null ? `${format(min)}–${format(max)}` : format((min ?? max) as number);
  return `${range} ${currency ?? ''}`.trim();
}

export function ApplicationDetailPage() {
  const { id, application, message } = useApplicationOrMessage();
  const remove = useDeleteApplication(id);
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  if (!application) return <p>{message}</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{application.company}</h1>
          <p className="text-slate-600 dark:text-slate-300">{application.role}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <StatusBadge status={application.status} />
            {application.needsFollowUp && <FollowUpFlag />}
          </div>
        </div>
        <div className="flex gap-3">
          <Link to={`/applications/${id}/edit`} className="btn-primary">
            Edit
          </Link>
          <button type="button" className="btn-danger" onClick={() => setConfirming(true)}>
            Delete
          </button>
        </div>
      </div>

      <dl className="grid gap-4 sm:grid-cols-2">
        <Field label="Date applied">{application.dateApplied}</Field>
        <Field label="Source">{application.source}</Field>
        <Field label="Salary">{salary(application)}</Field>
        <Field label="Contact">{application.contact}</Field>
        <Field label="Next step">
          {[application.nextStep, application.nextStepDate && `(${application.nextStepDate})`]
            .filter(Boolean)
            .join(' ')}
        </Field>
        <Field label="Job link">
          {application.jobLink && (
            <a
              href={application.jobLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-700 underline dark:text-blue-400"
            >
              {application.jobLink}
            </a>
          )}
        </Field>
      </dl>
      <Field label="Notes">
        {application.notes && <span className="whitespace-pre-wrap">{application.notes}</span>}
      </Field>

      <section aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-lg font-semibold">
          Status history
        </h2>
        <ol className="mt-2 flex flex-col gap-2 border-l-2 border-slate-200 pl-4 dark:border-slate-700">
          {[...application.history].reverse().map((entry) => (
            <li key={entry.id} className="text-sm">
              <span className="font-medium">
                {entry.fromStatus
                  ? `${entry.fromStatus} → ${entry.toStatus}`
                  : `Created as ${entry.toStatus}`}
              </span>
              <time dateTime={entry.occurredAt} className="ml-2 text-slate-500 dark:text-slate-400">
                {new Date(entry.occurredAt).toLocaleString()}
              </time>
            </li>
          ))}
        </ol>
      </section>

      <ConfirmDialog
        open={confirming}
        title={`Delete ${application.company}?`}
        message="The application and its history will be removed. This cannot be undone."
        confirmLabel="Delete"
        busy={remove.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => void navigate('/', { replace: true }),
          })
        }
      />
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link to="/" className="text-blue-700 underline dark:text-blue-400">
        Back to your applications
      </Link>
    </div>
  );
}

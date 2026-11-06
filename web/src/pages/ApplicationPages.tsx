import type { ApplicationDetail } from '@jat/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { formatDate, formatDateTime } from '../format';
import { ApiRequestError } from '../api/client';
import {
  useApplication,
  useCreateApplication,
  useDeleteApplication,
  useUpdateApplication,
} from '../api/hooks';
import { ApplicationForm } from '../components/ApplicationForm';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InterviewsSection } from '../components/InterviewsSection';
import { FollowUpFlag, StatusBadge } from '../components/StatusBadge';
import { EMPTY_FORM, toFormValues, toPatch, type FieldErrors } from '../form';
import { timeline } from '../timeline';

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
        fillFromLink
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
      <Link
        to="/"
        className="self-start text-sm text-blue-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-blue-400"
      >
        ← Back to applications
      </Link>
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
        <Field label="Date applied">
          {application.dateApplied && formatDate(application.dateApplied)}
        </Field>
        <Field label="Source">{application.source}</Field>
        <Field label="Salary">{salary(application)}</Field>
        <Field label="Contact">{application.contact}</Field>
        <Field label="Lead">
          {application.leadId && (
            <Link
              to={`/leads/${application.leadId}`}
              className="text-blue-700 underline dark:text-blue-400"
            >
              {application.leadName}
            </Link>
          )}
        </Field>
        <Field label="Next step">
          {[
            application.nextStep,
            application.nextStepDate && `(${formatDate(application.nextStepDate)})`,
          ]
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

      <InterviewsSection application={application} />

      <section aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-lg font-semibold">
          History
        </h2>
        <ol className="mt-2 flex flex-col gap-2 border-l-2 border-slate-200 pl-4 dark:border-slate-700">
          {timeline(application.history, application.interviews).map((item) =>
            item.kind === 'status' ? (
              <li key={item.key} className="text-sm">
                <span className="font-medium">
                  {item.entry.fromStatus
                    ? `${item.entry.fromStatus} → ${item.entry.toStatus}`
                    : `Created as ${item.entry.toStatus}`}
                </span>
                <time
                  dateTime={item.entry.occurredAt}
                  className="ml-2 text-slate-500 dark:text-slate-400"
                >
                  {formatDateTime(item.entry.occurredAt)}
                </time>
                {item.entry.actor === 'gmail' && (
                  <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-200">
                    from Gmail
                  </span>
                )}
              </li>
            ) : (
              <li key={item.key} className="text-sm">
                <span className="font-medium">
                  Interview{item.interview.label ? `: ${item.interview.label}` : ''}
                </span>
                <time
                  dateTime={item.interview.heldOn}
                  className="ml-2 text-slate-500 dark:text-slate-400"
                >
                  {formatDate(item.interview.heldOn)}
                </time>
              </li>
            ),
          )}
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

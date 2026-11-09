import type { ApplicationDetail } from '@jat/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
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
import { LeadMessageSection } from '../components/LeadMessageSection';
import { ResumeMatchSection } from '../components/ResumeMatchSection';
import { TailoringSection } from '../components/TailoringSection';
import { Glow } from '../components/ui/Glow';
import {
  FillFromPostingButton,
  FindPostingButton,
  SuggestionCard,
} from '../components/PostingDetails';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader, RevealHeading } from '../components/ui/PageHeader';
import { Pill } from '../components/ui/Pill';
import { interviewText } from '../timeline';
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
  // "Track this title" on the resume page opens the form with the role filled in.
  const [params] = useSearchParams();
  const role = params.get('role')?.trim().slice(0, 200) ?? '';
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Breadcrumbs items={[{ label: 'Applications', to: '/' }, { label: 'Add application' }]} />
      <PageHeader
        title="Add application"
        subtitle="Paste a posting link to fill the basics, then add the rest."
      />
      <ApplicationForm
        initial={role ? { ...EMPTY_FORM, role } : EMPTY_FORM}
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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Breadcrumbs
        items={[
          { label: 'Applications', to: '/' },
          { label: application.company, to: `/applications/${id}` },
          { label: 'Edit' },
        ]}
      />
      <PageHeader title={`Edit ${application.company}`} />
      <ApplicationForm
        initial={toFormValues(application)}
        submitLabel="Save changes"
        busy={update.isPending}
        serverErrors={serverErrors(update.error)}
        formError={formMessage(update.error)}
        fillFromLink
        postingLink={application.jobLink ?? ''}
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

function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`border-t border-line py-3 first:border-t-0 ${wide ? 'sm:col-span-2' : ''}`}>
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="mt-0.5 break-words">{children || <span className="text-fg-3">–</span>}</dd>
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
  if (!application) return <p className="text-fg-2">{message}</p>;
  const interview = application.nextInterviewOn ? interviewText(application) : null;

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs items={[{ label: 'Applications', to: '/' }, { label: application.company }]} />
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <div className="rise mb-3.5 flex flex-wrap items-center gap-2">
            {interview && (
              <Pill tone="iv" dot>
                {interview}
              </Pill>
            )}
            <StatusBadge status={application.status} />
            {application.needsFollowUp && <FollowUpFlag />}
          </div>
          <RevealHeading text={application.company} />
          <p className="rise rise-3 mt-3 text-[1.0625rem] tracking-[-0.015em] text-fg-2">
            {application.role}
          </p>
        </div>
        <div className="rise rise-4 flex flex-wrap items-start gap-3">
          <FillFromPostingButton application={application} />
          <FindPostingButton application={application} />
          <Link to={`/applications/${id}/edit`} className="btn-w min-h-12 px-6 text-[0.9375rem]">
            Edit
          </Link>
          <button
            type="button"
            className="btn-d min-h-12 px-6 text-[0.9375rem]"
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        </div>
      </div>

      <SuggestionCard application={application} />

      <div className="grid items-start gap-3 lg:grid-cols-[1.25fr_1fr]">
        <Glow as="section" aria-labelledby="details-heading" className="rise rise-3 p-5">
          <h2 id="details-heading" className="text-[0.8125rem] font-medium text-fg-2">
            Details
          </h2>
          <dl className="mt-2 grid gap-x-6 sm:grid-cols-2">
            <Field label="Date applied">
              {application.dateApplied && formatDate(application.dateApplied)}
            </Field>
            <Field label="Source">{application.source}</Field>
            <Field label="Salary">{salary(application)}</Field>
            <Field label="Contact">{application.contact}</Field>
            <Field label="Lead">
              {application.leadId && (
                <Link to={`/leads/${application.leadId}`} className="link underline">
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
            <Field label="Location">{application.location}</Field>
            <Field label="Work mode">{application.workMode}</Field>
            <Field label="Posted on">
              {application.postedOn && formatDate(application.postedOn)}
            </Field>
            <Field label="Job link" wide>
              {application.jobLink && (
                <a
                  href={application.jobLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link underline"
                >
                  {application.jobLink}
                </a>
              )}
            </Field>
            <Field label="Notes" wide>
              {application.notes && (
                <span className="whitespace-pre-wrap">{application.notes}</span>
              )}
            </Field>
          </dl>
        </Glow>

        <div className="flex flex-col gap-3">
          <InterviewsSection application={application} />
          <ResumeMatchSection application={application} />
          <TailoringSection application={application} />
          <LeadMessageSection application={application} />

          <Glow as="section" aria-labelledby="history-heading" className="rise rise-5 p-5">
            <h2 id="history-heading" className="text-[0.8125rem] font-medium text-fg-2">
              History
            </h2>
            <ol className="timeline mt-4 flex flex-col gap-4">
              {timeline(application.history, application.interviews).map((item) =>
                item.kind === 'status' ? (
                  <li key={item.key} className="text-sm">
                    <span className="font-medium">
                      {item.entry.fromStatus
                        ? `${item.entry.fromStatus} → ${item.entry.toStatus}`
                        : `Created as ${item.entry.toStatus}`}
                    </span>
                    {item.entry.actor === 'gmail' && <Pill className="ml-2">from Gmail</Pill>}
                    <time dateTime={item.entry.occurredAt} className="block text-xs text-fg-3">
                      {formatDateTime(item.entry.occurredAt)}
                    </time>
                  </li>
                ) : (
                  <li key={item.key} className="text-sm">
                    <span className="font-medium">
                      Interview{item.interview.label ? `: ${item.interview.label}` : ''}
                    </span>
                    <time dateTime={item.interview.heldOn} className="block text-xs text-fg-3">
                      {formatDate(item.interview.heldOn)}
                    </time>
                  </li>
                ),
              )}
            </ol>
          </Glow>
        </div>
      </div>

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
    <div className="relative flex min-h-[62vh] flex-col items-center justify-center gap-5 overflow-hidden text-center">
      <div aria-hidden="true" className="orb" />
      <p aria-hidden="true" className="big-404 rise">
        404
      </p>
      <RevealHeading
        text="Page not found"
        className="relative text-4xl font-semibold tracking-[-0.05em] sm:text-5xl"
      />
      <Link to="/" className="btn-w relative mt-1 min-h-12 px-6 text-[0.9375rem]">
        Back to your applications
      </Link>
    </div>
  );
}

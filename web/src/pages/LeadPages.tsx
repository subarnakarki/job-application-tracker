import {
  LeadInputSchema,
  LeadNoteInputSchema,
  localDateIn,
  type LeadDetail,
  type LeadInput,
  type LeadNote,
} from '@jat/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiRequestError } from '../api/client';
import {
  useAddLeadNote,
  useCreateLead,
  useDeleteLead,
  useDeleteLeadNote,
  useLead,
  useLeads,
  useMe,
  useUpdateLead,
  useUpdateLeadNote,
} from '../api/hooks';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { StatusBadge } from '../components/StatusBadge';
import { formatDate } from '../format';
import { STAGE_COLOR } from '../stage';
import { useSlashToFocus } from '../useSlashToFocus';
import { useToast } from '../components/Toast';
import { Avatar } from '../components/ui/Avatar';
import { Glow } from '../components/ui/Glow';
import { PageHeader, RevealHeading } from '../components/ui/PageHeader';
import { Pill } from '../components/ui/Pill';
import { SearchField } from '../components/ui/SearchField';
import { useSpotlight } from '../useSpotlight';

type Errors = Record<string, string>;

/** Field -> first message, from a zod result or from the server's validation issues. */
function issuesOf(issues: { path: PropertyKey[] | string; message: string }[]): Errors {
  const errors: Errors = {};
  for (const issue of issues) {
    const path = Array.isArray(issue.path) ? String(issue.path[0] ?? '') : issue.path;
    errors[path] ??= issue.message;
  }
  return errors;
}

function serverMessage(error: unknown): string | null {
  if (!error) return null;
  if (!(error instanceof ApiRequestError)) return 'Something went wrong. Try again.';
  if (error.code === 'validation_error') return 'Please fix the highlighted fields.';
  if (error.code === 'rate_limited')
    return 'Too many changes in a short time. Try again in a while.';
  return error.message;
}

function serverFieldErrors(error: unknown): Errors {
  return error instanceof ApiRequestError && error.body?.issues ? issuesOf(error.body.issues) : {};
}

const linkClass = 'link flex min-h-11 items-center px-2 text-[0.8125rem] underline';
const LEAD_COLOR = 'var(--color-violet)';

export function LeadsPage() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const leads = useLeads(q || undefined);
  const searchField = useRef<HTMLInputElement>(null);
  useSlashToFocus(searchField);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Networking leads"
        subtitle="The people helping you find a job: recruiters, referrers, friends. Keep notes from each conversation and link the applications they led to."
        actions={
          <Link to="/leads/new" className="btn-w min-h-12 px-6 text-[0.9375rem]">
            Add lead
          </Link>
        }
      />
      <div className="rise rise-5 flex">
        <SearchField
          id="lead-search"
          inputRef={searchField}
          value={search}
          onChange={setSearch}
          placeholder="Name, company or notes"
          shortcut
        />
      </div>
      {leads.isPending && <p className="text-fg-2">Loading…</p>}
      {leads.isError && <p className="text-red">Could not load your leads.</p>}
      {leads.isSuccess && leads.data.total === 0 && (
        <div className="rounded-2xl border border-dashed border-line-2 p-8 text-center">
          <p className="font-medium">{q ? 'No leads match.' : 'No leads yet.'}</p>
          <p className="mt-1 text-sm text-fg-2">
            {q ? 'Try another search.' : 'Add the first person helping you.'}
          </p>
        </div>
      )}
      <ul className="rise rise-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {leads.data?.items.map((lead) => (
          <li key={lead.id}>
            <Link
              to={`/leads/${lead.id}`}
              className="glow flex h-full flex-col gap-3 p-5 transition-transform duration-300 hover:-translate-y-0.5"
            >
              <span className="flex items-center gap-3">
                <Avatar name={lead.name} color={LEAD_COLOR} letters={2} />
                <span className="min-w-0">
                  <b className="block truncate text-base font-medium tracking-[-0.02em]">
                    {lead.name}
                  </b>
                  {lead.company && (
                    <small className="block truncate text-[0.8125rem] text-fg-2">
                      {lead.company}
                    </small>
                  )}
                </span>
                <Pill className="ml-auto shrink-0">
                  {lead.applicationCount === 1
                    ? '1 application'
                    : `${lead.applicationCount} applications`}
                </Pill>
              </span>
              {lead.latestNote && (
                <span className="line-clamp-2 border-t border-line pt-3 text-[0.8125rem] text-fg-2">
                  <b className="font-medium text-fg">{formatDate(lead.latestNote.heldOn)}</b>:{' '}
                  {lead.latestNote.body}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface LeadFormValues {
  name: string;
  company: string;
  email: string;
  phone: string;
  profileLink: string;
}

const EMPTY_LEAD: LeadFormValues = { name: '', company: '', email: '', phone: '', profileLink: '' };

function toLeadValues(lead: LeadDetail): LeadFormValues {
  return {
    name: lead.name,
    company: lead.company ?? '',
    email: lead.email ?? '',
    phone: lead.phone ?? '',
    profileLink: lead.profileLink ?? '',
  };
}

function LeadForm({
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial: LeadFormValues;
  submitLabel: string;
  busy: boolean;
  error: unknown;
  onSubmit: (input: LeadInput) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [clientErrors, setClientErrors] = useState<Errors>({});
  const errors = { ...serverFieldErrors(error), ...clientErrors };
  const id = useId();
  const message = serverMessage(error);
  const spotlight = useSpotlight();

  const field = (
    name: keyof LeadFormValues,
    label: string,
    type = 'text',
    autoComplete?: string,
  ) => {
    const controlId = `${id}-${name}`;
    const problem = errors[name];
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={controlId} className="text-[0.8125rem] font-medium text-fg-2">
          {label}
        </label>
        <input
          id={controlId}
          type={type}
          autoComplete={autoComplete}
          className="inp"
          value={values[name]}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${controlId}-error` : undefined}
          onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
        />
        {problem && (
          <p id={`${controlId}-error`} className="text-sm text-red">
            {problem}
          </p>
        )}
      </div>
    );
  };

  return (
    <form
      noValidate
      {...spotlight}
      className="glow flex flex-col gap-4 p-5 sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        const result = LeadInputSchema.safeParse(values);
        if (!result.success) {
          const found = issuesOf(result.error.issues);
          setClientErrors(found);
          const first = Object.keys(found)[0];
          if (first) document.getElementById(`${id}-${first}`)?.focus();
          return;
        }
        setClientErrors({});
        onSubmit(result.data);
      }}
    >
      {message && (
        <p role="alert" className="rounded-lg bg-red/10 p-3 text-sm text-red">
          {message}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {field('name', 'Name *', 'text', 'name')}
        {field('company', 'Company', 'text', 'organization')}
        {field('email', 'Email', 'email', 'email')}
        {field('phone', 'Phone', 'tel', 'tel')}
        {field('profileLink', 'Profile link', 'url')}
      </div>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className="btn-w min-h-12 px-6 text-[0.9375rem]">
          {busy ? 'Saving…' : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="btn-d min-h-12 px-6 text-[0.9375rem]">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function NewLeadPage() {
  const create = useCreateLead();
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeader title="Add lead" />
      <LeadForm
        initial={EMPTY_LEAD}
        submitLabel="Save lead"
        busy={create.isPending}
        error={create.error}
        onCancel={() => void navigate('/leads')}
        onSubmit={(input) =>
          create.mutate(input, {
            onSuccess: (lead) => {
              toast(`Saved ${lead.name}`);
              void navigate(`/leads/${lead.id}`);
            },
          })
        }
      />
    </div>
  );
}

function useLeadOrMessage() {
  const { id = '' } = useParams();
  const query = useLead(id);
  let message: string | null = null;
  if (query.isPending) message = 'Loading…';
  else if (query.error instanceof ApiRequestError && query.error.status === 404)
    message = 'This lead does not exist.';
  else if (query.isError) message = 'Could not load this lead.';
  return { id, lead: query.data, message };
}

export function EditLeadPage() {
  const { id, lead, message } = useLeadOrMessage();
  const update = useUpdateLead(id);
  const navigate = useNavigate();
  const toast = useToast();
  if (!lead) return <p className="text-fg-2">{message}</p>;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeader title={`Edit ${lead.name}`} />
      <LeadForm
        initial={toLeadValues(lead)}
        submitLabel="Save changes"
        busy={update.isPending}
        error={update.error}
        onCancel={() => void navigate(`/leads/${id}`)}
        onSubmit={(input) =>
          update.mutate(input, {
            onSuccess: () => {
              toast('Saved changes');
              void navigate(`/leads/${id}`);
            },
          })
        }
      />
    </div>
  );
}

/** Add or edit one note: the day (today by default, never later) and what was said. */
function NoteForm({
  initial,
  today,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial: { heldOn: string; body: string };
  today: string;
  submitLabel: string;
  busy: boolean;
  error: unknown;
  onSubmit: (value: { heldOn: string; body: string }, reset: () => void) => void;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [clientErrors, setClientErrors] = useState<Errors>({});
  const errors = { ...serverFieldErrors(error), ...clientErrors };
  const id = useId();
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const result = LeadNoteInputSchema.safeParse(values);
        const found = result.success ? {} : issuesOf(result.error.issues);
        if (result.success && result.data.heldOn > today)
          found['heldOn'] = 'A note cannot be dated in the future';
        setClientErrors(found);
        if (!result.success || Object.keys(found).length > 0) return;
        onSubmit(result.data, () => setValues({ heldOn: today, body: '' }));
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-day`} className="text-[0.8125rem] font-medium text-fg-2">
          Day
        </label>
        <input
          id={`${id}-day`}
          type="date"
          max={today}
          className="inp w-48"
          value={values.heldOn}
          aria-invalid={errors['heldOn'] ? true : undefined}
          aria-describedby={errors['heldOn'] ? `${id}-day-error` : undefined}
          onChange={(event) => setValues((current) => ({ ...current, heldOn: event.target.value }))}
        />
        {errors['heldOn'] && (
          <p id={`${id}-day-error`} className="text-sm text-red">
            {errors['heldOn']}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-body`} className="text-[0.8125rem] font-medium text-fg-2">
          What was said
        </label>
        <textarea
          id={`${id}-body`}
          rows={3}
          className="inp"
          value={values.body}
          aria-invalid={errors['body'] ? true : undefined}
          aria-describedby={errors['body'] ? `${id}-body-error` : undefined}
          onChange={(event) => setValues((current) => ({ ...current, body: event.target.value }))}
        />
        {errors['body'] && (
          <p id={`${id}-body-error`} className="text-sm text-red">
            {errors['body']}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className="btn-w">
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn-d">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function NoteItem({ leadId, note, today }: { leadId: string; note: LeadNote; today: string }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const update = useUpdateLeadNote(leadId);
  const remove = useDeleteLeadNote(leadId);
  if (editing) {
    return (
      <li className="border-t border-line py-4 first:border-t-0">
        <NoteForm
          initial={{ heldOn: note.heldOn, body: note.body }}
          today={today}
          submitLabel="Save note"
          busy={update.isPending}
          error={update.error}
          onCancel={() => setEditing(false)}
          onSubmit={(patch) =>
            update.mutate({ noteId: note.id, patch }, { onSuccess: () => setEditing(false) })
          }
        />
      </li>
    );
  }
  return (
    <li className="border-t border-line py-4 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <time dateTime={note.heldOn} className="text-[0.8125rem] font-semibold">
          {formatDate(note.heldOn)}
        </time>
        <span className="flex gap-1 text-sm">
          <button type="button" className={linkClass} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className={linkClass} onClick={() => setConfirming(true)}>
            Delete
          </button>
        </span>
      </div>
      <p className="mt-1 text-sm whitespace-pre-wrap text-fg-2">{note.body}</p>
      <ConfirmDialog
        open={confirming}
        title="Delete this note?"
        message="The note will be removed. This cannot be undone."
        confirmLabel="Delete note"
        busy={remove.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => remove.mutate(note.id, { onSuccess: () => setConfirming(false) })}
      />
    </li>
  );
}

export function LeadPage() {
  const { id, lead, message } = useLeadOrMessage();
  const me = useMe();
  const addNote = useAddLeadNote(id);
  const remove = useDeleteLead(id);
  const navigate = useNavigate();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  if (!lead) return <p className="text-fg-2">{message}</p>;
  const today = localDateIn(new Date(), me.data?.timeZone ?? 'UTC');
  const hasContact = Boolean(lead.email || lead.phone || lead.profileLink);

  return (
    <div className="flex flex-col gap-6">
      <Link to="/leads" className="back-link">
        ← Back to leads
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 items-center gap-4 sm:gap-5">
          <Avatar name={lead.name} color={LEAD_COLOR} size="xl" />
          <div className="min-w-0">
            <RevealHeading
              text={lead.name}
              className="text-4xl font-semibold tracking-[-0.055em] sm:text-6xl"
            />
            {lead.company && <p className="rise rise-3 mt-1 text-fg-2">{lead.company}</p>}
          </div>
        </div>
        <div className="rise rise-4 flex flex-wrap gap-3">
          <Link to={`/leads/${id}/edit`} className="btn-w min-h-12 px-6 text-[0.9375rem]">
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

      <div className="grid items-start gap-3 lg:grid-cols-[1fr_1.4fr]">
        <div className="flex flex-col gap-3">
          {hasContact && (
            <Glow as="section" aria-labelledby="contact-heading" className="rise rise-3 p-5">
              <h2 id="contact-heading" className="text-[0.8125rem] font-medium text-fg-2">
                Contact
              </h2>
              <dl className="mt-2">
                {lead.email && (
                  <div className="border-t border-line py-3 first:border-t-0">
                    <dt className="text-xs text-fg-3">Email</dt>
                    <dd className="break-words">
                      <a href={`mailto:${lead.email}`} className="link underline">
                        {lead.email}
                      </a>
                    </dd>
                  </div>
                )}
                {lead.phone && (
                  <div className="border-t border-line py-3 first:border-t-0">
                    <dt className="text-xs text-fg-3">Phone</dt>
                    <dd>
                      <a href={`tel:${lead.phone}`} className="link underline">
                        {lead.phone}
                      </a>
                    </dd>
                  </div>
                )}
                {lead.profileLink && (
                  <div className="border-t border-line py-3 first:border-t-0">
                    <dt className="text-xs text-fg-3">Profile</dt>
                    <dd className="break-words">
                      <a
                        href={lead.profileLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="link underline"
                      >
                        {lead.profileLink}
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            </Glow>
          )}

          <Glow
            as="section"
            aria-labelledby="lead-applications-heading"
            className="rise rise-4 p-5"
          >
            <h2
              id="lead-applications-heading"
              className="flex justify-between text-[0.8125rem] font-medium text-fg-2"
            >
              <span>Applications</span>
              <span className="tabular-nums">{lead.applications.length}</span>
            </h2>
            {lead.applications.length === 0 ? (
              <p className="mt-3 text-sm text-fg-2">
                None yet. Choose this lead on an application to link it.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col">
                {lead.applications.map((application) => (
                  <li key={application.id} className="border-t border-line first:border-t-0">
                    <Link
                      to={`/applications/${application.id}`}
                      aria-label={`${application.company} · ${application.role}`}
                      className="flex min-h-14 items-center gap-3 py-3 transition-[padding] duration-300 hover:pl-1.5"
                    >
                      <Avatar name={application.company} color={STAGE_COLOR[application.status]} />
                      <span className="min-w-0">
                        <b className="block truncate text-[0.9375rem] font-medium">
                          {application.company}
                        </b>
                        <small className="block truncate text-[0.8125rem] text-fg-2">
                          {application.role}
                        </small>
                      </span>
                      <span className="ml-auto shrink-0">
                        <StatusBadge status={application.status} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Glow>
        </div>

        <Glow as="section" aria-labelledby="notes-heading" className="rise rise-5 p-5">
          <h2 id="notes-heading" className="text-[0.8125rem] font-medium text-fg-2">
            Conversation notes
          </h2>
          <div className="mt-3 border-b border-line pb-5">
            <NoteForm
              key={lead.noteCount}
              initial={{ heldOn: today, body: '' }}
              today={today}
              submitLabel="Add note"
              busy={addNote.isPending}
              error={addNote.error}
              onSubmit={(input, reset) =>
                addNote.mutate(input, {
                  onSuccess: () => {
                    reset();
                    toast('Note added');
                  },
                })
              }
            />
          </div>
          {lead.notes.length === 0 ? (
            <p className="mt-4 text-sm text-fg-2">No notes yet.</p>
          ) : (
            <ul className="flex flex-col">
              {lead.notes.map((note) => (
                <NoteItem key={note.id} leadId={id} note={note} today={today} />
              ))}
            </ul>
          )}
        </Glow>
      </div>

      <ConfirmDialog
        open={confirming}
        title={`Delete ${lead.name}?`}
        message="The lead and its notes will be removed. Its applications stay, unlinked. This cannot be undone."
        confirmLabel="Delete lead"
        busy={remove.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          remove.mutate(undefined, { onSuccess: () => void navigate('/leads', { replace: true }) })
        }
      />
    </div>
  );
}

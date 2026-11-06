import {
  LeadInputSchema,
  LeadNoteInputSchema,
  localDateIn,
  type LeadDetail,
  type LeadInput,
  type LeadNote,
} from '@jat/shared';
import { useEffect, useId, useState } from 'react';
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

const linkClass = 'text-blue-link underline';

export function LeadsPage() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const leads = useLeads(q || undefined);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Networking leads</h1>
        <Link to="/leads/new" className="btn-primary">
          Add lead
        </Link>
      </div>
      <p className="text-sm text-fg-2">
        The people helping you find a job: recruiters, referrers, friends. Keep notes from each
        conversation and link the applications they led to.
      </p>
      <div className="flex flex-col gap-1">
        <label htmlFor="lead-search" className="text-sm font-medium">
          Search
        </label>
        <input
          id="lead-search"
          type="search"
          className="input"
          placeholder="Name, company or notes"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {leads.isPending && <p>Loading…</p>}
      {leads.isError && <p className="text-red">Could not load your leads.</p>}
      {leads.isSuccess && leads.data.total === 0 && (
        <div className="rounded-xl border border-dashed border-line-2 p-8 text-center">
          <p className="font-medium">{q ? 'No leads match.' : 'No leads yet.'}</p>
          <p className="mt-1 text-sm text-fg-2">
            {q ? 'Try another search.' : 'Add the first person helping you.'}
          </p>
        </div>
      )}
      <ul className="flex flex-col gap-3">
        {leads.data?.items.map((lead) => (
          <li key={lead.id}>
            <Link
              to={`/leads/${lead.id}`}
              className="block rounded-xl border border-line p-4 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-blue"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">{lead.name}</span>
                <span className="text-xs text-fg-3">
                  {lead.applicationCount === 1
                    ? '1 application'
                    : `${lead.applicationCount} applications`}
                </span>
              </div>
              {lead.company && <p className="text-sm text-fg-2">{lead.company}</p>}
              {lead.latestNote && (
                <p className="mt-1 line-clamp-2 text-sm text-fg-3">
                  {formatDate(lead.latestNote.heldOn)}: {lead.latestNote.body}
                </p>
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

  const field = (
    name: keyof LeadFormValues,
    label: string,
    type = 'text',
    autoComplete?: string,
  ) => {
    const controlId = `${id}-${name}`;
    const problem = errors[name];
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={controlId} className="text-sm font-medium">
          {label}
        </label>
        <input
          id={controlId}
          type={type}
          autoComplete={autoComplete}
          className={`input ${problem ? 'border-red' : ''}`}
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
      className="flex flex-col gap-4"
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

export function NewLeadPage() {
  const create = useCreateLead();
  const navigate = useNavigate();
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">Add lead</h1>
      <LeadForm
        initial={EMPTY_LEAD}
        submitLabel="Save lead"
        busy={create.isPending}
        error={create.error}
        onCancel={() => void navigate('/leads')}
        onSubmit={(input) =>
          create.mutate(input, { onSuccess: (lead) => void navigate(`/leads/${lead.id}`) })
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
  if (!lead) return <p>{message}</p>;
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">Edit {lead.name}</h1>
      <LeadForm
        initial={toLeadValues(lead)}
        submitLabel="Save changes"
        busy={update.isPending}
        error={update.error}
        onCancel={() => void navigate(`/leads/${id}`)}
        onSubmit={(input) =>
          update.mutate(input, { onSuccess: () => void navigate(`/leads/${id}`) })
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
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-day`} className="text-sm font-medium">
          Day
        </label>
        <input
          id={`${id}-day`}
          type="date"
          max={today}
          className="input w-48"
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
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-body`} className="text-sm font-medium">
          What was said
        </label>
        <textarea
          id={`${id}-body`}
          rows={3}
          className="input"
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
        <button type="submit" disabled={busy} className="btn-primary">
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn-secondary">
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
      <li className="rounded-lg border border-line p-3">
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
    <li className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <time dateTime={note.heldOn} className="text-sm font-medium">
          {formatDate(note.heldOn)}
        </time>
        <span className="flex gap-3 text-sm">
          <button type="button" className={linkClass} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className={linkClass} onClick={() => setConfirming(true)}>
            Delete
          </button>
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm">{note.body}</p>
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
  const [confirming, setConfirming] = useState(false);
  if (!lead) return <p>{message}</p>;
  const today = localDateIn(new Date(), me.data?.timeZone ?? 'UTC');

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{lead.name}</h1>
          {lead.company && <p className="text-fg-2">{lead.company}</p>}
        </div>
        <div className="flex gap-3">
          <Link to={`/leads/${id}/edit`} className="btn-primary">
            Edit
          </Link>
          <button type="button" className="btn-danger" onClick={() => setConfirming(true)}>
            Delete
          </button>
        </div>
      </div>

      {(lead.email || lead.phone || lead.profileLink) && (
        <dl className="grid gap-3 sm:grid-cols-3">
          {lead.email && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-3">Email</dt>
              <dd className="break-words">
                <a href={`mailto:${lead.email}`} className={linkClass}>
                  {lead.email}
                </a>
              </dd>
            </div>
          )}
          {lead.phone && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-3">Phone</dt>
              <dd>
                <a href={`tel:${lead.phone}`} className={linkClass}>
                  {lead.phone}
                </a>
              </dd>
            </div>
          )}
          {lead.profileLink && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-3">Profile</dt>
              <dd className="break-words">
                <a
                  href={lead.profileLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={linkClass}
                >
                  {lead.profileLink}
                </a>
              </dd>
            </div>
          )}
        </dl>
      )}

      <section aria-labelledby="notes-heading" className="flex flex-col gap-3">
        <h2 id="notes-heading" className="text-lg font-semibold">
          Notes
        </h2>
        <NoteForm
          key={lead.noteCount}
          initial={{ heldOn: today, body: '' }}
          today={today}
          submitLabel="Add note"
          busy={addNote.isPending}
          error={addNote.error}
          onSubmit={(input, reset) => addNote.mutate(input, { onSuccess: reset })}
        />
        {lead.notes.length === 0 ? (
          <p className="text-sm text-fg-3">No notes yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {lead.notes.map((note) => (
              <NoteItem key={note.id} leadId={id} note={note} today={today} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="lead-applications-heading" className="flex flex-col gap-2">
        <h2 id="lead-applications-heading" className="text-lg font-semibold">
          Applications
        </h2>
        {lead.applications.length === 0 ? (
          <p className="text-sm text-fg-3">
            None yet. Choose this lead on an application to link it.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {lead.applications.map((application) => (
              <li
                key={application.id}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <Link to={`/applications/${application.id}`} className={linkClass}>
                  {application.company} · {application.role}
                </Link>
                <StatusBadge status={application.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

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

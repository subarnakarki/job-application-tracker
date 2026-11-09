import {
  characterCount,
  companyKey,
  isLinkedInLink,
  LEAD_MESSAGE_KIND_LABELS,
  LEAD_MESSAGE_KINDS,
  LEAD_MESSAGE_LIMITS,
  suggestedMessageKind,
  type ApplicationDetail,
  type Lead,
  type LeadMessageKind,
} from '@jat/shared';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { ApiRequestError } from '../api/client';
import {
  useCreateLead,
  useDraftLeadMessage,
  useJobSearchSetup,
  useLeads,
  useMarkLeadMessageSent,
} from '../api/hooks';
import { useToast } from './Toast';
import { Glow } from './ui/Glow';

const labelClass = 'text-[0.8125rem] font-medium text-fg-2';

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

/** Leads at the application's company first, then the rest by name. */
function orderedLeads(leads: Lead[], company: string): Lead[] {
  const key = companyKey(company);
  const atCompany = (lead: Lead) => (lead.company && companyKey(lead.company) === key ? 0 : 1);
  return [...leads].sort((a, b) => atCompany(a) - atCompany(b) || a.name.localeCompare(b.name));
}

/**
 * "Message a lead": drafts a LinkedIn connection note and message about this application. The app
 * cannot send LinkedIn messages: the owner copies one, opens the lead's profile and sends it, then
 * marks it sent, which logs it on the lead. Shown only where the job search is available.
 */
export function LeadMessageSection({ application }: { application: ApplicationDetail }) {
  const setup = useJobSearchSetup();
  if (!setup.data?.available) return null;
  return <LeadMessagePanel application={application} />;
}

function LeadMessagePanel({ application }: { application: ApplicationDetail }) {
  const id = useId();
  const leads = useLeads();
  const draft = useDraftLeadMessage(application.id);
  const [leadId, setLeadId] = useState(application.leadId ?? '');
  const [kind, setKind] = useState<LeadMessageKind>(suggestedMessageKind(application.status));
  const [steer, setSteer] = useState('');
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');

  const options = orderedLeads(leads.data?.items ?? [], application.company);
  const lead = options.find((entry) => entry.id === leadId) ?? null;

  return (
    <Glow as="section" aria-labelledby={`${id}-heading`} className="flex flex-col gap-4 p-5">
      <h2 id={`${id}-heading`} className="text-[0.8125rem] font-medium text-fg-2">
        Message a lead
      </h2>
      <p className="text-sm text-fg-3">
        Drafts a LinkedIn note and message about this job. You send it yourself on LinkedIn, then
        mark it sent to log it on the lead.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-lead`} className={labelClass}>
            Lead
          </label>
          <select
            id={`${id}-lead`}
            className="inp"
            value={leadId}
            onChange={(event) => setLeadId(event.target.value)}
          >
            <option value="">Choose a lead</option>
            {options.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.company ? `${entry.name} (${entry.company})` : entry.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="link self-start text-sm underline"
            aria-expanded={adding}
            onClick={() => setAdding((open) => !open)}
          >
            Add a lead
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-kind`} className={labelClass}>
            Kind of message
          </label>
          <select
            id={`${id}-kind`}
            className="inp"
            value={kind}
            onChange={(event) => setKind(event.target.value as LeadMessageKind)}
          >
            {LEAD_MESSAGE_KINDS.map((value) => (
              <option key={value} value={value}>
                {LEAD_MESSAGE_KIND_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {adding && (
        <NewLeadForm
          company={application.company}
          onAdded={(newId) => {
            setLeadId(newId);
            setAdding(false);
          }}
        />
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-steer`} className={labelClass}>
          What you want to say (optional)
        </label>
        <input
          id={`${id}-steer`}
          className="inp"
          value={steer}
          maxLength={LEAD_MESSAGE_LIMITS.steer}
          placeholder="Mention the Playwright work"
          onChange={(event) => setSteer(event.target.value)}
        />
      </div>

      <div>
        <button
          type="button"
          className="btn-d"
          disabled={!leadId || draft.isPending}
          onClick={() =>
            draft.mutate(
              { leadId, kind, steer },
              {
                onSuccess: (result) => {
                  setNote(result.connectionNote);
                  setMessage(result.message);
                },
              },
            )
          }
        >
          {draft.isPending ? 'Drafting…' : 'Draft message'}
        </button>
      </div>
      {draft.isPending && (
        <p role="status" className="text-sm text-fg-3">
          Drafting from the job, your notes about this lead and your resume…
        </p>
      )}
      {draft.isError && (
        <p role="alert" className="text-sm text-red">
          {errorText(draft.error, 'Could not draft right now. Try again.')}
        </p>
      )}

      {draft.data && lead && (
        <div className="flex flex-col gap-5">
          <MessageVersion
            applicationId={application.id}
            lead={lead}
            label="Connection note"
            limit={LEAD_MESSAGE_LIMITS.connectionNote}
            value={note}
            onChange={setNote}
          />
          <MessageVersion
            applicationId={application.id}
            lead={lead}
            label="Message"
            limit={LEAD_MESSAGE_LIMITS.message}
            value={message}
            onChange={setMessage}
          />
        </div>
      )}
    </Glow>
  );
}

/** One version of the message: editable, with its count, Copy (and open), and Mark sent. */
function MessageVersion({
  applicationId,
  lead,
  label,
  limit,
  value,
  onChange,
}: {
  applicationId: string;
  lead: Lead;
  label: string;
  limit: number;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const toast = useToast();
  const sent = useMarkLeadMessageSent(applicationId);
  const [copyFailed, setCopyFailed] = useState(false);
  const count = characterCount(value);
  const over = count > limit;
  const link = lead.profileLink;
  const openLabel = !link
    ? 'Copy'
    : isLinkedInLink(link)
      ? 'Copy and open profile'
      : 'Copy and open link';

  const copyAndOpen = async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setCopyFailed(true);
      return;
    }
    if (link) window.open(link, '_blank', 'noopener,noreferrer');
    else toast('Copied');
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <textarea
        id={id}
        rows={label === 'Message' ? 7 : 3}
        className="inp text-sm"
        value={value}
        aria-describedby={`${id}-count`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-count`} className={over ? 'text-sm text-red' : 'text-xs text-fg-3'}>
        {count} of {limit} characters{over ? ': too long for LinkedIn' : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-d"
          disabled={!value.trim()}
          aria-label={`${openLabel}: ${label.toLowerCase()}`}
          onClick={() => void copyAndOpen()}
        >
          {openLabel}
        </button>
        <button
          type="button"
          className="btn-d"
          disabled={!value.trim() || sent.isPending}
          aria-label={`Mark sent: ${label.toLowerCase()}`}
          onClick={() =>
            sent.mutate(
              { leadId: lead.id, text: value },
              { onSuccess: () => toast(`Logged on ${lead.name}`) },
            )
          }
        >
          {sent.isPending ? 'Saving…' : 'Mark sent'}
        </button>
      </div>
      {copyFailed && (
        <p role="alert" className="text-sm text-red">
          Could not copy. Select the text and copy it yourself.
        </p>
      )}
      {sent.isError && (
        <p role="alert" className="text-sm text-red">
          {errorText(sent.error, 'Could not save. Try again.')}
        </p>
      )}
      {sent.isSuccess && (
        <p className="text-sm text-fg-2">
          Logged on{' '}
          <Link to={`/leads/${lead.id}`} className="link underline">
            {lead.name}
          </Link>
          .
        </p>
      )}
    </div>
  );
}

/** A new lead, added right here: name and profile link (company prefilled). */
function NewLeadForm({ company, onAdded }: { company: string; onAdded: (id: string) => void }) {
  const id = useId();
  const create = useCreateLead();
  const [name, setName] = useState('');
  const [profileLink, setProfileLink] = useState('');
  return (
    <form
      className="flex flex-col gap-3 rounded-tile bg-s2 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        create.mutate(
          {
            name: name.trim(),
            company,
            email: null,
            phone: null,
            profileLink: profileLink.trim() || null,
          },
          { onSuccess: (lead) => onAdded(lead.id) },
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-name`} className={labelClass}>
            Name
          </label>
          <input
            id={`${id}-name`}
            className="inp"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-link`} className={labelClass}>
            LinkedIn profile (optional)
          </label>
          <input
            id={`${id}-link`}
            className="inp"
            type="url"
            value={profileLink}
            placeholder="https://www.linkedin.com/in/…"
            onChange={(event) => setProfileLink(event.target.value)}
          />
        </div>
      </div>
      {create.isError && (
        <p role="alert" className="text-sm text-red">
          {errorText(create.error, 'Could not add the lead. Try again.')}
        </p>
      )}
      <div>
        <button type="submit" className="btn-d" disabled={!name.trim() || create.isPending}>
          {create.isPending ? 'Adding…' : 'Add lead'}
        </button>
      </div>
    </form>
  );
}

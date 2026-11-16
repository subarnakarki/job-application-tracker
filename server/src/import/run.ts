import {
  ApplicationInputSchema,
  isHttpUrl,
  LIMITS,
  localDateIn,
  resolveDateApplied,
  type Status,
} from '@jat/shared';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import {
  createApplication,
  listMatchCandidates,
  updateApplication,
  type Owner,
} from '../repo/applications';
import {
  claimMessage,
  finishRun,
  lastFinishedRunStart,
  releasePending,
  startRun,
  updateItem,
  type ItemFields,
} from '../repo/imports';
import type { Classification, EmailClassifier } from './classify';
import { GmailError, gmailQuery, MAX_MESSAGES, type GmailClient, type GmailMessage } from './gmail';
import { decide, type EmailVerdict } from './verdict';
import { BOARD_LABELS, siteOf } from '../postings/boards';
import type { Details } from '../postings/details';
import type { PageFetcher } from '../postings/fetchPage';
import { fillEmpty, UNKNOWN_ROLE, type Fillable } from '../postings/fill';
import { findOnBoards, suggestionOf } from '../postings/lookup';
import { isSignInSite, readPosting } from '../postings/preview';
import { saveSuggestion } from '../repo/postingSuggestions';

export interface ImportDeps {
  db: Db;
  gmail: GmailClient;
  classifier: EmailClassifier;
  clock: Clock;
  /** Reading job postings for the applications an import creates. Without it, none are read. */
  postings?: {
    /** For a posting link (the usual 2 MB cap). */
    fetchPage: PageFetcher;
    /** For a company's whole job board, which can be several MB. */
    fetchBoard: PageFetcher;
  };
}

/** At most this many posting links read, and board lookups made, per import (a run has 300 s). */
export const MAX_POSTING_READS = 20;
export const MAX_BOARD_LOOKUPS = 8;

/** Career-site hosts whose pages are known to carry JobPosting data, read automatically too. */
const AUTO_READ_PAGES = /(^|\.)(teamtailor\.com|jobs\.personio\.(de|com))$/i;

/**
 * Whether a link from an email is read without asking: only known job boards. Anyone can send an
 * email, so arbitrary links are kept as the job link but read only when the user asks.
 */
export function readsAutomatically(link: string): boolean {
  const url = new URL(link);
  return (
    url.protocol === 'https:' && (siteOf(url).kind !== 'page' || AUTO_READ_PAGES.test(url.hostname))
  );
}

/** The verdict's posting link, but only if it really is one of the email's own links. */
export function postingLinkOf(verdict: EmailVerdict, message: GmailMessage | null): string | null {
  const link = verdict.postingUrl?.trim();
  if (!link || link.length > LIMITS.jobLink || !isHttpUrl(link)) return null;
  return message?.links?.some((candidate) => candidate.url === link) ? link : null;
}

/** "Acme Careers <jobs@acme.example>" -> "jobs@acme.example". */
export function senderAddress(from: string): string | null {
  const address = /<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1] ?? /^\S+@\S+$/.exec(from.trim())?.[0];
  return address ?? null;
}

/** This user already has an import running: only one at a time. */
export class ImportAlreadyRunningError extends Error {
  constructor() {
    super('An import is already running');
    this.name = 'ImportAlreadyRunningError';
  }
}

/** Emails fetched and classified at the same time (the applying is one at a time). */
const CONCURRENCY = 5;

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  // The first error stops every worker from starting another item (a Claude limit would fail
  // them all alike); the items already started finish, then the error is thrown.
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index] as T);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}

interface Prepared {
  itemId: string;
  message: GmailMessage | null;
  classification: Classification;
  /** The job posting link from the email, when it has one. */
  link?: string | null;
  /** What that posting says, when it was read. */
  posting?: (Details & { jobLink: string }) | null;
}

/** An application this import created without posting details: worth a board lookup. */
interface Created {
  itemId: string;
  applicationId: string;
  company: string;
  role: string;
  sender: string | null;
  reason: string;
}

/** Reads the posting links of job emails, on known job boards only. Failures just leave them unread. */
async function readPostings(fetchPage: PageFetcher, prepared: Prepared[]): Promise<void> {
  for (const item of prepared) {
    if (item.classification.kind === 'verdict')
      item.link = postingLinkOf(item.classification.verdict, item.message);
  }
  const toRead = prepared
    .filter(
      (item) =>
        item.link &&
        item.classification.kind === 'verdict' &&
        item.classification.verdict.kind !== 'not_job_related' &&
        !isSignInSite(new URL(item.link)) &&
        readsAutomatically(item.link),
    )
    .slice(0, MAX_POSTING_READS);
  await mapLimit(toRead, CONCURRENCY, async (item) => {
    try {
      item.posting = await readPosting(item.link ?? '', fetchPage);
    } catch {
      item.posting = null;
    }
  });
}

/** Looks the created applications up on public job boards and saves what is found as a suggestion. */
async function lookUpBoards(deps: ImportDeps, owner: Owner, created: Created[]): Promise<void> {
  const fetchBoard = deps.postings?.fetchBoard;
  if (!fetchBoard) return;
  await mapLimit(created.slice(0, MAX_BOARD_LOOKUPS), 3, async (entry) => {
    try {
      const match = await findOnBoards(
        { company: entry.company, role: entry.role, senderEmail: entry.sender },
        fetchBoard,
      );
      if (!match) return;
      const saved = await saveSuggestion(
        deps.db,
        owner.userId,
        entry.applicationId,
        suggestionOf(match),
        deps.clock.now(),
      );
      if (saved)
        await updateItem(deps.db, owner.userId, entry.itemId, {
          reason:
            `${entry.reason}; a possible posting was found on ${BOARD_LABELS[match.source]}`.slice(
              0,
              200,
            ),
        });
    } catch {
      // A lookup is a bonus: it never fails the import.
    }
  });
}

/**
 * The date applied an import should record: the day of the email (in the user's time zone),
 * exactly when the usual rule would fill in "today" (first reaching Applied or later with no
 * date yet). Undefined otherwise, or when the email has no date, so the usual rule applies.
 */
export function importedDateApplied(
  previousStatus: Status | null,
  newStatus: Status,
  currentDateApplied: string | null,
  emailDate: Date | null,
  timeZone: string,
): string | undefined {
  if (!emailDate || currentDateApplied !== null) return undefined;
  const emailDay = localDateIn(emailDate, timeZone);
  return (
    resolveDateApplied({ previousStatus, newStatus, dateApplied: null, today: emailDay }) ??
    undefined
  );
}

export { UNKNOWN_ROLE };

/**
 * One Gmail import for one user: find new job emails, classify each one, and
 * apply what the rules allow. Every email ends up as an item on the run, so the
 * results page can show it and undo it. The access token is used and dropped.
 */
export async function runImport(
  deps: ImportDeps,
  owner: Owner,
  accessToken: string,
): Promise<string> {
  const { db, gmail, classifier, clock } = deps;
  // Claim the run first (one at a time per user), so a second request does no work at all.
  const runId = await startRun(db, owner.userId, clock.now());
  if (!runId) throw new ImportAlreadyRunningError();
  let since: Date | null;
  try {
    since = await lastFinishedRunStart(db, owner.userId);
  } catch (error) {
    await finishRun(db, owner.userId, runId, {
      status: 'failed',
      emailsScanned: 0,
      now: clock.now(),
    });
    throw error;
  }
  try {
    const ids = await gmail.listMessageIds(accessToken, gmailQuery(since), MAX_MESSAGES);
    const claimed: { itemId: string; messageId: string }[] = [];
    for (const messageId of ids) {
      const itemId = await claimMessage(db, owner.userId, runId, messageId, clock.now());
      if (itemId) claimed.push({ itemId, messageId });
    }

    const prepared = await mapLimit(claimed, CONCURRENCY, async ({ itemId, messageId }) => {
      let message: GmailMessage;
      try {
        message = await gmail.getMessage(accessToken, messageId);
      } catch (error) {
        if (!(error instanceof GmailError)) throw error;
        const unread: Prepared = {
          itemId,
          message: null,
          classification: { kind: 'unclassified', reason: 'Could not read the email' },
        };
        return unread;
      }
      return { itemId, message, classification: await classifier.classify(message) };
    });

    // Oldest first, so "thanks for applying" lands before that company's "unfortunately".
    prepared.sort(
      (a, b) => (a.message?.date?.getTime() ?? Infinity) - (b.message?.date?.getTime() ?? Infinity),
    );
    if (deps.postings) await readPostings(deps.postings.fetchPage, prepared);
    const created: Created[] = [];
    for (const item of prepared) {
      const result = await applyOne(deps, owner, item);
      if (result) created.push(result);
    }
    await lookUpBoards(deps, owner, created);

    await finishRun(db, owner.userId, runId, {
      status: 'finished',
      emailsScanned: ids.length,
      now: clock.now(),
    });
    return runId;
  } catch (error) {
    await releasePending(db, owner.userId, runId);
    await finishRun(db, owner.userId, runId, {
      status: 'failed',
      emailsScanned: 0,
      now: clock.now(),
    });
    throw error;
  }
}

/** Applies one email; returns the application it created when that one could use a board lookup. */
async function applyOne(
  deps: ImportDeps,
  owner: Owner,
  prepared: Prepared,
): Promise<Created | void> {
  const { db, clock } = deps;
  const { itemId, message, classification } = prepared;
  const save = (fields: ItemFields) =>
    updateItem(db, owner.userId, itemId, {
      emailFrom: message?.from ?? '',
      emailSubject: message?.subject ?? '',
      emailDate: message?.date ?? null,
      ...fields,
    });

  if (classification.kind === 'unclassified') {
    return save({ outcome: 'needs_review', reason: classification.reason });
  }
  const { verdict } = classification;
  const described: ItemFields = {
    verdictKind: verdict.kind,
    confidence: verdict.confidence,
    company: verdict.company.trim() || null,
    role: verdict.role?.trim() || null,
    summary: verdict.summary,
  };
  const candidates = await listMatchCandidates(db, owner.userId);
  const decision = decide(verdict, candidates);
  const review = (
    reason: string,
    proposed = decision.kind === 'review' ? decision.proposed : null,
  ) => save({ ...described, outcome: 'needs_review', reason, proposedStatus: proposed });

  switch (decision.kind) {
    case 'ignore':
      return save({ ...described, outcome: 'ignored', reason: decision.reason });
    case 'review':
      return save({
        ...described,
        outcome: 'needs_review',
        reason: decision.reason,
        proposedStatus: decision.proposed,
        applicationId: decision.applicationId,
      });
    case 'create': {
      // What the email gave, then the empty fields filled from its posting (when it was read).
      const base: Fillable = {
        role: verdict.role?.trim() || UNKNOWN_ROLE,
        jobLink: prepared.link ?? null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        location: null,
        workMode: null,
        postedOn: null,
      };
      const { patch, filled } = prepared.posting
        ? fillEmpty(base, prepared.posting)
        : { patch: {}, filled: [] };
      const input = ApplicationInputSchema.safeParse({
        company: verdict.company.trim(),
        ...base,
        ...patch,
        status: decision.status,
        dateApplied:
          importedDateApplied(null, decision.status, null, message?.date ?? null, owner.timeZone) ??
          null,
        source: 'Other',
        notes: `Added from Gmail: ${verdict.summary}`,
      });
      if (!input.success) return review('Could not create it from this email', decision.status);
      const created = await createApplication(db, owner, input.data, clock.now(), 'gmail');
      if (created.kind === 'limit_reached') {
        return review('Application limit reached', decision.status);
      }
      if (created.kind === 'invalid')
        return review('Could not create it from this email', decision.status);
      const reason = filled.length
        ? `New application; filled from the posting: ${filled.join(', ')}`.slice(0, 200)
        : 'New application';
      await save({
        ...described,
        outcome: 'created',
        reason,
        applicationId: created.value.record.id,
        toStatus: created.value.record.status,
        appliedVersion: created.value.record.version,
      });
      const role = verdict.role?.trim();
      // Nothing read from a posting, but a role to look for: the company's job board may have it.
      if (!prepared.posting && role)
        return {
          itemId,
          applicationId: created.value.record.id,
          company: verdict.company.trim(),
          role,
          sender: message ? senderAddress(message.from) : null,
          reason,
        };
      return;
    }
    case 'change': {
      const candidate = candidates.find((app) => app.id === decision.applicationId);
      if (!candidate) return review('The application is gone', decision.to);
      const updated = await updateApplication(
        db,
        owner,
        candidate.id,
        candidate.version,
        {
          status: decision.to,
          dateApplied: importedDateApplied(
            candidate.status,
            decision.to,
            candidate.dateApplied,
            message?.date ?? null,
            owner.timeZone,
          ),
        },
        clock.now(),
        'gmail',
      );
      if (updated.kind !== 'updated') return review('It changed while importing', decision.to);
      return save({
        ...described,
        outcome: 'status_changed',
        reason: `${decision.from} → ${decision.to}`,
        applicationId: candidate.id,
        fromStatus: decision.from,
        toStatus: decision.to,
        previousDateApplied: candidate.dateApplied,
        appliedVersion: updated.value.record.version,
      });
    }
  }
}

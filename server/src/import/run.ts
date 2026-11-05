import { ApplicationInputSchema } from '@jat/shared';
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
  createRun,
  finishRun,
  lastFinishedRunStart,
  releasePending,
  updateItem,
  type ItemFields,
} from '../repo/imports';
import type { Classification, EmailClassifier } from './classify';
import { GmailError, gmailQuery, MAX_MESSAGES, type GmailClient, type GmailMessage } from './gmail';
import { decide } from './verdict';

export interface ImportDeps {
  db: Db;
  gmail: GmailClient;
  classifier: EmailClassifier;
  clock: Clock;
}

/** Emails fetched and classified at the same time (the applying is one at a time). */
const CONCURRENCY = 5;

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface Prepared {
  itemId: string;
  message: GmailMessage | null;
  classification: Classification;
}

/** Placeholder when an email names no role: `role` is required on an application. */
export const UNKNOWN_ROLE = 'Role not stated';

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
  const since = await lastFinishedRunStart(db, owner.userId);
  const runId = await createRun(db, owner.userId, clock.now());
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
    for (const item of prepared) await applyOne(deps, owner, item);

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

async function applyOne(deps: ImportDeps, owner: Owner, prepared: Prepared): Promise<void> {
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
      const input = ApplicationInputSchema.safeParse({
        company: verdict.company.trim(),
        role: verdict.role?.trim() || UNKNOWN_ROLE,
        status: decision.status,
        source: 'Other',
        notes: `Added from Gmail: ${verdict.summary}`,
      });
      if (!input.success) return review('Could not create it from this email', decision.status);
      const created = await createApplication(db, owner, input.data, clock.now(), 'gmail');
      if (created.kind === 'limit_reached') {
        return review('Application limit reached', decision.status);
      }
      return save({
        ...described,
        outcome: 'created',
        reason: 'New application',
        applicationId: created.value.record.id,
        toStatus: created.value.record.status,
        appliedVersion: created.value.record.version,
      });
    }
    case 'change': {
      const candidate = candidates.find((app) => app.id === decision.applicationId);
      if (!candidate) return review('The application is gone', decision.to);
      const updated = await updateApplication(
        db,
        owner,
        candidate.id,
        candidate.version,
        { status: decision.to },
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

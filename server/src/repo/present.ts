import {
  isClosed,
  needsFollowUp,
  type Application,
  type ApplicationDetail,
  type HistoryEntry,
} from '@jat/shared';
import type { ApplicationRecord, ApplicationWithHistory, HistoryRecord } from './applications';

export interface PresentContext {
  now: Date;
  timeZone: string;
}

/** The API shape of one application. `needsFollowUp` is computed here, per request, in the user's zone. */
export function presentApplication(
  record: ApplicationRecord,
  context: PresentContext,
): Application {
  return {
    id: record.id,
    company: record.company,
    role: record.role,
    status: record.status,
    dateApplied: record.dateApplied,
    source: record.source,
    salaryMin: record.salaryMin,
    salaryMax: record.salaryMax,
    salaryCurrency: record.salaryCurrency,
    jobLink: record.jobLink,
    contact: record.contact,
    nextStep: record.nextStep,
    nextStepDate: record.nextStepDate,
    notes: record.notes,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    lastActivityAt: record.lastActivityAt.toISOString(),
    version: record.version,
    needsFollowUp: needsFollowUp(
      {
        status: record.status,
        lastActivityAt: record.lastActivityAt,
        nextStepDate: record.nextStepDate,
      },
      context,
    ),
    isClosed: isClosed(record.status),
    leadId: record.leadId,
    leadName: record.leadName,
  };
}

export function presentHistory(entry: HistoryRecord): HistoryEntry {
  return {
    id: entry.id,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    occurredAt: entry.occurredAt.toISOString(),
    actor: entry.actor,
  };
}

export function presentDetail(
  value: ApplicationWithHistory,
  context: PresentContext,
): ApplicationDetail {
  return {
    ...presentApplication(value.record, context),
    history: value.history.map(presentHistory),
  };
}

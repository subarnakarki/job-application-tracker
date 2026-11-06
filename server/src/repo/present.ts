import {
  isClosed,
  localDateIn,
  type Interview,
  needsFollowUp,
  type Application,
  type ApplicationDetail,
  type HistoryEntry,
} from '@jat/shared';
import type { ApplicationRecord, ApplicationWithHistory, HistoryRecord } from './applications';
import type { InterviewRecord } from './interviews';

export interface PresentContext {
  now: Date;
  timeZone: string;
}

/** The API shape of one application. `needsFollowUp` is computed here, per request, in the user's zone. */
export function presentApplication(
  record: ApplicationRecord,
  context: PresentContext,
): Application {
  const today = localDateIn(context.now, context.timeZone);
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
    location: record.location,
    workMode: record.workMode,
    postedOn: record.postedOn,
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
        latestInterviewOn: record.interviewDates.at(-1) ?? null,
      },
      context,
    ),
    isClosed: isClosed(record.status),
    leadId: record.leadId,
    leadName: record.leadName,
    interviewCount: record.interviewDates.length,
    nextInterviewOn: record.interviewDates.find((day) => day >= today) ?? null,
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
    interviews: value.interviews.map(presentInterview),
  };
}

export function presentInterview(entry: InterviewRecord): Interview {
  return {
    id: entry.id,
    heldOn: entry.heldOn,
    label: entry.label,
    notes: entry.notes,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

import { IMPORT_VERDICT_KINDS, isClosed, STATUSES, type Status } from '@jat/shared';
import { z } from 'zod';

export const VERDICT_KINDS = IMPORT_VERDICT_KINDS;
export type VerdictKind = (typeof VERDICT_KINDS)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;

/**
 * What the classifier may say about one email, and nothing more: it never names
 * an application id or an action, so a hostile email can at most mislabel itself.
 */
export const EmailVerdictSchema = z.strictObject({
  kind: z.enum(VERDICT_KINDS),
  company: z.string().max(200),
  role: z.string().max(200).nullable(),
  confidence: z.enum(CONFIDENCES),
  summary: z.string().max(300),
});
export type EmailVerdict = z.infer<typeof EmailVerdictSchema>;

/** The status each kind of email moves an application to. */
export const TARGET_STATUS: Record<Exclude<VerdictKind, 'not_job_related'>, Status> = {
  application_confirmation: 'Applied',
  assessment: 'Screening',
  interview_invite: 'Interviewing',
  offer: 'Offer',
  rejection: 'Rejected',
};

/** Lowercase, punctuation and legal suffixes removed: "Acme, Inc." and "ACME" match. */
export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(
      (word, index, words) => !(index > 0 && index === words.length - 1 && SUFFIXES.has(word)),
    )
    .join(' ');
}
const SUFFIXES = new Set([
  'inc',
  'llc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'gmbh',
  'plc',
]);

function normalizeRole(role: string): string {
  return role
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface Candidate {
  id: string;
  company: string;
  role: string;
  status: Status;
}

export type Decision =
  | { kind: 'ignore'; reason: string }
  | { kind: 'create'; status: Status }
  | { kind: 'change'; applicationId: string; from: Status; to: Status }
  | { kind: 'review'; reason: string; proposed: Status | null; applicationId: string | null };

const ORDER = new Map<Status, number>(STATUSES.map((status, index) => [status, index]));

/** Pure: what one classified email should do to this user's applications. */
export function decide(verdict: EmailVerdict, applications: readonly Candidate[]): Decision {
  if (verdict.kind === 'not_job_related') return { kind: 'ignore', reason: 'Not about a job' };
  const target = TARGET_STATUS[verdict.kind];
  const company = normalizeCompany(verdict.company);
  if (!company)
    return { kind: 'review', reason: 'No company found', proposed: target, applicationId: null };

  const sameCompany = applications.filter((app) => normalizeCompany(app.company) === company);
  let open = sameCompany.filter((app) => !isClosed(app.status));
  if (open.length > 1 && verdict.role) {
    const role = normalizeRole(verdict.role);
    const byRole = open.filter((app) => {
      const candidate = normalizeRole(app.role);
      return candidate === role || candidate.includes(role) || role.includes(candidate);
    });
    if (byRole.length > 0) open = byRole;
  }
  const match = open.length === 1 ? open[0] : undefined;

  if (verdict.confidence !== 'high') {
    return {
      kind: 'review',
      reason: 'Not sure enough to change anything',
      proposed: target,
      applicationId: match?.id ?? null,
    };
  }
  if (open.length > 1) {
    return {
      kind: 'review',
      reason: 'Several applications match',
      proposed: target,
      applicationId: null,
    };
  }
  if (!match) {
    if (verdict.kind === 'application_confirmation') return { kind: 'create', status: target };
    const reason =
      sameCompany.length > 0 ? 'The matching application is closed' : 'No matching application';
    return { kind: 'review', reason, proposed: target, applicationId: null };
  }
  if (match.status === target) return { kind: 'ignore', reason: `Already ${target}` };
  if (target !== 'Rejected' && (ORDER.get(target) ?? 0) < (ORDER.get(match.status) ?? 0)) {
    if (verdict.kind === 'application_confirmation') {
      return { kind: 'ignore', reason: `Already ${match.status}` };
    }
    return {
      kind: 'review',
      reason: `Would move it back from ${match.status}`,
      proposed: target,
      applicationId: match.id,
    };
  }
  return { kind: 'change', applicationId: match.id, from: match.status, to: target };
}

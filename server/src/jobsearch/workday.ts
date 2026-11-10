import { indexText, jobRefOf, titleMatch, type JobRef } from '@jat/shared';
import type { PageFetcher } from '../postings/fetchPage';
import type { SweepRules } from './sweep';

/**
 * Workday career sites, read for fresh jobs. Each site answers a public job-list request (the one
 * its own page makes), newest postings first, with the day each was posted as words ("Posted
 * Today", "Posted 3 Days Ago"). A watched Workday board is named `tenant.wdN/site`: the host and
 * the site, since one company may run several sites.
 */

const BOARD = /^([a-z0-9-]{1,60})\.(wd\d{1,4})\/([A-Za-z0-9_-]{1,60})$/;
const LOCALE = /^[a-z]{2}(-[A-Za-z]{2})?$/;

/** The watched-board name for a Workday link (a job, or the site's own page); null otherwise. */
export function workdayBoardOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' || !host) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const site = LOCALE.test(parts[0] ?? '') ? parts[1] : parts[0];
  if (!site || site === 'job') return null;
  const board = `${host[1] ?? ''}.${host[2] ?? ''}/${site}`;
  return BOARD.test(board) ? board : null;
}

/** Where a board's job list is asked for, and the base of its job links; null for a bad name. */
export function workdayAddresses(board: string): { listUrl: string; jobBase: string } | null {
  const match = BOARD.exec(board);
  if (!match) return null;
  const [, tenant = '', pod = '', site = ''] = match;
  const host = `${tenant}.${pod}.myworkdayjobs.com`;
  return {
    listUrl: `https://${host}/wday/cxs/${tenant}/${site}/jobs`,
    jobBase: `https://${host}/${site}`,
  };
}

/** "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago", as days. */
export function workdayPostedDays(postedOn: unknown): number | null {
  if (typeof postedOn !== 'string') return null;
  const text = postedOn.toLowerCase();
  if (text.includes('today')) return 0;
  if (text.includes('yesterday')) return 1;
  const days = /(\d+)(\+)?\s+days?\s+ago/.exec(text);
  if (!days) return null;
  // "30+" is at least a day more than it says.
  return Number(days[1]) + (days[2] ? 1 : 0);
}

/** Jobs asked for at once, and pages read per board: the newest sixty postings at most. */
export const WORKDAY_PAGE_SIZE = 20;
export const WORKDAY_MAX_PAGES = 3;

export interface WorkdayFound {
  ref: JobRef;
  /** As a search result would give it: the title, and the age for the posting date. */
  result: { title: string; pageAge: string | null };
}

/**
 * The wanted, recent jobs on one Workday board. Pages are read newest first until one holds
 * nothing from today or yesterday (the list is in posting order, bar a few pinned jobs), so an
 * hourly reading sees everything new without paging through the whole site.
 */
export async function readWorkdayBoard(
  board: string,
  rules: SweepRules,
  fetchBoard: PageFetcher,
): Promise<WorkdayFound[]> {
  const addresses = workdayAddresses(board);
  if (!addresses) throw new Error('Not a Workday board');
  const found: WorkdayFound[] = [];
  for (let page = 0; page < WORKDAY_MAX_PAGES; page += 1) {
    const answer = await fetchBoard(addresses.listUrl, {
      json: {
        appliedFacets: {},
        limit: WORKDAY_PAGE_SIZE,
        offset: page * WORKDAY_PAGE_SIZE,
        searchText: '',
      },
    });
    const parsed = JSON.parse(answer.text) as { jobPostings?: unknown };
    const postings = Array.isArray(parsed.jobPostings) ? (parsed.jobPostings as unknown[]) : [];
    let fresh = 0;
    for (const posting of postings) {
      if (typeof posting !== 'object' || posting === null) continue;
      const { title, externalPath, postedOn } = posting as Record<string, unknown>;
      const days = workdayPostedDays(postedOn);
      if (days !== null && days <= 1) fresh += 1;
      if (typeof title !== 'string' || typeof externalPath !== 'string') continue;
      if (days === null || days > rules.timeframeDays) continue;
      const index = indexText(title);
      if (rules.skipped.some((term) => term.trim() && index.has(term))) continue;
      if (rules.wanted.length > 0 && titleMatch(rules.wanted, title) === undefined) continue;
      const ref = jobRefOf(`${addresses.jobBase}${externalPath}`);
      if (ref?.source !== 'workday') continue;
      found.push({
        ref,
        result: { title: title.slice(0, 200), pageAge: `${String(days)} days ago` },
      });
    }
    if (postings.length < WORKDAY_PAGE_SIZE || fresh === 0) break;
  }
  return found;
}

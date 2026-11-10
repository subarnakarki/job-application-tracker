import { appendFileSync } from 'node:fs';
import { workdayAddresses } from '../jobsearch/workday';
import { BOARDS, type BoardSource } from './boards';
import { asArray, fieldOf, parseJson } from './details';
import { createPageFetcher, type PageFetcher } from './fetchPage';
import { previewPosting } from './preview';
import { readPostingText } from './text';

/**
 * Live check of every job board reader: the unit tests read saved responses, so they keep passing
 * when a board changes its pages or API. For each board this finds a job open today on a real
 * company's board (a fixed job link would close), then reads it the way the app does: "Fill from
 * link" must find the role, and the posting text (for job fit) must be there where the board has it.
 *
 * Network only, nothing stored. Run: `npm run check:boards -w @jat/server`; daily on GitHub
 * Actions (.github/workflows/board-check.yml), which fails, and so emails the owner, on any break.
 */

const fetchPage = createPageFetcher();
const fetchList = createPageFetcher({ maxBytes: 10 * 1024 * 1024 });

interface Probe {
  board: string;
  /** Companies tried in order, so one with no open jobs today does not fail the check. */
  companies: string[];
  /** A link to one open job, or null when the company has none. */
  findJob: (company: string, fetchList: PageFetcher) => Promise<string | null>;
  /** False where the board does not publish the posting's text where the app can read it. */
  hasText: boolean;
}

const fromList = (source: BoardSource) => async (company: string, fetch: PageFetcher) => {
  const url = BOARDS[source].listUrl(company);
  if (!url) return null;
  return BOARDS[source].parseList((await fetch(url)).text, company)[0]?.link ?? null;
};

const PROBES: Probe[] = [
  {
    board: 'Greenhouse',
    companies: ['figma', 'stripe'],
    findJob: fromList('greenhouse'),
    hasText: true,
  },
  { board: 'Lever', companies: ['palantir', 'spotify'], findJob: fromList('lever'), hasText: true },
  { board: 'Ashby', companies: ['ramp', 'notion'], findJob: fromList('ashby'), hasText: true },
  { board: 'Rippling', companies: ['rippling'], findJob: fromList('rippling'), hasText: true },
  {
    board: 'SmartRecruiters',
    companies: ['smartrecruiters', 'Visa'],
    findJob: fromList('smartrecruiters'),
    hasText: true,
  },
  {
    board: 'Breezy HR',
    companies: ['reveleer', 'breezy'],
    findJob: fromList('breezy'),
    hasText: true,
  },
  {
    board: 'Recruitee',
    companies: ['bunq'],
    // The list links to the company's own domain (careers.bunq.com), which the app reads only
    // through JobPosting data; the recruitee.com link (which redirects there) is the one it knows.
    findJob: async (company, fetch) => {
      const link = await fromList('recruitee')(company, fetch);
      const slug = link ? new URL(link).pathname.split('/')[2] : undefined;
      return slug ? `https://${company}.recruitee.com/o/${slug}` : null;
    },
    hasText: true,
  },
  { board: 'Teamtailor', companies: ['career'], findJob: fromList('teamtailor'), hasText: true },
  { board: 'Personio', companies: ['ottonova'], findJob: fromList('personio'), hasText: true },
  {
    board: 'Workday',
    companies: ['alliancedata.wd5/breadfinancial_US'],
    findJob: async (company, fetch) => {
      const addresses = workdayAddresses(company);
      if (!addresses) return null;
      const answer = await fetch(addresses.listUrl, {
        json: { appliedFacets: {}, limit: 1, offset: 0, searchText: '' },
      });
      const path = fieldOf(
        asArray(fieldOf(parseJson(answer.text), 'jobPostings'))[0],
        'externalPath',
      );
      return typeof path === 'string' ? `${addresses.jobBase}${path}` : null;
    },
    hasText: true,
  },
  {
    board: 'Workable',
    companies: ['huggingface'],
    findJob: async (company, fetch) => {
      const list = parseJson(
        (await fetch(`https://apply.workable.com/api/v1/widget/accounts/${company}`)).text,
      );
      const code = fieldOf(asArray(fieldOf(list, 'jobs'))[0], 'shortcode');
      return typeof code === 'string' ? `https://apply.workable.com/${company}/j/${code}/` : null;
    },
    hasText: true,
  },
  {
    board: 'Jobvite',
    companies: ['nutanix'],
    findJob: async (company, fetch) => {
      const html = (await fetch(`https://jobs.jobvite.com/${company}/jobs`)).text;
      const id = new RegExp(`/${company}/job/([A-Za-z0-9]{4,20})`).exec(html)?.[1];
      return id ? `https://jobs.jobvite.com/${company}/job/${id}` : null;
    },
    hasText: true,
  },
  {
    board: 'Zoho Recruit',
    companies: ['quoris'],
    // The careers list page loads its jobs by script, from this public list.
    findJob: async (company, fetch) => {
      const list = parseJson(
        (
          await fetch(
            `https://${company}.zohorecruit.com/recruit/v2/public/Job_Openings?pagename=Careers&source=CareerSite`,
          )
        ).text,
      );
      const id = fieldOf(asArray(fieldOf(list, 'data'))[0], 'id');
      return typeof id === 'string'
        ? `https://${company}.zohorecruit.com/jobs/Careers/${id}`
        : null;
    },
    hasText: true,
  },
];

interface Outcome {
  board: string;
  ok: boolean;
  link: string | null;
  found: string;
  problem: string | null;
}

const message = (error: unknown) =>
  error instanceof Error
    ? `${(error as { code?: string }).code ?? error.name}: ${error.message}`
    : String(error);

async function check(probe: Probe): Promise<Outcome> {
  const problems: string[] = [];
  for (const company of probe.companies) {
    let link: string | null;
    try {
      link = await probe.findJob(company, fetchList);
    } catch (error) {
      problems.push(`${company}: job list unreadable (${message(error)})`);
      continue;
    }
    if (!link) {
      problems.push(`${company}: no open job found`);
      continue;
    }
    const outcome: Outcome = { board: probe.board, ok: true, link, found: '', problem: null };
    const fail = (problem: string) => ({ ...outcome, ok: false, problem });
    try {
      const preview = await previewPosting(link, fetchPage);
      if (!preview.role) return fail('Fill from link found no role');
      const filled = Object.entries(preview)
        .filter(([key, value]) => key !== 'jobLink' && value !== null)
        .map(([key]) => key);
      outcome.found = `${preview.role} (${filled.join(', ')})`;
    } catch (error) {
      return fail(`Fill from link failed (${message(error)})`);
    }
    if (probe.hasText) {
      try {
        const text = await readPostingText(link, fetchPage);
        outcome.found += `; text ${String(text.length)} chars`;
      } catch (error) {
        return fail(`posting text failed (${message(error)})`);
      }
    }
    return outcome;
  }
  return {
    board: probe.board,
    ok: false,
    link: null,
    found: '',
    problem: `no job to check: ${problems.join('; ')}`,
  };
}

async function main(): Promise<void> {
  const outcomes = await Promise.all(PROBES.map(check));
  const lines = outcomes.map((o) =>
    o.ok
      ? `| ✅ | ${o.board} | ${o.found} | ${o.link ?? ''} |`
      : `| ❌ | ${o.board} | ${o.problem ?? ''} | ${o.link ?? ''} |`,
  );
  const report = [
    '## Job board live check',
    '',
    '| | Board | Read | Job checked |',
    '| - | - | - | - |',
    ...lines,
    '',
  ].join('\n');
  console.log(report);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary) appendFileSync(summary, report);
  const broken = outcomes.filter((o) => !o.ok).length;
  if (broken > 0) {
    console.error(`${String(broken)} of ${String(outcomes.length)} boards broken`);
    process.exitCode = 1;
  }
}

await main();

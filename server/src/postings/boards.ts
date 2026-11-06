import { LIMITS } from '@jat/shared';
import {
  asArray,
  cleanText,
  dayOf,
  EMPTY,
  fieldOf,
  locationOf,
  merge,
  onlySalary,
  parseJson,
  salaryInText,
  salaryRange,
  workModeOf,
  type Details,
} from './details';
import { fromJobPosting, fromJobPostingObject } from './jsonld';

/**
 * Job boards with a public, keyless API. Each one's response shape was checked against a real
 * board (saved, trimmed, in ./fixtures). Two uses:
 *  - reading a posting link ("Fill from link", and links found in imported emails), and
 *  - listing a company's open jobs, to look a posting up when an email has no link.
 */
export const BOARD_SOURCES = [
  'greenhouse',
  'lever',
  'ashby',
  'rippling',
  'smartrecruiters',
  'breezy',
  'recruitee',
  'teamtailor',
  'personio',
] as const;
export type BoardSource = (typeof BOARD_SOURCES)[number];

/** How each board is named to people. */
export const BOARD_LABELS: Record<BoardSource, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  rippling: 'Rippling',
  smartrecruiters: 'SmartRecruiters',
  breezy: 'Breezy HR',
  recruitee: 'Recruitee',
  teamtailor: 'Teamtailor',
  personio: 'Personio',
};

const SLUG = /^[A-Za-z0-9_.-]{1,100}$/;
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f-]{36}$/i;

const text = (value: unknown, max: number = LIMITS.role) => cleanText(value, max);

// ---------- Each board's job shape -> Details ----------

/** Greenhouse pay is in cents, with a free-text title such as "Annual Base Salary Range". */
function greenhouseSalary(ranges: unknown): Details['salary'] {
  return onlySalary(
    asArray(ranges)
      .filter((range) => {
        const title = fieldOf(range, 'title');
        return !(typeof title === 'string' && /hour|month|week|day/i.test(title));
      })
      .map((range) => {
        const cents = (key: string) => {
          const value = fieldOf(range, key);
          return typeof value === 'number' ? value / 100 : null;
        };
        return salaryRange(cents('min_cents'), cents('max_cents'), fieldOf(range, 'currency_type'));
      }),
  );
}

export function fromGreenhouse(job: unknown): Details {
  return {
    company: text(fieldOf(job, 'company_name'), LIMITS.company),
    role: text(fieldOf(job, 'title')),
    salary: greenhouseSalary(fieldOf(job, 'pay_input_ranges')),
    location: locationOf([fieldOf(fieldOf(job, 'location'), 'name')]),
    workMode: null,
    postedOn: dayOf(fieldOf(job, 'first_published')),
  };
}

export function fromLever(posting: unknown): Details {
  const categories = fieldOf(posting, 'categories');
  const range = fieldOf(posting, 'salaryRange');
  const all = asArray(fieldOf(categories, 'allLocations'));
  return {
    company: null,
    role: text(fieldOf(posting, 'text')),
    salary:
      fieldOf(range, 'interval') === 'per-year-salary'
        ? salaryRange(fieldOf(range, 'min'), fieldOf(range, 'max'), fieldOf(range, 'currency'))
        : null,
    location: locationOf(all.length ? all : [fieldOf(categories, 'location')]),
    workMode: workModeOf(fieldOf(posting, 'workplaceType')),
    postedOn: dayOf(fieldOf(posting, 'createdAt')),
  };
}

function ashbySalary(job: unknown): Details['salary'] {
  const tiers = asArray(fieldOf(fieldOf(job, 'compensation'), 'compensationTiers'));
  return onlySalary(
    tiers
      .flatMap((tier) => asArray(fieldOf(tier, 'components')))
      .filter(
        (component) =>
          fieldOf(component, 'compensationType') === 'Salary' &&
          fieldOf(component, 'interval') === '1 YEAR',
      )
      .map((component) =>
        salaryRange(
          fieldOf(component, 'minValue'),
          fieldOf(component, 'maxValue'),
          fieldOf(component, 'currencyCode'),
        ),
      ),
  );
}

export function fromAshby(job: unknown): Details {
  const secondary = asArray(fieldOf(job, 'secondaryLocations')).map((place) =>
    fieldOf(place, 'location'),
  );
  return {
    company: null,
    role: text(fieldOf(job, 'title')),
    salary: ashbySalary(job),
    location: locationOf([fieldOf(job, 'location'), ...secondary]),
    workMode:
      workModeOf(fieldOf(job, 'workplaceType')) ??
      (fieldOf(job, 'isRemote') === true ? 'Remote' : null),
    postedOn: dayOf(fieldOf(job, 'publishedAt')),
  };
}

export function fromRippling(job: unknown): Details {
  const pay = asArray(fieldOf(job, 'payRangeDetails'));
  const places = asArray(fieldOf(job, 'workLocations'));
  const label = fieldOf(fieldOf(job, 'workLocation'), 'label');
  const remote =
    (pay.length > 0 && pay.every((range) => fieldOf(range, 'isRemote') === true)) ||
    places.some((place) => typeof place === 'string' && /^remote\b/i.test(place));
  return {
    company: text(fieldOf(job, 'companyName'), LIMITS.company),
    role: text(fieldOf(job, 'name')),
    salary: onlySalary(
      pay
        .filter((range) => fieldOf(range, 'frequency') === 'YEAR')
        .map((range) =>
          salaryRange(
            fieldOf(range, 'rangeStart'),
            fieldOf(range, 'rangeEnd'),
            fieldOf(range, 'currency'),
          ),
        ),
    ),
    location: locationOf(places.length ? places : [label]),
    workMode: remote ? 'Remote' : null,
    postedOn: dayOf(fieldOf(job, 'createdOn')),
  };
}

export function fromSmartRecruiters(posting: unknown): Details {
  const location = fieldOf(posting, 'location');
  const flag = (key: string) => fieldOf(location, key) === true;
  return {
    company: text(fieldOf(fieldOf(posting, 'company'), 'name'), LIMITS.company),
    role: text(fieldOf(posting, 'name')),
    salary: null,
    location: locationOf([fieldOf(location, 'fullLocation')]),
    // SmartRecruiters says both flags explicitly, so neither means on-site.
    workMode: location ? (flag('remote') ? 'Remote' : flag('hybrid') ? 'Hybrid' : 'On-site') : null,
    postedOn: dayOf(fieldOf(posting, 'releasedDate')),
  };
}

export function fromBreezy(job: unknown): Details {
  const places = asArray(fieldOf(job, 'locations'));
  const primary = fieldOf(job, 'location');
  return {
    company: text(fieldOf(fieldOf(job, 'company'), 'name'), LIMITS.company),
    role: text(fieldOf(job, 'name')),
    // Breezy gives pay as free text ("$0.05 – $0.06 / hour"), so it is not read.
    salary: null,
    location: locationOf(
      (places.length ? places : [primary]).map((place) => fieldOf(place, 'name')),
    ),
    workMode: fieldOf(primary, 'is_remote') === true ? 'Remote' : null,
    postedOn: dayOf(fieldOf(job, 'published_date')),
  };
}

export function fromRecruitee(offer: unknown): Details {
  const salary = fieldOf(offer, 'salary');
  const places = asArray(fieldOf(offer, 'locations')).map((place) => {
    const city = fieldOf(place, 'city');
    const country = fieldOf(place, 'country');
    return [city, country].filter((part) => typeof part === 'string' && part).join(', ');
  });
  const flag = (key: string) => fieldOf(offer, key) === true;
  return {
    company: text(fieldOf(offer, 'company_name'), LIMITS.company),
    role: text(fieldOf(offer, 'title')),
    salary:
      fieldOf(salary, 'period') === 'year'
        ? salaryRange(fieldOf(salary, 'min'), fieldOf(salary, 'max'), fieldOf(salary, 'currency'))
        : null,
    location: locationOf(places),
    workMode: flag('remote')
      ? 'Remote'
      : flag('hybrid')
        ? 'Hybrid'
        : flag('on_site')
          ? 'On-site'
          : null,
    postedOn: dayOf(fieldOf(offer, 'published_at')),
  };
}

/** The text inside one XML element, entities decoded. */
function xmlText(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? cleanText(match[1]?.replace(/<!\[CDATA\[|\]\]>/g, ''), LIMITS.location) : null;
}

/** Personio's XML feed, one <position> per job. */
function personioPositions(xml: string): { id: string; xml: string }[] {
  return [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)]
    .map((match) => match[1] ?? '')
    .map((position) => ({ id: xmlText(position, 'id') ?? '', xml: position }))
    .filter((position) => /^\d{1,20}$/.test(position.id));
}

export function fromPersonio(position: string): Details {
  const extra = [...position.matchAll(/<additionalOffices>([\s\S]*?)<\/additionalOffices>/g)]
    .flatMap((block) => [...(block[1] ?? '').matchAll(/<office>([\s\S]*?)<\/office>/g)])
    .map((office) => office[1]);
  return {
    company: null,
    role: text(xmlText(position, 'name')),
    salary: null,
    location: locationOf([xmlText(position, 'office'), ...extra]),
    workMode: null,
    postedOn: dayOf(xmlText(position, 'createdAt')),
  };
}

export function fromWorkday(body: unknown): Details {
  const info = fieldOf(body, 'jobPostingInfo');
  const description = fieldOf(info, 'jobDescription');
  return {
    company: text(fieldOf(fieldOf(body, 'hiringOrganization'), 'name'), LIMITS.company),
    role: text(fieldOf(info, 'title')),
    salary: typeof description === 'string' ? salaryInText(description) : null,
    location: locationOf([
      fieldOf(info, 'location'),
      ...asArray(fieldOf(info, 'additionalLocations')),
    ]),
    workMode: workModeOf(fieldOf(info, 'remoteType')),
    postedOn: dayOf(fieldOf(info, 'startDate')),
  };
}

// ---------- Reading a posting link ----------

/** A request to make for a link, and how to read what comes back. */
interface Read {
  url: string;
  /** False: if it fails, the other reads still count (it only adds, say, the salary). */
  required: boolean;
  parse: (body: string) => Partial<Details> | null;
}

/** Workday has a public API for one posting, but none that lists a company's jobs by name. */
export type Site = { kind: BoardSource | 'workday'; reads: Read[] } | { kind: 'page' };

/** Links whose board has a public API, and what to read. Every id is validated before it is used in a URL. */
export function siteOf(url: URL): Site {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  const pagePosting: Read = {
    url: url.toString(),
    required: true,
    parse: (body) => fromJobPosting(body),
  };

  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host) && parts[1] === 'jobs') {
    const [board, , id] = parts;
    if (board && id && SLUG.test(board) && /^\d{1,20}$/.test(id))
      return {
        kind: 'greenhouse',
        reads: [
          {
            url: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}?pay_transparency=true`,
            required: true,
            parse: (body) => fromGreenhouse(parseJson(body)),
          },
        ],
      };
  }
  if (/^jobs(\.eu)?\.lever\.co$/.test(host)) {
    const [company, id] = parts;
    if (company && id && SLUG.test(company) && UUID.test(id))
      return {
        kind: 'lever',
        reads: [
          pagePosting,
          {
            url: `https://api${host.includes('.eu.') ? '.eu' : ''}.lever.co/v0/postings/${company}/${id}`,
            required: false,
            parse: (body) => fromLever(parseJson(body)),
          },
        ],
      };
  }
  if (host === 'jobs.ashbyhq.com') {
    const [org, id] = parts;
    if (org && id && SLUG.test(org) && UUID.test(id))
      return {
        kind: 'ashby',
        reads: [
          pagePosting,
          {
            url: `https://api.ashbyhq.com/posting-api/job-board/${org}?includeCompensation=true`,
            required: false,
            parse: (body) => {
              const jobs = asArray(fieldOf(parseJson(body), 'jobs'));
              const job = jobs.find((entry) => fieldOf(entry, 'id') === id);
              return job ? fromAshby(job) : null;
            },
          },
        ],
      };
  }
  if (host === 'ats.rippling.com') {
    // Optionally a locale first: /en-US/acme/jobs/<uuid>.
    const rest = /^[a-z]{2}(-[A-Z]{2})?$/.test(parts[0] ?? '') ? parts.slice(1) : parts;
    const [board, jobs, id] = rest;
    if (board && jobs === 'jobs' && id && SLUG.test(board) && UUID.test(id))
      return {
        kind: 'rippling',
        reads: [
          {
            url: `https://api.rippling.com/platform/api/ats/v1/board/${board}/jobs/${id}`,
            required: true,
            parse: (body) => fromRippling(parseJson(body)),
          },
        ],
      };
  }
  if (host === 'jobs.smartrecruiters.com') {
    const [company, posting] = parts;
    const id = /^(\d{6,20})(-|$)/.exec(posting ?? '')?.[1];
    if (company && id && SLUG.test(company))
      return {
        kind: 'smartrecruiters',
        reads: [
          {
            url: `https://api.smartrecruiters.com/v1/companies/${company}/postings/${id}`,
            required: true,
            parse: (body) => fromSmartRecruiters(parseJson(body)),
          },
        ],
      };
  }
  const breezy = /^([a-z0-9-]+)\.breezy\.hr$/.exec(host)?.[1];
  if (breezy && SUBDOMAIN.test(breezy) && parts[0] === 'p') {
    const id = /^([0-9a-f]{6,20})(-|$)/.exec(parts[1] ?? '')?.[1];
    if (id)
      return {
        kind: 'breezy',
        reads: [
          {
            url: `https://${breezy}.breezy.hr/json`,
            required: true,
            parse: (body) => {
              const job = asArray(parseJson(body)).find((entry) => fieldOf(entry, 'id') === id);
              return job ? fromBreezy(job) : null;
            },
          },
        ],
      };
  }
  const recruitee = /^([a-z0-9-]+)\.recruitee\.com$/.exec(host)?.[1];
  if (
    recruitee &&
    SUBDOMAIN.test(recruitee) &&
    parts[0] === 'o' &&
    parts[1] &&
    SLUG.test(parts[1])
  ) {
    const slug = parts[1];
    return {
      kind: 'recruitee',
      reads: [
        {
          url: `https://${recruitee}.recruitee.com/api/offers/`,
          required: true,
          parse: (body) => {
            const offer = asArray(fieldOf(parseJson(body), 'offers')).find(
              (entry) => fieldOf(entry, 'slug') === slug,
            );
            return offer ? fromRecruitee(offer) : null;
          },
        },
      ],
    };
  }
  // https://acme.wd5.myworkdayjobs.com/en-US/acme_careers/job/Boston-MA/QA-Engineer_R123: the page
  // is drawn by script, so its own JSON is read instead (the same path under /wday/cxs/).
  const workday = /^([a-z0-9-]+)\.wd\d{1,3}\.myworkdayjobs\.com$/.exec(host)?.[1];
  if (workday && SUBDOMAIN.test(workday)) {
    const rest = /^[a-z]{2}(-[A-Z]{2})?$/.test(parts[0] ?? '') ? parts.slice(1) : parts;
    const [siteName, kind, ...path] = rest;
    const segment = /^[A-Za-z0-9_.()~%-]{1,200}$/;
    if (
      siteName &&
      SLUG.test(siteName) &&
      kind === 'job' &&
      path.length > 0 &&
      path.length <= 3 &&
      path.every((part) => segment.test(part))
    )
      return {
        kind: 'workday',
        reads: [
          {
            url: `https://${host}/wday/cxs/${workday}/${siteName}/job/${path.join('/')}`,
            required: true,
            parse: (body) => fromWorkday(parseJson(body)),
          },
        ],
      };
  }
  return { kind: 'page' };
}

// ---------- Listing a company's open jobs ----------

/** One open job on a board, read without visiting it. */
export interface BoardJob {
  source: BoardSource;
  title: string;
  link: string;
  /** The company as the board names it, when it does: a check that the guessed board is the right one. */
  company: string | null;
  details: Details;
  /** A per-job API with more (the salary), read only for the job that matches. */
  more?: { url: string; parse: (body: string) => Partial<Details> };
}

interface Board {
  /** The list of open jobs for a board name (null when the name cannot be one on this board). */
  listUrl: (slug: string) => string | null;
  parseList: (body: string, slug: string) => BoardJob[];
}

const job = (
  source: BoardSource,
  link: unknown,
  details: Details,
  company: string | null = details.company,
  more?: BoardJob['more'],
): BoardJob | null => {
  const href = typeof link === 'string' && /^https:\/\//.test(link) ? link : null;
  if (!href || !details.role) return null;
  return {
    source,
    title: details.role,
    link: href.slice(0, LIMITS.jobLink),
    company,
    details,
    ...(more ? { more } : {}),
  };
};

const present = (jobs: (BoardJob | null)[]): BoardJob[] =>
  jobs.filter((entry): entry is BoardJob => entry !== null);

export const BOARDS: Record<BoardSource, Board> = {
  greenhouse: {
    listUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    parseList: (body, slug) =>
      present(
        asArray(fieldOf(parseJson(body), 'jobs')).map((entry) => {
          const id = fieldOf(entry, 'id');
          return job(
            'greenhouse',
            fieldOf(entry, 'absolute_url'),
            fromGreenhouse(entry),
            undefined,
            {
              url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${String(id)}?pay_transparency=true`,
              parse: (detail) => fromGreenhouse(parseJson(detail)),
            },
          );
        }),
      ),
  },
  lever: {
    listUrl: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    parseList: (body) =>
      present(
        asArray(parseJson(body)).map((entry) =>
          job('lever', fieldOf(entry, 'hostedUrl'), fromLever(entry)),
        ),
      ),
  },
  ashby: {
    listUrl: (slug) =>
      `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    parseList: (body) =>
      present(
        asArray(fieldOf(parseJson(body), 'jobs'))
          .filter((entry) => fieldOf(entry, 'isListed') !== false)
          .map((entry) => job('ashby', fieldOf(entry, 'jobUrl'), fromAshby(entry))),
      ),
  },
  rippling: {
    listUrl: (slug) => `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`,
    // The list has one row per job and location, with no pay: the job's own API has the rest.
    parseList: (body, slug) =>
      present(
        asArray(parseJson(body)).map((entry) => {
          const id = fieldOf(entry, 'uuid');
          return job('rippling', fieldOf(entry, 'url'), fromRippling(entry), null, {
            url: `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs/${String(id)}`,
            parse: (detail) => fromRippling(parseJson(detail)),
          });
        }),
      ),
  },
  smartrecruiters: {
    listUrl: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`,
    parseList: (body) =>
      present(
        asArray(fieldOf(parseJson(body), 'content')).map((entry) => {
          const company = fieldOf(fieldOf(entry, 'company'), 'identifier');
          const id = fieldOf(entry, 'id');
          const link =
            typeof company === 'string' && typeof id === 'string'
              ? `https://jobs.smartrecruiters.com/${company}/${id}`
              : null;
          return job('smartrecruiters', link, fromSmartRecruiters(entry));
        }),
      ),
  },
  breezy: {
    listUrl: (slug) => (SUBDOMAIN.test(slug) ? `https://${slug}.breezy.hr/json` : null),
    parseList: (body) =>
      present(
        asArray(parseJson(body)).map((entry) =>
          job('breezy', fieldOf(entry, 'url'), fromBreezy(entry)),
        ),
      ),
  },
  recruitee: {
    listUrl: (slug) => (SUBDOMAIN.test(slug) ? `https://${slug}.recruitee.com/api/offers/` : null),
    parseList: (body) =>
      present(
        asArray(fieldOf(parseJson(body), 'offers')).map((entry) =>
          job('recruitee', fieldOf(entry, 'careers_url'), fromRecruitee(entry)),
        ),
      ),
  },
  teamtailor: {
    listUrl: (slug) => (SUBDOMAIN.test(slug) ? `https://${slug}.teamtailor.com/jobs.json` : null),
    // A JSON Feed whose items carry a schema.org JobPosting.
    parseList: (body) =>
      present(
        asArray(fieldOf(parseJson(body), 'items')).map((entry) => {
          const posting = fieldOf(entry, '_jobposting');
          const details = merge(
            posting && typeof posting === 'object'
              ? fromJobPostingObject(posting as Record<string, unknown>)
              : EMPTY,
            {
              role: text(fieldOf(entry, 'title')),
              postedOn: dayOf(fieldOf(entry, 'date_published')),
            },
          );
          return job('teamtailor', fieldOf(entry, 'url'), details);
        }),
      ),
  },
  personio: {
    listUrl: (slug) => (SUBDOMAIN.test(slug) ? `https://${slug}.jobs.personio.de/xml` : null),
    parseList: (body, slug) =>
      present(
        personioPositions(body).map((position) =>
          job(
            'personio',
            `https://${slug}.jobs.personio.de/job/${position.id}`,
            fromPersonio(position.xml),
            null,
          ),
        ),
      ),
  },
};

import { LIMITS } from '@jat/shared';
import {
  asArray,
  byClass,
  cleanText,
  dayOf,
  EMPTY,
  fieldOf,
  locationOf,
  merge,
  onlySalary,
  parseJson,
  placeOf,
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

/** The text of a single-quoted JavaScript string literal's body, escapes decoded. */
function jsStringText(body: string): string {
  const named: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, (_, escape: string) =>
    escape.length > 1
      ? String.fromCharCode(parseInt(escape.slice(1), 16))
      : (named[escape] ?? escape),
  );
}

/**
 * The jobs a Zoho Recruit page is drawn from: its pages carry no JobPosting data, only a script
 * line `var jobs = JSON.parse('[{…}]')` with the posting's fields.
 */
export function zohoJobs(html: string): unknown[] {
  const literal = /\bjobs\s*=\s*JSON\.parse\('((?:[^'\\]|\\[\s\S])*)'\)/.exec(html)?.[1];
  return literal === undefined ? [] : asArray(parseJson(jsStringText(literal)));
}

/** The company is not in the job data, but the page names it as the site. */
function zohoCompany(html: string): string | null {
  const meta = /<meta\s+property="og:site_name"\s+content="([^"]*)"/i.exec(html)?.[1];
  return text(meta, LIMITS.company);
}

/**
 * A Zoho date: the page gives 2026-10-30; the public list writes it in the portal's own format
 * (10/30/2026), which it does not name. A day over 12 settles the order; otherwise month first,
 * Zoho's default, is assumed only on zohorecruit.com (the US data centre), else it is not guessed.
 */
export function zohoDay(value: unknown, monthFirst: boolean): string | null {
  const iso = dayOf(value);
  if (iso || typeof value !== 'string') return iso;
  const match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [, a = '', b = '', year = ''] = match;
  const [first, second] = [Number(a), Number(b)];
  const order =
    first > 12 ? 'dayFirst' : second > 12 ? 'monthFirst' : monthFirst ? 'monthFirst' : null;
  if (!order) return null;
  const [month, day] = order === 'monthFirst' ? [first, second] : [second, first];
  return dayOf(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}

/** One Zoho job: from the page's script (Remote_Job true) or the public list (Remote_Job "Yes"). */
export function fromZoho(job: unknown, company: string | null, monthFirst = true): Details {
  const field = (key: string) => fieldOf(job, key);
  const salary = field('Salary');
  const description = field('Job_Description');
  const place = placeOf(job, ['City', 'State', 'Country']);
  const remote = field('Remote_Job');
  return {
    company,
    role: text(field('Posting_Title')) ?? text(field('Job_Opening_Name')),
    // Zoho's salary is free text ("$90,000 - $110,000"); the description may say it instead.
    salary:
      (typeof salary === 'string' ? salaryInText(salary) : null) ??
      (typeof description === 'string' ? salaryInText(description) : null),
    location: locationOf([place]),
    workMode:
      remote === true || (typeof remote === 'string' && /^yes$/i.test(remote)) ? 'Remote' : null,
    postedOn: zohoDay(field('Date_Opened'), monthFirst),
  };
}

/** One job in a Zoho portal's public list, by id. */
function zohoListJob(body: string, id: string): unknown {
  return asArray(fieldOf(parseJson(body), 'data')).find((entry) => fieldOf(entry, 'id') === id);
}

/** One Workable job from its own public API: everything but the company, the text included. */
export function fromWorkableJob(job: unknown): Details {
  const places = asArray(fieldOf(job, 'locations')).map((place) =>
    placeOf(place, ['city', 'region', 'country']),
  );
  const description = fieldOf(job, 'description');
  return {
    company: null,
    role: text(fieldOf(job, 'title')),
    salary: typeof description === 'string' ? salaryInText(description) : null,
    location: locationOf(
      places.length ? places : [placeOf(fieldOf(job, 'location'), ['city', 'region', 'country'])],
    ),
    workMode:
      workModeOf(fieldOf(job, 'workplace')) ?? (fieldOf(job, 'remote') === true ? 'Remote' : null),
    postedOn: dayOf(fieldOf(job, 'published')),
  };
}

/** One job in a Workable account's public list (`account` is the list, which names the company). */
export function fromWorkable(account: unknown, job: unknown): Details {
  return {
    company: text(fieldOf(account, 'name'), LIMITS.company),
    role: text(fieldOf(job, 'title')),
    salary: null,
    location: locationOf([placeOf(job, ['city', 'state', 'country'])]),
    workMode: fieldOf(job, 'telecommuting') === true ? 'Remote' : null,
    postedOn: dayOf(fieldOf(job, 'published_on')) ?? dayOf(fieldOf(job, 'created_at')),
  };
}

/** A Jobvite page's description, as HTML. */
export const jobviteDescription = (html: string): string | null =>
  byClass(html, 'jv-job-detail-description', 'div');

/**
 * Jobvite: no API and no JobPosting data, so the page itself is read. It gives no date, and a
 * closed job lands on the company's job list, which has no job title (role null).
 */
export function fromJobvite(html: string): Details {
  // "Sales | Omaha, Nebraska | Denver, Colorado": the department, then each place.
  const places = (byClass(html, 'jv-job-detail-meta', 'p') ?? '')
    .split(/<span[^>]*jv-inline-separator[^>]*><\/span>/i)
    .map((part) => cleanText(part, LIMITS.location))
    .filter((part): part is string => part !== null)
    .slice(1);
  return {
    company: text(/<title>([^<]*?)\s+Careers\b/i.exec(html)?.[1], LIMITS.company),
    role: text(byClass(html, 'jv-header', 'h2')),
    salary: salaryInText(jobviteDescription(html) ?? ''),
    location: locationOf(places),
    workMode: places.some((place) => /^remote\b/i.test(place)) ? 'Remote' : null,
    postedOn: null,
  };
}

// ---------- Reading a posting link ----------

/** A request to make for a link, and how to read what comes back. */
interface Read {
  url: string;
  /** False: if it fails, the other reads still count (it only adds, say, the salary). */
  required: boolean;
  parse: (body: string) => Partial<Details> | null;
  /**
   * Where the posting's text is in the body (for job fit): by default, the prose fields of a JSON
   * answer or the page's own text. False for a read with none of this posting's text (a company's
   * whole job list), which is then not fetched for the text at all.
   */
  text?: false | ((body: string) => string | null);
}

/**
 * Workday has a public API for one posting, but none that lists a company's jobs by name; Zoho
 * Recruit and Jobvite have only the posting's own page; Workable's list is rate-limited, so the
 * hourly search reads it apart from the boards it lists.
 */
export type Site =
  | {
      kind: BoardSource | 'workday' | 'zoho' | 'workable' | 'jobvite';
      reads: Read[];
      /** False when the posting's page is drawn by script, so its text is not worth a read. */
      pageHasText?: false;
    }
  | { kind: 'page' };

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
            text: false,
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
            text: false,
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
          text: false,
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
  // https://acme.zohorecruit.com/jobs/Careers/837266000007382093/QA-Lead?source=CareerSite: the
  // portal's public job list (small, with the text) and the page (big, drawn by script from a job
  // array in it), which alone names the company and gives an unambiguous date.
  const zoho = /^([a-z0-9-]+)\.zohorecruit\.(com|eu|in|com\.au|jp|ca)$/.exec(host)?.[1];
  if (zoho && SUBDOMAIN.test(zoho) && parts[0] === 'jobs') {
    const [, portal, id] = parts;
    if (portal && id && SLUG.test(portal) && /^\d{6,25}$/.test(id)) {
      const monthFirst = host.endsWith('.zohorecruit.com');
      return {
        kind: 'zoho',
        pageHasText: false,
        reads: [
          {
            url: `https://${host}/jobs/${portal}/${id}`,
            required: false,
            text: false,
            parse: (body) => {
              const posting = zohoJobs(body).find((entry) => fieldOf(entry, 'id') === id);
              return posting ? fromZoho(posting, zohoCompany(body)) : null;
            },
          },
          {
            url: `https://${host}/recruit/v2/public/Job_Openings?pagename=${portal}&source=CareerSite`,
            required: true,
            parse: (body) => {
              const posting = zohoListJob(body, id);
              return posting ? fromZoho(posting, null, monthFirst) : null;
            },
            text: (body) => {
              const description = fieldOf(zohoListJob(body, id), 'Job_Description');
              return typeof description === 'string' ? description : null;
            },
          },
        ],
      };
    }
  }
  // https://apply.workable.com/acme/j/ABC123/: the page is drawn by script. The job's own public
  // API has all but the company, which the account's list (rate-limited, so optional) names. A
  // /j/ABC123 link without the account cannot be read this way.
  if (host === 'apply.workable.com') {
    const [account, kind, code] = parts;
    if (account && kind === 'j' && code && SLUG.test(account) && /^[A-Z0-9]{6,20}$/i.test(code)) {
      const shortcode = code.toUpperCase();
      return {
        kind: 'workable',
        pageHasText: false,
        reads: [
          {
            url: `https://apply.workable.com/api/v1/accounts/${account}/jobs/${shortcode}`,
            required: true,
            parse: (body) => fromWorkableJob(parseJson(body)),
          },
          {
            url: `https://apply.workable.com/api/v1/widget/accounts/${account}`,
            required: false,
            text: false,
            parse: (body) => {
              const list = parseJson(body);
              const posting = asArray(fieldOf(list, 'jobs')).find(
                (entry) => String(fieldOf(entry, 'shortcode')).toUpperCase() === shortcode,
              );
              return posting ? fromWorkable(list, posting) : null;
            },
          },
        ],
      };
    }
  }
  if (host === 'jobs.jobvite.com') {
    const [company, kind, id] = parts;
    if (company && kind === 'job' && id && SLUG.test(company) && /^[A-Za-z0-9]{4,20}$/.test(id))
      return {
        kind: 'jobvite',
        reads: [
          {
            url: `https://jobs.jobvite.com/${company}/job/${id}`,
            required: true,
            parse: (body) => {
              const details = fromJobvite(body);
              return details.role ? details : null;
            },
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

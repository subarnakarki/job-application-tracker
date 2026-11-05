import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LIMITS } from './constants';
import {
  ApplicationInputSchema,
  ApplicationPatchSchema,
  findSalaryIssues,
  isHttpUrl,
  ListQuerySchema,
  TimeZoneSchema,
  UserSettingsPatchSchema,
} from './schemas';

const minimal = { company: 'Acme', role: 'SDET' };

/** Paths of the issues zod reports, e.g. ['salaryMax']. */
function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return result.error?.issues.map((issue) => issue.path.join('.')) ?? [];
}

describe('ApplicationInputSchema (create)', () => {
  it('needs only company and role, and fills the rest with defaults', () => {
    expect(ApplicationInputSchema.parse(minimal)).toEqual({
      company: 'Acme',
      role: 'SDET',
      status: 'Saved',
      dateApplied: null,
      source: 'Other',
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      jobLink: null,
      contact: null,
      nextStep: null,
      nextStepDate: null,
      notes: '',
    });
  });

  it('accepts a fully populated application', () => {
    const full = {
      company: 'Acme',
      role: 'SDET',
      status: 'Interviewing',
      dateApplied: '2026-10-01',
      source: 'Referral',
      salaryMin: 120000,
      salaryMax: 150000,
      salaryCurrency: 'USD',
      jobLink: 'https://acme.example/jobs/42',
      contact: 'Pat Lee',
      nextStep: 'Onsite',
      nextStepDate: '2026-11-12',
      notes: 'Line one\nLine two',
    };
    expect(ApplicationInputSchema.parse(full)).toEqual(full);
  });

  describe('required text', () => {
    it.each([
      ['missing company', { role: 'SDET' }, 'company'],
      ['missing role', { company: 'Acme' }, 'role'],
      ['empty company', { ...minimal, company: '' }, 'company'],
      ['whitespace-only role', { ...minimal, role: '   ' }, 'role'],
      [
        'company over the limit',
        { ...minimal, company: 'a'.repeat(LIMITS.company + 1) },
        'company',
      ],
      ['newline in company', { ...minimal, company: 'Ac\nme' }, 'company'],
      ['tab in role', { ...minimal, role: 'SD\tET' }, 'role'],
      ['null company', { ...minimal, company: null }, 'company'],
      ['non-string role', { ...minimal, role: 42 }, 'role'],
    ])('rejects %s', (_label, input, path) => {
      const result = ApplicationInputSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain(path);
    });

    it('trims surrounding whitespace and accepts the maximum length', () => {
      const parsed = ApplicationInputSchema.parse({
        company: '  Acme  ',
        role: 'a'.repeat(LIMITS.role),
      });
      expect(parsed.company).toBe('Acme');
      expect(parsed.role).toHaveLength(LIMITS.role);
    });
  });

  describe('enums', () => {
    it.each([
      ['status', { ...minimal, status: 'Hired' }],
      ['status', { ...minimal, status: 'applied' }],
      ['source', { ...minimal, source: 'Glassdoor' }],
      ['source', { ...minimal, source: 'linkedin' }],
    ])('rejects an invalid %s', (path, input) => {
      expect(issuePaths(ApplicationInputSchema.safeParse(input))).toContain(path);
    });
  });

  describe('dates', () => {
    it.each([
      '2026-02-30',
      '2026-13-01',
      'yesterday',
      '2026-11-5',
      '11/05/2026',
      '2026-11-05T00:00:00Z',
      '',
    ])('rejects dateApplied %j', (dateApplied) => {
      expect(issuePaths(ApplicationInputSchema.safeParse({ ...minimal, dateApplied }))).toContain(
        'dateApplied',
      );
    });

    it('accepts a leap day and null', () => {
      expect(
        ApplicationInputSchema.parse({ ...minimal, nextStepDate: '2028-02-29' }).nextStepDate,
      ).toBe('2028-02-29');
      expect(
        ApplicationInputSchema.parse({ ...minimal, dateApplied: null }).dateApplied,
      ).toBeNull();
    });
  });

  describe('job link', () => {
    it.each([
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'ftp://files.example/x',
      'example.com',
      '/relative/path',
      'http://user:pw@host.example',
      'https://',
      'file:///etc/passwd',
    ])('rejects %j', (jobLink) => {
      expect(issuePaths(ApplicationInputSchema.safeParse({ ...minimal, jobLink }))).toContain(
        'jobLink',
      );
    });

    it('accepts http and https, and treats an empty string as no link', () => {
      expect(
        ApplicationInputSchema.parse({ ...minimal, jobLink: 'http://acme.example/a?b=1#c' })
          .jobLink,
      ).toBe('http://acme.example/a?b=1#c');
      expect(
        ApplicationInputSchema.parse({ ...minimal, jobLink: '  https://acme.example  ' }).jobLink,
      ).toBe('https://acme.example');
      expect(ApplicationInputSchema.parse({ ...minimal, jobLink: '' }).jobLink).toBeNull();
    });

    it('rejects a link over the length limit', () => {
      const long = `https://acme.example/${'a'.repeat(LIMITS.jobLink)}`;
      expect(issuePaths(ApplicationInputSchema.safeParse({ ...minimal, jobLink: long }))).toContain(
        'jobLink',
      );
    });

    it('only ever accepts strings that parse as http(s) URLs (property)', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string(),
            fc.webUrl(),
            fc.constantFrom('javascript:1', 'HTTP://x.y', ' https://a.b '),
          ),
          (value) => {
            const result = ApplicationInputSchema.safeParse({ ...minimal, jobLink: value });
            if (result.success && result.data.jobLink !== null) {
              const protocol = new URL(result.data.jobLink).protocol;
              expect(['http:', 'https:']).toContain(protocol);
            }
          },
        ),
      );
    });
  });

  describe('salary', () => {
    it.each([
      ['negative minimum', { salaryMin: -1, salaryCurrency: 'USD' }, 'salaryMin'],
      ['fractional maximum', { salaryMax: 100.5, salaryCurrency: 'USD' }, 'salaryMax'],
      [
        'maximum below minimum',
        { salaryMin: 150000, salaryMax: 120000, salaryCurrency: 'USD' },
        'salaryMax',
      ],
      ['amount without currency', { salaryMin: 100000 }, 'salaryCurrency'],
      ['lower-case currency', { salaryMin: 1, salaryCurrency: 'usd' }, 'salaryCurrency'],
      ['two-letter currency', { salaryMin: 1, salaryCurrency: 'US' }, 'salaryCurrency'],
      [
        'amount above the limit',
        { salaryMax: LIMITS.salaryMax + 1, salaryCurrency: 'USD' },
        'salaryMax',
      ],
      ['string amount', { salaryMin: '100000', salaryCurrency: 'USD' }, 'salaryMin'],
    ])('rejects %s', (_label, salary, path) => {
      expect(issuePaths(ApplicationInputSchema.safeParse({ ...minimal, ...salary }))).toContain(
        path,
      );
    });

    it('accepts a range, a lone minimum, equal bounds and no salary at all', () => {
      expect(
        ApplicationInputSchema.safeParse({
          ...minimal,
          salaryMin: 1,
          salaryMax: 2,
          salaryCurrency: 'EUR',
        }).success,
      ).toBe(true);
      expect(
        ApplicationInputSchema.safeParse({ ...minimal, salaryMin: 90000, salaryCurrency: 'USD' })
          .success,
      ).toBe(true);
      expect(
        ApplicationInputSchema.safeParse({
          ...minimal,
          salaryMin: 5,
          salaryMax: 5,
          salaryCurrency: 'USD',
        }).success,
      ).toBe(true);
      expect(ApplicationInputSchema.safeParse(minimal).success).toBe(true);
    });
  });

  describe('optional text, notes and unknown keys', () => {
    it('stores an empty optional text as null and trims the rest', () => {
      const parsed = ApplicationInputSchema.parse({
        ...minimal,
        contact: '   ',
        nextStep: ' Call ',
      });
      expect(parsed.contact).toBeNull();
      expect(parsed.nextStep).toBe('Call');
    });

    it('enforces the optional text limits', () => {
      expect(
        issuePaths(
          ApplicationInputSchema.safeParse({ ...minimal, contact: 'a'.repeat(LIMITS.contact + 1) }),
        ),
      ).toContain('contact');
      expect(
        issuePaths(
          ApplicationInputSchema.safeParse({
            ...minimal,
            nextStep: 'a'.repeat(LIMITS.nextStep + 1),
          }),
        ),
      ).toContain('nextStep');
    });

    it('keeps notes as written (newlines allowed) up to the limit', () => {
      expect(ApplicationInputSchema.parse({ ...minimal, notes: ' a\n\n b ' }).notes).toBe(
        ' a\n\n b ',
      );
      expect(
        ApplicationInputSchema.safeParse({ ...minimal, notes: 'a'.repeat(LIMITS.notes) }).success,
      ).toBe(true);
      expect(
        issuePaths(
          ApplicationInputSchema.safeParse({ ...minimal, notes: 'a'.repeat(LIMITS.notes + 1) }),
        ),
      ).toContain('notes');
    });

    it('rejects unknown keys, so clients cannot set server-owned fields', () => {
      for (const extra of [
        { id: 'x' },
        { userId: 'x' },
        { createdAt: '2026-01-01' },
        { lastActivityAt: '2026-01-01' },
        { version: 3 },
        { needsFollowUp: true },
      ]) {
        expect(
          ApplicationInputSchema.safeParse({ ...minimal, ...extra }).success,
          JSON.stringify(extra),
        ).toBe(false);
      }
    });

    it('rejects non-object bodies', () => {
      for (const body of [null, undefined, 'x', 7, [], [minimal]]) {
        expect(ApplicationInputSchema.safeParse(body).success).toBe(false);
      }
    });
  });
});

describe('ApplicationPatchSchema', () => {
  it('accepts an empty patch (a no-op) and does not inject defaults', () => {
    expect(ApplicationPatchSchema.parse({})).toEqual({});
  });

  it('keeps only the keys that were sent', () => {
    expect(ApplicationPatchSchema.parse({ status: 'Offer', notes: 'Great call' })).toEqual({
      status: 'Offer',
      notes: 'Great call',
    });
  });

  it('lets nullable fields be cleared with null', () => {
    const cleared = {
      dateApplied: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      jobLink: null,
      contact: null,
      nextStep: null,
      nextStepDate: null,
    };
    expect(ApplicationPatchSchema.parse(cleared)).toEqual(cleared);
  });

  it.each([
    ['company', { company: null }],
    ['role', { role: null }],
    ['status', { status: null }],
    ['source', { source: null }],
    ['notes', { notes: null }],
    ['company', { company: '  ' }],
    ['status', { status: 'Hired' }],
    ['jobLink', { jobLink: 'javascript:alert(1)' }],
    ['dateApplied', { dateApplied: '2026-02-30' }],
    ['salaryMax', { salaryMin: 200, salaryMax: 100 }],
  ])('rejects an invalid %s', (path, patch) => {
    expect(issuePaths(ApplicationPatchSchema.safeParse(patch))).toContain(path);
  });

  it('cannot check salary pairing alone: that is the API merge step', () => {
    // Only a currency-less amount: valid here, flagged by findSalaryIssues on the merged record.
    expect(ApplicationPatchSchema.safeParse({ salaryMin: 100000 }).success).toBe(true);
    expect(findSalaryIssues({ salaryMin: 100000, salaryMax: null, salaryCurrency: null })).toEqual([
      { path: 'salaryCurrency', message: 'Currency is required with a salary' },
    ]);
  });

  it('rejects unknown and server-owned keys', () => {
    for (const extra of [
      { id: 'x' },
      { userId: 'x' },
      { updatedAt: 'x' },
      { lastActivityAt: 'x' },
      { version: 2 },
      { typo: 1 },
    ]) {
      expect(ApplicationPatchSchema.safeParse(extra).success, JSON.stringify(extra)).toBe(false);
    }
  });
});

describe('findSalaryIssues', () => {
  it('reports nothing for a valid or absent salary', () => {
    expect(findSalaryIssues({ salaryMin: null, salaryMax: null, salaryCurrency: null })).toEqual(
      [],
    );
    expect(findSalaryIssues({ salaryMin: 1, salaryMax: 2, salaryCurrency: 'USD' })).toEqual([]);
    expect(
      findSalaryIssues({ salaryMin: undefined, salaryMax: undefined, salaryCurrency: undefined }),
    ).toEqual([]);
  });

  it('reports both problems when both apply', () => {
    const issues = findSalaryIssues({ salaryMin: 200, salaryMax: 100, salaryCurrency: null });
    expect(issues.map((issue) => issue.path).sort()).toEqual(['salaryCurrency', 'salaryMax']);
  });
});

describe('isHttpUrl', () => {
  it('is true only for http and https without credentials', () => {
    expect(isHttpUrl('https://a.example')).toBe(true);
    expect(isHttpUrl('HTTP://A.EXAMPLE/path')).toBe(true);
    expect(isHttpUrl('https://u:p@a.example')).toBe(false);
    expect(isHttpUrl('mailto:a@b.c')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});

describe('ListQuerySchema', () => {
  it('defaults the sort and leaves filters unset', () => {
    expect(ListQuerySchema.parse({})).toEqual({ sort: 'updated_desc' });
  });

  it('parses every filter', () => {
    expect(
      ListQuerySchema.parse({
        status: 'Applied',
        followUp: 'true',
        q: '  acme  ',
        sort: 'company_asc',
      }),
    ).toEqual({
      status: 'Applied',
      followUp: true,
      q: 'acme',
      sort: 'company_asc',
    });
    expect(ListQuerySchema.parse({ followUp: 'false' }).followUp).toBe(false);
  });

  it('treats a blank search as no search', () => {
    expect(ListQuerySchema.parse({ q: '   ' }).q).toBeUndefined();
    expect(ListQuerySchema.parse({ q: '' }).q).toBeUndefined();
  });

  it.each([
    ['status', { status: 'Hired' }],
    ['status', { status: ['Applied', 'Offer'] }],
    ['followUp', { followUp: 'yes' }],
    ['followUp', { followUp: true }],
    ['q', { q: 'a'.repeat(LIMITS.search + 1) }],
    ['sort', { sort: 'random' }],
    ['', { page: '2' }],
  ])('rejects invalid %s', (_path, query) => {
    expect(ListQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('TimeZoneSchema', () => {
  it('accepts IANA names and rejects offsets and junk', () => {
    expect(TimeZoneSchema.safeParse('America/New_York').success).toBe(true);
    expect(TimeZoneSchema.safeParse('UTC').success).toBe(true);
    for (const bad of ['+05:00', 'Mars/Olympus', '', 'EST5EDT; select 1', 42, null]) {
      expect(TimeZoneSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});

describe('UserSettingsPatchSchema', () => {
  it('accepts a valid zone and nothing else', () => {
    expect(UserSettingsPatchSchema.parse({ timeZone: 'Asia/Kolkata' })).toEqual({
      timeZone: 'Asia/Kolkata',
    });
  });

  it.each([
    ['empty body', {}],
    ['offset zone', { timeZone: '+05:00' }],
    ['unknown zone', { timeZone: 'Mars/Olympus' }],
    ['null', { timeZone: null }],
    ['extra key', { timeZone: 'UTC', email: 'x@y.z' }],
    ['server-owned key', { isDemo: false }],
  ])('rejects %s', (_label, body) => {
    expect(UserSettingsPatchSchema.safeParse(body).success).toBe(false);
  });
});

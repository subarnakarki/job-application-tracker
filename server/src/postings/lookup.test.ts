import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FetchError, type PageFetcher } from './fetchPage';
import { findOnBoards, slugsFor, titleScore } from './lookup';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** Serves the given URLs; every other board answers 404, as a missing board does. */
function boards(map: Record<string, string>): PageFetcher & { asked: string[] } {
  const asked: string[] = [];
  const fetcher = (url: string) => {
    asked.push(url);
    const text = map[url];
    return text === undefined
      ? Promise.reject(new FetchError('http_status', '404'))
      : Promise.resolve({ url, contentType: 'application/json', text });
  };
  return Object.assign(fetcher, { asked });
}

const STRIPE = {
  'https://boards-api.greenhouse.io/v1/boards/stripe/jobs': fixture('greenhouse-board.json'),
};
const RIPPLING_BOARD = 'https://api.rippling.com/platform/api/ats/v1/board/rippling/jobs';

describe('likely board names', () => {
  it('squashes and hyphenates the company, drops Inc and friends, and adds the sender’s domain', () => {
    expect(slugsFor('Northwind Health, Inc.', 'talent@northwind.co.uk')).toEqual([
      'northwindhealth',
      'northwind-health',
      'northwind',
    ]);
    expect(slugsFor('Stripe', 'jobs@stripe.com')).toEqual(['stripe']);
  });

  it('ignores job-board and mail-provider domains', () => {
    expect(slugsFor('Acme', 'no-reply@us.greenhouse-mail.io')).toEqual(['acme']);
    expect(slugsFor('Acme', 'someone@gmail.com')).toEqual(['acme']);
  });
});

describe('title matching', () => {
  it('treats gender tags, case and punctuation as the same title', () => {
    expect(titleScore('Senior SDET (m/w/d)', 'senior sdet')).toBe(1);
    expect(titleScore('Account Executive, Enterprise', 'Account Executive Enterprise')).toBe(1);
  });

  it('scores different jobs low', () => {
    expect(titleScore('Senior SDET', 'Staff Product Designer')).toBe(0);
    expect(titleScore('Senior SDET', 'SDET')).toBeLessThan(0.8);
  });
});

describe('finding the posting on the company’s board', () => {
  it('finds the job on its board and keeps the link and what the board says', async () => {
    const fetch = boards(STRIPE);
    const match = await findOnBoards({ company: 'Stripe', role: 'abuse investigator' }, fetch);
    expect(match).toMatchObject({
      source: 'greenhouse',
      jobLink: 'https://stripe.com/jobs/search?gh_jid=8172487',
      // The same job is open in several places: all of them are kept.
      details: {
        role: 'Abuse Investigator',
        location: 'Dublin; Seattle, San Francisco, New York City',
      },
    });
  });

  it('reads the job’s own API for the rest (Rippling’s list has no pay or company)', async () => {
    const job = JSON.parse(fixture('rippling-job.json')) as { uuid: string };
    const fetch = boards({
      [RIPPLING_BOARD]: fixture('rippling-board.json'),
      [`${RIPPLING_BOARD}/${job.uuid}`]: fixture('rippling-job.json'),
    });
    const match = await findOnBoards(
      { company: 'Rippling', role: 'Account Executive, Broker Channel (Boston)' },
      fetch,
    );
    expect(match).toMatchObject({
      source: 'rippling',
      jobLink: `https://ats.rippling.com/rippling/jobs/${job.uuid}`,
      details: { company: 'Rippling', location: 'Boston, MA' },
    });
  });

  it('refuses a board that names another company, even when the name was a good guess', async () => {
    const fetch = boards(STRIPE);
    expect(
      await findOnBoards(
        { company: 'Acme', role: 'Abuse Investigator', senderEmail: 'jobs@stripe.com' },
        fetch,
      ),
    ).toBeNull();
  });

  it('finds nothing when no title is close, or the role is unknown', async () => {
    expect(
      await findOnBoards({ company: 'Stripe', role: 'Chief Llama Officer' }, boards(STRIPE)),
    ).toBeNull();
    const quiet = boards(STRIPE);
    expect(await findOnBoards({ company: 'Stripe', role: ' ' }, quiet)).toBeNull();
    expect(quiet.asked).toEqual([]);
  });

  it('does not guess between two different jobs that match equally well', async () => {
    const two = JSON.stringify({
      jobs: [
        {
          id: 1,
          title: 'Senior SDET Mobile',
          absolute_url: 'https://acme.example/1',
          company_name: 'Acme',
        },
        {
          id: 2,
          title: 'Senior SDET Web',
          absolute_url: 'https://acme.example/2',
          company_name: 'Acme',
        },
      ],
    });
    const fetch = boards({ 'https://boards-api.greenhouse.io/v1/boards/acme/jobs': two });
    expect(await findOnBoards({ company: 'Acme', role: 'Senior SDET' }, fetch)).toBeNull();
  });

  it('asks every board, for each likely name, and survives boards that fail', async () => {
    const fetch = boards({});
    expect(await findOnBoards({ company: 'Acme Labs', role: 'SDET' }, fetch)).toBeNull();
    // 9 boards x 2 names (acmelabs, acme-labs).
    expect(fetch.asked).toHaveLength(18);
    expect(fetch.asked.every((url) => url.startsWith('https://'))).toBe(true);
  });
});

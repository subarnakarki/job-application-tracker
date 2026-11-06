import { describe, expect, it } from 'vitest';
import { BODY_LIMIT, gmailQuery, parseMessage } from './gmail';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

const headers = [
  { name: 'From', value: 'Acme Careers <jobs@acme.example>' },
  { name: 'Subject', value: 'Your application to Acme' },
  { name: 'Date', value: 'Tue, 03 Nov 2026 14:00:00 +0000' },
];

describe('parseMessage', () => {
  it('prefers the plain-text part of a multipart email, and reads the headers', () => {
    const message = parseMessage({
      id: 'm1',
      payload: {
        mimeType: 'multipart/alternative',
        headers,
        parts: [
          { mimeType: 'text/html', body: { data: b64('<p>HTML version</p>') } },
          { mimeType: 'text/plain', body: { data: b64('Thanks for applying, café!') } },
        ],
      },
    });

    expect(message).toEqual({
      id: 'm1',
      from: 'Acme Careers <jobs@acme.example>',
      subject: 'Your application to Acme',
      date: new Date('2026-11-03T14:00:00Z'),
      body: 'Thanks for applying, café!',
      links: [],
    });
  });

  it('keeps the links of an email, which its text alone would lose', () => {
    const html =
      '<p>Thanks! <a href="https://job-boards.greenhouse.io/acme/jobs/42?gh_src=x&amp;t=1">View the job</a> ' +
      '<a href="mailto:jobs@acme.example">Mail us</a> <a href=\'https://acme.example/unsubscribe\'><b>Unsubscribe</b></a></p>';
    const plain =
      'See https://jobs.lever.co/acme/1234, or https://job-boards.greenhouse.io/acme/jobs/42?gh_src=x&t=1.';
    const message = parseMessage({
      id: 'm3',
      payload: {
        mimeType: 'multipart/alternative',
        headers,
        parts: [
          { mimeType: 'text/html', body: { data: b64(html) } },
          { mimeType: 'text/plain', body: { data: b64(plain) } },
        ],
      },
    });

    expect(message.links).toEqual([
      { url: 'https://job-boards.greenhouse.io/acme/jobs/42?gh_src=x&t=1', text: 'View the job' },
      { url: 'https://acme.example/unsubscribe', text: 'Unsubscribe' },
      { url: 'https://jobs.lever.co/acme/1234', text: '' },
    ]);
  });

  it('falls back to the text of an HTML-only email, without scripts or styles', () => {
    const html =
      '<html><head><style>p{}</style></head><body><p>We&nbsp;regret</p><script>x()</script><div>to inform &amp; you</div></body></html>';
    const message = parseMessage({
      id: 'm2',
      payload: { mimeType: 'text/html', headers, body: { data: b64(html) } },
    });

    expect(message.body).toBe('We regret\n to inform & you');
  });

  it('caps the body, and tolerates a missing body and a bad date', () => {
    const long = parseMessage({
      id: 'm3',
      payload: { mimeType: 'text/plain', body: { data: b64('x'.repeat(BODY_LIMIT + 50)) } },
    });
    const empty = parseMessage({
      id: 'm4',
      payload: { mimeType: 'text/plain', headers: [{ name: 'Date', value: 'not a date' }] },
    });

    expect(long.body).toHaveLength(BODY_LIMIT);
    expect(empty).toMatchObject({ body: '', date: null, from: '', subject: '' });
  });
});

describe('gmailQuery', () => {
  it('looks back 30 days the first time, then only since the last import', () => {
    expect(gmailQuery(null)).toMatch(/^newer_than:30d /);
    expect(gmailQuery(new Date('2026-11-01T00:00:00Z'))).toMatch(/^after:1793491200 /);
  });
});

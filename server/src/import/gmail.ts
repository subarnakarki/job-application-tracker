import { z } from 'zod';

/** The longest body the classifier sees; the opening of an email carries its meaning. */
export const BODY_LIMIT = 8000;
export const MAX_MESSAGES = 50;

/** One email, reduced to what classification and the results page need. */
export interface GmailMessage {
  id: string;
  from: string;
  subject: string;
  date: Date | null;
  body: string;
}

/** Injected into the app, so tests never talk to Google. */
export interface GmailClient {
  /** Ids of messages matching the query, newest first, at most `max`. */
  listMessageIds(accessToken: string, query: string, max: number): Promise<string[]>;
  getMessage(accessToken: string, id: string): Promise<GmailMessage>;
}

export class GmailError extends Error {}

const API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

/** Senders and subjects that job emails tend to have; promotions and social are skipped. */
const JOB_QUERY =
  '-category:promotions -category:social ' +
  '{subject:application subject:applying subject:applied subject:interview subject:offer ' +
  'subject:position subject:candidacy subject:"thank you for" subject:"next steps" ' +
  'from:greenhouse.io from:lever.co from:myworkday.com from:myworkdayjobs.com from:ashbyhq.com ' +
  'from:smartrecruiters.com from:icims.com from:jobvite.com from:workable.com}';

/** The search: emails since the last import, or from the last 30 days the first time. */
export function gmailQuery(since: Date | null): string {
  const window = since ? `after:${Math.floor(since.getTime() / 1000)}` : 'newer_than:30d';
  return `${window} ${JOB_QUERY}`;
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

const PartSchema: z.ZodType<Part> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(PartSchema).optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  }),
);
const MessageSchema = z.object({ id: z.string(), payload: PartSchema });
const ListSchema = z.object({ messages: z.array(z.object({ id: z.string() })).optional() });

function decode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

function findPart(part: Part, mimeType: string): Part | undefined {
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

/** Visible text of an HTML email: no tags, scripts, styles or entity noise. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function tidy(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Plain text if the email has it, else the HTML's text; trimmed to `BODY_LIMIT`. */
export function messageBody(payload: Part): string {
  const plain = findPart(payload, 'text/plain');
  if (plain?.body?.data) return tidy(decode(plain.body.data)).slice(0, BODY_LIMIT);
  const html = findPart(payload, 'text/html');
  if (html?.body?.data) return tidy(htmlToText(decode(html.body.data))).slice(0, BODY_LIMIT);
  return '';
}

export function parseMessage(raw: unknown): GmailMessage {
  const message = MessageSchema.parse(raw);
  const header = (name: string) =>
    message.payload.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
  const date = new Date(header('date'));
  return {
    id: message.id,
    from: header('from').slice(0, 300),
    subject: header('subject').slice(0, 500),
    date: Number.isNaN(date.getTime()) ? null : date,
    body: messageBody(message.payload),
  };
}

async function call(accessToken: string, url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new GmailError(`Gmail answered ${response.status}`);
  return response.json();
}

export const gmailRestClient: GmailClient = {
  async listMessageIds(accessToken, query, max) {
    const params = new URLSearchParams({ q: query, maxResults: String(max) });
    const list = ListSchema.parse(await call(accessToken, `${API}?${params.toString()}`));
    return (list.messages ?? []).map((message) => message.id);
  },
  async getMessage(accessToken, id) {
    return parseMessage(await call(accessToken, `${API}/${encodeURIComponent(id)}?format=full`));
  },
};

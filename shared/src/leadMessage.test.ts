import { describe, expect, it } from 'vitest';
import { STATUSES } from './constants';
import {
  characterCount,
  clipToLength,
  isLinkedInLink,
  LeadMessageRequestSchema,
  LeadMessageSentSchema,
  sentMessageNote,
  suggestedMessageKind,
} from './leadMessage';

describe('lead messages', () => {
  it('suggests the kind of message from the status', () => {
    expect(STATUSES.map((status) => [status, suggestedMessageKind(status)])).toEqual([
      ['Saved', 'referral'],
      ['Applied', 'follow_up'],
      ['Screening', 'follow_up'],
      ['Interviewing', 'thanks'],
      ['Offer', 'keep_in_touch'],
      ['Rejected', 'keep_in_touch'],
      ['Withdrawn', 'keep_in_touch'],
    ]);
  });

  it('counts characters as people see them', () => {
    expect(characterCount('café 👋')).toBe(6);
    expect('café 👋'.length).toBe(7);
  });

  it('cuts at the last whole sentence, else the last whole word, never mid-character', () => {
    expect(clipToLength('Short enough.', 200)).toBe('Short enough.');
    expect(clipToLength('First sentence here. Second one is longer than fits.', 30)).toBe(
      'First sentence here.',
    );
    expect(clipToLength('one two three four five six', 12)).toBe('one two');
    expect(characterCount(clipToLength('👋'.repeat(300), 200))).toBeLessThanOrEqual(200);
  });

  it('knows a LinkedIn link from any other', () => {
    expect(isLinkedInLink('https://www.linkedin.com/in/sam')).toBe(true);
    expect(isLinkedInLink('https://linkedin.com/in/sam')).toBe(true);
    expect(isLinkedInLink('https://linkedin.com.evil.example/in/sam')).toBe(false);
    expect(isLinkedInLink('https://sam.dev')).toBe(false);
    expect(isLinkedInLink(null)).toBe(false);
  });

  it('words the note logged on the lead', () => {
    expect(sentMessageNote('Acme', 'SDET', '  Hi Sam!  ')).toBe(
      'LinkedIn message about SDET at Acme:\n\nHi Sam!',
    );
  });

  it('keeps the steer to one line, and the text sent within LinkedIn limits', () => {
    const lead = { leadId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', kind: 'thanks' };
    expect(LeadMessageRequestSchema.parse(lead).steer).toBe('');
    expect(LeadMessageRequestSchema.safeParse({ ...lead, steer: 'a\nb' }).success).toBe(false);
    expect(LeadMessageSentSchema.safeParse({ leadId: lead.leadId, text: '  ' }).success).toBe(
      false,
    );
    expect(
      LeadMessageSentSchema.safeParse({ leadId: lead.leadId, text: 'x'.repeat(8001) }).success,
    ).toBe(false);
  });
});

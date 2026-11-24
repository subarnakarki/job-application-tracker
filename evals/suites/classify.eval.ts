import { EmailVerdictSchema } from '@jat/server/src/import/verdict';
import type { GmailMessage } from '@jat/server/src/import/gmail';
import { expect, it } from 'vitest';
import { classifier, observer } from '../src/clients';

// E0 spike: one hand-written email through the real classifier. The dataset, checks and scores
// replace this in Phase E1.
const confirmation: GmailMessage = {
  id: 'spike-1',
  from: 'Northwind Robotics Careers <no-reply@greenhouse-mail.example>',
  subject: 'Thank you for applying to Northwind Robotics',
  date: new Date('2026-11-02T15:04:00Z'),
  links: [
    {
      text: 'View the job posting',
      url: 'https://boards.example-ats.com/northwindrobotics/jobs/4821',
    },
  ],
  body: [
    'Hi Jordan,',
    '',
    'Thanks for applying to the Senior QA Automation Engineer role at Northwind Robotics. We have',
    'received your application and our team will review it. If your experience matches what we are',
    'looking for, a recruiter will reach out about next steps.',
    '',
    'Best,',
    'The Northwind Robotics Talent Team',
  ].join('\n'),
};

it('classifies an application confirmation', async () => {
  const result = await observer.inCase('spike-1', () => classifier.classify(confirmation));
  const calls = observer.callsFor('spike-1');
  console.info('observed:', JSON.stringify(calls, null, 2));

  expect(calls).toHaveLength(1);
  expect(calls[0]?.error).toBeNull();
  expect(result.kind).toBe('verdict');
  if (result.kind !== 'verdict') return;
  expect(EmailVerdictSchema.safeParse(result.verdict).success).toBe(true);
  expect(result.verdict).toMatchObject({
    kind: 'application_confirmation',
    company: 'Northwind Robotics',
    postingUrl: 'https://boards.example-ats.com/northwindrobotics/jobs/4821',
  });
});

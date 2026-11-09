import { describe, expect, it } from 'vitest';
import { trimPostingBoilerplate } from './trim';

describe('trimPostingBoilerplate: legal notices removed before the model reads a posting', () => {
  it('drops equal-opportunity, accommodation, E-Verify, privacy and agency notices', () => {
    const posting = [
      'Senior SDET at Acme.',
      'You will own our Playwright suites and CI/CD.',
      'Acme is an equal opportunity employer.',
      'All qualified applicants will receive consideration without regard to race, color, religion, sex or national origin.',
      'If you need a reasonable accommodation during the process, email us.',
      'We participate in E-Verify.',
      'Read our Candidate Privacy Notice before applying.',
      'We do not accept unsolicited resumes from recruitment agencies.',
      'The base salary range is $150,000 to $180,000.',
      'About us: we build tools for clinics.',
    ].join(' ');
    expect(trimPostingBoilerplate(posting)).toBe(
      [
        'Senior SDET at Acme.',
        'You will own our Playwright suites and CI/CD.',
        'The base salary range is $150,000 to $180,000.',
        'About us: we build tools for clinics.',
      ].join(' '),
    );
  });

  it('keeps job requirements that only mention a nearby word', () => {
    const posting =
      'Experience with accessibility testing is a plus. You will verify data privacy controls in our APIs. 5+ years of QA.';
    expect(trimPostingBoilerplate(posting)).toBe(posting);
  });

  it('never returns an empty posting', () => {
    const allNotices = 'We are an equal opportunity employer. We participate in E-Verify.';
    expect(trimPostingBoilerplate(allNotices)).toBe(allNotices);
    expect(trimPostingBoilerplate('')).toBe('');
  });
});

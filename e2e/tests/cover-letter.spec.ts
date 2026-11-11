import { expect, test } from '../fixtures';
import { CoverLetterSection } from '../pages/CoverLetterSection';

// The server's stand-in model for test users writes a letter that names the tone, the length and
// the "what to stress" line, so each choice can be seen reaching the draft.
const RESUME = [
  'Pat Example',
  'Senior SDET who builds Playwright suites.',
  '- Ran SQL reports for the growth team.',
  '- Kept flaky tests under one percent by fixing them each week.',
  '- Paired with developers on contract tests for the payments service.',
].join('\n');

const POSTING =
  'We test with Playwright and TypeScript, check data with SQL, and ship on Docker and Kubernetes. '.repeat(
    4,
  );

test('draft a cover letter from a pasted posting, edit it, save it, and draft again', async ({
  page,
  api,
}) => {
  await api.uploadResumeText(RESUME);
  // A LinkedIn link cannot be read, so the posting is pasted. The contact gives the greeting.
  const application = await api.createApplication({
    company: 'Acme',
    role: 'Senior SDET',
    status: 'Saved',
    jobLink: 'https://www.linkedin.com/jobs/view/123',
    contact: 'Jane Doe, recruiter',
  });
  await page.goto(`/applications/${application.id}`);
  const letter = new CoverLetterSection(page);

  // Defaults: standard and professional.
  await expect(letter.length(/^Standard/)).toBeChecked();
  await expect(letter.tone('Professional')).toBeChecked();
  await letter.length(/^Short/).check();
  await letter.tone('Warm').check();
  await letter.steer.fill('I led the API test suite.');
  await letter.draftButton.click();
  await expect(letter.alert).toContainText('Paste it instead');
  await letter.posting.fill(POSTING);
  await letter.draftFromPosting.click();

  await expect(letter.text).toHaveValue(/^Dear Jane Doe,\n\n/);
  await expect(letter.text).toHaveValue(
    /Senior SDET role at Acme \(warm, short\)\. I led the API test suite\./,
  );
  await expect(letter.text).toHaveValue(/Sincerely,\nPat Example$/);
  await expect(letter.state).toContainText('not saved yet');
  await expect(letter.count).toBeVisible();

  // Edit a sentence, see it flagged, then save.
  const edited = (await letter.text.inputValue()).replace(
    'Thank you for your time.',
    'I would welcome a conversation.',
  );
  await letter.text.fill(edited);
  await expect(letter.state).toHaveText(/^Edited, not saved yet/);
  await expect(letter.printLink).toBeHidden();
  await letter.saveButton.click();
  await expect(letter.state).toHaveText(/^Saved on/);
  await expect(letter.saveButton).toBeDisabled();

  await page.reload();
  await expect(letter.text).toHaveValue(edited);
  await expect(letter.state).toHaveText(/^Saved on/);
  // The choices come back with the letter.
  await expect(letter.tone('Warm')).toBeChecked();
  await expect(letter.length(/^Short/)).toBeChecked();

  // Drafting again asks first, since it replaces the saved letter; Cancel keeps it.
  await letter.tone('Direct').check();
  await letter.draftAgainButton.click();
  await expect(letter.dialog).toContainText('replaces your saved letter');
  await letter.dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(letter.text).toHaveValue(edited);

  await letter.draftAgainButton.click();
  await letter.dialog.getByRole('button', { name: 'Draft again' }).click();
  await expect(letter.text).toHaveValue(/\(direct, short\)/);
  await expect(letter.state).toContainText('not saved yet');
  await expect(page.getByText('Cover letter drafted for Acme')).toBeVisible();
});

test('undo edits, copy the letter, and remove it', async ({ page, api, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await api.uploadResumeText(RESUME);
  const application = await api.createApplication({ company: 'Acme', role: 'Senior SDET' });
  const drafted = await page.request.post(
    `/api/applications/${application.id}/cover-letter/draft`,
    { data: { postingText: POSTING, tone: 'enthusiastic' } },
  );
  expect(drafted.status(), await drafted.text()).toBe(200);

  await page.goto(`/applications/${application.id}`);
  const letter = new CoverLetterSection(page);
  const original = await letter.text.inputValue();
  expect(original).toMatch(/^Dear Hiring Manager,/);

  await letter.text.fill('Something else');
  await letter.undoButton.click();
  await expect(letter.text).toHaveValue(original);

  await letter.copyButton.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(original.trim());

  await letter.removeButton.click();
  await expect(letter.dialog).toContainText('Remove this cover letter?');
  await letter.dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(letter.text).toBeHidden();
  await expect(letter.draftButton).toBeVisible();
});

test('the cover letter as a printable page, saved as a PDF from the browser', async ({
  page,
  api,
}) => {
  await api.uploadResumeText(RESUME);
  const application = await api.createApplication({ company: 'Acme', role: 'Senior SDET' });
  const saved = await page.request.put(`/api/applications/${application.id}/cover-letter`, {
    data: { text: 'Dear Jane,\n\nI build test suites.\n\nSincerely,\nPat Example' },
  });
  expect(saved.status(), await saved.text()).toBe(200);

  await page.goto(`/applications/${application.id}`);
  await new CoverLetterSection(page).printLink.click();

  await expect(page).toHaveURL(`/applications/${application.id}/cover-letter`);
  // The title becomes the PDF's file name.
  await expect(page).toHaveTitle('Cover letter - Acme - Senior SDET');
  const sheet = page.getByRole('article', { name: "This job's cover letter" });
  await expect(sheet.getByRole('paragraph')).toHaveText([
    'Dear Jane,',
    'I build test suites.',
    'Sincerely,\nPat Example',
  ]);
  const print = page.getByRole('button', { name: 'Print or save as PDF' });
  await expect(print).toBeVisible();

  await page.emulateMedia({ media: 'print' });
  await expect(print).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await expect(sheet).toBeVisible();
});

test('without a resume, the section asks for one instead of drafting', async ({ page, api }) => {
  const application = await api.createApplication({ company: 'Acme', role: 'Senior SDET' });
  await page.goto(`/applications/${application.id}`);
  const letter = new CoverLetterSection(page);
  await expect(letter.root).toContainText('Upload your resume to draft a cover letter');
  await expect(letter.draftButton).toBeHidden();
});

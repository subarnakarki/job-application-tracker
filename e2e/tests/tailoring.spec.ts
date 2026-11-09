import { expect, test } from '../fixtures';

const RESUME = [
  'Pat Example',
  'Senior SDET who builds Playwright suites.',
  '- Ran SQL reports for the growth team.',
  '- Kept flaky tests under one percent by fixing them each week.',
  '- Paired with developers on contract tests for the payments service.',
].join('\n');

// Five terms the stand-in model reads as the keywords: the resume has Playwright and SQL (40%).
const POSTING =
  'We test with Playwright and TypeScript, check data with SQL, and ship on Docker and Kubernetes. '.repeat(
    4,
  );

test("tailor an application's resume: paste the posting, pick, edit by hand, save", async ({
  page,
  api,
}) => {
  await api.uploadResumeText(RESUME);
  // A LinkedIn link cannot be read, so the posting is pasted.
  const application = await api.createApplication({
    company: 'Acme',
    role: 'Senior SDET',
    status: 'Saved',
    jobLink: 'https://www.linkedin.com/jobs/view/123',
  });
  await page.goto(`/applications/${application.id}`);
  const section = page.getByRole('region', { name: 'Tailored resume' });

  await section.getByRole('button', { name: 'Tailor my resume' }).click();
  await expect(section.getByRole('alert')).toContainText('Paste it instead');
  await section.getByLabel('Paste the job posting').fill(POSTING);
  await section.getByRole('button', { name: 'Tailor from this posting' }).click();

  // The suggestion adds TypeScript, a tool the resume never names: it starts unticked.
  await expect(section.getByText('Check this: not in your resume: TypeScript')).toBeVisible();
  const status = section.getByRole('status').filter({ hasText: /^Fit/ });
  await expect(status).toHaveText('Fit 40%');
  await section.getByRole('checkbox', { name: /Use suggestion 1/ }).check();
  await expect(status).toHaveText('Fit 40% → 60% with the ticked edits');

  await section.getByRole('button', { name: "Edit and save as this job's resume" }).click();
  const editor = section.getByLabel("This job's resume");
  await expect(editor).toHaveValue(/Senior SDET who builds Playwright suites, using TypeScript\./);
  await editor.fill(`${await editor.inputValue()}\n- Built Docker images for the test grid.`);
  await expect(section.getByText(/^Fit 40% → 80% · still missing: Kubernetes$/)).toBeVisible();
  await section.getByRole('button', { name: "Save as this job's resume" }).click();

  await expect(section.getByText(/^Saved for this job on/)).toContainText(
    '2 changes from your resume',
  );
  await page.reload();
  await expect(section.getByText(/^Saved for this job on/)).toBeVisible();
  await section.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(section.getByLabel("This job's resume")).toHaveValue(
    /- Built Docker images for the test grid\.$/,
  );
});

import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';

// Against the production build (see playwright.config.ts), which `vite preview` serves with the
// same Content-Security-Policy as Vercel. The dev server sends none, so nothing else would notice
// a blocked font, style or script. Every page is opened and none may report a violation.
test.use({ baseURL: 'http://localhost:4173' });

/** Starts recording CSP violations (the browser's event and its console report) on a page. */
async function watchCsp(page: Page): Promise<string[]> {
  const problems: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(
        `CSP-VIOLATION ${event.violatedDirective} ${event.blockedURI} at ${event.sourceFile}:${event.lineNumber} ${event.sample}`,
      );
    });
  });
  page.on('console', (message) => {
    const text = message.text();
    if (/CSP-VIOLATION|Content Security Policy|Refused to/.test(text)) problems.push(text);
  });
  return problems;
}

/** Opens a path and waits until the page has rendered its heading and gone quiet. */
async function visit(page: Page, path: string) {
  await page.goto(path);
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page.waitForLoadState('networkidle');
}

test('the preview sends the strict policy, and the check really sees a violation', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  const problems = await watchCsp(page);
  const response = await page.goto('/login');
  const policy = response?.headers()['content-security-policy'] ?? '';
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("style-src 'self'");
  expect(policy).toContain("font-src 'self'");
  expect(policy).not.toContain('unsafe-inline');

  // An inline script is what the policy forbids: the watcher must report it, or it checks nothing.
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.inlineScriptRan = true';
    document.head.append(script);
  });
  await expect.poll(() => problems.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => 'inlineScriptRan' in window)).toBe(false);
});

test('the public pages load without a policy violation', async ({ page, context }) => {
  await context.clearCookies();
  const problems = await watchCsp(page);

  await visit(page, '/login');
  await visit(page, '/privacy');

  expect(problems).toEqual([]);
});

test('every signed-in page loads without a policy violation', async ({ page, api }) => {
  const application = await api.createApplication({
    company: 'Acme Robotics',
    role: 'Senior SDET',
    status: 'Interviewing',
  });
  const lead = await page.request.post('/api/leads', { data: { name: 'Sam Rivera' } });
  expect(lead.status(), await lead.text()).toBe(201);
  const { id: leadId } = (await lead.json()) as { id: string };
  const runId = await api.seedImport([
    {
      subject: 'Thanks for applying',
      from: 'jobs@initech.example',
      hoursAgo: 2,
      verdict: {
        kind: 'application_confirmation',
        company: 'Initech',
        role: 'QA Engineer',
        confidence: 'high',
        summary: 'Initech received the application.',
      },
    },
  ]);
  const problems = await watchCsp(page);

  await visit(page, '/');
  await visit(page, '/?view=board');
  await visit(page, `/applications/${application.id}`);
  // The confirm dialog has its own backdrop and animation styles.
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await visit(page, '/applications/new');
  await visit(page, `/applications/${application.id}/edit`);
  await visit(page, '/leads');
  await visit(page, '/leads/new');
  await visit(page, `/leads/${leadId}`);
  await visit(page, '/stats');
  await visit(page, '/account');
  await visit(page, `/import/${runId}`);
  await visit(page, '/no-such-page');

  expect(problems).toEqual([]);
});

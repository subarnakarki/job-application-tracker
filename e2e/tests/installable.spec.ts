import { expect, test } from '../fixtures';

// Against the production build (see playwright.config.ts): the service worker exists only there.
test.use({ baseURL: 'http://localhost:4173' });

test('the app can be installed: a manifest with working icons', async ({ request }) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  const body = (await manifest.json()) as {
    name: string;
    display: string;
    icons: { src: string; purpose?: string }[];
  };
  expect(body).toMatchObject({ name: 'Job Application Tracker', display: 'standalone' });
  expect(body.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  for (const icon of body.icons) {
    const image = await request.get(icon.src);
    expect(image.headers()['content-type'], icon.src).toBe('image/png');
  }
});

test('it opens offline, says so, and never caches your data', async ({ page, context, api }) => {
  await api.createApplication({ company: 'Private Co', role: 'SDET' });
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now the worker controls the page
  await expect(page.getByText('Private Co')).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByText("You're offline. Your applications will load when you're back online."),
  ).toBeVisible();

  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys())
        urls.push(new URL(request.url).pathname);
    }
    return urls;
  });
  expect(cached).toContain('/index.html');
  expect(cached.filter((path) => path.startsWith('/api'))).toEqual([]);
  await context.setOffline(false);
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { AppRoutes } from './App';
import { PipelineBar } from './components/PipelineBar';

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('sends a signed-out visitor to the sign-in page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'unauthorized', message: 'Sign in' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    renderAt('/applications/new');
    // The header offers the demo too, so look in the page itself.
    expect(
      within(await screen.findByRole('main')).getByRole('button', { name: 'Try the demo' }),
    ).toBeVisible();
  });
});

describe('Sign-in page', () => {
  it('explains why a Google sign-in came back, and keeps the return path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'unauthenticated', message: 'Sign in' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    renderAt('/login?error=google_cancelled&next=%2Fapplications%2Fnew');
    expect(await screen.findByRole('alert')).toHaveTextContent('Google sign-in was cancelled.');
    expect(screen.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      '/api/auth/google/start?next=%2Fapplications%2Fnew',
    );
  });
});

describe('PipelineBar', () => {
  it('selects a stage and clears it when tapped again', async () => {
    const onSelect = vi.fn();
    const pipeline = {
      stages: (
        ['Saved', 'Applied', 'Screening', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn'] as const
      ).map((status) => ({ status, count: 1 })),
      followUpCount: 0,
      total: 7,
    };
    const { rerender } = render(
      <PipelineBar pipeline={pipeline} selected={undefined} onSelect={onSelect} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Applied/ }));
    expect(onSelect).toHaveBeenLastCalledWith('Applied');

    rerender(<PipelineBar pipeline={pipeline} selected="Applied" onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: /Applied/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: /Applied/ }));
    expect(onSelect).toHaveBeenLastCalledWith(undefined);
  });
});

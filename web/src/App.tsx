import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import {
  ApplicationDetailPage,
  EditApplicationPage,
  NewApplicationPage,
  NotFoundPage,
} from './pages/ApplicationPages';
import { ApplicationsPage } from './pages/ApplicationsPage';
import { AccountPage } from './pages/AccountPage';
import { ImportResultsPage } from './pages/ImportResultsPage';
import { LoginPage } from './pages/LoginPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { StatsPage } from './pages/StatsPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route element={<Layout />}>
        <Route index element={<ApplicationsPage />} />
        <Route path="applications/new" element={<NewApplicationPage />} />
        <Route path="applications/:id" element={<ApplicationDetailPage />} />
        <Route path="applications/:id/edit" element={<EditApplicationPage />} />
        <Route path="stats" element={<StatsPage />} />
        <Route path="import/:runId" element={<ImportResultsPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  const [client] = useState(
    () =>
      new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

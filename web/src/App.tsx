import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { ApiRequestError } from './api/client';
import { Layout } from './components/Layout';
import { TailoredResumePage } from './pages/TailoredResumePage';
import { CoverLetterPage } from './pages/CoverLetterPage';
import {
  ApplicationDetailPage,
  EditApplicationPage,
  NewApplicationPage,
  NotFoundPage,
} from './pages/ApplicationPages';
import { ApplicationsPage } from './pages/ApplicationsPage';
import { AccountPage } from './pages/AccountPage';
import { ImportResultsPage } from './pages/ImportResultsPage';
import { EditLeadPage, LeadPage, LeadsPage, NewLeadPage } from './pages/LeadPages';
import { LoginPage } from './pages/LoginPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { ResumePage } from './pages/ResumePage';
import {
  ApplyQueuePage,
  JobSearchPage,
  JobSearchRunPage,
  JobSearchSetupPage,
} from './pages/JobSearchPages';
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
        <Route path="applications/:id/resume" element={<TailoredResumePage />} />
        <Route path="applications/:id/cover-letter" element={<CoverLetterPage />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="leads/new" element={<NewLeadPage />} />
        <Route path="leads/:id" element={<LeadPage />} />
        <Route path="leads/:id/edit" element={<EditLeadPage />} />
        <Route path="stats" element={<StatsPage />} />
        <Route path="resume" element={<ResumePage />} />
        <Route path="job-search" element={<JobSearchPage />} />
        <Route path="job-search/setup" element={<JobSearchSetupPage />} />
        <Route path="job-search/runs/:id" element={<JobSearchRunPage />} />
        <Route path="apply-queue" element={<ApplyQueuePage />} />
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
      new QueryClient({
        defaultOptions: {
          queries: {
            // A 4xx (not found, signed out, not allowed) will not change on a retry: show it at once.
            retry: (failures, error) =>
              failures < 1 && !(error instanceof ApiRequestError && error.status < 500),
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

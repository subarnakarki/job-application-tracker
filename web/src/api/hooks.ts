import {
  ApplicationDetailSchema,
  ApplyQueueSchema,
  JobHitSchema,
  JobSearchRunDetailSchema,
  JobSearchRunListSchema,
  JobSearchSetupSchema,
  QueueCheckResultSchema,
  ResumeTextSchema,
  type DraftEdit,
  type JobSearchProfile,
  ApplicationListSchema,
  ImportItemSchema,
  ImportRunDetailSchema,
  ImportRunListSchema,
  ImportStatusSchema,
  InterviewSchema,
  LeadDetailSchema,
  LeadListSchema,
  LeadNoteSchema,
  PipelineSchema,
  PostingPreviewSchema,
  ResumeAnalysisListSchema,
  ResumeAnalysisSchema,
  ResumeEnvelopeSchema,
  ResumeSchema,
  StatsSchema,
  UserEnvelopeSchema,
  type Application,
  type ApplicationInput,
  type ApplicationList,
  type ApplicationPatch,
  type InterviewInput,
  type InterviewPatch,
  type LeadInput,
  type LeadNoteInput,
  type LeadNotePatch,
  type LeadPatch,
  type ListQuery,
  type Pipeline,
  type ResumeUpload,
  type Status,
  type User,
} from '@jat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { moveInList, moveInPipeline } from '../optimistic';
import { apiRequest, ApiRequestError } from './client';

export type ListFilters = Partial<Pick<ListQuery, 'status' | 'followUp' | 'q' | 'sort'>>;

export function toQueryString(filters: ListFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.followUp !== undefined) params.set('followUp', String(filters.followUp));
  if (filters.q) params.set('q', filters.q);
  if (filters.sort) params.set('sort', filters.sort);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** The signed-in user, or null when signed out. */
export function useMe() {
  return useQuery<User | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await apiRequest('/api/me', UserEnvelopeSchema)).user;
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

export function useApplications(filters: ListFilters) {
  return useQuery({
    queryKey: ['applications', filters],
    queryFn: () => apiRequest(`/api/applications${toQueryString(filters)}`, ApplicationListSchema),
  });
}

export function usePipeline(q: string | undefined) {
  return useQuery({
    queryKey: ['pipeline', q ?? ''],
    queryFn: () =>
      apiRequest(`/api/pipeline${q ? `?q=${encodeURIComponent(q)}` : ''}`, PipelineSchema),
  });
}

export function useStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: () => apiRequest('/api/stats', StatsSchema),
  });
}

export function useApplication(id: string) {
  return useQuery({
    queryKey: ['application', id],
    queryFn: () =>
      apiRequest(`/api/applications/${encodeURIComponent(id)}`, ApplicationDetailSchema),
  });
}

/** After any change, every list, count and detail may be stale. */
function useRefresh() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['applications'] }),
      client.invalidateQueries({ queryKey: ['pipeline'] }),
      client.invalidateQueries({ queryKey: ['stats'] }),
      client.invalidateQueries({ queryKey: ['application'] }),
    ]);
}

/**
 * Moves an application to another stage at once (list and pipeline caches), then saves it.
 * On failure the caches are put back; either way everything is refetched from the server.
 */
export function useMoveApplication() {
  const client = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ application, to }: { application: Application; to: Status }) =>
      apiRequest(
        `/api/applications/${encodeURIComponent(application.id)}`,
        ApplicationDetailSchema,
        { method: 'PATCH', body: { status: to }, version: application.version },
      ),
    onMutate: async ({ application, to }) => {
      await Promise.all([
        client.cancelQueries({ queryKey: ['applications'] }),
        client.cancelQueries({ queryKey: ['pipeline'] }),
      ]);
      const lists = client.getQueriesData<ApplicationList>({ queryKey: ['applications'] });
      const pipelines = client.getQueriesData<Pipeline>({ queryKey: ['pipeline'] });
      const now = new Date().toISOString();
      for (const [key, data] of lists) {
        if (data)
          client.setQueryData(
            key,
            moveInList(data, application.id, to, (key[1] ?? {}) as ListFilters, now),
          );
      }
      for (const [key, data] of pipelines) {
        if (data)
          client.setQueryData(
            key,
            moveInPipeline(data, application.status, to, application.needsFollowUp),
          );
      }
      return { lists, pipelines };
    },
    onError: (_error, _variables, snapshot) => {
      for (const [key, data] of [...(snapshot?.lists ?? []), ...(snapshot?.pipelines ?? [])])
        client.setQueryData(key, data);
    },
    onSettled: refresh,
  });
}

export function useCreateApplication() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: ApplicationInput) =>
      apiRequest('/api/applications', ApplicationDetailSchema, { method: 'POST', body: input }),
    onSuccess: refresh,
  });
}

export function useUpdateApplication(id: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ version, patch }: { version: number; patch: ApplicationPatch }) =>
      apiRequest(`/api/applications/${encodeURIComponent(id)}`, ApplicationDetailSchema, {
        method: 'PATCH',
        body: patch,
        version,
      }),
    onSuccess: refresh,
  });
}

/** Fills the application's empty fields from its suggested posting (an edit: needs the version). */
export function useApplySuggestion(id: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ version }: { version: number }) =>
      apiRequest(
        `/api/applications/${encodeURIComponent(id)}/suggestion/apply`,
        ApplicationDetailSchema,
        { method: 'POST', body: {}, version },
      ),
    onSuccess: refresh,
  });
}

export function useFindPosting(id: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () =>
      apiRequest(
        `/api/applications/${encodeURIComponent(id)}/suggestion/find`,
        ApplicationDetailSchema,
        { method: 'POST', body: {} },
      ),
    onSuccess: refresh,
  });
}

export function useDismissSuggestion(id: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () =>
      apiRequest(`/api/applications/${encodeURIComponent(id)}/suggestion`, null, {
        method: 'DELETE',
      }),
    onSuccess: refresh,
  });
}

export function useDeleteApplication(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest(`/api/applications/${encodeURIComponent(id)}`, null, { method: 'DELETE' }),
    // Not refetching the deleted application itself (it would 404); it is dropped from the cache instead.
    onSuccess: () => {
      client.removeQueries({ queryKey: ['application', id], type: 'inactive' });
      return Promise.all([
        client.invalidateQueries({ queryKey: ['applications'] }),
        client.invalidateQueries({ queryKey: ['pipeline'] }),
        client.invalidateQueries({ queryKey: ['stats'] }),
        client.invalidateQueries({
          queryKey: ['application'],
          predicate: (query) => query.queryKey[1] !== id,
        }),
      ]);
    },
  });
}

export function useDemoSignIn() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest('/api/auth/demo', UserEnvelopeSchema, { method: 'POST' }),
    onSuccess: ({ user }) => {
      client.setQueryData(['me'], user);
      return client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
    },
  });
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest('/api/auth/logout', null, { method: 'POST' }),
    onSuccess: () => {
      client.clear();
      client.setQueryData(['me'], null);
    },
  });
}

export function useUpdateTimeZone() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (timeZone: string) =>
      apiRequest('/api/me', UserEnvelopeSchema, { method: 'PATCH', body: { timeZone } }),
    onSuccess: ({ user }) => {
      client.setQueryData(['me'], user);
      // "Needs follow-up" depends on the user's time zone.
      return client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
    },
  });
}

/** The phrase the API requires, so an account is never deleted by a stray request. */
export const ACCOUNT_DELETION_CONFIRMATION = 'delete my account';

export function useDeleteAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest('/api/me', null, {
        method: 'DELETE',
        body: { confirm: ACCOUNT_DELETION_CONFIRMATION },
      }),
    onSuccess: () => {
      client.clear();
      client.setQueryData(['me'], null);
    },
  });
}

export function useImportStatus() {
  return useQuery({
    queryKey: ['import-status'],
    queryFn: () => apiRequest('/api/import/status', ImportStatusSchema),
    staleTime: 60_000,
  });
}

export function useImportRuns() {
  return useQuery({
    queryKey: ['import-runs'],
    queryFn: () => apiRequest('/api/import/runs', ImportRunListSchema),
  });
}

export function useImportRun(runId: string) {
  return useQuery({
    queryKey: ['import-run', runId],
    queryFn: () =>
      apiRequest(`/api/import/runs/${encodeURIComponent(runId)}`, ImportRunDetailSchema),
  });
}

export type ImportAction = 'undo' | 'apply' | 'dismiss';

/** Undo, apply or dismiss one imported email; refreshes the run and everything it may change. */
export function useImportAction(runId: string) {
  const client = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ itemId, action }: { itemId: string; action: ImportAction }) =>
      apiRequest(`/api/import/items/${encodeURIComponent(itemId)}/${action}`, ImportItemSchema, {
        method: 'POST',
        body: {},
      }),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['import-run', runId] }),
        client.invalidateQueries({ queryKey: ['import-runs'] }),
        refresh(),
      ]),
  });
}

// ---------------------------------------------------------------------------------------------
// Networking leads

export function useLeads(q?: string) {
  return useQuery({
    queryKey: ['leads', q ?? ''],
    queryFn: () =>
      apiRequest(`/api/leads${q ? `?q=${encodeURIComponent(q)}` : ''}`, LeadListSchema),
  });
}

export function useLead(id: string) {
  return useQuery({
    queryKey: ['lead', id],
    queryFn: () => apiRequest(`/api/leads/${encodeURIComponent(id)}`, LeadDetailSchema),
  });
}

/** A lead change can show up in lead lists, the lead page and applications (their lead's name). */
function useLeadRefresh() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['leads'] }),
      client.invalidateQueries({ queryKey: ['lead'] }),
      client.invalidateQueries({ queryKey: ['applications'] }),
      client.invalidateQueries({ queryKey: ['application'] }),
    ]);
}

export function useCreateLead() {
  const refresh = useLeadRefresh();
  return useMutation({
    mutationFn: (input: LeadInput) =>
      apiRequest('/api/leads', LeadDetailSchema, { method: 'POST', body: input }),
    onSuccess: refresh,
  });
}

export function useUpdateLead(id: string) {
  const refresh = useLeadRefresh();
  return useMutation({
    mutationFn: (patch: LeadPatch) =>
      apiRequest(`/api/leads/${encodeURIComponent(id)}`, LeadDetailSchema, {
        method: 'PATCH',
        body: patch,
      }),
    onSuccess: refresh,
  });
}

export function useDeleteLead(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest(`/api/leads/${encodeURIComponent(id)}`, null, { method: 'DELETE' }),
    // Not refetching the deleted lead itself (it would 404).
    onSuccess: () => {
      client.removeQueries({ queryKey: ['lead', id], type: 'inactive' });
      return Promise.all([
        client.invalidateQueries({ queryKey: ['leads'] }),
        client.invalidateQueries({ queryKey: ['applications'] }),
        client.invalidateQueries({ queryKey: ['application'] }),
      ]);
    },
  });
}

export function useAddLeadNote(leadId: string) {
  const refresh = useLeadRefresh();
  return useMutation({
    mutationFn: (input: LeadNoteInput) =>
      apiRequest(`/api/leads/${encodeURIComponent(leadId)}/notes`, LeadNoteSchema, {
        method: 'POST',
        body: input,
      }),
    onSuccess: refresh,
  });
}

export function useUpdateLeadNote(leadId: string) {
  const refresh = useLeadRefresh();
  return useMutation({
    mutationFn: ({ noteId, patch }: { noteId: string; patch: LeadNotePatch }) =>
      apiRequest(
        `/api/leads/${encodeURIComponent(leadId)}/notes/${encodeURIComponent(noteId)}`,
        LeadNoteSchema,
        { method: 'PATCH', body: patch },
      ),
    onSuccess: refresh,
  });
}

export function useDeleteLeadNote(leadId: string) {
  const refresh = useLeadRefresh();
  return useMutation({
    mutationFn: (noteId: string) =>
      apiRequest(
        `/api/leads/${encodeURIComponent(leadId)}/notes/${encodeURIComponent(noteId)}`,
        null,
        { method: 'DELETE' },
      ),
    onSuccess: refresh,
  });
}

// ---------------------------------------------------------------------------------------------
// Interviews (each change is an edit of its application, so everything is refreshed)

export function useAddInterview(applicationId: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: InterviewInput) =>
      apiRequest(
        `/api/applications/${encodeURIComponent(applicationId)}/interviews`,
        InterviewSchema,
        {
          method: 'POST',
          body: input,
        },
      ),
    onSuccess: refresh,
  });
}

export function useUpdateInterview(applicationId: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ interviewId, patch }: { interviewId: string; patch: InterviewPatch }) =>
      apiRequest(
        `/api/applications/${encodeURIComponent(applicationId)}/interviews/${encodeURIComponent(interviewId)}`,
        InterviewSchema,
        { method: 'PATCH', body: patch },
      ),
    onSuccess: refresh,
  });
}

export function useDeleteInterview(applicationId: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (interviewId: string) =>
      apiRequest(
        `/api/applications/${encodeURIComponent(applicationId)}/interviews/${encodeURIComponent(interviewId)}`,
        null,
        { method: 'DELETE' },
      ),
    onSuccess: refresh,
  });
}

/** "Fill from link": reads a posting on the server; stores nothing. */
export function usePostingPreview() {
  return useMutation({
    mutationFn: (url: string) =>
      apiRequest('/api/postings/preview', PostingPreviewSchema, { method: 'POST', body: { url } }),
  });
}

// Resume match (Phase 14)

export function useResume() {
  return useQuery({
    queryKey: ['resume'],
    queryFn: () => apiRequest('/api/resume', ResumeEnvelopeSchema),
  });
}

export function useUploadResume() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (upload: ResumeUpload) =>
      apiRequest('/api/resume', ResumeSchema, { method: 'PUT', body: upload }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['resume'] }),
  });
}

export function useDeleteResume() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest('/api/resume', null, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['resume'] }),
  });
}

export function useResumeAnalyses() {
  return useQuery({
    queryKey: ['resume-analyses'],
    queryFn: () => apiRequest('/api/resume/analyses', ResumeAnalysisListSchema),
  });
}

export function useResumeAnalysis(id: string | null) {
  return useQuery({
    queryKey: ['resume-analysis', id],
    queryFn: () =>
      apiRequest(`/api/resume/analyses/${encodeURIComponent(id ?? '')}`, ResumeAnalysisSchema),
    enabled: id !== null,
  });
}

export function useAnalyseResume() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest('/api/resume/analyses', ResumeAnalysisSchema, { method: 'POST', body: {} }),
    onSuccess: (analysis) => {
      client.setQueryData(['resume-analysis', analysis.id], analysis);
      return client.invalidateQueries({ queryKey: ['resume-analyses'] });
    },
  });
}

export function useDeleteResumeAnalysis() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/resume/analyses/${encodeURIComponent(id)}`, null, { method: 'DELETE' }),
    onSuccess: (_result, id) => {
      client.removeQueries({ queryKey: ['resume-analysis', id] });
      return client.invalidateQueries({ queryKey: ['resume-analyses'] });
    },
  });
}

// Job search (Phase 15)

export function useJobSearchSetup() {
  return useQuery({
    queryKey: ['job-search-setup'],
    queryFn: () => apiRequest('/api/job-search/profile', JobSearchSetupSchema),
  });
}

export function useSaveJobSearchProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (profile: JobSearchProfile) =>
      apiRequest('/api/job-search/profile', JobSearchSetupSchema, { method: 'PUT', body: profile }),
    onSuccess: (setup) => client.setQueryData(['job-search-setup'], setup),
  });
}

/** The latest runs. While one is going (or `watching`), checked every 2 seconds for progress. */
export function useJobSearchRuns(enabled: boolean, watching = false) {
  return useQuery({
    queryKey: ['job-search-runs'],
    queryFn: () => apiRequest('/api/job-search/runs', JobSearchRunListSchema),
    enabled,
    refetchInterval: (query) =>
      watching || query.state.data?.items.some((run) => run.status === 'running') ? 2000 : false,
  });
}

export function useJobSearchRun(id: string) {
  return useQuery({
    queryKey: ['job-search-run', id],
    queryFn: () =>
      apiRequest(`/api/job-search/runs/${encodeURIComponent(id)}`, JobSearchRunDetailSchema),
  });
}

function useRefreshJobSearch() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['job-search-runs'] }),
      client.invalidateQueries({ queryKey: ['job-search-run'] }),
      client.invalidateQueries({ queryKey: ['apply-queue'] }),
    ]);
}

export function useRunJobSearch() {
  const refresh = useRefreshJobSearch();
  return useMutation({
    mutationFn: () =>
      apiRequest('/api/job-search/runs', JobSearchRunDetailSchema, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });
}

export function useApplyQueue(enabled = true) {
  return useQuery({
    queryKey: ['apply-queue'],
    queryFn: () => apiRequest('/api/job-search/queue', ApplyQueueSchema),
    enabled,
  });
}

export type HitAction = 'applied' | 'track' | 'blocked' | 'skip' | 'queue' | 'redraft' | 'closed';

/** "Tailor my resume": suggested edits for one job, stored on it. */
export function useTailorResume() {
  const refresh = useRefreshJobSearch();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/job-search/hits/${encodeURIComponent(id)}/tailor`, JobHitSchema, {
        method: 'POST',
        body: {},
      }),
    onSuccess: refresh,
  });
}

/** "Check they're still open": reads each waiting job again; closed ones leave the queue. */
export function useCheckQueue() {
  const refresh = useRefreshJobSearch();
  return useMutation({
    mutationFn: () =>
      apiRequest('/api/job-search/queue/check', QueueCheckResultSchema, {
        method: 'POST',
        body: {},
      }),
    onSuccess: refresh,
  });
}

export function useHitAction() {
  const refresh = useRefreshJobSearch();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: HitAction; reason?: string }) =>
      apiRequest(`/api/job-search/hits/${encodeURIComponent(id)}/${action}`, JobHitSchema, {
        method: 'POST',
        body: action === 'blocked' ? { reason } : {},
      }),
    onSuccess: async (_hit, { action }) => {
      await refresh();
      if (action === 'applied' || action === 'track')
        await Promise.all([
          client.invalidateQueries({ queryKey: ['applications'] }),
          client.invalidateQueries({ queryKey: ['pipeline'] }),
          client.invalidateQueries({ queryKey: ['stats'] }),
        ]);
    },
  });
}

export function useEditDraft() {
  const refresh = useRefreshJobSearch();
  return useMutation({
    mutationFn: ({ id, edit }: { id: string; edit: DraftEdit }) =>
      apiRequest(`/api/job-search/hits/${encodeURIComponent(id)}/draft`, JobHitSchema, {
        method: 'PUT',
        body: edit,
      }),
    onSuccess: refresh,
  });
}

export function useResumeText(enabled: boolean) {
  return useQuery({
    queryKey: ['resume-text'],
    queryFn: () => apiRequest('/api/resume/text', ResumeTextSchema),
    enabled,
  });
}

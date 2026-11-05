import {
  ApplicationDetailSchema,
  ApplicationListSchema,
  PipelineSchema,
  StatsSchema,
  UserEnvelopeSchema,
  type ApplicationInput,
  type ApplicationPatch,
  type ListQuery,
  type User,
} from '@jat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

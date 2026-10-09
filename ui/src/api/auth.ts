import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './client';

export type Theme = 'system' | 'light' | 'dark';
export type UserRole = 'ADMIN' | 'MEMBER';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  theme: Theme;
}

export const meKey = ['auth', 'me'] as const;

/** The signed-in user, or null without a session (401). */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async () => {
      try {
        return await api.get<AuthUser>('/auth/me');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => api.post<AuthUser>('/auth/login', input),
    onSuccess: (user) => {
      // Whatever was cached belonged to the previous session.
      queryClient.clear();
      queryClient.setQueryData(meKey, user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/auth/logout'),
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData(meKey, null);
    },
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; theme?: Theme }) => api.patch<AuthUser>('/auth/me', input),
    onSuccess: (user) => queryClient.setQueryData(meKey, user),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) => api.post<void>('/auth/me/password', input),
  });
}

// ---------------------------------------------------------------- users (administrators)

export interface StudioUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  workspaceCount: number;
}

const usersKey = ['users'] as const;

export function useUsers(enabled: boolean) {
  return useQuery({ queryKey: usersKey, queryFn: () => api.get<StudioUser[]>('/users'), enabled });
}

function useUsersMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => queryClient.invalidateQueries({ queryKey: usersKey }) });
}

/** The answer carries the generated password, shown once. */
export const useCreateUser = () =>
  useUsersMutation((input: { name: string; email: string; role: UserRole }) => api.post<{ user: StudioUser; password: string }>('/users', input));

export const useUpdateUser = () =>
  useUsersMutation(({ id, ...input }: { id: string; name?: string; role?: UserRole; isActive?: boolean }) => api.patch<StudioUser>(`/users/${id}`, input));

export const useResetPassword = () => useUsersMutation((id: string) => api.post<{ password: string }>(`/users/${id}/password`));

export const useDeleteUser = () => useUsersMutation((id: string) => api.delete<void>(`/users/${id}`));

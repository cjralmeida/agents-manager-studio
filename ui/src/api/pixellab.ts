import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

/** PixelLab account (API token kept encrypted); agents with the "pixellab" tool generate pixel art through it. */
export interface PixellabAccount {
  id: string;
  label: string;
  tokenHint: string;
  workspaceCount: number;
}

const key = ["pixellab-accounts"] as const;

export function usePixellabAccounts() {
  return useQuery({
    queryKey: key,
    queryFn: () => api.get<PixellabAccount[]>("/pixellab-accounts"),
  });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: key });
}

export function useCreatePixellabAccount() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { label: string; token: string }) =>
      api.post<PixellabAccount>("/pixellab-accounts", input),
    onSuccess: invalidate,
  });
}

export function useUpdatePixellabAccount() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      id,
      ...input
    }: {
      id: string;
      label?: string;
      token?: string;
    }) => api.patch<PixellabAccount>(`/pixellab-accounts/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useVerifyPixellabAccount() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: true; usd: number | null; credits: number | null }>(
        `/pixellab-accounts/${id}/verify`,
      ),
    onSuccess: invalidate,
  });
}

export function useDeletePixellabAccount() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/pixellab-accounts/${id}`),
    onSuccess: invalidate,
  });
}

/** Why a request to a provider never got a response (timeout, DNS, connection reset), for the error message. */
export function networkFailure(error: unknown) {
  if (error instanceof Error && error.name === 'TimeoutError') return 'sem resposta em 30 s';
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
  return cause?.code ?? (error instanceof Error ? error.message : String(error));
}

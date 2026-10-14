/**
 * Whether `count` more test environments of `envMb` fit on the computer: what is used now, plus what environments still
 * going up have reserved (they have not taken their memory yet), plus the new ones, must stay under the same memory
 * limit the agents launch under.
 */
export function reservationFits(input: { used: number; total: number; reservedMb: number; limitPercent: number; envMb: number; count: number }) {
  if (input.total <= 0) return false;
  const mb = 1024 * 1024;
  const after = input.used + (input.reservedMb + input.envMb * input.count) * mb;
  return (after / input.total) * 100 <= input.limitPercent;
}

/** Memory counted for a service without mem_limit (e.g. the database), MB. */
const SERVICE_MEMORY_MB = 256;

export interface ComposeService {
  build?: unknown;
  ports?: { target: number }[];
  labels?: Record<string, string>;
  mem_limit?: string | number;
}

/**
 * Services the testers reach: the ones labeled studio.test: "<port>"; without labels, the ones built from the project
 * that publish a port (the app, not the database).
 */
export function exposedServices(services: Record<string, ComposeService>) {
  const labeled = Object.entries(services).flatMap(([name, service]) => {
    const port = Number(service.labels?.['studio.test']);
    return Number.isInteger(port) && port > 0 ? [{ name, port }] : [];
  });
  if (labeled.length > 0) return labeled;
  return Object.entries(services).flatMap(([name, service]) =>
    service.build && service.ports?.[0]?.target ? [{ name, port: service.ports[0].target }] : [],
  );
}

/** Memory the stack takes: the label studio.test.memory (MB) when set, else each service's mem_limit (or a small default). */
export function stackMemoryMb(services: Record<string, ComposeService>) {
  const labeled = Object.values(services).reduce((total, service) => total + (Number(service.labels?.['studio.test.memory']) || 0), 0);
  if (labeled > 0) return labeled;
  return Object.values(services).reduce((total, service) => {
    const bytes = Number(service.mem_limit);
    return total + (Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 / 1024) : SERVICE_MEMORY_MB);
  }, 0);
}

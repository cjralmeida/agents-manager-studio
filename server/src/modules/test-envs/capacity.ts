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

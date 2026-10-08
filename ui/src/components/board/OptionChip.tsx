import type { BoardOption } from '../../api/boards';

/** Colored chip for a board option (column or field value), using the provider color. */
export function OptionChip({ option, title }: { option: BoardOption; title?: string }) {
  return (
    <span
      title={title ?? option.description ?? undefined}
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap"
      style={{ color: option.color, backgroundColor: `${option.color}1f`, borderColor: `${option.color}55` }}
    >
      {option.name}
    </span>
  );
}

export function ColorDot({ color }: { color: string }) {
  return <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

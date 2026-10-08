import { ColorDot } from './board/OptionChip';

function toggle(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

/** Toggle chips for multiple choice; none selected reads as "any". */
export function ChipPicker({
  options,
  selected,
  onChange,
  emptyLabel = 'qualquer',
}: {
  options: { id: string; name: string; color?: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  emptyLabel?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const active = selected.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(toggle(selected, option.id))}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
              active ? 'border-accent bg-accent/15 text-white' : 'border-border text-muted hover:text-white'
            }`}
          >
            {option.color && <ColorDot color={option.color} />}
            {option.name}
          </button>
        );
      })}
      {selected.length === 0 && <span className="self-center text-xs text-muted">{emptyLabel}</span>}
    </div>
  );
}

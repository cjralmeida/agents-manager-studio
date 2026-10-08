import { useSearchParams } from 'react-router';

interface Tab<T extends string> {
  id: T;
  label: string;
}

/** Active tab kept in the `tab` query param, so it survives reloads and can be linked. The first tab is the default. */
export function useTabParam<T extends string>(tabs: readonly Tab<T>[]) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const active = tabs.find((tab) => tab.id === requested)?.id ?? tabs[0]!.id;
  const setActive = (id: T) => setSearchParams(id === tabs[0]!.id ? {} : { tab: id });
  return [active, setActive] as const;
}

interface TabsProps<T extends string> {
  tabs: readonly Tab<T>[];
  active: T;
  onChange: (id: T) => void;
}

export function Tabs<T extends string>({ tabs, active, onChange }: TabsProps<T>) {
  return (
    <nav className="flex gap-1 border-b border-border">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${active === tab.id ? 'border-accent text-white' : 'border-transparent text-muted hover:text-white'}`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

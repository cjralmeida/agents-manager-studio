import { type Skill, type SkillSource, skillSourceLabels, useSkills } from '../../api/skills';

export function groupSkills(skills: Skill[]) {
  const groups = new Map<SkillSource, Skill[]>();
  for (const skill of skills) {
    groups.set(skill.source, [...(groups.get(skill.source) ?? []), skill]);
  }
  return [...groups.entries()];
}

export function SkillsSection() {
  const skills = useSkills();

  return (
    <section>
      <h2 className="text-base font-semibold">Skills disponíveis</h2>
      <p className="mt-1 text-sm text-muted">
        Lidas da sua pasta <code className="text-gray-300">.claude/skills</code>. Escolha quais cada workspace usa na
        configuração do workspace.
      </p>

      {skills.data?.length === 0 && <p className="mt-4 text-sm text-muted">Nenhuma skill encontrada.</p>}
      {groupSkills(skills.data ?? []).map(([source, items]) => (
        <div key={source} className="mt-4">
          <h3 className="text-xs font-medium tracking-wider text-muted uppercase">{skillSourceLabels[source]}</h3>
          <ul className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
            {items.map((skill) => (
              <li key={skill.id} className="rounded-md border border-border bg-panel px-3 py-2">
                <div className="text-sm font-medium">{skill.name}</div>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted">{skill.description}</p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

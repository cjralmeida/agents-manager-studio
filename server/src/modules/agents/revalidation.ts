/**
 * What to test again after a merge with the base (or any change after an approval): only what can change behavior.
 * Comments, docs and formatting only need the build and the application starting; executable changes need the tests
 * of the areas they touch. Shared by the conflict messages to the builder and the note to a validator re-checking.
 */
export const NON_BEHAVIORAL =
  'comentários (javadoc, docstrings), documentação (.md), texto de changelog/versão, descrições e exemplos do contrato (não paths, parâmetros nem schemas), formatação e espaços';

export const REVALIDATE_AFTER_MERGE = [
  'Quanto testar depois da junção: veja o que ela mudou nos arquivos (os conflitos que você resolveu e o que veio da branch de destino para os arquivos da sua tarefa).',
  `- Se mexeu só em coisas que não mudam comportamento — ${NON_BEHAVIORAL} —, não rode a suíte nem testes: garanta só que o build passa e que a aplicação sobe (o servidor inicia / o jogo abre) e termine.`,
  '- Se mexeu em código executável, configuração, dependências, migração, contrato (paths, parâmetros, schemas), assets usados pelo app ou nos próprios testes: rode os testes das áreas afetadas (não a suíte inteira, a menos que a área seja transversal) e corrija o que quebrar.',
  'No resultado, diga em uma linha o que a junção mudou e qual dos dois casos foi.',
].join('\n');

/** Note for a validator whose earlier approval was undone only by a merge conflict at publish time. */
export function revalidationNote(approvedAt: Date) {
  return [
    'Revalidação depois de junção: você (este passo) já aprovou este trabalho em',
    `${approvedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC; ele só voltou porque o merge na publicação teve conflito com a branch de destino, e o passo anterior juntou a base e resolveu.`,
    'Revalide só o que mudou desde a sua aprovação: o commit "Merge … (resolver conflitos)" (`git show --remerge-diff <commit>` mostra como os conflitos foram resolvidos) e o que veio depois dele.',
    `- Só coisas que não mudam comportamento (${NON_BEHAVIORAL}): não rode testes nem cobertura de novo; confira que compila e que a aplicação sobe, e aprove.`,
    '- Código executável, configuração, migração, contrato ou testes mexidos: rode os testes das áreas afetadas por essa mudança e decida por eles. O resto já foi aprovado por você e pelas outras tarefas.',
  ].join('\n');
}

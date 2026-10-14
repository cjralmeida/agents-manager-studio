import type { StatusRole } from './types.js';

/** GitHub single-select colors and the hex used for them in the Studio (tuned for a dark UI). */
export const GITHUB_COLORS = {
  GRAY: '#8b949e',
  BLUE: '#4493f8',
  GREEN: '#3fb950',
  YELLOW: '#d29922',
  ORANGE: '#db6d28',
  RED: '#f85149',
  PINK: '#db61a2',
  PURPLE: '#a371f7',
} as const;
export type GitHubColor = keyof typeof GITHUB_COLORS;

export interface TemplateOption {
  name: string;
  color: GitHubColor;
  description: string;
}

export interface TemplateStatus extends TemplateOption {
  role: StatusRole;
}

/**
 * The Studio board template, modeled on the GlobalFarm-Hub board. Used to create GitLab boards (as labels)
 * and GitHub projects when no template project is configured.
 */
export const BOARD_TEMPLATE = {
  statuses: [
    {
      role: 'blocked',
      name: 'Backlog',
      color: 'BLUE',
      description:
        'Tarefas que ainda não podem ser feitas: esperam as tarefas de "Depende de:" (o Studio move para "A fazer" quando forem entregues) ou uma decisão entre um agente e uma pessoa (campo Decisão = Aguardando decisão). Os agentes não executam este item.',
    },
    { role: 'todo', name: 'A fazer', color: 'GRAY', description: 'A tarefa foi registrada, mas ainda não começou.' },
    { role: 'inProgress', name: 'Em andamento', color: 'YELLOW', description: 'Existe alguém trabalhando na tarefa.' },
    { role: 'review', name: 'Em validação', color: 'PURPLE', description: 'O trabalho foi realizado e aguarda revisão ou aprovação.' },
    {
      role: 'homologation',
      name: 'Em homologação',
      color: 'ORANGE',
      description: 'Publicado em homologação; aguarda o teste da funcionalidade completa.',
    },
    { role: 'done', name: 'Concluído', color: 'GREEN', description: 'O critério de conclusão foi atendido e a entrega foi validada.' },
  ] satisfies TemplateStatus[],
  fields: [
    {
      name: 'Área',
      options: [
        { name: 'Documentação', color: 'GRAY', description: 'Requisitos, regras de negócio, decisões e documentação do produto.' },
        { name: 'Frontend', color: 'BLUE', description: 'Interface, navegação e interação do usuário com a aplicação.' },
        { name: 'Backend', color: 'PURPLE', description: 'APIs, regras de negócio, dados e integrações no servidor.' },
      ],
    },
    {
      name: 'Prioridade',
      options: [
        { name: 'P0 - Crítica', color: 'RED', description: 'Incidente grave ou risco imediato a dados, segurança ou operação essencial.' },
        { name: 'P1 - Alta', color: 'ORANGE', description: 'Essencial para a próxima entrega ou para desbloquear trabalho prioritário.' },
        { name: 'P2 - Média', color: 'YELLOW', description: 'Trabalho necessário no planejamento normal, sem urgência imediata.' },
        { name: 'P3 - Baixa', color: 'GREEN', description: 'Trabalho adiável, de menor impacto e sem bloquear a entrega.' },
      ],
    },
    {
      name: 'Tipo',
      options: [
        { name: 'Nova funcionalidade', color: 'GREEN', description: 'Implementação de uma capacidade que ainda não existe no produto.' },
        { name: 'Bug', color: 'RED', description: 'Correção de comportamento que diverge do esperado e aprovado.' },
        { name: 'Melhoria', color: 'BLUE', description: 'Evolução de uma funcionalidade existente para aumentar seu valor ou qualidade.' },
        { name: 'Refatoração', color: 'ORANGE', description: 'Reorganização interna do código sem alterar o comportamento esperado.' },
        { name: 'Configuração técnica', color: 'PURPLE', description: 'Preparação ou ajuste de dependências, ambiente, build e CI/CD.' },
        { name: 'Documentação', color: 'GRAY', description: 'Criação ou atualização de documentação como entrega principal.' },
      ],
    },
    {
      name: 'Decisão',
      options: [
        {
          name: 'Aguardando decisão',
          color: 'RED',
          description: 'A tarefa espera uma decisão a tomar entre um agente e uma pessoa. Decidida, o campo é limpo.',
        },
      ],
    },
  ] satisfies { name: string; options: TemplateOption[] }[],
  shortDescription: 'Quadro de tarefas do workspace, acompanhado pelo Agents Manager Studio.',
  readme: `# Quadro de tarefas

Cada issue permanece no repositório responsável pela entrega e é acompanhada neste quadro.

## Fluxo

A fazer → Em andamento → Em validação → Concluído. Mova para Concluído somente após verificar o critério de conclusão.

## Descrição da tarefa

### Objetivo
O que precisa ser feito?

### Critério de conclusão
Como verificar que ficou pronto?

### Referências
Links de protótipo, documento, PR e tarefas relacionadas.

## Prioridade

- P0 - Crítica: incidente grave, risco imediato a dados ou segurança. Uso excepcional.
- P1 - Alta: essencial para a próxima entrega ou desbloqueia trabalho prioritário.
- P2 - Média: trabalho necessário no planejamento normal.
- P3 - Baixa: benefício menor ou adiável.

## Backlog

Tarefas que ainda não podem ser feitas ficam no Backlog, e os agentes não as executam:
- com a linha "Depende de:", esperam essas tarefas; o Studio as move para "A fazer" quando todas forem entregues;
- com o campo Decisão = "Aguardando decisão", esperam uma decisão entre um agente e uma pessoa; decidida, o campo é limpo
  e o card vai para onde a decisão levar.
`,
};

/** Body pre-filled for new tasks, following the template README. */
export const TASK_BODY_TEMPLATE = `### Objetivo

### Critério de conclusão

### Referências
`;

/** GitLab has no single-select fields: statuses and fields become "Prefix: value" labels. */
export const GITLAB_STATUS_PREFIX = 'Status: ';

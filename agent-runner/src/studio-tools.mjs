// Studio tools offered to the agent as an in-process MCP server ("studio").
// Each tool forwards to the Studio server, which runs it with the workspace credentials:
// tokens never enter the container.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/**
 * @param {(name: string, args: object) => Promise<{ ok: boolean, data?: unknown, error?: string }>} call
 * @param {string[]} groups enabled groups: "board" (read and write), "board_read", "result", "studio" (Órbi)
 */
export function createStudioTools(call, groups) {
  const run = (name) => async (args) => {
    const response = await call(name, args);
    if (!response.ok) return { ...asText({ erro: response.error }), isError: true };
    return asText(response.data);
  };

  const tools = [];
  if (groups.includes('result')) {
    tools.push(
      tool(
        'report_result',
        'Registra o resultado final do seu trabalho para o Studio (e para o próximo agente do workflow). Chame uma vez, ao terminar.',
        {
          status: z.enum(['success', 'failure']).describe('success quando o objetivo foi cumprido; failure quando não foi (ex.: testes falharam).'),
          summary: z.string().describe('Resumo claro do resultado, em português.'),
          details: z.string().optional().describe('Detalhes úteis para quem continuar o trabalho (ex.: falhas encontradas e onde).'),
        },
        run('report_result'),
      ),
    );
  }

  const boardRead = groups.includes('board') || groups.includes('board_read');
  if (boardRead) {
    tools.push(
      tool(
        'board_list_tasks',
        'Lista as tarefas do quadro do workspace, com colunas, campos e repositórios disponíveis.',
        {
          column: z.string().optional().describe('Nome da coluna (ex.: "A fazer").'),
          search: z.string().optional().describe('Texto para filtrar por título ou descrição.'),
          limit: z.number().int().optional(),
        },
        run('board_list_tasks'),
      ),
      tool('board_get_task', 'Mostra uma tarefa do quadro com a descrição completa.', { id: z.string() }, run('board_get_task')),
    );
  }
  if (groups.includes('board')) {
    tools.push(
      tool(
        'board_create_task',
        'Cria uma tarefa (issue) no quadro do workspace. Use o modelo de descrição do quadro: Objetivo, Critério de conclusão e Referências.',
        {
          title: z.string(),
          body: z.string().describe('Descrição em Markdown.'),
          repository: z.string().optional().describe('Repositório ou projeto onde a tarefa será feita (veja board_list_tasks).'),
          column: z.string().optional().describe('Coluna inicial; vazio usa a padrão.'),
          fields: z.record(z.string(), z.string()).optional().describe('Campos pelo nome, ex.: {"Tipo": "Bug", "Prioridade": "P2 - Média"}.'),
        },
        run('board_create_task'),
      ),
      tool(
        'board_update_task',
        'Move uma tarefa de coluna, altera seus campos e/ou reescreve título e descrição.',
        {
          id: z.string(),
          title: z.string().optional().describe('Novo título (vazio mantém o atual).'),
          body: z.string().optional().describe('Nova descrição completa, em Markdown (substitui a atual).'),
          column: z.string().optional(),
          fields: z.record(z.string(), z.string()).optional(),
        },
        run('board_update_task'),
      ),
    );
  }

  if (groups.includes('studio')) {
    tools.push(
      tool(
        'studio_context',
        'Mostra o workspace: projetos, quadro (colunas, campos e opções com ids), Render, agentes e workflows com todos os campos.',
        {},
        run('studio_context'),
      ),
      tool(
        'studio_list_runs',
        'Lista as execuções recentes de workflows, com o estado de cada passo, erros e resumos.',
        { workflowId: z.string().optional(), limit: z.number().int().optional() },
        run('studio_list_runs'),
      ),
      tool(
        'studio_list_executions',
        'Lista as execuções recentes de agentes (opcionalmente de um agente do workspace ou de um status).',
        { agentId: z.string().optional().describe('Id do agente do workspace.'), status: z.string().optional(), limit: z.number().int().optional() },
        run('studio_list_executions'),
      ),
      tool(
        'studio_get_execution',
        'Mostra uma execução com o resultado, o erro e o final da linha do tempo, para explicar o que aconteceu.',
        { id: z.string() },
        run('studio_get_execution'),
      ),
      tool('studio_usage', 'Mostra o consumo do Claude no workspace: limites do plano, custo estimado e tokens.', {}, run('studio_usage')),
      tool(
        'studio_propose',
        'Propõe uma mudança ao usuário (ele vê um cartão e decide se aplica). O Studio valida antes; se vier erro, corrija o payload.',
        {
          kind: z.enum([
            'create_agent',
            'update_agent',
            'delete_agent',
            'create_workflow',
            'update_workflow',
            'delete_workflow',
            'start_workflow',
            'cancel_run',
            'create_task',
          ]),
          summary: z.string().describe('Uma frase dizendo o que a proposta faz, para o cartão.'),
          payload: z.record(z.string(), z.unknown()).describe('Dados da mudança, no formato descrito nas suas instruções.'),
        },
        run('studio_propose'),
      ),
    );
  }

  return tools.length > 0 ? createSdkMcpServer({ name: 'studio', version: '1.0.0', tools }) : null;
}

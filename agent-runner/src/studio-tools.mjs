// Studio tools offered to the agent as an in-process MCP server ("studio").
// Each tool forwards to the Studio server, which runs it with the workspace credentials:
// tokens never enter the container.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/**
 * @param {(name: string, args: object) => Promise<{ ok: boolean, data?: unknown, error?: string }>} call
 * @param {string[]} groups enabled groups: "board", "result"
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

  if (groups.includes('board')) {
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
        'Move uma tarefa de coluna e/ou altera seus campos.',
        {
          id: z.string(),
          column: z.string().optional(),
          fields: z.record(z.string(), z.string()).optional(),
        },
        run('board_update_task'),
      ),
    );
  }

  return tools.length > 0 ? createSdkMcpServer({ name: 'studio', version: '1.0.0', tools }) : null;
}

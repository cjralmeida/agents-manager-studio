# Agents Manager Studio

Gerenciador pessoal de agentes de programação, organizado por workspaces (pastas de `D:\Projetos`).

## Serviços

| URL | Serviço |
|---|---|
| http://studio.localhost | UI (`ui/`, React + Vite) |
| http://studio.localhost/api | Server (`server/`, Fastify + Prisma) |
| http://n8n.localhost | n8n |

Todos passam pelo proxy Caddy (`infra/proxy/Caddyfile`) na porta 80. O Postgres guarda os bancos `studio` e `n8n`.

## Primeira execução

```sh
cp .env.example .env   # preencha os valores
docker compose up -d --build
```

## Desenvolvimento (hot reload)

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Server e UI rodam a partir do código-fonte montado no container; edições no Windows recarregam sozinhas (via polling).

Migrations (com o modo dev rodando):

```sh
docker compose exec server npx prisma migrate dev --name <descricao>
```

## Estrutura

```
infra/      proxy (Caddyfile) e scripts de init do Postgres
server/     backend: src/modules/<modulo>/routes.ts + service.ts, prisma/
ui/         frontend: src/api, src/components, src/pages
```

## Quadro de tarefas

Cada workspace pode vincular um quadro próprio (aba **Quadro**):

- **GitHub:** um GitHub Project (v2). O token fine-grained da conta precisa de *Projects: leitura e escrita* na organização e *Issues: leitura e escrita* nos repositórios.
- **GitLab:** um board de grupo. As colunas são labels `Status: …` e os campos são labels `Campo: valor`. "A fazer" corresponde às issues abertas sem coluna, e "Concluído" às fechadas.

Se o Studio não encontrar um quadro, ele pode criar um no estilo do template (`server/src/modules/boards/template.ts`). No GitHub, ele copia o projeto-modelo definido em Configurações → Git, quando houver.

Ao lançar um agente a partir de um card:

1. a tarefa vai para a coluna de andamento;
2. o PR/MR referencia a issue com `Closes #N`;
3. a tarefa vai para validação.

Os papéis das colunas ficam em Configuração do workspace. Tarefas na coluna "bloqueada" ("Aguardando aprovação") não aceitam agentes.

## Agentes: ambiente, avisos e consumo

- **Imagem do agente** (`agent-runner/`): traz Node.js 24, Python 3 (com pip e venv), git e o Claude Code. Depois de alterá-la, reconstrua com `docker compose --profile tools build agent-runner`.
- **Notificações do navegador:** para ativar, use o botão no rodapé do menu lateral. O aviso chega quando um agente faz uma pergunta, fica pronto para revisão, abre o PR/MR ou falha, desde que o Studio esteja aberto em alguma aba e sem foco. O título da aba mostra quantos agentes aguardam você.
- **Consumo do Docker:** o Dashboard mostra memória, CPU, containers e disco. Lançar um agente pede confirmação quando a memória ou a CPU passam de `AGENT_LAUNCH_MEMORY_PERCENT` ou `AGENT_LAUNCH_CPU_PERCENT`, que por padrão são 80% e 85%.

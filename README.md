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

Depois disso, o jeito do dia a dia é o `studio.ps1` (PowerShell). Ele roda `docker compose up -d` e deixa em segundo plano o **ajudante do Windows**, que troca a pasta central quando você pede em **Configurações → Geral**:

```powershell
powershell -ExecutionPolicy Bypass -File .\studio.ps1            # sobe o Studio e o ajudante
powershell -ExecutionPolicy Bypass -File .\studio.ps1 -Install   # também inicia o ajudante com o Windows
powershell -ExecutionPolicy Bypass -File .\studio.ps1 -Uninstall # tira do Inicializar e para o ajudante
```

Use `-Dev` em todos para o modo de desenvolvimento. O `-Install` só cria um atalho na pasta Inicializar do seu usuário, sem precisar de administrador.

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

## Conectores

As ferramentas que o Studio e os agentes usam ficam em **Conectores** (menu lateral): **Claude**, **GitHub**, **GitLab** e **Render**.

- **Página Conectores:** onde você conecta as contas. No card do GitHub também fica o projeto-modelo de quadro.
- **Aba Conectores de cada workspace:** onde você escolhe quais contas os agentes daquele workspace usam, vincula o quadro de tarefas, escolhe a conta do Render e o serviço de cada projeto.
- **Aba Configuração do workspace:** só o que é do próprio workspace: skills, comportamento do quadro (intervalo e papéis das colunas) e copiar a configuração para outros workspaces.

## Workspaces

Cada pasta da **pasta central** (`PROJECTS_HOST_DIR` no `.env`) é um workspace.

- **Criar um workspace:** use **Novo workspace** na página Workspaces. O Studio cria a pasta e a registra. Depois coloque ou clone os projetos dentro dela e clique em "Reler diretório".
- **Clonar um repositório:** use **Clonar repositório** na aba Projetos do workspace.
  - Escolha o repositório na lista das contas git do workspace (no GitLab, a busca é pelo nome do projeto) ou cole a URL, https ou ssh.
  - Os privados usam o token da conta apenas durante o clone; o `origin` fica com a URL sem credenciais.
  - O clone roda em segundo plano, e o projeto aparece sozinho quando termina.
- **Criar um projeto do zero:** use **Novo projeto** na aba Projetos do workspace.
  - O Studio cria a pasta com git: branch `main`, um README e o primeiro commit.
  - Se você escolher uma conta GitHub/GitLab do workspace e onde criar (seu usuário, uma organização ou um grupo), ele também cria o repositório remoto (privado por padrão), liga como `origin` sem credenciais e faz o push.
  - O nome do repositório vem do nome da pasta, sem acentos e com `-` no lugar de espaços. O token precisa do escopo `repo` no GitHub (ou "Administration: write" num token fine-grained) e `api` no GitLab.
- **Permissões:** o Studio só escreve na pasta central, porque ela é montada com escrita no server, e não no disco inteiro.
- **Trocar a pasta central:** em **Configurações → Geral**, informe a pasta (e as pastas ignoradas) e clique em aplicar. O ajudante do Windows (`studio.ps1`) confere se a pasta existe e não é a raiz de um disco nem pasta do sistema, atualiza o `.env` e recria o server. Enquanto isso, o Studio mostra uma tela de espera e relê os workspaces quando volta. Sem o ajudante rodando, a tela mostra o comando para colar no PowerShell. Pedidos, estado e log do ajudante ficam em `host-helper/`, que não é versionada.

## Quadro de tarefas

Cada workspace pode vincular um quadro próprio (aba **Quadro**):

- **GitHub:** um GitHub Project (v2). O token fine-grained da conta precisa de *Projects: leitura e escrita* na organização e *Issues: leitura e escrita* nos repositórios.
- **GitLab:** um board de grupo. As colunas são labels `Status: …` e os campos são labels `Campo: valor`. "A fazer" corresponde às issues abertas sem coluna, e "Concluído" às fechadas.

**Modelo de quadro:** em **Quadro de tarefas → Modelo** fica a estrutura que vale para todos os workspaces: colunas, com o papel de cada uma para os agentes, e campos de escolha com suas opções. O primeiro modelo é o template do Studio (`server/src/modules/boards/template.ts`).
- O editor é visual: as colunas ficam lado a lado e se arrastam pelo ⠿, e cada coluna ou opção tem cor e descrição. Os papéis "A fazer" e "Concluído" são obrigatórios.
- **Revisar mudanças** mostra o que vai mudar e pede para onde vão os cards das colunas removidas. Ao salvar, a mudança é aplicada em todos os quadros que estão no modelo, e o resultado de cada um aparece na tela.
- Renomear mantém os cards na coluna ou opção. No GitHub, o ID da opção é preservado; no GitLab, o label é renomeado.

**Quadros dos workspaces:**
- **Criar um quadro:** ele já nasce no modelo. No GitHub, usa o projeto-modelo de Conectores, quando houver, pelas visões, e aplica o modelo por cima.
- **Vincular um quadro existente:** ele aparece como "não convertido". **Converter para o modelo** mostra a que coluna, campo e opção do modelo corresponde cada parte do quadro, com sugestões pelo nome. O que corresponde é renomeado, o que falta é criado e o resto é removido no provedor, depois de mover os cards.
- **Mudanças feitas direto no GitHub/GitLab:** a leitura periódica marca o quadro como "fora do modelo". Nada é desfeito sozinho; **Sincronizar com o modelo** abre a mesma tela de conversão.
- **No GitLab**, as colunas do modelo com papel "A fazer" e "Concluído" são as issues abertas sem coluna e as fechadas. A ordem dos campos segue o modelo.
- **Um quadro só pode estar vinculado a um workspace.**

Ao lançar um agente a partir de um card:

1. a tarefa vai para a coluna de andamento;
2. o PR/MR referencia a issue com `Closes #N`;
3. a tarefa vai para validação.

Os papéis das colunas ficam em Configuração do workspace. Tarefas na coluna "bloqueada" ("Aguardando aprovação") não aceitam agentes.

## Agentes: ambiente, avisos e consumo

- **Imagem do agente** (`agent-runner/`): traz Node.js 24, Python 3 (com pip e venv), git e o Claude Code. Depois de alterá-la, reconstrua com `docker compose --profile tools build agent-runner`.
- **Notificações do navegador:** para ativar, use o botão no rodapé do menu lateral. O aviso chega quando um agente faz uma pergunta, fica pronto para revisão, abre o PR/MR ou falha, desde que o Studio esteja aberto em alguma aba e sem foco. O título da aba mostra quantos agentes aguardam você.
- **Consumo do Studio no Docker:** o Dashboard mostra memória, CPU, containers e disco, considerando só os serviços do Studio e os agentes. Lançar um agente pede confirmação quando a memória ou a CPU passam de `AGENT_LAUNCH_MEMORY_PERCENT` ou `AGENT_LAUNCH_CPU_PERCENT`, que por padrão são 80% e 85%.
- **Consumo do Claude:** o Dashboard mostra, por conta Claude, as janelas do plano: a sessão de 5 horas e a semanal, em %, com o horário em que reiniciam. Essas janelas vêm junto de cada requisição dos agentes, e o botão "Atualizar" faz uma chamada mínima com o Haiku para lê-las.
- **Uso dos agentes:** o Dashboard mostra tokens e custo estimado, que é o preço de API e não é cobrado no plano Max. Há totais de hoje, 7 e 30 dias, um gráfico dos últimos 14 dias e rankings por workspace, por modelo e por agente. O histórico continua depois que o agente é excluído.
- **Dashboard por workspace** (aba Dashboard do workspace): é o mesmo dashboard do geral, mas restrito ao workspace.
  - Mostra os agentes, o consumo do Claude, os containers dos agentes e o disco usado pelas cópias dos projetos e pelas sessões dos agentes.
  - Os serviços do Studio são compartilhados e aparecem só no geral.
  - As janelas do plano são da conta Claude inteira.

## Agentes do workspace

Os agentes fixos ficam na aba **Agentes** do workspace. Cada um tem:

- um papel com instruções, que vão para o prompt de sistema;
- um modelo;
- os projetos em que trabalha. Sem projeto, ele trabalha sem repositório;
- o tipo de entrega: código (commit + PR/MR) ou resultado;
- acesso opcional ao quadro de tarefas;
- a opção de concluir sozinho.

Pelo quadro, os agentes usam ferramentas do Studio via MCP: `board_list_tasks`, `board_get_task`, `board_create_task`, `board_update_task` e `report_result`. Quem executa essas ferramentas é o server, então os tokens nunca entram nos containers.

## Workflows

Os workflows ficam na aba **Workflows** do workspace. Um workflow tem um **gatilho** e uma sequência de **passos**, e cada passo recebe o resultado do anterior.

- **Gatilhos:**
  - uma mensagem sua, como uma conversa no Studio;
  - uma tarefa que aparece no quadro e bate com os filtros (coluna, campos, repositório, sem responsável).
- **Passos:**
  - **Agente**, com estas opções:
    - "para cada tarefa criada pelo passo anterior": uma linha por tarefa, por padrão uma de cada vez;
    - "continuar do trabalho do passo anterior": começa da cópia e da branch do agente anterior;
    - "se falhar, devolver para o passo X", até N tentativas.
  - **Deploy (Render):** faz o merge do PR/MR e publica o serviço do projeto, por padrão em homologação.
- **Autonomia:** tudo segue sozinho. As perguntas dos agentes continuam esperando a sua resposta.
- **Pausas:** os workflows pausam quando a janela de 5 horas do Claude passa de `WORKFLOW_PLAN_LIMIT_PERCENT` (padrão 80%) ou quando o Docker está no limite.
- **Atualização dos quadros:** o server lê os quadros a cada 2 minutos. Isso é configurável de 1 a 15 minutos.
- **Retomada:** tudo fica no banco, então os workflows continuam de onde pararam quando o Studio reinicia.
- **Base das cópias:** as cópias novas partem da versão mais recente da branch base no remoto, para que cada tarefa enxergue o que as anteriores já publicaram.

## Órbi (assistente)

O **Órbi** é o assistente do Studio. Ele abre pelo botão no canto inferior direito, em qualquer tela, e sabe em que workspace e página você está.

- **O que ele faz:** monta agentes e workflows a partir de uma descrição, explica falhas de execuções e responde sobre consumo.
- **Leitura:** é livre.
- **Mudanças:** toda mudança vira uma **proposta** num cartão com **Aplicar** e **Descartar**. Os tipos de proposta são: criar, alterar ou excluir agentes e workflows; iniciar workflows; cancelar execuções; e criar tarefas. O Studio valida a proposta com as mesmas regras dos formulários, antes de mostrá-la e de novo ao aplicar.
- **Limites:** ele não vê tokens nem mexe em contas.
- **Como funciona por dentro:** é uma conversa no mesmo runner dos agentes, com ferramentas próprias (`studio_*`). As instruções dele estão em `server/src/modules/assistant/guide.ts`. As conversas ficam por workspace e não aparecem entre as execuções.

## Deploy (Render)

1. Em **Conectores → Render**, adicione uma conta com a chave de API do Render. Ela fica criptografada e nunca vai para os agentes. Uma conta pode servir a vários workspaces.
2. Em **Conectores do workspace → Render**, escolha a conta.
3. Na mesma tela, escolha o serviço de **homologação** e, se houver, o de **produção** de cada projeto.

Um deploy faz o merge do PR/MR do agente, quando houver um, e dispara o serviço de homologação. Um monitor acompanha o deploy até ficar no ar ou falhar, mesmo depois de um reinício. O Dashboard do workspace mostra os últimos deploys. `RENDER_API_URL` existe só para testes.

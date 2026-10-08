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

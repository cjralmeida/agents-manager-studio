import { createHmac } from 'node:crypto';
import net from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { prisma } from '../../db.js';

/**
 * Throwaway services for the tests of agents that work on a repository: an empty PostgreSQL database with its own
 * login (no access to the Studio database or to other agents' databases) and a Redis database index. The password
 * is derived from the Studio key, so a resumed agent gets the same URL without storing it. Both are wiped when the
 * agent finishes.
 */

const DB_PREFIX = 'ams_test_';
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const REDIS_DATABASES = 15; // indexes 1..15; 0 stays unused
const JANITOR_MS = 10 * 60_000;

export const testDatabaseName = (agentId: string) => `${DB_PREFIX}${agentId.replaceAll('-', '')}`;

/** Hex only, so it is safe inside SQL and URLs. */
const testDatabasePassword = (agentId: string) => createHmac('sha256', config.encryptionKey).update(`test-db:${agentId}`).digest('hex').slice(0, 32);

function agentIdOf(databaseName: string) {
  const hex = databaseName.slice(DB_PREFIX.length);
  return /^[0-9a-f]{32}$/.test(hex) ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null;
}

async function exists(query: string, value: string) {
  return (await prisma.$queryRawUnsafe<unknown[]>(query, value)).length > 0;
}

/** Creates (once) the agent's database and login; returns the URL the agent's tests use. */
export async function ensureTestDatabase(agentId: string) {
  const name = testDatabaseName(agentId);
  const password = testDatabasePassword(agentId);
  if (!(await exists('SELECT 1 FROM pg_roles WHERE rolname = $1', name))) {
    await prisma.$executeRawUnsafe(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}'`);
  }
  if (!(await exists('SELECT 1 FROM pg_database WHERE datname = $1', name))) {
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${name}" OWNER "${name}"`);
    await prisma.$executeRawUnsafe(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);
  }
  return `postgresql://${name}:${password}@${config.testDatabaseHost}:5432/${name}`;
}

export async function dropTestDatabase(agentId: string) {
  const name = testDatabaseName(agentId);
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${name}"`);
}

/** Redis database index of the agent: the lowest one no other unfinished agent holds. */
export async function ensureTestRedis(agentId: string) {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId }, select: { testRedisDb: true } });
  let index = agent.testRedisDb;
  if (index === null) {
    const taken = await prisma.agent.findMany({
      where: { testRedisDb: { not: null }, status: { notIn: [...TERMINAL] as never[] } },
      select: { testRedisDb: true },
    });
    const used = new Set(taken.map((entry) => entry.testRedisDb));
    index = Array.from({ length: REDIS_DATABASES }, (_, offset) => offset + 1).find((candidate) => !used.has(candidate)) ?? null;
    if (index === null) return null;
    await prisma.agent.update({ where: { id: agentId }, data: { testRedisDb: index } });
  }
  return `redis://${config.testRedisHost}:6379/${index}`;
}

/** SELECT + FLUSHDB over the Redis protocol (no client library needed for two commands). */
function flushRedisDatabase(index: number) {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: config.testRedisHost, port: 6379 });
    const command = (...parts: string[]) => `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`;
    let replies = '';
    socket.setTimeout(5_000, () => socket.destroy(new Error('Redis não respondeu.')));
    socket.on('connect', () => socket.write(command('SELECT', String(index)) + command('FLUSHDB')));
    socket.on('data', (chunk) => {
      replies += chunk.toString();
      if ((replies.match(/\r\n/g) ?? []).length >= 2) {
        socket.end();
        replies.includes('-ERR') ? reject(new Error(replies.trim())) : resolve();
      }
    });
    socket.on('error', reject);
  });
}

/** Env for the agent container: only agents that work on a repository get test services. */
export async function testServicesEnv(agentId: string, hasRepository: boolean): Promise<Record<string, string>> {
  if (!hasRepository) return {};
  const env: Record<string, string> = { TEST_DATABASE_URL: await ensureTestDatabase(agentId) };
  const redis = await ensureTestRedis(agentId).catch(() => null);
  if (redis) env.TEST_REDIS_URL = redis;
  return env;
}

/** Nobody but the Studio connects to its own databases (agents share the network with Postgres). */
export async function lockDownStudioDatabases() {
  const databases = await prisma.$queryRawUnsafe<{ datname: string }[]>(
    `SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT LIKE '${DB_PREFIX}%' AND datname <> 'postgres'`,
  );
  for (const { datname } of databases) await prisma.$executeRawUnsafe(`REVOKE CONNECT ON DATABASE "${datname.replaceAll('"', '""')}" FROM PUBLIC`);
}

/** Drops the test database and clears the Redis index of agents that finished (or no longer exist). */
export async function cleanupTestServices(log?: FastifyBaseLogger) {
  const databases = await prisma.$queryRawUnsafe<{ datname: string }[]>(`SELECT datname FROM pg_database WHERE datname LIKE '${DB_PREFIX}%'`);
  for (const { datname } of databases) {
    const agentId = agentIdOf(datname);
    const agent = agentId ? await prisma.agent.findUnique({ where: { id: agentId }, select: { status: true } }) : null;
    if (agentId && agent && !TERMINAL.has(agent.status)) continue;
    await dropTestDatabase(agentId ?? datname.slice(DB_PREFIX.length)).catch((err: unknown) => log?.warn({ err, datname }, 'Test database cleanup failed'));
  }
  const finished = await prisma.agent.findMany({
    where: { testRedisDb: { not: null }, status: { in: [...TERMINAL] as never[] } },
    select: { id: true, testRedisDb: true },
  });
  for (const agent of finished) {
    try {
      await flushRedisDatabase(agent.testRedisDb!);
      await prisma.agent.update({ where: { id: agent.id }, data: { testRedisDb: null } });
    } catch (err) {
      log?.warn({ err, agentId: agent.id }, 'Test Redis cleanup failed');
    }
  }
}

export function startTestServicesJanitor(log: FastifyBaseLogger) {
  const run = () => void cleanupTestServices(log).catch((err: unknown) => log.error({ err }, 'Test services janitor failed'));
  void lockDownStudioDatabases().catch((err: unknown) => log.error({ err }, 'Could not restrict access to the Studio databases'));
  run();
  const timer = setInterval(run, JANITOR_MS);
  return () => clearInterval(timer);
}

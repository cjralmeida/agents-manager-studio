import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { runOnce } from '../../lib/docker.js';
import { workdirHostPath, workdirPath } from './workdir.js';

/**
 * Projects whose tests need the database structure (e.g. GlobalFarm: a pg_dump of the schema plus the Flyway history,
 * because the migrations do not build the database from scratch) keep it in `docker/db/baseline/*.sql`. Applying it
 * takes minutes, so the Studio applies it once per baseline version into a template database and every agent's test
 * database is a copy of that template (seconds).
 */

const BASELINE_DIR = 'docker/db/baseline';
const TEMPLATE_PREFIX = 'ams_tpl_';
/** Same major as the Studio's Postgres: the dumps use psql 17.6+ commands (\restrict). */
const PSQL_IMAGE = 'postgres:17.6-alpine';
const creating = new Map<string, Promise<string | null>>();

/** Superuser connection to a database of the Studio's Postgres, as seen from the agents' network. */
function superuserUrl(database: string) {
  const url = new URL(config.databaseUrl);
  url.hostname = config.testDatabaseHost;
  url.port = '5432';
  url.pathname = `/${database}`;
  url.search = '';
  return url.toString();
}

async function psql(database: string, args: string[], binds: string[] = [], timeoutMs = 15 * 60_000) {
  return runOnce({
    image: PSQL_IMAGE,
    cmd: ['psql', '-q', '-X', superuserUrl(database), ...args],
    binds,
    network: config.agentNetwork,
    timeoutMs,
  });
}

async function databaseExists(name: string) {
  return (await prisma.$queryRawUnsafe<unknown[]>('SELECT 1 FROM pg_database WHERE datname = $1', name)).length > 0;
}

/** The baseline files of the agent's copy, in order, or null when the project has none. */
async function baselineFiles(workdir: string) {
  const dir = path.posix.join(workdirPath(workdir), BASELINE_DIR);
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.sql')).sort();
  return names.length > 0 ? { dir, names } : null;
}

/** Template database with the agent's baseline applied (created once per baseline version), or null. */
export async function baselineTemplate(agent: { workdir: string }) {
  const files = await baselineFiles(agent.workdir);
  if (!files) return null;
  const hash = createHash('sha256');
  for (const name of files.names) hash.update(name).update(await readFile(path.posix.join(files.dir, name)));
  const template = `${TEMPLATE_PREFIX}${hash.digest('hex').slice(0, 16)}`;
  if (await databaseExists(template)) return template;

  const pending = creating.get(template);
  if (pending) return pending;
  const work = (async () => {
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${template}"`);
    // Without ON_ERROR_STOP: a dump may name roles or extensions this Postgres does not have; the structure still loads.
    const result = await psql(
      template,
      files.names.flatMap((name) => ['-f', `/baseline/${name}`]),
      [`${workdirHostPath(agent.workdir)}/${BASELINE_DIR}:/baseline:ro`],
    );
    const tables = await psql(template, ['-At', '-c', "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"], [], 60_000);
    if (result.timedOut || Number(tables.stdout.trim()) === 0) {
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
      return null;
    }
    await prisma.$executeRawUnsafe(`ALTER DATABASE "${template}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
    return template;
  })().finally(() => creating.delete(template));
  creating.set(template, work);
  return work;
}

/** Hands every object of a database copied from a template over to the agent's login (they belong to the superuser). */
export async function giveOwnership(database: string, role: string) {
  const sql = `DO $$
DECLARE r record;
BEGIN
  EXECUTE format('ALTER SCHEMA public OWNER TO %I', '${role}');
  FOR r IN SELECT c.oid::regclass AS name, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))
  LOOP
    BEGIN EXECUTE format('ALTER TABLE %s OWNER TO %I', r.name, '${role}'); EXCEPTION WHEN others THEN NULL; END;
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    BEGIN EXECUTE format('ALTER ROUTINE %s OWNER TO %I', r.name, '${role}'); EXCEPTION WHEN others THEN NULL; END;
  END LOOP;
END $$;`;
  await psql(database, ['-c', sql], [], 5 * 60_000);
}

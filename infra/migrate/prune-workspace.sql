-- Leaves only one workspace (and its owner) in a COPY of the Studio database. Never run it on the live database:
-- export-workspace.sh restores a dump into a throwaway database, runs this there and dumps the result.
-- Usage: psql -v ws=Celcode -f prune-workspace.sql
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE keep_ws AS SELECT id, owner_id FROM workspaces WHERE name = :'ws';
DO $$ BEGIN
  IF (SELECT count(*) FROM keep_ws) <> 1 THEN RAISE EXCEPTION 'workspace not found'; END IF;
END $$;

-- 1. Rows of the other workspaces: every table with a workspace_id column (some have no foreign key to cascade).
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'workspace_id' AND table_name <> 'workspaces'
  LOOP
    EXECUTE format('DELETE FROM %I WHERE workspace_id IS NOT NULL AND workspace_id NOT IN (SELECT id FROM keep_ws)', t);
  END LOOP;
END $$;
DELETE FROM workspaces WHERE id NOT IN (SELECT id FROM keep_ws);

-- 2. Accounts the kept workspace does not use (they belong to the owner, not to a workspace).
DELETE FROM git_accounts WHERE id NOT IN (SELECT git_account_id FROM workspace_git_accounts);
DELETE FROM agent_accounts WHERE id NOT IN (SELECT agent_account_id FROM workspace_settings WHERE agent_account_id IS NOT NULL);
DELETE FROM render_accounts WHERE id NOT IN (SELECT render_account_id FROM workspace_settings WHERE render_account_id IS NOT NULL);
DELETE FROM aws_accounts WHERE id NOT IN (SELECT aws_account_id FROM workspace_settings WHERE aws_account_id IS NOT NULL);
DELETE FROM clickup_accounts WHERE id NOT IN (SELECT clickup_account_id FROM workspace_settings WHERE clickup_account_id IS NOT NULL);
DELETE FROM pixellab_accounts WHERE id NOT IN (SELECT pixellab_account_id FROM workspace_settings WHERE pixellab_account_id IS NOT NULL);

-- 3. Órbi history of other workspaces, and the pilot state (it points at conversations that stay behind).
DELETE FROM orbi_activities WHERE workspace_id IS NULL;
DELETE FROM orbi_pilot_events;
DELETE FROM user_settings WHERE key LIKE 'orbi%' OR key LIKE 'viewProfile%';

-- 4. Only the owner stays; sessions are dropped (log in again on the new machine).
DELETE FROM sessions;
DELETE FROM users WHERE id NOT IN (SELECT owner_id FROM keep_ws);

-- 5. Nothing starts by itself on the new machine: workflows and Órbi routines off; routines watch only the kept
-- workspace (an empty list means all, which there is that one).
UPDATE workflows SET is_enabled = false;
UPDATE orbi_routines
SET enabled = false,
    workspace_ids = ARRAY(SELECT unnest(workspace_ids) INTERSECT SELECT id FROM keep_ws);

COMMIT;

SELECT 'workspaces' AS what, count(*) FROM workspaces
UNION ALL SELECT 'projects', count(*) FROM projects
UNION ALL SELECT 'agents', count(*) FROM agents
UNION ALL SELECT 'workflows', count(*) FROM workflows
UNION ALL SELECT 'users', count(*) FROM users;

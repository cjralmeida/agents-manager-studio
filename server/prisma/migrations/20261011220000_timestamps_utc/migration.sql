-- The Studio sent UTC timestamps without an offset, and the sessions read them in the database's default time zone
-- (e.g. America/Sao_Paulo), so every stored instant was off by that zone's offset. From now on the Studio connects in
-- UTC (src/db.ts) and the database defaults to UTC; this moves the existing values to the real instant.
DO $$
DECLARE
  zone text := current_setting('TimeZone');
  col record;
BEGIN
  IF zone NOT IN ('UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Z') THEN
    FOR col IN
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'timestamp with time zone' AND table_name <> '_prisma_migrations'
    LOOP
      EXECUTE format('UPDATE %I SET %I = (%I AT TIME ZONE %L) AT TIME ZONE ''UTC'' WHERE %I IS NOT NULL',
        col.table_name, col.column_name, col.column_name, zone, col.column_name);
    END LOOP;
  END IF;
  EXECUTE format('ALTER DATABASE %I SET timezone TO ''UTC''', current_database());
END $$;

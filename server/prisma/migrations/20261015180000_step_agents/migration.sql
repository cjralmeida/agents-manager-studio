-- Workflows now set how many agents work each step; the old "runs at the same time" becomes the agents of the first
-- step, and the other steps start with one.
UPDATE "workflows"
SET "steps" = (
  SELECT jsonb_agg(
    CASE
      WHEN step ? 'agents' THEN step
      WHEN ordinality = 1 THEN step || jsonb_build_object('agents', "workflows"."max_concurrent_runs")
      ELSE step || jsonb_build_object('agents', 1)
    END
    ORDER BY ordinality
  )
  FROM jsonb_array_elements("workflows"."steps") WITH ORDINALITY AS t(step, ordinality)
)
WHERE jsonb_typeof("steps") = 'array';

-- Migration 004: channel address scheme
--
-- Rewrites legacy `cli:<user>` addresses to the M4.5 hierarchical form
-- `channel:cli:<user>`. Three columns affected: `from` (single string),
-- `to` (JSON array), `cc` (JSON array, nullable).
--
-- Idempotent: a re-run after a successful first pass rewrites zero rows
-- because the `LIKE 'cli:%'` predicates no longer match.
--
-- Failure mode: if `to` or `cc` contains malformed JSON, `json_each`
-- raises and the migration's transaction rolls back. Fail loudly is
-- preferred to silent corruption.

-- Update `from` (single string column).
UPDATE messages
SET "from" = 'channel:' || "from"
WHERE "from" LIKE 'cli:%';

-- Update `to` (JSON array). For each row that contains at least one
-- legacy cli:* element, rebuild the array with each cli:* element
-- prefixed by 'channel:'.
UPDATE messages
SET "to" = (
  SELECT json_group_array(
    CASE WHEN value LIKE 'cli:%' THEN 'channel:' || value ELSE value END
  )
  FROM json_each(messages."to")
)
WHERE EXISTS (
  SELECT 1 FROM json_each(messages."to") WHERE value LIKE 'cli:%'
);

-- Update `cc` (JSON array, nullable).
UPDATE messages
SET cc = (
  SELECT json_group_array(
    CASE WHEN value LIKE 'cli:%' THEN 'channel:' || value ELSE value END
  )
  FROM json_each(messages.cc)
)
WHERE cc IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM json_each(messages.cc) WHERE value LIKE 'cli:%'
  );

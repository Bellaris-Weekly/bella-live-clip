-- Collapse legacy op:sequence rows, preserving the latest client sequence and
-- the first server receipt. The primary key and existing operation index stay.
WITH ranked AS (
  SELECT *,
    json_extract(context, '$.operation.id') AS operation_id,
    MIN(received_at) OVER (
      PARTITION BY source, json_extract(context, '$.operation.id')
    ) AS first_received,
    ROW_NUMBER() OVER (
      PARTITION BY source, json_extract(context, '$.operation.id')
      ORDER BY COALESCE(json_extract(context, '$.operation.sequence'), 0) DESC, received_at DESC, id DESC
    ) AS rank
  FROM logs
  WHERE json_type(context, '$.operation.id') = 'text'
    AND length(json_extract(context, '$.operation.id')) BETWEEN 1 AND 128
    AND substr(json_extract(context, '$.operation.id'), 1, 1) GLOB '[A-Za-z0-9]'
    AND json_extract(context, '$.operation.id') NOT GLOB '*[^A-Za-z0-9._:-]*'
)
INSERT INTO logs (source, id, received_at, level, event, version, message, context)
SELECT source, operation_id, received_at, level, event, version, message,
  json_set(context, '$.operation.firstReceivedAt', first_received)
FROM ranked WHERE rank = 1
ON CONFLICT(source, id) DO UPDATE SET
  received_at = excluded.received_at, level = excluded.level, event = excluded.event,
  version = excluded.version, message = excluded.message, context = excluded.context;

DELETE FROM logs
WHERE json_type(context, '$.operation.id') = 'text'
  AND length(json_extract(context, '$.operation.id')) BETWEEN 1 AND 128
  AND substr(json_extract(context, '$.operation.id'), 1, 1) GLOB '[A-Za-z0-9]'
  AND json_extract(context, '$.operation.id') NOT GLOB '*[^A-Za-z0-9._:-]*'
  AND id != json_extract(context, '$.operation.id');

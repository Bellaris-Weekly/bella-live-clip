CREATE INDEX IF NOT EXISTS logs_order ON logs (received_at DESC, source DESC, id DESC);
CREATE INDEX IF NOT EXISTS logs_operation ON logs (json_extract(context, '$.operation.id'), received_at DESC, source DESC, id DESC);
CREATE INDEX IF NOT EXISTS logs_mode ON logs (json_extract(context, '$.mode'), received_at DESC, source DESC, id DESC);

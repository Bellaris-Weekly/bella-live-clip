CREATE TABLE logs (
  source TEXT NOT NULL,
  id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('error', 'warn', 'info')),
  event TEXT NOT NULL,
  version TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT NOT NULL CHECK (json_valid(context)),
  PRIMARY KEY (source, id)
) WITHOUT ROWID;

CREATE INDEX logs_received_at ON logs (received_at);
CREATE INDEX logs_source_received_at ON logs (source, received_at);

-- Runtime state required by the initial MVP implementation.  The canonical
-- relational migration (001) remains independently applicable and is applied
-- before this additive migration.
CREATE TABLE IF NOT EXISTS trust_layer_runtime_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trust_layer_oauth_runtime_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

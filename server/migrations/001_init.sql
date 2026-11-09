-- Nexo: esquema inicial
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE devices (
  id           text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{8}$'),
  public_key   bytea NOT NULL UNIQUE CHECK (length(public_key) = 32),
  fingerprint  text NOT NULL,
  name         text NOT NULL DEFAULT '',
  os           text NOT NULL DEFAULT '',
  app_version  text NOT NULL DEFAULT '',
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE INDEX devices_user_idx ON devices (user_id);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY,
  viewer_id    text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  host_id      text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  viewer_name  text NOT NULL DEFAULT '',
  host_name    text NOT NULL DEFAULT '',
  mode         text NOT NULL CHECK (mode IN ('attended','unattended')),
  status       text NOT NULL CHECK (status IN ('pending','active','rejected','cancelled','timeout','ended')),
  permissions  jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz,
  ended_at     timestamptz,
  duration_sec integer,
  end_reason   text
);
CREATE INDEX sessions_viewer_idx ON sessions (viewer_id, created_at DESC);
CREATE INDEX sessions_host_idx   ON sessions (host_id, created_at DESC);
CREATE INDEX sessions_open_idx   ON sessions (status) WHERE status IN ('pending','active');

CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  event          text NOT NULL,
  actor_device   text,
  actor_user     uuid,
  subject_device text,
  session_id     uuid,
  ip             text,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_actor_idx   ON audit_log (actor_device, at DESC);
CREATE INDEX audit_subject_idx ON audit_log (subject_device, at DESC);
CREATE INDEX audit_session_idx ON audit_log (session_id);
CREATE INDEX audit_user_idx    ON audit_log (actor_user, at DESC);

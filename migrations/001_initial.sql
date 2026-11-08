CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  display_name VARCHAR(40) NOT NULL,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  is_test_host BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  code VARCHAR(8) UNIQUE NOT NULL,
  owner_id TEXT NOT NULL REFERENCES participants(id),
  title VARCHAR(40) NOT NULL,
  location VARCHAR(100) NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  time_zone TEXT NOT NULL,
  registration_closes_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','finalized')),
  seed TEXT NOT NULL,
  management_hash TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  finalized_at TIMESTAMPTZ,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(end_at > start_at)
);
CREATE INDEX events_due ON events(status,registration_closes_at);
CREATE INDEX events_expiry ON events(end_at);
CREATE TABLE event_members (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  display_name VARCHAR(40) NOT NULL,
  name_key TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(event_id,participant_id),
  UNIQUE(event_id,name_key)
);
CREATE TABLE event_grants (
  token_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  PRIMARY KEY(token_hash,event_id),
  FOREIGN KEY(event_id,participant_id) REFERENCES event_members(event_id,participant_id) ON DELETE CASCADE
);
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  name VARCHAR(50) NOT NULL,
  capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 100),
  description VARCHAR(500) NOT NULL DEFAULT '',
  difficulty VARCHAR(20) NOT NULL DEFAULT '',
  position BIGSERIAL NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(event_id,id),
  FOREIGN KEY(event_id,host_id) REFERENCES event_members(event_id,participant_id) ON DELETE CASCADE
);
CREATE INDEX games_event_order ON games(event_id,position);
CREATE TABLE registrations (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  primary_game_id TEXT NOT NULL,
  final_game_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('attendee','waitlist','unassigned')),
  is_host BOOLEAN NOT NULL DEFAULT FALSE,
  allocation_reason TEXT CHECK(allocation_reason IN ('primary','balanced')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(event_id,participant_id),
  FOREIGN KEY(event_id,participant_id) REFERENCES event_members(event_id,participant_id) ON DELETE CASCADE,
  FOREIGN KEY(event_id,primary_game_id) REFERENCES games(event_id,id) ON DELETE CASCADE,
  FOREIGN KEY(event_id,final_game_id) REFERENCES games(event_id,id) ON DELETE CASCADE,
  CHECK(NOT is_host OR status = 'attendee')
);
CREATE INDEX registrations_game_queue ON registrations(event_id,primary_game_id,status,id);

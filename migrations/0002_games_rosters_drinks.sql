-- Preserve the existing installation as its first saved game.
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'draft' CHECK(phase IN ('draft','lobby','live','paused','ended')),
  logo TEXT,
  started_at INTEGER,
  timer_started_at INTEGER,
  timer_elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK(timer_elapsed_ms >= 0),
  created TEXT NOT NULL
);
INSERT INTO games(id,name,phase,logo,started_at,timer_started_at,created)
SELECT 'default','Battle for New York',CASE phase WHEN 'setup' THEN 'draft' ELSE phase END,logo,
  CASE WHEN phase <> 'setup' THEN unixepoch() * 1000 END,
  CASE WHEN phase = 'live' THEN unixepoch() * 1000 END,
  strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM settings WHERE id=1;

-- Podium titles belong to the installation, not an individual game.
ALTER TABLE settings ADD COLUMN podium_1 TEXT NOT NULL DEFAULT '1';
ALTER TABLE settings ADD COLUMN podium_2 TEXT NOT NULL DEFAULT '2';
ALTER TABLE settings ADD COLUMN podium_3 TEXT NOT NULL DEFAULT '3';
-- SQLite cannot ADD a REFERENCES column with a non-null default to a populated
-- table. Copy these tables instead, preserving every existing row and index.
CREATE TABLE sessions_next (token TEXT PRIMARY KEY, team_id TEXT, role TEXT NOT NULL, expires INTEGER NOT NULL, game_id TEXT NOT NULL DEFAULT 'default' REFERENCES games(id));
INSERT INTO sessions_next SELECT token,team_id,role,expires,'default' FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_next RENAME TO sessions;
CREATE INDEX session_expiry ON sessions(expires);
CREATE TABLE media_next (id TEXT PRIMARY KEY, team_id TEXT, kind TEXT NOT NULL, mime TEXT NOT NULL, created TEXT NOT NULL, game_id TEXT NOT NULL DEFAULT 'default' REFERENCES games(id));
INSERT INTO media_next SELECT id,team_id,kind,mime,created,'default' FROM media;
DROP TABLE media;
ALTER TABLE media_next RENAME TO media;
CREATE TABLE audit_next (id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT NOT NULL, created TEXT NOT NULL, game_id TEXT NOT NULL DEFAULT 'default' REFERENCES games(id));
INSERT INTO audit_next SELECT id,action,detail,created,'default' FROM audit;
DROP TABLE audit;
ALTER TABLE audit_next RENAME TO audit;

-- Rebuild the related tables so team names and Google place IDs can recur in
-- different games. Rename children first and remove them before their parents.
ALTER TABLE attempts RENAME TO attempts_legacy;
ALTER TABLE venues RENAME TO venues_legacy;
ALTER TABLE teams RENAME TO teams_legacy;
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL,
  password TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  adjustment INTEGER NOT NULL DEFAULT 0,
  UNIQUE(game_id,name),
  UNIQUE(game_id,id)
);
CREATE TABLE venues (
  game_id TEXT NOT NULL REFERENCES games(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  owner TEXT,
  status TEXT NOT NULL CHECK(status IN ('available','claimed','open','locked')),
  updated TEXT NOT NULL,
  PRIMARY KEY(game_id,id),
  FOREIGN KEY(game_id,owner) REFERENCES teams(game_id,id)
);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  venue_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('claim','steal')),
  status TEXT NOT NULL CHECK(status IN ('pending','completed','failed','vetoed','lost','void')),
  challenge INTEGER,
  photo TEXT,
  completion_photo TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  UNIQUE(game_id,venue_id,team_id),
  FOREIGN KEY(game_id,venue_id) REFERENCES venues(game_id,id),
  FOREIGN KEY(game_id,team_id) REFERENCES teams(game_id,id)
);
INSERT INTO teams SELECT id,'default',name,color,password,active,adjustment FROM teams_legacy;
INSERT INTO venues SELECT 'default',id,name,address,owner,status,updated FROM venues_legacy;
INSERT INTO attempts SELECT id,'default',venue_id,team_id,kind,status,challenge,photo,completion_photo,created,updated FROM attempts_legacy;
DROP TABLE attempts_legacy;
DROP TABLE venues_legacy;
DROP TABLE teams_legacy;
CREATE INDEX attempts_recent ON attempts(game_id,created DESC);
CREATE INDEX attempts_pending ON attempts(game_id,team_id,status);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  team_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(team_id,name),
  UNIQUE(game_id,id),
  FOREIGN KEY(game_id,team_id) REFERENCES teams(game_id,id)
);
CREATE TABLE drinks (
  game_id TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  created TEXT NOT NULL,
  PRIMARY KEY(game_id,venue_id,member_id),
  FOREIGN KEY(game_id,venue_id) REFERENCES venues(game_id,id),
  FOREIGN KEY(game_id,member_id) REFERENCES members(game_id,id)
);
CREATE INDEX drinks_member ON drinks(member_id);
CREATE INDEX audit_game ON audit(game_id,created DESC);

-- LAPIS source annotation database (Cloudflare D1 / SQLite).
-- Data model is additive: fields and catalog releases are insert-only; a new
-- catalog version is a new release whose detections are cross-matched onto the
-- existing sources, so annotations (attached to sources.uid) are never lost.

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  inbox_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL
);

-- One row per pointing / FitsMap.
CREATE TABLE IF NOT EXISTS fields (
  field_id TEXT PRIMARY KEY,
  label TEXT,
  map_url TEXT,
  map_auth TEXT,              -- optional "user:pass" override for this map
  map_meta TEXT,              -- json: wcs, tile transformation, image layers (parsed from the FitsMap)
  tile_version INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- One row per ingested catalog (field + version). Never overwritten.
CREATE TABLE IF NOT EXISTS releases (
  release_id TEXT PRIMARY KEY,
  field_id TEXT NOT NULL,
  version TEXT NOT NULL,
  filters TEXT NOT NULL,      -- json: [{name, wave_um, width_um}]
  apertures TEXT NOT NULL,    -- json: list of aperture keys stored in the full-photometry blobs
  default_aperture TEXT NOT NULL,
  source_file TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'ingesting',
  n_sources INTEGER NOT NULL DEFAULT 0,
  n_new INTEGER NOT NULL DEFAULT 0,
  ingested_by TEXT,
  ingested_at TEXT NOT NULL
);

-- Astrophysical objects. uid is an IAU-style coordinate name, stable forever.
CREATE TABLE IF NOT EXISTS sources (
  uid TEXT PRIMARY KEY,
  ra REAL NOT NULL,
  dec REAL NOT NULL,
  first_release TEXT,
  created_at TEXT NOT NULL,
  last_activity TEXT
);
CREATE INDEX IF NOT EXISTS sources_dec ON sources(dec);

-- A source as measured in one catalog release.
CREATE TABLE IF NOT EXISTS detections (
  release_id TEXT NOT NULL,
  cat_id INTEGER NOT NULL,
  uid TEXT NOT NULL,
  field_id TEXT NOT NULL,
  ra REAL NOT NULL,
  dec REAL NOT NULL,
  x REAL,
  y REAL,
  phot TEXT,                  -- json {band: [flux_nJy, err_nJy]} in the default aperture
  photoz TEXT,                -- json {photo-z table: summary columns}
  PRIMARY KEY (release_id, cat_id)
);
CREATE INDEX IF NOT EXISTS detections_uid ON detections(uid);
CREATE INDEX IF NOT EXISTS detections_cat ON detections(cat_id);

-- Object-type up/down votes (pills under the source name). Changing a vote retracts
-- the old row and inserts a new one, so the history is kept.
CREATE TABLE IF NOT EXISTS otypes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL,
  otype TEXT NOT NULL,
  username TEXT NOT NULL,
  vote INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL,
  retracted_at TEXT
);
CREATE INDEX IF NOT EXISTS otypes_uid ON otypes(uid);
CREATE INDEX IF NOT EXISTS otypes_user ON otypes(username);
CREATE INDEX IF NOT EXISTS otypes_otype ON otypes(otype);

CREATE TABLE IF NOT EXISTS otype_vocab (
  otype TEXT PRIMARY KEY,
  description TEXT,
  created_by TEXT
);
INSERT OR IGNORE INTO otype_vocab (otype, description) VALUES
  ('Brown dwarf', 'Substellar object (T/Y/L dwarf candidate)'),
  ('Star', 'Galactic star'),
  ('Galaxy', 'Galaxy'),
  ('High-z galaxy candidate', 'Dropout / photo-z selected high-redshift galaxy'),
  ('Little red dot', 'Compact red source with V-shaped SED'),
  ('AGN / quasar', 'Active galactic nucleus or quasar'),
  ('Emission-line galaxy', 'Strong medium-band excess'),
  ('Dusty / red galaxy', 'Optically faint, red galaxy'),
  ('Transient / moving object', 'Variable, transient, or solar-system object'),
  ('Artifact', 'Spurious detection (persistence, snowball, diffraction spike, edge, etc.)'),
  ('Blended / contaminated', 'Photometry affected by a neighbour'),
  ('Unknown', 'Unclear nature; needs discussion');

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL,
  username TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS comments_uid ON comments(uid);
CREATE INDEX IF NOT EXISTS comments_user ON comments(username);

-- Uploaded SED fits; the curve itself lives in R2 under r2_key.
CREATE TABLE IF NOT EXISTS seds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL,
  username TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'sed',  -- 'sed' (SED fit) or 'pz' (P(z))
  label TEXT NOT NULL,
  code TEXT,
  redshift REAL,
  notes TEXT,
  original_name TEXT,
  n_points INTEGER,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS seds_uid ON seds(uid);
CREATE INDEX IF NOT EXISTS seds_user ON seds(username);

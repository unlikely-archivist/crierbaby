-- Apply after replacing <database-name>: npx wrangler d1 execute <database-name> --remote --file=schema.sql

-- The stash. Photo bytes live in KV at img:<key>; a photo leaves the stash when a post uses it.
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  sig TEXT,                                 -- visual fingerprint {h, c} so look-alikes don't post back to back
  hash TEXT,                                -- SHA-256 of the original file: the same photo isn't added twice while it's waiting
  priority INTEGER NOT NULL DEFAULT 0,      -- "post next" from the stash: higher goes into the next open day first
  created_at TEXT NOT NULL
);

-- One row per post. Scheduled posts own a day (slot_day, UTC); custom one-offs can share a day.
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_day TEXT NOT NULL,                   -- YYYY-MM-DD in UTC
  slot_time TEXT NOT NULL,                  -- HH:MM UTC, jittered a few minutes
  kind TEXT NOT NULL,                       -- standard | minimal | custom | held (AI needs a manual caption)
  photos TEXT NOT NULL,                     -- JSON [{key, type, width, height, alt}] in posting order
  status TEXT NOT NULL DEFAULT 'draft',     -- writing | draft (needs review) | approved | posting | posted | failed
  caption TEXT NOT NULL DEFAULT '',
  caption_options TEXT NOT NULL DEFAULT '[]',
  manual INTEGER NOT NULL DEFAULT 0,        -- 1 = manually written (AI declined, or the owner chose to)
  rewrites INTEGER NOT NULL DEFAULT 0,      -- times QA sent it back for repeating other captions (max 2)
  tries INTEGER NOT NULL DEFAULT 0,         -- posting attempts; Bluesky hiccups are retried up to 3 times
  claimed_at TEXT,                          -- when the current posting attempt started
  error TEXT,
  url TEXT,
  posted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_post_per_day ON posts (slot_day) WHERE kind NOT IN ('custom', 'held');

-- Caption writer instructions: links and voice/caption rules.
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                       -- link | voice
  text TEXT NOT NULL,
  until TEXT,                               -- reserved for future expiring instructions
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Starts paused so nothing is published until the account owner turns it on.
INSERT OR IGNORE INTO settings (key, value) VALUES ('paused', '1');

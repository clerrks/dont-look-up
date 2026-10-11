-- D1 schema for the Daily Challenge leaderboard (database: dontlookup-daily)
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  grade TEXT NOT NULL,
  lives INTEGER NOT NULL,
  thrift INTEGER NOT NULL,
  prudence INTEGER NOT NULL,
  spent REAL NOT NULL,
  hit INTEGER NOT NULL,
  actions TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_day_score ON runs(day, score DESC);

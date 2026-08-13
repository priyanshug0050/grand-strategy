-- ============================================================================
--  schema.sql — Persistence layer
-- ============================================================================
--
--  DESIGN RULE: STORE ONLY WHAT CANNOT BE DERIVED.
--
--  Population, score, commerce, disease, pollution, and income are NEVER
--  stored. They are recomputed from infrastructure, land, and improvements
--  every time they are needed. That is what prevents drift, desync, and the
--  need for event replay — and it is why the engine can be verified by unit
--  tests instead of by staring at production data.
--
--  If you ever feel the urge to add a `population` column as a cache, add a
--  materialized view instead. A stored population WILL diverge from the
--  computed one, and then you have two truths and no way to pick.
--
--  MONEY AND RESOURCES ARE NUMERIC, NEVER FLOAT.
--  Floating point accumulates error under repeated addition. Over 12 ticks a
--  day for months, that error becomes free money — and free money in a
--  multiplayer economy is an exploit, not a rounding artifact.
--
--  NEGATIVE BALANCES ARE IMPOSSIBLE AT THE DATABASE LEVEL.
--  Every balance column carries a CHECK (>= 0). The engine already prevents
--  this in application code; the constraint is the backstop for when a future
--  code path forgets. A duping bug that would have silently drained a
--  stockpile below zero instead aborts the transaction.
-- ============================================================================

-- ============================================================================
-- USERS & AUTH
-- ============================================================================

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  is_banned     BOOLEAN NOT NULL DEFAULT FALSE
);

-- ============================================================================
-- GLOBAL GAME STATE (singleton)
-- ============================================================================

CREATE TABLE game_state (
  id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  current_turn     BIGINT NOT NULL DEFAULT 0,
  world_radiation  NUMERIC(10,4) NOT NULL DEFAULT 0 CHECK (world_radiation >= 0),
  last_tick_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  tick_in_progress BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO game_state (id) VALUES (1);

-- Per-continent radiation. Nukes hit the continent hard and the world lightly,
-- which is what makes nuclear war a tragedy of the commons.
CREATE TABLE continent_radiation (
  continent  TEXT PRIMARY KEY,
  radiation  NUMERIC(10,4) NOT NULL DEFAULT 0 CHECK (radiation >= 0)
);

-- ============================================================================
-- ALLIANCES
-- ============================================================================

CREATE TABLE alliances (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  acronym            TEXT NOT NULL,
  color              TEXT NOT NULL DEFAULT 'gray',
  tax_money_rate     NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (tax_money_rate BETWEEN 0 AND 1),
  tax_resource_rate  NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (tax_resource_rate BETWEEN 0 AND 1),
  color_changed_turn BIGINT,
  founded_turn       BIGINT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- NATIONS
-- ============================================================================
-- Turn-numbered columns are nullable rather than defaulting to 0. Turn 0 is a
-- LEGITIMATE value, and code that treats it as "unset" (JavaScript's `|| 0`
-- trap) silently breaks. NULL means unset; 0 means turn zero.
-- ============================================================================

CREATE TABLE nations (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL UNIQUE,
  leader_name           TEXT NOT NULL,
  continent             TEXT NOT NULL,

  money                 NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (money >= 0),
  map_points            SMALLINT NOT NULL DEFAULT 0 CHECK (map_points >= 0),

  color                 TEXT NOT NULL DEFAULT 'beige',
  domestic_policy       TEXT,
  war_policy            TEXT,

  alliance_id           BIGINT REFERENCES alliances(id) ON DELETE SET NULL,
  alliance_role         TEXT,

  -- Turn markers. NULL = never happened.
  founded_turn          BIGINT NOT NULL DEFAULT 0,
  beige_until_turn      BIGINT,
  last_active_turn      BIGINT NOT NULL DEFAULT 0,
  last_city_turn        BIGINT,
  joined_alliance_turn  BIGINT,
  domestic_policy_turn  BIGINT,
  war_policy_turn       BIGINT,
  color_changed_turn    BIGINT,

  spies                 SMALLINT NOT NULL DEFAULT 0 CHECK (spies >= 0),
  is_deleted            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_nations_alliance ON nations(alliance_id) WHERE is_deleted = FALSE;
CREATE INDEX idx_nations_user ON nations(user_id);
CREATE INDEX idx_nations_active ON nations(last_active_turn) WHERE is_deleted = FALSE;

-- ============================================================================
-- CITIES
-- ============================================================================

CREATE TABLE cities (
  id             BIGSERIAL PRIMARY KEY,
  nation_id      BIGINT NOT NULL REFERENCES nations(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  continent      TEXT NOT NULL,
  infrastructure NUMERIC(12,2) NOT NULL DEFAULT 10 CHECK (infrastructure >= 0),
  land           NUMERIC(12,2) NOT NULL DEFAULT 250 CHECK (land >= 0),
  founded_turn   BIGINT NOT NULL DEFAULT 0,
  powered        BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (nation_id, name)
);

CREATE INDEX idx_cities_nation ON cities(nation_id);
-- Damage always lands on the highest-infrastructure city, so that lookup is hot.
CREATE INDEX idx_cities_infra ON cities(nation_id, infrastructure DESC);

CREATE TABLE city_improvements (
  city_id          BIGINT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  improvement_key  TEXT NOT NULL,
  count            SMALLINT NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (city_id, improvement_key)
);

-- ============================================================================
-- STOCKPILES & UNITS
-- ============================================================================

CREATE TABLE nation_resources (
  nation_id  BIGINT NOT NULL REFERENCES nations(id) ON DELETE CASCADE,
  resource   TEXT NOT NULL,
  amount     NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  PRIMARY KEY (nation_id, resource)
);

CREATE TABLE nation_units (
  nation_id  BIGINT NOT NULL REFERENCES nations(id) ON DELETE CASCADE,
  unit_key   TEXT NOT NULL,
  count      BIGINT NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (nation_id, unit_key)
);

CREATE TABLE nation_projects (
  nation_id    BIGINT NOT NULL REFERENCES nations(id) ON DELETE CASCADE,
  project_key  TEXT NOT NULL,
  built_turn   BIGINT NOT NULL,
  PRIMARY KEY (nation_id, project_key)
);

-- Daily recruitment allowance. Keyed by game DAY, not calendar date — the
-- "double buy" exploit in P&W exists precisely because the reset boundary and
-- the purchase window are misaligned.
CREATE TABLE recruitment_log (
  nation_id  BIGINT NOT NULL REFERENCES nations(id) ON DELETE CASCADE,
  game_day   BIGINT NOT NULL,
  unit_key   TEXT NOT NULL,
  count      BIGINT NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (nation_id, game_day, unit_key)
);

-- ============================================================================
-- ALLIANCE BANK
-- ============================================================================

CREATE TABLE alliance_bank (
  alliance_id  BIGINT NOT NULL REFERENCES alliances(id) ON DELETE CASCADE,
  resource     TEXT NOT NULL,
  amount       NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  PRIMARY KEY (alliance_id, resource)
);

-- Every bank movement is logged. This is the #1 abuse surface in the genre:
-- an unlogged withdrawal is indistinguishable from a duping bug after the fact.
CREATE TABLE alliance_bank_log (
  id           BIGSERIAL PRIMARY KEY,
  alliance_id  BIGINT NOT NULL REFERENCES alliances(id) ON DELETE CASCADE,
  nation_id    BIGINT REFERENCES nations(id) ON DELETE SET NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('deposit','withdraw','tax','loot')),
  resource     TEXT NOT NULL,
  amount       NUMERIC(20,4) NOT NULL,
  turn         BIGINT NOT NULL,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bank_log_alliance ON alliance_bank_log(alliance_id, created_at DESC);

-- ============================================================================
-- WARS & BATTLES
-- ============================================================================

CREATE TABLE wars (
  id                     BIGSERIAL PRIMARY KEY,
  attacker_id            BIGINT NOT NULL REFERENCES nations(id) ON DELETE CASCADE,
  defender_id            BIGINT NOT NULL REFERENCES nations(id) ON DELETE CASCADE,
  war_type               TEXT NOT NULL CHECK (war_type IN ('attrition','ordinary','raid')),

  attacker_resistance    NUMERIC(6,2) NOT NULL DEFAULT 100 CHECK (attacker_resistance >= 0),
  defender_resistance    NUMERIC(6,2) NOT NULL DEFAULT 100 CHECK (defender_resistance >= 0),

  attacker_control_state TEXT,
  defender_control_state TEXT,
  attacker_fortified     BOOLEAN NOT NULL DEFAULT FALSE,
  defender_fortified     BOOLEAN NOT NULL DEFAULT FALSE,

  started_turn           BIGINT NOT NULL,
  ended_turn             BIGINT,
  winner_id              BIGINT REFERENCES nations(id) ON DELETE SET NULL,

  CHECK (attacker_id <> defender_id)
);

CREATE INDEX idx_wars_attacker ON wars(attacker_id) WHERE ended_turn IS NULL;
CREATE INDEX idx_wars_defender ON wars(defender_id) WHERE ended_turn IS NULL;

-- rng_seed is the important column. Store it and any disputed battle can be
-- replayed byte-for-byte through combat.js. Without it, "the game cheated me"
-- is unanswerable.
CREATE TABLE battles (
  id                BIGSERIAL PRIMARY KEY,
  war_id            BIGINT NOT NULL REFERENCES wars(id) ON DELETE CASCADE,
  attacker_id       BIGINT NOT NULL REFERENCES nations(id) ON DELETE CASCADE,
  attack_type       TEXT NOT NULL,
  victory_type      SMALLINT NOT NULL CHECK (victory_type BETWEEN 0 AND 3),
  rng_seed          BIGINT NOT NULL,

  attacker_value    NUMERIC(20,2) NOT NULL,
  defender_value    NUMERIC(20,2) NOT NULL,
  infra_destroyed   NUMERIC(12,2) NOT NULL DEFAULT 0,
  loot              NUMERIC(20,2) NOT NULL DEFAULT 0,
  resistance_loss   NUMERIC(6,2) NOT NULL DEFAULT 0,
  target_city_id    BIGINT REFERENCES cities(id) ON DELETE SET NULL,

  attacker_casualties JSONB NOT NULL DEFAULT '{}',
  defender_casualties JSONB NOT NULL DEFAULT '{}',

  turn              BIGINT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_battles_war ON battles(war_id, created_at DESC);

-- ============================================================================
-- ESPIONAGE
-- ============================================================================

CREATE TABLE espionage_ops (
  id            BIGSERIAL PRIMARY KEY,
  attacker_id   BIGINT NOT NULL REFERENCES nations(id) ON DELETE CASCADE,
  defender_id   BIGINT NOT NULL REFERENCES nations(id) ON DELETE CASCADE,
  operation     TEXT NOT NULL,
  safety_level  SMALLINT NOT NULL CHECK (safety_level BETWEEN 1 AND 3),
  success       BOOLEAN NOT NULL,
  detected      BOOLEAN NOT NULL,
  odds          NUMERIC(6,2) NOT NULL,
  spies_lost    SMALLINT NOT NULL DEFAULT 0,
  rng_seed      BIGINT NOT NULL,
  turn          BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_espionage_daily ON espionage_ops(attacker_id, turn);

-- ============================================================================
-- MARKET
-- ============================================================================
-- Per-resource order books with instant matching on cross. No NPC price floor
-- or ceiling — that absence is exactly why prices stay volatile and the
-- economy feels alive. Resist adding one.
-- ============================================================================

CREATE TABLE market_orders (
  id           BIGSERIAL PRIMARY KEY,
  nation_id    BIGINT NOT NULL REFERENCES nations(id) ON DELETE CASCADE,
  resource     TEXT NOT NULL,
  side         TEXT NOT NULL CHECK (side IN ('buy','sell')),
  price        NUMERIC(14,2) NOT NULL CHECK (price > 0),
  quantity     NUMERIC(20,4) NOT NULL CHECK (quantity > 0),
  filled       NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (filled >= 0),
  is_open      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (filled <= quantity)
);

-- The matching index: best price first, oldest first at equal price.
CREATE INDEX idx_market_book ON market_orders(resource, side, price, created_at)
  WHERE is_open = TRUE;
CREATE INDEX idx_market_nation ON market_orders(nation_id) WHERE is_open = TRUE;

CREATE TABLE trades (
  id             BIGSERIAL PRIMARY KEY,
  resource       TEXT NOT NULL,
  buyer_id       BIGINT REFERENCES nations(id) ON DELETE SET NULL,
  seller_id      BIGINT REFERENCES nations(id) ON DELETE SET NULL,
  price          NUMERIC(14,2) NOT NULL,
  quantity       NUMERIC(20,4) NOT NULL,
  buy_order_id   BIGINT REFERENCES market_orders(id) ON DELETE SET NULL,
  sell_order_id  BIGINT REFERENCES market_orders(id) ON DELETE SET NULL,
  -- Flagged when the price deviates far from the rolling median. This is how
  -- wash trading between linked accounts gets caught — the mechanical duping
  -- defence (row locks) does nothing against a social exploit.
  flagged        BOOLEAN NOT NULL DEFAULT FALSE,
  turn           BIGINT NOT NULL,
  executed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_trades_resource_time ON trades(resource, executed_at DESC);
CREATE INDEX idx_trades_flagged ON trades(flagged) WHERE flagged = TRUE;

CREATE TABLE embargoes (
  id             BIGSERIAL PRIMARY KEY,
  nation_id      BIGINT REFERENCES nations(id) ON DELETE CASCADE,
  alliance_id    BIGINT REFERENCES alliances(id) ON DELETE CASCADE,
  target_nation  BIGINT REFERENCES nations(id) ON DELETE CASCADE,
  target_alliance BIGINT REFERENCES alliances(id) ON DELETE CASCADE,
  created_turn   BIGINT NOT NULL
);

-- ============================================================================
-- EVENTS
-- ============================================================================

CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  nation_id   BIGINT REFERENCES nations(id) ON DELETE CASCADE,
  turn        BIGINT NOT NULL,
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_nation ON events(nation_id, created_at DESC);
CREATE INDEX idx_events_unread ON events(nation_id) WHERE is_read = FALSE;

-- ============================================================================
-- ANTI-ABUSE
-- ============================================================================
-- Row-level locking defends against the MECHANICAL duping vector (two requests
-- racing on the same balance). It does nothing against the SOCIAL vector:
-- multi-accounting, sweetheart trades, and funnelling resources through an
-- intermediary. That needs linkage tracking, which is what this table is for.
-- ============================================================================

CREATE TABLE account_links (
  id          BIGSERIAL PRIMARY KEY,
  nation_id   BIGINT NOT NULL REFERENCES nations(id) ON DELETE CASCADE,
  ip_hash     TEXT,
  device_hash TEXT,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nation_id, ip_hash, device_hash)
);

CREATE INDEX idx_links_ip ON account_links(ip_hash);
CREATE INDEX idx_links_device ON account_links(device_hash);

-- HARD BLOCK: requires BOTH ip AND device to match.
--
-- Matching on IP alone is far too aggressive on the modern internet. Carrier-
-- grade NAT, university networks, offices, and mobile providers put thousands
-- of unrelated people behind one address. An IP-only rule would permanently
-- forbid two flatmates, or two students, from ever fighting each other — and
-- they would have no idea why.
--
-- Requiring both signals means we block the actual alt-farming pattern (same
-- person, same machine, same connection) while leaving shared-connection
-- players alone. Determined abusers can still evade it; that is what the
-- softer review queue below is for.
CREATE VIEW linked_nations AS
SELECT DISTINCT a.nation_id AS nation_a, b.nation_id AS nation_b
FROM account_links a
JOIN account_links b
  ON a.nation_id <> b.nation_id
 AND a.ip_hash IS NOT NULL AND a.ip_hash = b.ip_hash
 AND a.device_hash IS NOT NULL AND a.device_hash = b.device_hash;

-- SOFT SIGNAL: IP-only overlap. Never blocks anything on its own — it exists
-- so an admin can review a pattern (one IP, twelve nations, all funnelling
-- resources one direction) that no single rule should auto-punish.
CREATE VIEW suspected_links AS
SELECT DISTINCT a.nation_id AS nation_a, b.nation_id AS nation_b, a.ip_hash
FROM account_links a
JOIN account_links b
  ON a.nation_id <> b.nation_id
 AND a.ip_hash IS NOT NULL AND a.ip_hash = b.ip_hash
WHERE NOT EXISTS (
  SELECT 1 FROM linked_nations l
   WHERE l.nation_a = a.nation_id AND l.nation_b = b.nation_id
);

-- ============================================================================
-- CONVENIENCE VIEWS
-- ============================================================================

-- Note there is deliberately NO population or score column here. Both are
-- computed by the engine from the rows below. A view that pretended to know
-- them would be a second source of truth.
CREATE VIEW nation_summary AS
SELECT
  n.id,
  n.name,
  n.color,
  n.alliance_id,
  n.money,
  COUNT(DISTINCT c.id)             AS city_count,
  COALESCE(SUM(c.infrastructure),0) AS total_infrastructure,
  COALESCE(SUM(c.land),0)           AS total_land,
  (SELECT COUNT(*) FROM nation_projects p WHERE p.nation_id = n.id) AS project_count
FROM nations n
LEFT JOIN cities c ON c.nation_id = n.id
WHERE n.is_deleted = FALSE
GROUP BY n.id;

-- ============================================================================
-- POLICY SLOTS (migration)
-- ============================================================================
-- The original two columns (domestic_policy, war_policy) modelled P&W's system:
-- one domestic choice and one war choice. This game runs THREE slots — one
-- economic, one social, one military — each with its own cooldown.
--
-- Added as new columns rather than renaming, so an existing database can be
-- migrated by running just this block.

ALTER TABLE nations ADD COLUMN IF NOT EXISTS economic_policy TEXT;
ALTER TABLE nations ADD COLUMN IF NOT EXISTS social_policy TEXT;
ALTER TABLE nations ADD COLUMN IF NOT EXISTS military_policy TEXT;

ALTER TABLE nations ADD COLUMN IF NOT EXISTS economic_policy_turn BIGINT;
ALTER TABLE nations ADD COLUMN IF NOT EXISTS social_policy_turn BIGINT;
ALTER TABLE nations ADD COLUMN IF NOT EXISTS military_policy_turn BIGINT;

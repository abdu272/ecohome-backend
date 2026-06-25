-- ─────────────────────────────────────────────────────────────
-- SMART HOME ENERGY — MIGRATION (add new tables safely)
-- Run: psql -d smarthome_db -f db/migrate_iot.sql
-- Uses SERIAL ids to match the existing users table
-- ─────────────────────────────────────────────────────────────

-- ── Homes / Properties ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS homes (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name         VARCHAR(100) DEFAULT 'My Home',
  area_sqft    NUMERIC(8,2),
  num_rooms    INTEGER,
  created_at   TIMESTAMP DEFAULT NOW()
);

-- ── IoT Devices ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS iot_devices (
  id         SERIAL PRIMARY KEY,
  home_id    INTEGER REFERENCES homes(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  type       VARCHAR(50)  NOT NULL,
  room       VARCHAR(50),
  is_active  BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ── Raw Sensor Readings ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS sensor_readings (
  id             SERIAL PRIMARY KEY,
  device_id      INTEGER REFERENCES iot_devices(id) ON DELETE CASCADE,
  home_id        INTEGER REFERENCES homes(id),
  kwh_consumed   NUMERIC(10,4) DEFAULT 0,
  kwh_generated  NUMERIC(10,4) DEFAULT 0,
  kwh_exported   NUMERIC(10,4) DEFAULT 0,
  voltage        NUMERIC(6,2),
  temperature_c  NUMERIC(5,2),
  co2_kg         NUMERIC(8,4)  DEFAULT 0,
  cost_usd       NUMERIC(8,4)  DEFAULT 0,
  recorded_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMP DEFAULT NOW()
);

-- ── Daily Aggregated Summaries ────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_summaries (
  id                   SERIAL PRIMARY KEY,
  home_id              INTEGER REFERENCES homes(id),
  report_date          DATE NOT NULL,
  total_kwh_consumed   NUMERIC(10,4) DEFAULT 0,
  total_kwh_generated  NUMERIC(10,4) DEFAULT 0,
  total_kwh_exported   NUMERIC(10,4) DEFAULT 0,
  net_kwh              NUMERIC(10,4) DEFAULT 0,
  total_cost_usd       NUMERIC(8,2)  DEFAULT 0,
  savings_usd          NUMERIC(8,2)  DEFAULT 0,
  total_co2_kg         NUMERIC(8,4)  DEFAULT 0,
  co2_saved_kg         NUMERIC(8,4)  DEFAULT 0,
  eco_score            INTEGER       DEFAULT 0,
  efficiency_pct       NUMERIC(5,2)  DEFAULT 0,
  created_at           TIMESTAMP     DEFAULT NOW(),
  UNIQUE(home_id, report_date)
);

-- ── AI Optimization Suggestions ──────────────────────────────
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id                    SERIAL PRIMARY KEY,
  home_id               INTEGER REFERENCES homes(id),
  category              VARCHAR(50),
  title                 VARCHAR(200),
  description           TEXT,
  estimated_savings_usd NUMERIC(8,2) DEFAULT 0,
  estimated_co2_kg      NUMERIC(8,2) DEFAULT 0,
  priority              VARCHAR(20)  DEFAULT 'medium',
  is_applied            BOOLEAN      DEFAULT FALSE,
  generated_at          TIMESTAMP    DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_readings_home_date  ON sensor_readings(home_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_readings_device     ON sensor_readings(device_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_home_date     ON daily_summaries(home_id, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_suggestions_home    ON ai_suggestions(home_id, generated_at DESC);

-- ── Auto-aggregate trigger ────────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_daily_summary()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO daily_summaries (
    home_id, report_date,
    total_kwh_consumed, total_kwh_generated, total_kwh_exported, net_kwh,
    total_cost_usd, total_co2_kg, co2_saved_kg
  )
  SELECT
    NEW.home_id, DATE(NEW.recorded_at),
    SUM(kwh_consumed),  SUM(kwh_generated), SUM(kwh_exported),
    SUM(kwh_consumed) - SUM(kwh_generated),
    SUM(cost_usd), SUM(co2_kg),
    SUM(kwh_generated) * 0.233
  FROM sensor_readings
  WHERE home_id = NEW.home_id AND DATE(recorded_at) = DATE(NEW.recorded_at)
  ON CONFLICT (home_id, report_date) DO UPDATE SET
    total_kwh_consumed  = EXCLUDED.total_kwh_consumed,
    total_kwh_generated = EXCLUDED.total_kwh_generated,
    total_kwh_exported  = EXCLUDED.total_kwh_exported,
    net_kwh             = EXCLUDED.net_kwh,
    total_cost_usd      = EXCLUDED.total_cost_usd,
    total_co2_kg        = EXCLUDED.total_co2_kg,
    co2_saved_kg        = EXCLUDED.co2_saved_kg;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS after_sensor_insert ON sensor_readings;
CREATE TRIGGER after_sensor_insert
  AFTER INSERT ON sensor_readings
  FOR EACH ROW EXECUTE FUNCTION refresh_daily_summary();

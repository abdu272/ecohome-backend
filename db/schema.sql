-- db/schema.sql
-- Run once to initialise the SmartEnergyAI database
-- psql -U postgres -d smartenergy -f schema.sql

-- ─── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  full_name     VARCHAR(150)        NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  phone         VARCHAR(30),
  password_hash VARCHAR(255)        NOT NULL,
  role          VARCHAR(20)         NOT NULL DEFAULT 'user',
  is_verified   BOOLEAN             NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

-- ─── OTP Tokens (forgot-password flow) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      VARCHAR(10) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Devices ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(150) NOT NULL,
  type        VARCHAR(80)  NOT NULL,
  location    VARCHAR(150),
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  ai_enabled  BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Energy Readings ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS energy_readings (
  id          SERIAL PRIMARY KEY,
  device_id   INTEGER     NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id     INTEGER     NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  kwh         NUMERIC(10,4) NOT NULL,
  recorded_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─── Reports ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      VARCHAR(255),
  period     VARCHAR(50),
  data       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index helpers
CREATE INDEX IF NOT EXISTS idx_energy_user    ON energy_readings(user_id);
CREATE INDEX IF NOT EXISTS idx_energy_device  ON energy_readings(device_id);
CREATE INDEX IF NOT EXISTS idx_devices_user   ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_otp_user       ON otp_tokens(user_id);

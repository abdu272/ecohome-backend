// routes/iot.js — IoT ingestion + telemetry
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');

const CO2_PER_KWH  = 0.233;  // kg CO2 per kWh
const RATE_PER_KWH = 0.12;   // $ per kWh

// POST /api/iot/ingest — called by IoT gateway / MQTT bridge
router.post('/ingest', async (req, res) => {
  try {
    const { device_id, home_id, readings } = req.body;
    if (!device_id || !home_id || !Array.isArray(readings))
      return res.status(400).json({ error: 'device_id, home_id and readings[] required.' });

    for (const r of readings) {
      await pool.query(
        `INSERT INTO sensor_readings
         (device_id, home_id, kwh_consumed, kwh_generated, kwh_exported,
          voltage, temperature_c, co2_kg, cost_usd, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          device_id, home_id,
          r.kwh_consumed   || 0,
          r.kwh_generated  || 0,
          r.kwh_exported   || 0,
          r.voltage        || null,
          r.temperature_c  || null,
          ((r.kwh_consumed || 0) * CO2_PER_KWH).toFixed(4),
          ((r.kwh_consumed || 0) * RATE_PER_KWH).toFixed(4),
          r.recorded_at    || new Date(),
        ]
      );
    }
    res.json({ success: true, inserted: readings.length });
  } catch (err) {
    console.error('IoT ingest error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/iot/telemetry — latest reading for a home
router.get('/telemetry', async (req, res) => {
  try {
    const { home_id } = req.query;
    if (!home_id) return res.json({ telemetry: [], total_records: 0 });
    const { rows } = await pool.query(
      `SELECT * FROM sensor_readings WHERE home_id=$1 ORDER BY recorded_at DESC LIMIT 50`,
      [home_id]
    );
    res.json({ telemetry: rows, total_records: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/telemetry/current', async (req, res) => {
  try {
    const { home_id } = req.query;
    if (!home_id) return res.json({ message: 'No data' });
    const { rows } = await pool.query(
      `SELECT kwh_consumed, kwh_generated, voltage, temperature_c, co2_kg, cost_usd, recorded_at
       FROM sensor_readings WHERE home_id=$1 ORDER BY recorded_at DESC LIMIT 1`,
      [home_id]
    );
    res.json(rows[0] || { message: 'No data' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/nilm',   (req, res) => res.json({ prediction: null }));
router.post('/predict',(req, res) => res.json({ prediction: null }));
router.get('/recommendations', (req, res) => res.json({ recommendations: [] }));
router.get('/insights', (req, res) => res.json({
  peakLoad: { value: 0, change: 0, forecast: [] }, anomalies: [], schedule: null
}));

module.exports = router;

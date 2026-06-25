// routes/reports.js — Full sustainability report + PDF
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const authenticateToken = require('../middleware/authMiddleware');

router.use(authenticateToken);

// ── helpers ──────────────────────────────────────────────────
const getDateRange = (period, date) => {
  const ref = date ? new Date(date) : new Date();
  let startDate, endDate;
  if (period === 'daily') {
    startDate = new Date(ref); startDate.setHours(0,0,0,0);
    endDate   = new Date(ref); endDate.setHours(23,59,59,999);
  } else if (period === 'weekly') {
    const day = ref.getDay();
    startDate = new Date(ref); startDate.setDate(ref.getDate() - day); startDate.setHours(0,0,0,0);
    endDate   = new Date(startDate); endDate.setDate(startDate.getDate() + 6); endDate.setHours(23,59,59,999);
  } else {
    startDate = new Date(ref.getFullYear(), ref.getMonth(), 1);
    endDate   = new Date(ref.getFullYear(), ref.getMonth() + 1, 0, 23, 59, 59);
  }
  return { startDate, endDate };
};

const getPrevRange = (period, startDate, endDate) => {
  const ps = new Date(startDate), pe = new Date(endDate);
  if (period === 'daily')       { ps.setDate(ps.getDate()-1); pe.setDate(pe.getDate()-1); }
  else if (period === 'weekly') { ps.setDate(ps.getDate()-7); pe.setDate(pe.getDate()-7); }
  else                          { ps.setMonth(ps.getMonth()-1); pe.setMonth(pe.getMonth()-1); }
  return { prevStart: ps, prevEnd: pe };
};

// ── GET /api/reports/:homeId?period=daily|weekly|monthly ──────
router.get('/:homeId', async (req, res) => {
  try {
    const { homeId } = req.params;
    const { period = 'monthly', date } = req.query;
    const { startDate, endDate } = getDateRange(period, date);

    // Totals
    const { rows: [t] } = await pool.query(
      `SELECT
         COALESCE(SUM(kwh_consumed),0)  AS total_kwh_consumed,
         COALESCE(SUM(kwh_generated),0) AS total_kwh_generated,
         COALESCE(SUM(kwh_exported),0)  AS total_kwh_exported,
         COALESCE(SUM(kwh_consumed)-SUM(kwh_generated),0) AS net_kwh,
         COALESCE(SUM(cost_usd),0)      AS total_cost_usd,
         COALESCE(SUM(co2_kg),0)        AS total_co2_kg,
         COALESCE(SUM(kwh_generated)*0.233,0) AS co2_saved_kg,
         COUNT(DISTINCT device_id)      AS active_devices
       FROM sensor_readings
       WHERE home_id=$1 AND recorded_at BETWEEN $2 AND $3`,
      [homeId, startDate, endDate]
    );

    // Chart data
    const groupBy = period === 'daily'
      ? `DATE_TRUNC('hour', recorded_at)`
      : `DATE(recorded_at)`;
    const { rows: chartData } = await pool.query(
      `SELECT ${groupBy} AS time_bucket,
         COALESCE(SUM(kwh_consumed),0)  AS kwh_consumed,
         COALESCE(SUM(kwh_generated),0) AS kwh_generated,
         COALESCE(SUM(co2_kg),0)        AS co2_kg,
         COALESCE(SUM(cost_usd),0)      AS cost_usd
       FROM sensor_readings
       WHERE home_id=$1 AND recorded_at BETWEEN $2 AND $3
       GROUP BY time_bucket ORDER BY time_bucket ASC`,
      [homeId, startDate, endDate]
    );

    // Device breakdown
    const { rows: deviceBreakdown } = await pool.query(
      `SELECT d.name AS device_name, d.type AS device_type, d.room,
         COALESCE(SUM(r.kwh_consumed),0) AS kwh_consumed,
         COALESCE(SUM(r.cost_usd),0)     AS cost_usd,
         COALESCE(SUM(r.co2_kg),0)       AS co2_kg
       FROM sensor_readings r
       JOIN iot_devices d ON d.id = r.device_id
       WHERE r.home_id=$1 AND r.recorded_at BETWEEN $2 AND $3
       GROUP BY d.id, d.name, d.type, d.room
       ORDER BY kwh_consumed DESC`,
      [homeId, startDate, endDate]
    );

    // AI suggestions
    const { rows: aiSuggestions } = await pool.query(
      `SELECT * FROM ai_suggestions
       WHERE home_id=$1 AND is_applied=FALSE
       ORDER BY priority DESC, estimated_savings_usd DESC LIMIT 5`,
      [homeId]
    );

    // Eco score
    const renewablePct = t.total_kwh_consumed > 0
      ? (t.total_kwh_generated / t.total_kwh_consumed) * 100 : 0;
    const ecoScore = Math.min(100, Math.round(
      (renewablePct * 0.5) +
      (Math.max(0, 100 - t.total_co2_kg) * 0.3) +
      (Math.max(0, 100 - t.total_cost_usd) * 0.2)
    ));

    // Previous period comparison
    const { prevStart, prevEnd } = getPrevRange(period, startDate, endDate);
    const { rows: [prev] } = await pool.query(
      `SELECT COALESCE(SUM(kwh_consumed),0) AS kwh,
              COALESCE(SUM(cost_usd),0)     AS cost,
              COALESCE(SUM(co2_kg),0)       AS co2
       FROM sensor_readings WHERE home_id=$1 AND recorded_at BETWEEN $2 AND $3`,
      [homeId, prevStart, prevEnd]
    );

    const pct = (curr, p) => p > 0 ? (((curr - p) / p) * 100).toFixed(1) : '0';
    const comparison = {
      kwh_change_pct:  pct(t.total_kwh_consumed, prev.kwh),
      cost_change_pct: pct(t.total_cost_usd,     prev.cost),
      co2_change_pct:  pct(t.total_co2_kg,       prev.co2),
    };

    res.json({
      success: true,
      period, startDate, endDate,
      totals: { ...t, eco_score: ecoScore, renewable_pct: renewablePct.toFixed(1) },
      comparison,
      chartData,
      deviceBreakdown,
      aiSuggestions,
    });
  } catch (err) {
    console.error('Report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/reports/suggestions/:id/apply ─────────────────
router.patch('/suggestions/:id/apply', async (req, res) => {
  try {
    await pool.query('UPDATE ai_suggestions SET is_applied=TRUE WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports (backwards compat — return summary list) ──
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows } = await pool.query(
      `SELECT ds.*, h.name AS home_name
       FROM daily_summaries ds
       JOIN homes h ON h.id = ds.home_id
       WHERE h.user_id=$1
       ORDER BY ds.report_date DESC LIMIT 30`,
      [userId]
    );
    // Shape for existing ReportsScreen
    const reports = rows.map((r, i) => ({
      id: r.id, period: r.report_date,
      usage: parseFloat(r.total_kwh_consumed),
      cost:  parseFloat(r.total_cost_usd),
      savings: parseFloat(r.savings_usd),
      efficiency: r.eco_score,
    }));
    res.json({ reports });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/reports/detail/:id ───────────────────────────────
router.get('/detail/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.name AS category, SUM(r.kwh_consumed) AS consumption
       FROM sensor_readings r
       JOIN iot_devices d ON d.id = r.device_id
       JOIN daily_summaries ds ON DATE(r.recorded_at) = ds.report_date AND r.home_id = ds.home_id
       WHERE ds.id=$1
       GROUP BY d.name ORDER BY consumption DESC`,
      [req.params.id]
    );
    res.json({ breakdown: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

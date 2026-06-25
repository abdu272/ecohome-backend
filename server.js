const express = require('express');
const cors    = require('cors');
const dotenv  = require('dotenv');
const cron    = require('node-cron');

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Standard Routes ─────────────────────────────────────────
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/user',    require('./routes/user'));
app.use('/api/devices', require('./routes/devices'));
app.use('/api/energy',  require('./routes/energy'));
app.use('/api/ml',      require('./routes/ml'));
app.use('/api/iot',     require('./routes/iot'));
app.use('/api/reports', require('./routes/reports'));

// ── Homes Route (create / get home for a user) ───────────────
const pool = require('./db/pool');
const authenticateToken = require('./middleware/authMiddleware');

app.get('/api/homes', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM homes WHERE user_id=$1 ORDER BY created_at ASC',
      [req.user.id]
    );
    // Auto-create a default home if none exists
    if (rows.length === 0) {
      const { rows: newRows } = await pool.query(
        `INSERT INTO homes (user_id, name) VALUES ($1,'My Home') RETURNING *`,
        [req.user.id]
      );
      return res.json({ homes: newRows });
    }
    res.json({ homes: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PDF Download Route ───────────────────────────────────────
app.get('/api/reports/:homeId/pdf', authenticateToken, async (req, res) => {
  try {
    const { homeId } = req.params;
    const period = req.query.period || 'monthly';

    // Reuse report logic inline (avoid internal HTTP call)
    const getDateRange = (p) => {
      const ref = new Date();
      let s, e;
      if (p === 'daily') {
        s = new Date(ref); s.setHours(0,0,0,0);
        e = new Date(ref); e.setHours(23,59,59,999);
      } else if (p === 'weekly') {
        s = new Date(ref); s.setDate(ref.getDate()-ref.getDay()); s.setHours(0,0,0,0);
        e = new Date(s); e.setDate(s.getDate()+6); e.setHours(23,59,59,999);
      } else {
        s = new Date(ref.getFullYear(), ref.getMonth(), 1);
        e = new Date(ref.getFullYear(), ref.getMonth()+1, 0, 23, 59, 59);
      }
      return { startDate: s, endDate: e };
    };

    const { startDate, endDate } = getDateRange(period);

    const [totalsRes, chartRes, devRes, sugRes] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(kwh_consumed),0) AS total_kwh_consumed,
        COALESCE(SUM(kwh_generated),0) AS total_kwh_generated,
        COALESCE(SUM(cost_usd),0) AS total_cost_usd,
        COALESCE(SUM(co2_kg),0) AS total_co2_kg,
        COALESCE(SUM(kwh_generated)*0.233,0) AS co2_saved_kg
        FROM sensor_readings WHERE home_id=$1 AND recorded_at BETWEEN $2 AND $3`,
        [homeId, startDate, endDate]),
      pool.query(`SELECT DATE(recorded_at) AS time_bucket,
        SUM(kwh_consumed) AS kwh_consumed FROM sensor_readings
        WHERE home_id=$1 AND recorded_at BETWEEN $2 AND $3
        GROUP BY time_bucket ORDER BY time_bucket ASC`, [homeId, startDate, endDate]),
      pool.query(`SELECT d.name AS device_name, d.room,
        SUM(r.kwh_consumed) AS kwh_consumed, SUM(r.cost_usd) AS cost_usd
        FROM sensor_readings r JOIN iot_devices d ON d.id=r.device_id
        WHERE r.home_id=$1 AND r.recorded_at BETWEEN $2 AND $3
        GROUP BY d.id, d.name, d.room ORDER BY kwh_consumed DESC LIMIT 6`,
        [homeId, startDate, endDate]),
      pool.query(`SELECT * FROM ai_suggestions WHERE home_id=$1 AND is_applied=FALSE
        ORDER BY priority DESC LIMIT 5`, [homeId]),
    ]);

    const t = totalsRes.rows[0];
    const renewPct = t.total_kwh_consumed > 0
      ? (t.total_kwh_generated / t.total_kwh_consumed) * 100 : 0;
    const ecoScore = Math.min(100, Math.round(renewPct * 0.5 +
      Math.max(0, 100-t.total_co2_kg)*0.3 + Math.max(0, 100-t.total_cost_usd)*0.2));

    const report = {
      period, startDate, endDate,
      totals: { ...t, eco_score: ecoScore, renewable_pct: renewPct.toFixed(1) },
      comparison: { kwh_change_pct: 0, cost_change_pct: 0, co2_change_pct: 0 },
      chartData:       chartRes.rows,
      deviceBreakdown: devRes.rows,
      aiSuggestions:   sugRes.rows,
    };

    const { generatePDF } = require('./pdf_generator');
    const pdfBuffer = await generatePDF(report);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="eco-report-${period}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });
    res.end(pdfBuffer);
  } catch (err) {
    console.error('PDF error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI Suggestion Apply Route ────────────────────────────────
app.patch('/api/suggestions/:id/apply', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE ai_suggestions SET is_applied=TRUE WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Health check ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status:'ok', db:'postgresql', message:'SmartEnergyAI Backend Running' });
  } catch (err) { res.status(500).json({ status:'error', message: err.message }); }
});

// ── AI Cron — runs nightly at midnight ──────────────────────
cron.schedule('0 0 * * *', async () => {
  try {
    const { rows: homes } = await pool.query('SELECT id FROM homes');
    for (const h of homes) {
      const end   = new Date();
      const start = new Date(end); start.setDate(start.getDate()-7);

      const { rows } = await pool.query(
        `SELECT d.type, d.room,
           AVG(r.kwh_consumed) AS avg_kwh, AVG(r.temperature_c) AS avg_temp,
           SUM(r.cost_usd) AS total_cost, EXTRACT(HOUR FROM r.recorded_at) AS hour
         FROM sensor_readings r JOIN iot_devices d ON d.id=r.device_id
         WHERE r.home_id=$1 AND r.recorded_at BETWEEN $2 AND $3
         GROUP BY d.type, d.room, hour ORDER BY avg_kwh DESC`,
        [h.id, start, end]
      );

      for (const row of rows) {
        if (row.hour >= 18 && row.hour <= 22 && row.avg_kwh > 2) {
          await pool.query(
            `INSERT INTO ai_suggestions (home_id,category,title,description,estimated_savings_usd,estimated_co2_kg,priority)
             VALUES ($1,'schedule',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
            [h.id,
             `Shift ${row.type} usage off peak hours`,
             `Your ${row.type} in ${row.room||'home'} uses ${parseFloat(row.avg_kwh).toFixed(2)} kWh during peak hours (6–10 PM). Shifting to off-peak could save up to 30%.`,
             (row.total_cost * 0.3).toFixed(2),
             (row.avg_kwh * 7 * 0.233 * 0.3).toFixed(2),
             row.avg_kwh > 5 ? 'high' : 'medium']
          );
        }
        if (row.type === 'thermostat' && row.avg_temp > 22) {
          await pool.query(
            `INSERT INTO ai_suggestions (home_id,category,title,description,estimated_savings_usd,estimated_co2_kg,priority)
             VALUES ($1,'heating',$2,$3,$4,$5,'medium') ON CONFLICT DO NOTHING`,
            [h.id,
             'Lower thermostat by 2°C',
             `Reducing temp from ${parseFloat(row.avg_temp).toFixed(1)}°C saves up to 10% heating energy.`,
             (row.total_cost * 0.1).toFixed(2),
             (row.avg_kwh * 7 * 0.233 * 0.1).toFixed(2)]
          );
        }
      }
      console.log(`✅ AI suggestions updated for home ${h.id}`);
    }
  } catch (err) { console.error('Cron error:', err.message); }
});

// ── Start ────────────────────────────────────────────────────
pool.query('SELECT NOW()')
  .then(({ rows }) => {
    console.log(`✅ PostgreSQL connected — ${rows[0].now}`);
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 SmartEnergyAI Backend → http://0.0.0.0:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ PostgreSQL connection failed:', err.message);
    process.exit(1);
  });

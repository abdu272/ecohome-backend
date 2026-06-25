const express  = require('express');
const bcrypt    = require('bcryptjs');
const router    = express.Router();
const pool      = require('../db/pool');
const authenticateToken = require('../middleware/authMiddleware');

router.use(authenticateToken);

// ── GET /api/user/profile ─────────────────────────────────────
router.get('/profile', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, full_name, email, phone, role, created_at FROM users WHERE id=$1',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    res.json({
      success: true,
      user: {
        id:        u.id,
        fullName:  u.full_name,
        email:     u.email,
        phone:     u.phone || '',
        role:      u.role,
        createdAt: u.created_at,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /api/user/profile ─────────────────────────────────────
router.put('/profile', async (req, res) => {
  const { fullName, phone, email } = req.body;
  try {
    // Check email uniqueness if changed
    if (email) {
      const { rows } = await pool.query(
        'SELECT id FROM users WHERE email=$1 AND id<>$2',
        [email.toLowerCase().trim(), req.user.id]
      );
      if (rows.length) return res.status(409).json({ error: 'Email already in use.' });
    }
    const { rows } = await pool.query(
      `UPDATE users
         SET full_name = COALESCE($1, full_name),
             phone     = COALESCE($2, phone),
             email     = COALESCE($3, email),
             updated_at = NOW()
       WHERE id = $4
       RETURNING id, full_name, email, phone, role`,
      [fullName?.trim() || null, phone?.trim() || null, email?.toLowerCase().trim() || null, req.user.id]
    );
    const u = rows[0];
    res.json({
      success: true,
      message: 'Profile updated successfully.',
      user: { id: u.id, fullName: u.full_name, email: u.email, phone: u.phone, role: u.role },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /api/user/change-password ──────────────────────────
router.patch('/change-password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'currentPassword and newPassword are required.' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  try {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.user.id]);
    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /api/user/preferences ─────────────────────────────────
router.put('/preferences', (req, res) => {
  res.json({ success: true, message: 'Preferences updated', preferences: req.body });
});

// ── GET /api/user/stats ───────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(kwh_consumed),0) AS total_kwh,
              COALESCE(SUM(cost_usd),0)     AS total_cost,
              COALESCE(SUM(co2_kg),0)       AS total_co2,
              COUNT(DISTINCT device_id)     AS devices
       FROM sensor_readings r
       JOIN homes h ON h.id = r.home_id
       WHERE h.user_id = $1`,
      [req.user.id]
    );
    res.json({ success: true, stats: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

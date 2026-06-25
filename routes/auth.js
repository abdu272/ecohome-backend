// routes/auth.js  — PostgreSQL-backed auth (register / login / forgot / reset)
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const pool     = require('../db/pool');

const router = express.Router();

const JWT_SECRET  = process.env.JWT_SECRET  || 'change-me-in-production';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
const OTP_TTL_MS  = 10 * 60 * 1000; // 10 minutes

// ── helpers ──────────────────────────────────────────────────────────────────
const signToken = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

const safeUser = (row) => ({
  id:         row.id,
  fullName:   row.full_name,
  email:      row.email,
  phone:      row.phone,
  role:       row.role,
  isVerified: row.is_verified,
  createdAt:  row.created_at,
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { fullName, email, phone, password } = req.body;

  if (!fullName || !email || !password)
    return res.status(400).json({ error: 'fullName, email and password are required.' });

  try {
    // Duplicate check
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rowCount > 0)
      return res.status(409).json({ error: 'An account with this email already exists.' });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, phone, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [fullName.trim(), email.toLowerCase().trim(), phone || null, hash]
    );

    const user  = rows[0];
    const token = signToken({ id: user.id, email: user.email, role: user.role });

    res.status(201).json({ message: 'Account created successfully.', token, user: safeUser(user) });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0)
      return res.status(401).json({ error: 'Invalid email or password.' });

    const user  = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Invalid email or password.' });

    const token = signToken({ id: user.id, email: user.email, role: user.role });
    res.json({ message: 'Login successful.', token, user: safeUser(user) });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    // Always respond OK to avoid email enumeration
    if (rows.length === 0)
      return res.json({ message: 'If that email exists, a code has been sent.' });

    const userId  = rows[0].id;
    const otp     = crypto.randomInt(100000, 999999).toString(); // 6 digits
    const expires = new Date(Date.now() + OTP_TTL_MS);

    // Invalidate old tokens
    await pool.query('UPDATE otp_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE', [userId]);
    await pool.query(
      'INSERT INTO otp_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [userId, otp, expires]
    );

    // TODO: Send email via nodemailer / SendGrid
    // await sendOTPEmail(email, otp);
    console.log(`OTP for ${email}: ${otp}`);   // dev only — remove in production

    res.json({ message: 'If that email exists, a code has been sent.' });
  } catch (err) {
    console.error('Forgot-password error:', err.message);
    res.status(500).json({ error: 'Could not send reset code. Please try again.' });
  }
});

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP are required.' });

  try {
    const { rows } = await pool.query(
      `SELECT ot.id, ot.expires_at, ot.used
       FROM otp_tokens ot
       JOIN users u ON u.id = ot.user_id
       WHERE u.email = $1 AND ot.token = $2
       ORDER BY ot.created_at DESC
       LIMIT 1`,
      [email.toLowerCase().trim(), otp]
    );

    if (rows.length === 0)       return res.status(400).json({ error: 'Invalid code.' });
    if (rows[0].used)            return res.status(400).json({ error: 'Code already used.' });
    if (new Date() > rows[0].expires_at)
                                 return res.status(400).json({ error: 'Code has expired.' });

    res.json({ message: 'OTP verified.' });
  } catch (err) {
    console.error('Verify-OTP error:', err.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// ── POST /api/auth/reset-password ────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword)
    return res.status(400).json({ error: 'email, otp and newPassword are required.' });

  try {
    const { rows } = await pool.query(
      `SELECT ot.id, ot.expires_at, ot.used, u.id AS user_id
       FROM otp_tokens ot
       JOIN users u ON u.id = ot.user_id
       WHERE u.email = $1 AND ot.token = $2
       ORDER BY ot.created_at DESC
       LIMIT 1`,
      [email.toLowerCase().trim(), otp]
    );

    if (rows.length === 0)       return res.status(400).json({ error: 'Invalid or expired code.' });
    if (rows[0].used)            return res.status(400).json({ error: 'Code already used.' });
    if (new Date() > rows[0].expires_at)
                                 return res.status(400).json({ error: 'Code has expired.' });

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, rows[0].user_id]);
    await pool.query('UPDATE otp_tokens SET used = TRUE WHERE id = $1', [rows[0].id]);

    res.json({ message: 'Password reset successfully.' });
  } catch (err) {
    console.error('Reset-password error:', err.message);
    res.status(500).json({ error: 'Password reset failed. Please try again.' });
  }
});

module.exports = router;

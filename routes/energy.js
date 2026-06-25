const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authMiddleware');

router.use(authenticateToken);

router.get('/current', (req, res) => {
  res.json({ currentUsage: 0, efficiency: 0, gridLoad: 'N/A', monthlyEstimate: 0, savings: 0, aiProjected: 0, goal: 0 });
});

router.get('/trend', (req, res) => {
  res.json({ period: req.query.period || '24h', totalConsumption: 0, status: 'N/A', data: [] });
});

router.get('/breakdown', (req, res) => {
  res.json({ appliances: [] });
});

router.get('/optimizations', (req, res) => {
  res.json({ optimizations: [] });
});

module.exports = router;

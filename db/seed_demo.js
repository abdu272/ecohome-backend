// db/seed_demo.js
// Seeds demo IoT devices + 30 days of sensor readings for user id=3 (aw51725@gmail.com)
// Run: node db/seed_demo.js

require('dotenv').config();
const pool = require('./pool');

async function seed() {
  try {
    const userId = 3; // Abdul Wahid's user id

    // 1. Create home if not exists
    let { rows: homes } = await pool.query(
      'SELECT id FROM homes WHERE user_id=$1 LIMIT 1', [userId]
    );
    let homeId;
    if (homes.length === 0) {
      const r = await pool.query(
        `INSERT INTO homes (user_id, name, area_sqft, num_rooms)
         VALUES ($1,'My Smart Home',1800,4) RETURNING id`, [userId]
      );
      homeId = r.rows[0].id;
      console.log(`✅ Created home id=${homeId}`);
    } else {
      homeId = homes[0].id;
      console.log(`ℹ️  Using existing home id=${homeId}`);
    }

    // 2. Create demo IoT devices
    const deviceDefs = [
      { name:'Smart Meter',    type:'smart_meter',  room:'Utility' },
      { name:'Solar Array',    type:'solar_panel',  room:'Roof' },
      { name:'HVAC System',    type:'thermostat',   room:'Living Room' },
      { name:'EV Charger',     type:'ev_charger',   room:'Garage' },
      { name:'Washing Machine',type:'appliance',    room:'Laundry' },
    ];

    const deviceIds = [];
    for (const d of deviceDefs) {
      let { rows } = await pool.query(
        'SELECT id FROM iot_devices WHERE home_id=$1 AND name=$2 LIMIT 1', [homeId, d.name]
      );
      if (rows.length === 0) {
        const r = await pool.query(
          'INSERT INTO iot_devices (home_id,name,type,room) VALUES ($1,$2,$3,$4) RETURNING id',
          [homeId, d.name, d.type, d.room]
        );
        deviceIds.push({ id: r.rows[0].id, ...d });
      } else {
        deviceIds.push({ id: rows[0].id, ...d });
      }
    }
    console.log(`✅ Devices ready: ${deviceIds.map(d=>d.name).join(', ')}`);

    // 3. Seed 30 days × 8 readings per day per device
    const now = new Date();
    let inserted = 0;
    for (let day = 30; day >= 0; day--) {
      for (let hour = 0; hour < 24; hour += 3) { // every 3 hours
        const ts = new Date(now);
        ts.setDate(ts.getDate() - day);
        ts.setHours(hour, 0, 0, 0);

        for (const device of deviceIds) {
          let kwh_consumed = 0, kwh_generated = 0, temp = null;

          if (device.type === 'smart_meter') {
            kwh_consumed = +(0.8 + Math.random() * 1.5).toFixed(3);
          } else if (device.type === 'solar_panel') {
            // Solar only generates during daylight
            kwh_generated = (hour >= 6 && hour <= 18)
              ? +(Math.random() * 1.2).toFixed(3) : 0;
          } else if (device.type === 'thermostat') {
            kwh_consumed = +(0.4 + Math.random() * 0.8).toFixed(3);
            temp = +(20 + Math.random() * 5).toFixed(1);
          } else if (device.type === 'ev_charger') {
            // Only charges at night
            kwh_consumed = (hour >= 22 || hour <= 6)
              ? +(1.5 + Math.random() * 2).toFixed(3) : 0;
          } else {
            kwh_consumed = +(0.1 + Math.random() * 0.5).toFixed(3);
          }

          if (kwh_consumed === 0 && kwh_generated === 0) continue;

          const co2  = +(kwh_consumed * 0.233).toFixed(4);
          const cost = +(kwh_consumed * 0.12).toFixed(4);

          await pool.query(
            `INSERT INTO sensor_readings
             (device_id, home_id, kwh_consumed, kwh_generated, voltage, temperature_c, co2_kg, cost_usd, recorded_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [device.id, homeId, kwh_consumed, kwh_generated, 230, temp, co2, cost, ts]
          );
          inserted++;
        }
      }
    }
    console.log(`✅ Inserted ${inserted} sensor readings (30 days)`);

    // 4. Seed AI suggestions
    const suggestions = [
      { cat:'schedule', title:'Shift EV charging to off-peak hours',
        desc:'Your EV charger runs during peak hours (6–10 PM). Shifting to 11 PM–6 AM saves up to 30% on charging costs and reduces grid load.',
        savings:18.50, co2:5.2, priority:'high' },
      { cat:'solar',    title:'Optimise solar self-consumption',
        desc:'You export 32% of generated solar energy back to the grid. Scheduling heavy appliances (washing machine, dishwasher) between 10 AM–2 PM can maximise self-consumption.',
        savings:12.00, co2:3.8, priority:'medium' },
      { cat:'heating',  title:'Lower thermostat by 2°C at night',
        desc:'Reducing temperature from 23°C to 21°C during sleeping hours (10 PM–6 AM) can save up to 10% on heating energy while maintaining comfort.',
        savings:8.20,  co2:2.1, priority:'medium' },
      { cat:'appliance',title:'Run appliances in eco mode',
        desc:'Enabling eco mode on your washing machine reduces energy use by up to 40% per cycle with no reduction in cleaning performance.',
        savings:5.40,  co2:1.5, priority:'low' },
    ];

    for (const s of suggestions) {
      await pool.query(
        `INSERT INTO ai_suggestions (home_id,category,title,description,estimated_savings_usd,estimated_co2_kg,priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [homeId, s.cat, s.title, s.desc, s.savings, s.co2, s.priority]
      );
    }
    console.log(`✅ AI suggestions seeded`);
    console.log(`\n🎉 Done! Home ID for reports: ${homeId}`);
    console.log(`   API: GET /api/reports/${homeId}?period=monthly`);
  } catch (err) {
    console.error('❌ Seed error:', err.message);
  } finally {
    await pool.end();
  }
}

seed();

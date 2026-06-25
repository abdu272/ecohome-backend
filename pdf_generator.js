// backend/pdf_generator.js
const PDFDocument = require('pdfkit');

const C = {
  primary:   '#1B5E20',
  green:     '#2E7D32',
  lightGreen:'#4CAF50',
  orange:    '#F59E0B',
  red:       '#EF4444',
  dark:      '#0D1117',
  gray:      '#6B7280',
  lightGray: '#F3F4F6',
  white:     '#FFFFFF',
};

const generatePDF = (report) => new Promise((resolve, reject) => {
  try {
    const doc    = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data',  c   => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { totals, comparison, deviceBreakdown, aiSuggestions, period, startDate, endDate } = report;
    const PW = doc.page.width;
    const W  = PW - 100;

    // ── HEADER ────────────────────────────────────────────────
    doc.rect(0, 0, PW, 130).fill(C.dark);
    doc.fillColor(C.white).fontSize(28).font('Helvetica-Bold').text('EcoHome AI', 50, 35);
    doc.fontSize(14).font('Helvetica').text('Sustainability Report', 50, 68);

    const periodLabel = period.charAt(0).toUpperCase() + period.slice(1);
    const fmt = (d) => new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    doc.fontSize(10).fillColor('#A5D6A7').text(`${periodLabel}  •  ${fmt(startDate)} — ${fmt(endDate)}`, 50, 95);

    // Eco Score badge
    const score = totals.eco_score || 0;
    const sc    = score >= 75 ? C.lightGreen : score >= 50 ? C.orange : C.red;
    doc.circle(PW - 75, 65, 40).fill(sc);
    doc.fillColor(C.white).fontSize(22).font('Helvetica-Bold')
       .text(score.toString(), PW - 97, 50, { width: 44, align: 'center' });
    doc.fontSize(8).font('Helvetica')
       .text('ECO SCORE', PW - 100, 78, { width: 50, align: 'center' });

    let y = 155;

    const sectionTitle = (title, yp) => {
      doc.fillColor(C.dark).fontSize(13).font('Helvetica-Bold').text(title, 50, yp);
      doc.moveTo(50, yp + 18).lineTo(PW - 50, yp + 18).strokeColor('#E5E7EB').lineWidth(1).stroke();
      return yp + 28;
    };

    const statCard = (x, yp, w, h, label, value, unit, change, color) => {
      doc.roundedRect(x, yp, w, h, 8).fill(C.lightGray);
      doc.roundedRect(x, yp, 4, h, 2).fill(color);
      doc.fillColor(C.gray).fontSize(8).font('Helvetica').text(label.toUpperCase(), x+12, yp+10, { width: w-16 });
      doc.fillColor(C.dark).fontSize(18).font('Helvetica-Bold').text(value, x+12, yp+24, { width: w-16 });
      doc.fillColor(C.gray).fontSize(9).font('Helvetica').text(unit, x+12, yp+46, { width: w-16 });
      if (change != null) {
        const down  = parseFloat(change) < 0;
        const arrow = down ? '↓' : '↑';
        const cc    = down ? C.green : C.red;
        doc.fillColor(cc).fontSize(9).text(`${arrow} ${Math.abs(change)}% vs last ${period}`, x+12, yp+60, { width: w-16 });
      }
    };

    // ── KEY METRICS ───────────────────────────────────────────
    y = sectionTitle('Key Metrics', y);
    const cw = (W - 30) / 4, ch = 88;
    statCard(50,                  y, cw, ch, 'Energy Used',      `${parseFloat(totals.total_kwh_consumed||0).toFixed(1)} kWh`, 'total consumed',    comparison.kwh_change_pct,  C.primary);
    statCard(50+(cw+10),          y, cw, ch, 'Solar Generated',  `${parseFloat(totals.total_kwh_generated||0).toFixed(1)} kWh`, 'generated',       null,                        C.lightGreen);
    statCard(50+(cw+10)*2,        y, cw, ch, 'Total Cost',       `$${parseFloat(totals.total_cost_usd||0).toFixed(2)}`, 'electricity bill', comparison.cost_change_pct, C.orange);
    statCard(50+(cw+10)*3,        y, cw, ch, 'CO2 Emitted',      `${parseFloat(totals.total_co2_kg||0).toFixed(2)} kg`, 'CO2 equivalent',  comparison.co2_change_pct,  C.red);
    y += ch + 28;

    // ── RENEWABLE BAR ─────────────────────────────────────────
    y = sectionTitle('Renewable Energy', y);
    const rp = parseFloat(totals.renewable_pct||0);
    doc.roundedRect(50, y, W, 22, 11).fill('#E5E7EB');
    if (rp > 0) doc.roundedRect(50, y, Math.max(22, W*rp/100), 22, 11).fill(C.lightGreen);
    doc.fillColor(C.white).fontSize(10).font('Helvetica-Bold').text(`${rp}% Renewable`, 62, y+6);
    doc.fillColor(C.gray).fontSize(9).font('Helvetica')
       .text(`${parseFloat(totals.co2_saved_kg||0).toFixed(2)} kg CO2 saved by solar generation`, 50, y+30);
    y += 56;

    // ── DEVICE BREAKDOWN ──────────────────────────────────────
    if (deviceBreakdown?.length > 0) {
      y = sectionTitle('Device Energy Breakdown', y);
      const maxKwh = Math.max(...deviceBreakdown.map(d => parseFloat(d.kwh_consumed||0)));
      deviceBreakdown.slice(0,6).forEach((device, i) => {
        const kwh  = parseFloat(device.kwh_consumed||0);
        const pct  = maxKwh > 0 ? kwh/maxKwh : 0;
        const rowY = y + i*32;
        doc.fillColor(C.dark).fontSize(10).font('Helvetica').text(device.device_name||device.name, 50, rowY+4, { width:150 });
        doc.fillColor(C.gray).fontSize(8).text(device.room||device.device_type||'', 50, rowY+16, { width:150 });
        const bs = 210, bw = W-170;
        doc.roundedRect(bs, rowY+6, bw, 12, 6).fill('#E5E7EB');
        if (pct > 0) doc.roundedRect(bs, rowY+6, Math.max(12, bw*pct), 12, 6).fill(C.primary);
        doc.fillColor(C.dark).fontSize(9).font('Helvetica-Bold').text(`${kwh.toFixed(2)} kWh`, bs+bw+8, rowY+6, { width:60 });
        doc.fillColor(C.gray).fontSize(8).font('Helvetica').text(`$${parseFloat(device.cost_usd||0).toFixed(2)}`, bs+bw+8, rowY+18, { width:60 });
      });
      y += deviceBreakdown.slice(0,6).length * 32 + 20;
    }

    // ── AI SUGGESTIONS ────────────────────────────────────────
    if (aiSuggestions?.length > 0) {
      if (y > 620) { doc.addPage(); y = 50; }
      y = sectionTitle('AI Optimization Suggestions', y);
      aiSuggestions.forEach((s, i) => {
        const sY = y + i*72;
        const pc = s.priority === 'high' ? C.red : s.priority === 'medium' ? C.orange : C.lightGreen;
        doc.roundedRect(50, sY, W, 64, 8).fill(C.lightGray);
        doc.roundedRect(50, sY, 4, 64, 2).fill(pc);
        doc.fillColor(C.dark).fontSize(11).font('Helvetica-Bold').text(s.title, 64, sY+8, { width: W-120 });
        doc.fillColor(C.gray).fontSize(8).font('Helvetica').text(s.description, 64, sY+24, { width: W-120, height:28, ellipsis:true });
        doc.roundedRect(W-48, sY+8, 88, 22, 6).fill(C.lightGreen);
        doc.fillColor(C.white).fontSize(9).font('Helvetica-Bold')
           .text(`Save $${parseFloat(s.estimated_savings_usd||0).toFixed(0)}`, W-50, sY+14, { width:84, align:'center' });
        doc.fillColor(C.gray).fontSize(8).font('Helvetica')
           .text(`${parseFloat(s.estimated_co2_kg||0).toFixed(1)} kg CO2`, W-50, sY+36, { width:84, align:'center' });
      });
    }

    // ── FOOTER ────────────────────────────────────────────────
    const pH = doc.page.height;
    doc.rect(0, pH-50, PW, 50).fill(C.dark);
    doc.fillColor('#A5D6A7').fontSize(9).font('Helvetica')
       .text('Generated by EcoHome AI  •  Confidential', 50, pH-30, { width: PW-100, align:'center' });

    doc.end();
  } catch (err) { reject(err); }
});

module.exports = { generatePDF };

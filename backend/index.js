require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// Expiry status helper — null/empty expiry means "no expiry"
function getExpiryStatus(expiryDate) {
  if (!expiryDate) return { daysLeft: null, status: 'none' };
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const exp = new Date(expiryDate);
  if (isNaN(exp.getTime())) return { daysLeft: null, status: 'none' };
  exp.setHours(0, 0, 0, 0);
  const daysLeft = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
  let status = 'ok';
  if (daysLeft < 0) status = 'expired';
  else if (daysLeft <= 7) status = 'critical';
  else if (daysLeft <= 30) status = 'warning';
  return { daysLeft, status };
}

function withStatus(med) {
  const obj = med.toObject ? med.toObject() : med;
  return { ...obj, acknowledged: !!obj.acknowledgedAt, ...getExpiryStatus(obj.expiryDate) };
}

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/pharmalala';

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/pharmalala', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('Mongo connected')).catch(err => console.error(err));

// Models
const User = require('./models/User');
const Medicine = require('./models/Medicine');
const Reminder = require('./models/Reminder');

// Simple JWT middleware
function auth(req, res, next) {
  const token = req.header('Authorization')?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'devsecret');
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
}

// Auth
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Missing fields' });
  const existing = await User.findOne({ email });
  if (existing) return res.status(400).json({ message: 'Email in use' });
  const hash = await bcrypt.hash(password, 10);
  const user = await User.create({ name, email, password: hash });
  const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET || 'devsecret');
  res.json({ token, user: { id: user._id, email: user.email, name: user.name } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.status(400).json({ message: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ message: 'Invalid credentials' });
  const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET || 'devsecret');
  res.json({ token, user: { id: user._id, email: user.email, name: user.name } });
});

// Medicines (owner-only)
app.post('/api/medicines', auth, async (req, res) => {
  try {
    const { name, batch, expiryDate, quantity, notes } = req.body;
    if (!name) return res.status(400).json({ message: 'name is required' });
    let exp = undefined;
    if (expiryDate) {
      exp = new Date(expiryDate);
      if (isNaN(exp.getTime())) return res.status(400).json({ message: 'Invalid expiryDate' });
    }
    const med = await Medicine.create({ name, batch, expiryDate: exp, quantity: quantity ?? 1, notes, user: req.user.id });
    res.json(withStatus(med));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Expiring soon — must be before /:id routes
app.get('/api/medicines/expiring', auth, async (req, res) => {
  try {
    const days = parseInt(req.query.days || '180', 10);
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() + days);
    const q = { user: req.user.id, expiryDate: { $ne: null, $lte: cutoff } };
    if (req.query.unacked === 'true') q.acknowledgedAt = null;
    const meds = await Medicine.find(q).sort({ expiryDate: 1 });
    res.json(meds.map(withStatus));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/medicines', auth, async (req, res) => {
  const meds = await Medicine.find({ user: req.user.id }).sort({ expiryDate: 1 });
  res.json(meds.map(withStatus));
});

app.put('/api/medicines/:id', auth, async (req, res) => {
  try {
    const { name, batch, expiryDate, quantity, notes } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (batch !== undefined) update.batch = batch;
    if (quantity !== undefined) update.quantity = quantity;
    if (notes !== undefined) update.notes = notes;
    if (expiryDate !== undefined) {
      if (expiryDate === null || expiryDate === '') {
        update.$unset = { expiryDate: 1 };
        update.acknowledgedAt = null; // new date situation — require fresh acknowledgement
      } else {
        const exp = new Date(expiryDate);
        if (isNaN(exp.getTime())) return res.status(400).json({ message: 'Invalid expiryDate' });
        update.expiryDate = exp;
        update.acknowledgedAt = null; // expiry changed — require fresh acknowledgement
      }
    }
    const med = await Medicine.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      update,
      { new: true }
    );
    if (!med) return res.status(404).json({ message: 'Not found' });
    res.json(withStatus(med));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.delete('/api/medicines/:id', auth, async (req, res) => {
  const med = await Medicine.findOneAndDelete({ _id: req.params.id, user: req.user.id });
  if (!med) return res.status(404).json({ message: 'Not found' });
  res.json({ ok: true });
});

// Acknowledge: stops notifications for this medicine, expiry display stays
app.patch('/api/medicines/:id/acknowledge', auth, async (req, res) => {
  const med = await Medicine.findOneAndUpdate(
    { _id: req.params.id, user: req.user.id },
    { acknowledgedAt: new Date() },
    { new: true }
  );
  if (!med) return res.status(404).json({ message: 'Not found' });
  res.json(withStatus(med));
});

app.patch('/api/medicines/:id/unacknowledge', auth, async (req, res) => {
  const med = await Medicine.findOneAndUpdate(
    { _id: req.params.id, user: req.user.id },
    { acknowledgedAt: null },
    { new: true }
  );
  if (!med) return res.status(404).json({ message: 'Not found' });
  res.json(withStatus(med));
});

// Excel import: multipart field `file`, columns name/batch/expiryDate/quantity/notes
const multer = require('multer');
const XLSX = require('xlsx');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/medicines/import', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded (field: file)' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const failed = [];
    const valid = [];

    // Pick sheet: prefer one with GENERIC/BRAND headers (Sheet1 style) or Medicine Name (Medicines style)
    function detectSheet(name) {
      const ws = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (!rows.length) return null;
      const head = rows[0].map(h => String(h).trim().toLowerCase());
      if (head.includes('brand names') || head.includes('generic')) return { kind: 'sheet1', rows };
      if (head.includes('medicine name')) return { kind: 'medicines', rows };
      return null;
    }
    let picked = null;
    for (const n of wb.SheetNames) {
      if (/summary/i.test(n)) continue;
      const d = detectSheet(n);
      if (d) { picked = d; break; }
    }
    // fallback: first non-empty non-summary sheet as sheet1-style positional parse
    if (!picked) {
      for (const n of wb.SheetNames) {
        if (/summary/i.test(n)) continue;
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' });
        if (rows.length > 1) { picked = { kind: 'sheet1', rows }; break; }
      }
    }
    if (!picked) return res.status(400).json({ message: 'No importable sheet found' });

    function parseExpiry(v) {
      if (v === '' || v === null || v === undefined) return undefined;
      if (v instanceof Date && !isNaN(v.getTime())) return v;
      const d = new Date(v);
      return isNaN(d.getTime()) ? 'invalid' : d;
    }

    if (picked.kind === 'sheet1') {
      // Positional: GENERIC(0) | batch?(1) | qty(2) | BRAND(3) | EXPIRY(4)
      // Header row may be at index 0 — skip it (it has no brand/generic data pattern of counts, but detect explicitly)
      let lastGeneric = '';
      for (let i = 0; i < picked.rows.length; i++) {
        const r = picked.rows[i];
        const genericCell = String(r[0] || '').trim();
        const brand = String(r[3] || '').trim();
        if (i === 0 && /generic/i.test(genericCell)) continue; // header row
        if (genericCell) lastGeneric = genericCell;
        const generic = genericCell || lastGeneric; // forward-fill group header
        if (!generic && !brand) continue; // blank row
        const rowNum = i + 1;
        const name = brand && generic ? `${brand} (${generic})` : (brand || generic);
        const batch = String(r[1] || '').trim();
        const qtyRaw = r[2];
        const quantity = qtyRaw === '' ? 1 : Number(qtyRaw);
        if (isNaN(quantity)) { failed.push({ row: rowNum, error: 'Invalid quantity' }); continue; }
        const exp = parseExpiry(r[4]);
        if (exp === 'invalid') { failed.push({ row: rowNum, error: 'Invalid EXPIRY date' }); continue; }
        valid.push({ name, batch, notes: generic && brand ? generic : '', expiryDate: exp, quantity, user: req.user.id });
      }
    } else {
      // Medicines style: Medicine Name | Batch No. | Expiration Date | ...
      const head = picked.rows[0].map(h => String(h).trim().toLowerCase());
      const ci = (n) => head.indexOf(n);
      const iName = ci('medicine name'), iBatch = ci('batch no.'), iExp = ci('expiration date');
      for (let i = 1; i < picked.rows.length; i++) {
        const r = picked.rows[i];
        const name = String(r[iName] || '').trim();
        if (!name && !r[iBatch] && !r[iExp]) continue;
        const rowNum = i + 1;
        if (!name) { failed.push({ row: rowNum, error: 'Missing Medicine Name' }); continue; }
        const exp = parseExpiry(r[iExp]);
        if (exp === 'invalid') { failed.push({ row: rowNum, error: 'Invalid Expiration Date' }); continue; }
        valid.push({ name, batch: String(r[iBatch] || '').trim(), notes: '', expiryDate: exp, quantity: 1, user: req.user.id });
      }
    }

    let inserted = 0;
    if (valid.length) {
      const docs = await Medicine.insertMany(valid);
      inserted = docs.length;
    }
    res.json({ inserted, failed });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Reminders
app.post('/api/reminders', auth, async (req, res) => {
  const { medicineId, time, repeat } = req.body;
  const reminder = await Reminder.create({ medicine: medicineId, user: req.user.id, time, repeat });
  res.json(reminder);
});

app.get('/api/reminders', auth, async (req, res) => {
  const reminders = await Reminder.find({ user: req.user.id }).populate('medicine');
  res.json(reminders);
});

// Health check
app.get('/ping', (req, res) => res.json({ ok: true, time: Date.now() }));

app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on ${PORT}`));

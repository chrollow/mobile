import * as FileSystem from 'expo-file-system';
import api from './api';
import { getMirror, setMirror, getQueue, setQueue, enqueue, clearQueue, localId } from './store';

function sortMeds(list) {
  return [...list].sort((a, b) => {
    if (!a.expiryDate && !b.expiryDate) return 0;
    if (!a.expiryDate) return 1;
    if (!b.expiryDate) return -1;
    return new Date(a.expiryDate) - new Date(b.expiryDate);
  });
}

// ---------- online primitives (mirror after each success) ----------
async function onlineList() {
  const res = await api.get('/api/medicines');
  const list = sortMeds(res.data);
  await setMirror(list);
  return list;
}

async function onlineAdd(payload) {
  const res = await api.post('/api/medicines', payload);
  const mirror = await getMirror();
  await setMirror(sortMeds([...mirror, res.data]));
  return res.data;
}

async function onlineEdit(id, payload) {
  const res = await api.put(`/api/medicines/${id}`, payload);
  const mirror = await getMirror();
  await setMirror(sortMeds(mirror.map(m => (m._id === id ? res.data : m))));
  return res.data;
}

async function onlineDelete(id) {
  await api.delete(`/api/medicines/${id}`);
  const mirror = await getMirror();
  await setMirror(mirror.filter(m => m._id !== id));
}

async function onlineAck(id) {
  const res = await api.patch(`/api/medicines/${id}/acknowledge`);
  const mirror = await getMirror();
  await setMirror(mirror.map(m => (m._id === id ? res.data : m)));
  return res.data;
}

// ---------- offline primitives (local write + queued op) ----------
async function offlineAdd(payload) {
  const doc = { ...payload, _id: localId(), acknowledged: false, updatedAt: new Date().toISOString() };
  const mirror = await getMirror();
  await setMirror(sortMeds([...mirror, doc]));
  await enqueue({ type: 'add', doc });
  return doc;
}

async function offlineEdit(id, payload) {
  const mirror = await getMirror();
  const next = mirror.map(m => (m._id === id ? { ...m, ...payload, updatedAt: new Date().toISOString() } : m));
  await setMirror(sortMeds(next));
  await enqueue({ type: 'edit', id, payload });
  return next.find(m => m._id === id);
}

async function offlineDelete(id) {
  const mirror = await getMirror();
  await setMirror(mirror.filter(m => m._id !== id));
  await enqueue({ type: 'delete', id });
}

async function offlineAck(id) {
  const mirror = await getMirror();
  const next = mirror.map(m => (m._id === id ? { ...m, acknowledged: true, acknowledgedAt: new Date().toISOString() } : m));
  await setMirror(next);
  await enqueue({ type: 'ack', id });
  return next.find(m => m._id === id);
}

// ---------- mode-aware facade ----------
export const repo = {
  async list(mode) {
    if (mode === 'offline') return sortMeds(await getMirror());
    try {
      return await onlineList();
    } catch (e) {
      // fall back to mirror when the server is unreachable
      return sortMeds(await getMirror());
    }
  },
  async add(mode, payload) {
    return mode === 'offline' ? offlineAdd(payload) : onlineAdd(payload);
  },
  async edit(mode, id, payload) {
    if (mode === 'offline') return offlineEdit(id, payload);
    // editing a local-only doc while online: push as add, drop the temp doc
    if (String(id).startsWith('local-')) {
      const created = await onlineAdd(payload);
      const mirror = await getMirror();
      await setMirror(mirror.filter(m => m._id !== id));
      return created;
    }
    return onlineEdit(id, payload);
  },
  async remove(mode, id) {
    if (mode === 'offline') return offlineDelete(id);
    if (String(id).startsWith('local-')) {
      const mirror = await getMirror();
      await setMirror(mirror.filter(m => m._id !== id));
      return;
    }
    return onlineDelete(id);
  },
  async ack(mode, id) {
    if (mode === 'offline') return offlineAck(id);
    if (String(id).startsWith('local-')) {
      const mirror = await getMirror();
      await setMirror(mirror.map(m => (m._id === id ? { ...m, acknowledged: true } : m)));
      return;
    }
    return onlineAck(id);
  },

  // Push queued ops in order, then pull fresh state (last-write-wins, single device).
  async sync() {
    const queue = await getQueue();
    const idMap = {}; // local temp id -> server id
    for (const op of queue) {
      try {
        if (op.type === 'add') {
          const { _id, ...payload } = op.doc;
          const created = await onlineAdd(payload);
          idMap[_id] = created._id;
        } else if (op.type === 'edit') {
          const id = idMap[op.id] || op.id;
          if (String(id).startsWith('local-')) continue; // add op failed earlier; skip
          await onlineEdit(id, op.payload);
        } else if (op.type === 'delete') {
          const id = idMap[op.id] || op.id;
          if (String(id).startsWith('local-')) {
            const mirror = await getMirror();
            await setMirror(mirror.filter(m => m._id !== op.id));
            continue;
          }
          await onlineDelete(id);
        } else if (op.type === 'ack') {
          const id = idMap[op.id] || op.id;
          if (String(id).startsWith('local-')) continue;
          await onlineAck(id);
        }
      } catch (e) {
        // stop on first failure, keep remaining ops queued
        const idx = queue.indexOf(op);
        await setQueue(queue.slice(idx));
        return { ok: false, pushed: idx, error: e?.response?.data?.message || e.message };
      }
    }
    await clearQueue();
    const list = await onlineList();
    return { ok: true, pushed: queue.length, list };
  },
};

// ---------- on-device Excel parse (offline import, MED.xlsx Sheet1 format) ----------
export async function parseExcelLocal(uri) {
  const XLSX = require('xlsx');
  const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  const wb = XLSX.read(b64, { type: 'base64', cellDates: true });
  const valid = [];
  const failed = [];
  const sheets = wb.SheetNames.filter(n => !/summary/i.test(n));
  for (const name of sheets) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    if (!rows.length) continue;
    const head = rows[0].map(h => String(h).trim().toLowerCase());
    const isSheet1 = head.includes('brand names') || head.includes('generic');
    const isMedicines = head.includes('medicine name');
    if (!isSheet1 && !isMedicines) continue;
    let lastGeneric = '';
    const start = isSheet1 ? 0 : 1;
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      if (isSheet1) {
        const gCell = String(r[0] || '').trim();
        const brand = String(r[3] || '').trim();
        if (i === 0 && /generic/i.test(gCell)) continue;
        if (gCell) lastGeneric = gCell;
        const generic = gCell || lastGeneric;
        if (!generic && !brand) continue;
        const qty = r[2] === '' ? 1 : Number(r[2]);
        if (isNaN(qty)) { failed.push({ row: i + 1, error: 'Invalid quantity' }); continue; }
        let exp;
        const e = r[4];
        if (e !== '' && e != null) {
          exp = e instanceof Date && !isNaN(e) ? e.toISOString() : new Date(e);
          if (isNaN(new Date(exp).getTime())) { failed.push({ row: i + 1, error: 'Invalid EXPIRY date' }); continue; }
          exp = new Date(exp).toISOString();
        }
        valid.push({
          name: brand && generic ? `${brand} (${generic})` : brand || generic,
          batch: String(r[1] || '').trim(),
          expiryDate: exp || '',
          quantity: qty,
          notes: generic && brand ? generic : '',
        });
      } else {
        const ci = n => head.indexOf(n);
        const nm = String(r[ci('medicine name')] || '').trim();
        if (!nm && !r[ci('batch no.')] && !r[ci('expiration date')]) continue;
        if (!nm) { failed.push({ row: i + 1, error: 'Missing Medicine Name' }); continue; }
        let exp = '';
        const e = r[ci('expiration date')];
        if (e !== '' && e != null) {
          exp = e instanceof Date && !isNaN(e) ? e.toISOString() : new Date(e);
          if (isNaN(new Date(exp).getTime())) { failed.push({ row: i + 1, error: 'Invalid Expiration Date' }); continue; }
          exp = new Date(exp).toISOString();
        }
        valid.push({ name: nm, batch: String(r[ci('batch no.')] || '').trim(), expiryDate: exp, quantity: 1, notes: '' });
      }
    }
    if (valid.length || failed.length) break; // first importable sheet wins
  }
  return { valid, failed };
}

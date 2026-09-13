import AsyncStorage from '@react-native-async-storage/async-storage';

// Lightweight on-device store: medicine mirror + pending op queue + mode.
// Uses AsyncStorage (no native deps, works in Expo Go and dev builds).
// Medicine lists here are small (hundreds of rows), so JSON is plenty fast.

const K_MEDS = 'pharmalala.meds.v1';
const K_QUEUE = 'pharmalala.queue.v1';
const K_MODE = 'pharmalala.mode.v1'; // 'online' | 'offline'
const K_SESSION = 'pharmalala.hadSession.v1'; // '1' after first successful login

async function readJSON(key, fallback) {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJSON(key, val) {
  await AsyncStorage.setItem(key, JSON.stringify(val));
}

export async function getMirror() {
  return readJSON(K_MEDS, []);
}

export async function setMirror(list) {
  await writeJSON(K_MEDS, list);
}

export async function getQueue() {
  return readJSON(K_QUEUE, []);
}

export async function setQueue(q) {
  await writeJSON(K_QUEUE, q);
}

export async function enqueue(op) {
  const q = await getQueue();
  q.push({ ...op, at: Date.now() });
  await setQueue(q);
  return q.length;
}

export async function clearQueue() {
  await setQueue([]);
}

export async function getMode() {
  const m = await AsyncStorage.getItem(K_MODE);
  return m === 'offline' ? 'offline' : 'online';
}

export async function setModeRaw(mode) {
  await AsyncStorage.setItem(K_MODE, mode);
}

export async function hadSession() {
  return (await AsyncStorage.getItem(K_SESSION)) === '1';
}

export async function markSession() {
  await AsyncStorage.setItem(K_SESSION, '1');
}

export function localId() {
  return `local-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

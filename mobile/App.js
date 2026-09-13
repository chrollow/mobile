import React, { useEffect, useRef, useState } from 'react';
import {
  Alert, Animated, FlatList, Modal, Platform, Pressable, RefreshControl,
  SafeAreaView, StyleSheet, Text, TextInput, View, ActivityIndicator, ScrollView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as DocumentPicker from 'expo-document-picker';
import Constants from 'expo-constants';
import api, { setAuthToken, getStoredToken } from './api';
import { repo, parseExcelLocal } from './repo';
import { getMode, setModeRaw, getQueue, hadSession, markSession } from './store';

// Notifications are only available in a dev build / production — Expo Go
// crashes on the static import (SDK 53+), so load it lazily and no-op there.
const inExpoGo = Constants.appOwnership === 'expo';
let Notifications;
if (!inExpoGo) {
  Notifications = require('expo-notifications');
} else {
  const noop = async () => {};
  Notifications = {
    setNotificationHandler: noop,
    setNotificationChannelAsync: noop,
    getPermissionsAsync: async () => ({ granted: false }),
    requestPermissionsAsync: async () => ({ granted: false }),
    setBadgeCountAsync: noop,
    cancelAllScheduledNotificationsAsync: noop,
    scheduleNotificationAsync: noop,
    AndroidImportance: { MAX: 4 },
  };
}

// ---------- notifications (6-month window, persistent until acknowledged) ----------
const NOTIF_DAYS = 180;

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true }),
});

async function setupNotifications() {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('expiry', {
        name: 'Expiry reminders',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
      });
    }
    const cur = await Notifications.getPermissionsAsync();
    if (!cur.granted) await Notifications.requestPermissionsAsync();
  } catch (e) { console.warn('Notif setup', e.message); }
}

// Items needing attention: dated, unacknowledged, expiring within 6 months (or expired)
function pendingNotifs(list) {
  return list.filter(m => {
    if (!m.expiryDate || m.acknowledged) return false;
    const { daysLeft } = getStatus(m);
    return daysLeft !== null && daysLeft <= NOTIF_DAYS;
  });
}

async function syncNotifications(list) {
  try {
    const pending = pendingNotifs(list);
    await Notifications.setBadgeCountAsync(pending.length);
    await Notifications.cancelAllScheduledNotificationsAsync();
    if (pending.length) {
      const names = pending.slice(0, 3).map(m => m.name).join(', ');
      const more = pending.length > 3 ? ` +${pending.length - 3} more` : '';
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `${pending.length} medicine${pending.length > 1 ? 's' : ''} expiring within 6 months`,
          body: `${names}${more} — tap to review and acknowledge.`,
        },
        trigger: { hour: 9, minute: 0, repeats: true, channelId: 'expiry' },
      });
    }
  } catch (e) { console.warn('Notif sync', e.message); }
}

// ---------- theme ----------
const T = {
  teal: '#0d7377', tealDark: '#09595c', bg: '#f2f5f5', card: '#fff',
  ink: '#123332', muted: '#6b8a89', line: '#e3ecec',
  expired: '#d32f2f', critical: '#f57c00', warning: '#c89300', ok: '#2e9e5b', none: '#90a4ae',
};
const STATUS_LABEL = { expired: 'Expired', critical: 'Critical', warning: 'Soon', ok: 'Good', none: 'No expiry' };

function getStatus(med) {
  if (med.status) return { status: med.status, daysLeft: med.daysLeft ?? null };
  if (!med.expiryDate) return { status: 'none', daysLeft: null };
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const exp = new Date(med.expiryDate);
  if (isNaN(exp.getTime())) return { status: 'none', daysLeft: null };
  exp.setHours(0, 0, 0, 0);
  const daysLeft = Math.ceil((exp - now) / 86400000);
  let status = 'ok';
  if (daysLeft < 0) status = 'expired';
  else if (daysLeft <= 7) status = 'critical';
  else if (daysLeft <= 30) status = 'warning';
  return { status, daysLeft };
}

function sortMeds(list) {
  return [...list].sort((a, b) => {
    if (!a.expiryDate && !b.expiryDate) return 0;
    if (!a.expiryDate) return 1;
    if (!b.expiryDate) return -1;
    return new Date(a.expiryDate) - new Date(b.expiryDate);
  });
}

// ---------- small animated pressable ----------
function Btn({ title, onPress, variant = 'primary' }) {
  const s = useRef(new Animated.Value(1)).current;
  const pressIn = () => Animated.spring(s, { toValue: 0.95, useNativeDriver: true }).start();
  const pressOut = () => Animated.spring(s, { toValue: 1, useNativeDriver: true }).start();
  return (
    <Animated.View style={{ transform: [{ scale: s }] }}>
      <Pressable
        onPress={onPress} onPressIn={pressIn} onPressOut={pressOut}
        style={[styles.btn, variant === 'primary' ? styles.btnPrimary : styles.btnGhost]}
      >
        <Text style={variant === 'primary' ? styles.btnText : styles.btnGhostText}>{title}</Text>
      </Pressable>
    </Animated.View>
  );
}

// ---------- animated medicine card ----------
function MedCard({ item, index, onDelete, onEdit, onAck }) {
  const { status, daysLeft } = getStatus(item);
  const needsAck = item.expiryDate && !item.acknowledged && daysLeft !== null && daysLeft <= NOTIF_DAYS;
  const enter = useRef(new Animated.Value(0)).current;
  const delAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 350, delay: Math.min(index * 60, 600), useNativeDriver: true }).start();
  }, []);
  const remove = () => {
    Animated.timing(delAnim, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => onDelete(item._id));
  };
  const color = T[status];
  const pct = status === 'none' ? 0 : status === 'expired' ? 1 : status === 'ok' ? 0.08 : Math.max(0.12, 1 - Math.max(daysLeft, 0) / 30);
  return (
    <Animated.View style={{ opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }, { scale: delAnim }], marginBottom: 12 }}>
      <View style={styles.card}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <View style={{ flex: 1 }}>
          <View style={styles.cardRow}>
            <Text style={styles.cardName}>{item.name}</Text>
            <View style={[styles.pill, { backgroundColor: color + '18', borderColor: color + '55' }]}>
              <Text style={[styles.pillText, { color }]}>{STATUS_LABEL[status]}{daysLeft !== null ? ` · ${daysLeft}d` : ''}</Text>
            </View>
          </View>
          <Text style={styles.cardSub}>
            {item.expiryDate ? new Date(item.expiryDate).toLocaleDateString() : 'No expiry date'}{item.batch ? `  ·  Batch ${item.batch}` : ''}{item.quantity ? `  ·  ×${item.quantity}` : ''}
          </Text>
          {!!item.notes && <Text style={styles.cardNotes}>{item.notes}</Text>}
          {status !== 'none' && <View style={styles.bar}><View style={[styles.barFill, { backgroundColor: color, width: `${Math.round(pct * 100)}%` }]} /></View>}
          <View style={styles.cardActions}>
            <Pressable onPress={() => onEdit(item)} style={styles.editBtn}><Text style={styles.editText}>Edit</Text></Pressable>
            {needsAck ? <Pressable onPress={() => onAck(item._id)} style={styles.ackBtn}><Text style={styles.ackText}>✓ Acknowledge</Text></Pressable> : null}
            <Pressable onPress={remove} style={styles.delBtn}><Text style={styles.delText}>Delete</Text></Pressable>
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

// ---------- stats: monthly expiry bars (next 6 months) ----------
function StatsChart({ meds, monthFilter, onSelectMonth }) {
  const months = [];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleString('default', { month: 'short' }), y: d.getFullYear(), m: d.getMonth(), count: 0 });
  }
  meds.forEach(med => {
    if (!med.expiryDate) return;
    const e = new Date(med.expiryDate);
    if (isNaN(e.getTime())) return;
    const key = `${e.getFullYear()}-${e.getMonth()}`;
    const slot = months.find(x => x.key === key);
    if (slot) slot.count++;
  });
  const max = Math.max(1, ...months.map(x => x.count));
  return (
    <View style={styles.statsCard}>
      <Text style={styles.statsTitle}>Expiring by month</Text>
      <View style={styles.bars}>
        {months.map(s => (
          <Pressable key={s.key} onPress={() => onSelectMonth(monthFilter === s.key ? null : s.key)} style={styles.barCol}>
            <Text style={[styles.barNum, monthFilter === s.key && { color: T.teal, fontWeight: '800' }]}>{s.count}</Text>
            <View style={styles.barTrack}>
              <Animated.View style={[styles.barFillV, { height: `${Math.round((s.count / max) * 100)}%`, backgroundColor: monthFilter === s.key ? T.teal : '#7fc4c6' }]} />
            </View>
            <Text style={[styles.barLbl, monthFilter === s.key && { color: T.teal, fontWeight: '800' }]}>{s.label}</Text>
          </Pressable>
        ))}
      </View>
      {monthFilter ? <Pressable onPress={() => onSelectMonth(null)}><Text style={styles.clearFilter}>Clear month filter ✕</Text></Pressable> : null}
    </View>
  );
}

export default function App() {
  const [mode, setMode] = useState('auth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [meds, setMeds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('all');
  const [monthFilter, setMonthFilter] = useState(null);
  const [showStats, setShowStats] = useState(true);
  const [importResult, setImportResult] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const [netMode, setNetMode] = useState('online'); // 'online' | 'offline'
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const sheetY = useRef(new Animated.Value(600)).current;
  const fade = useRef(new Animated.Value(0)).current;

  const [name, setName] = useState('');
  const [batch, setBatch] = useState('');
  const [expDate, setExpDate] = useState(null); // Date | null = no expiry
  const [expWebText, setExpWebText] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    (async () => {
      const savedMode = await getMode();
      setNetMode(savedMode);
      const t = await getStoredToken();
      setupNotifications();
      if (t) {
        setAuthToken(t);
        await markSession();
        setMode('app');
        loadMeds(false, savedMode);
      } else if (await hadSession()) {
        // returning user, token cleared: allow offline entry with saved data
        setMode('app');
        loadMeds(false, 'offline');
      }
    })();
    Animated.timing(fade, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, []);

  useEffect(() => {
    Animated.spring(sheetY, { toValue: sheetOpen ? 0 : 600, useNativeDriver: true, damping: 26, stiffness: 260 }).start();
  }, [sheetOpen]);

  const counts = { expired: 0, critical: 0, warning: 0, none: 0, ok: 0 };
  meds.forEach(m => { const s = getStatus(m).status; counts[s]++; });

  async function refreshPending() {
    setPendingCount((await getQueue()).length);
  }

  async function loadMeds(showAlert = true, modeOverride) {
    const m = modeOverride || netMode;
    setLoading(true);
    try {
      const list = await repo.list(m);
      setMeds(list);
      refreshPending();
      if (m === 'online') syncNotifications(list);
      if (showAlert && list.length) {
        const pend = pendingNotifs(list);
        if (pend.length > 0) Alert.alert('Expiry reminder', `${pend.length} medicine${pend.length > 1 ? 's' : ''} expiring within 6 months — review and acknowledge.`);
      }
    } catch (err) { console.warn('Load error', err?.response?.data || err.message); }
    setLoading(false);
  }

  async function acknowledge(id) {
    try {
      const updated = await repo.ack(netMode, id);
      setMeds(prev => { const next = prev.map(m => m._id === id ? { ...m, ...updated } : m); if (netMode === 'online') syncNotifications(next); return next; });
      refreshPending();
    } catch (err) { console.warn('Ack error', err?.response?.data || err.message); }
  }

  async function acknowledgeAll() {
    const pend = pendingNotifs(meds);
    for (const m of pend) {
      try {
        const updated = await repo.ack(netMode, m._id);
        setMeds(prev => prev.map(x => x._id === m._id ? { ...x, ...updated } : x));
      } catch (err) { console.warn('Ack-all error', err?.response?.data || err.message); }
    }
    refreshPending();
    loadMeds(false);
  }

  function resetForm() {
    setName(''); setBatch(''); setExpDate(null); setExpWebText('');
    setQuantity('1'); setNotes(''); setFormError(''); setEditingId(null);
  }
  function openAdd() { resetForm(); setSheetOpen(true); }
  function openEdit(item) {
    setEditingId(item._id);
    setName(item.name || ''); setBatch(item.batch || '');
    setExpDate(item.expiryDate ? new Date(item.expiryDate) : null);
    setExpWebText(item.expiryDate ? new Date(item.expiryDate).toISOString().slice(0, 10) : '');
    setQuantity(String(item.quantity ?? 1)); setNotes(item.notes || '');
    setFormError(''); setSheetOpen(true);
  }

  function effectiveExpiry() {
    if (Platform.OS === 'web') {
      if (!expWebText.trim()) return undefined;
      const d = new Date(expWebText.trim());
      return isNaN(d.getTime()) ? 'invalid' : d;
    }
    return expDate || undefined;
  }

  async function saveMedicine() {
    setFormError('');
    if (!name.trim()) return setFormError('Name is required.');
    const exp = effectiveExpiry();
    if (exp === 'invalid') return setFormError('Expiry must be a valid date.');
    const payload = {
      name: name.trim(), batch: batch.trim(),
      expiryDate: exp ? exp.toISOString() : '',
      quantity: Number(quantity) || 1, notes: notes.trim(),
    };
    try {
      if (editingId) {
        const updated = await repo.edit(netMode, editingId, payload);
        setMeds(prev => sortMeds(prev.map(m => m._id === editingId ? { ...m, ...updated } : m)));
      } else {
        const created = await repo.add(netMode, payload);
        setMeds(prev => sortMeds([...prev, created]));
      }
      refreshPending();
      setSheetOpen(false); resetForm();
    } catch (err) { setFormError(err?.response?.data?.message || err.message); }
  }

  async function deleteMedicine(id) {
    try { await repo.remove(netMode, id); setMeds(prev => prev.filter(m => m._id !== id)); refreshPending(); }
    catch (err) { console.warn('Delete error', err?.response?.data || err.message); }
  }

  async function pickAndUploadExcel() {
    setImportResult(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', copyToCacheDirectory: true,
      });
      if (picked.canceled) return;
      const file = picked.assets[0];
      if (netMode === 'offline') {
        // on-device parse, added straight to the local list
        const { valid, failed } = await parseExcelLocal(file.uri);
        for (const v of valid) await repo.add('offline', v);
        setImportResult({ inserted: valid.length, failed });
        Alert.alert('Import done', `Inserted ${valid.length}, failed ${failed.length} (offline — will sync)`);
        loadMeds(false);
        return;
      }
      const form = new FormData();
      form.append('file', { uri: file.uri, name: file.name || 'medicines.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const res = await api.post('/api/medicines/import', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setImportResult(res.data);
      Alert.alert('Import done', `Inserted ${res.data.inserted}, failed ${res.data.failed?.length || 0}`);
      loadMeds(false);
    } catch (err) {
      console.warn('Import error', err?.response?.data || err.message);
      Alert.alert('Import failed', err?.response?.data?.message || err.message);
    }
  }

  async function toggleNetMode() {
    if (syncing) return;
    if (netMode === 'online') {
      await setModeRaw('offline');
      setNetMode('offline');
      loadMeds(false, 'offline');
    } else {
      setSyncing(true);
      try {
        const r = await repo.sync();
        if (!r.ok) {
          Alert.alert('Sync incomplete', `Pushed ${r.pushed} change(s), then stopped: ${r.error}. Staying offline.`);
          await loadMeds(false, 'offline');
        } else {
          await setModeRaw('online');
          setNetMode('online');
          setMeds(r.list);
          syncNotifications(r.list);
          if (r.pushed > 0) Alert.alert('Back online', `Synced ${r.pushed} offline change(s).`);
        }
      } catch (err) {
        Alert.alert('Sync failed', err?.response?.data?.message || err.message);
      }
      refreshPending();
      setSyncing(false);
    }
  }

  async function doAuth(kind) {
    setAuthBusy(true);
    try {
      const url = kind === 'register' ? '/api/auth/register' : '/api/auth/login';
      const res = await api.post(url, kind === 'register' ? { name: 'Mobile', email, password } : { email, password });
      await setAuthToken(res.data.token);
      await markSession();
      setupNotifications();
      setMode('app'); loadMeds();
    } catch (err) { Alert.alert('Auth failed', err?.response?.data?.message || err.message); }
    setAuthBusy(false);
  }

  async function continueOffline() {
    try {
      const list = await repo.list('offline');
      setNetMode('offline');
      await setModeRaw('offline');
      setMeds(list);
      refreshPending();
      setMode('app');
    } catch (err) { Alert.alert('Offline unavailable', err.message); }
  }

  async function handleLogout() {
    await setAuthToken(null);
    setMode('auth'); setEmail(''); setPassword(''); setMeds([]);
  }

  const filtered = meds.filter(m => {
    const { status } = getStatus(m);
    if (monthFilter && m.expiryDate) {
      const e = new Date(m.expiryDate);
      if (`${e.getFullYear()}-${e.getMonth()}` !== monthFilter) return false;
    } else if (monthFilter && !m.expiryDate) return false;
    if (filter === 'expiring') return status !== 'ok' && status !== 'none';
    if (filter === 'expired') return status === 'expired';
    if (filter === 'noexpiry') return status === 'none';
    return true;
  });

  if (mode === 'auth') {
    return (
      <LinearGradient colors={[T.tealDark, T.teal]} style={{ flex: 1 }}>
        <SafeAreaView style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
          <Animated.View style={{ opacity: fade }}>
            <Text style={styles.hero}>PharmAlala</Text>
            <Text style={styles.heroSub}>Never miss a medicine expiry again.</Text>
            <View style={styles.authCard}>
              <TextInput placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" style={styles.input} />
              <TextInput placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry style={styles.input} />
              {authBusy ? <ActivityIndicator /> : (
                <><Btn title="Login" onPress={() => doAuth('login')} /><View style={{ height: 8 }} /><Btn title="Create account" onPress={() => doAuth('register')} variant="ghost" /><View style={{ height: 8 }} /><Btn title="Continue offline" onPress={continueOffline} variant="ghost" /></>
              )}
            </View>
          </Animated.View>
        </SafeAreaView>
      </LinearGradient>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: T.bg }}>
      <LinearGradient colors={[T.tealDark, T.teal]} style={styles.header}>
        <SafeAreaView>
          <View style={styles.headerRow}>
            <View><Text style={styles.heroSmall}>PharmAlala</Text><Text style={styles.headerSub}>{meds.length} medicines tracked</Text></View>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Pressable onPress={toggleNetMode} style={[styles.modeToggle, netMode === 'offline' && styles.modeToggleOff]}>
                <Text style={styles.modeToggleText}>{syncing ? 'Syncing…' : netMode === 'online' ? '● Online' : '○ Offline'}</Text>
              </Pressable>
              <Pressable onPress={handleLogout} style={styles.logout}><Text style={styles.logoutText}>Logout</Text></Pressable>
            </View>
          </View>
          <View style={styles.stats}>
            {[{ l: 'Expired', v: counts.expired }, { l: '≤ 7 days', v: counts.critical }, { l: '≤ 30 days', v: counts.warning }, { l: 'No expiry', v: counts.none }].map(s => (
              <View key={s.l} style={styles.stat}><Text style={styles.statNum}>{s.v}</Text><Text style={styles.statLbl}>{s.l}</Text></View>
            ))}
          </View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
        {netMode === 'offline' && (
          <View style={styles.offlineBar}>
            <Text style={styles.offlineText}>Offline mode — {pendingCount} change{pendingCount === 1 ? '' : 's'} pending sync</Text>
          </View>
        )}
        {pendingNotifs(meds).length > 0 && (
          <View style={styles.banner}>
            <Text style={styles.bannerTitle}>⚠ {pendingNotifs(meds).length} medicine{pendingNotifs(meds).length > 1 ? 's' : ''} expiring within 6 months</Text>
            {pendingNotifs(meds).slice(0, 3).map(m => {
              const { daysLeft } = getStatus(m);
              return (
                <View key={m._id} style={styles.bannerRow}>
                  <Text style={styles.bannerText}>{m.name} ({daysLeft}d)</Text>
                  <Pressable onPress={() => acknowledge(m._id)} style={styles.bannerAck}><Text style={styles.bannerAckText}>✓ Got it</Text></Pressable>
                </View>
              );
            })}
            <Pressable onPress={acknowledgeAll} style={styles.bannerAll}><Text style={styles.bannerAllText}>Acknowledge all</Text></Pressable>
          </View>
        )}
        <Pressable onPress={() => setShowStats(v => !v)} style={styles.statsToggle}>
          <Text style={styles.statsToggleText}>{showStats ? '▼' : '▶'} Statistics</Text>
        </Pressable>
        {showStats && <StatsChart meds={meds} monthFilter={monthFilter} onSelectMonth={setMonthFilter} />}

        <View style={styles.pills}>
          {['all', 'expiring', 'expired', 'noexpiry'].map(f => (
            <Pressable key={f} onPress={() => setFilter(f)} style={[styles.pillBtn, filter === f && styles.pillBtnActive]}>
              <Text style={[styles.pillBtnText, filter === f && styles.pillBtnTextActive]}>{f === 'noexpiry' ? 'No expiry' : f[0].toUpperCase() + f.slice(1)}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable onPress={pickAndUploadExcel} style={styles.uploadBtn}>
          <Text style={styles.uploadText}>⭳ Upload Excel (MED.xlsx format)</Text>
        </Pressable>
        {importResult ? <Text style={styles.importNote}>Inserted {importResult.inserted}, failed {importResult.failed?.length || 0}</Text> : null}

        {loading && meds.length === 0 ? (
          <View style={{ paddingTop: 24 }}><ActivityIndicator size="large" color={T.teal} /><Text style={styles.hintCenter}>Loading medicines…</Text></View>
        ) : (
          <FlatList
            data={filtered} keyExtractor={i => i._id} scrollEnabled={false}
            contentContainerStyle={{ paddingBottom: 96 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await loadMeds(false); setRefreshing(false); }} />}
            ListEmptyComponent={<Text style={styles.hintCenter}>No medicines here. Tap + to add one.</Text>}
            renderItem={({ item, index }) => <MedCard item={item} index={index} onDelete={deleteMedicine} onEdit={openEdit} onAck={acknowledge} />}
          />
        )}
      </ScrollView>

      <Pressable onPress={openAdd} style={styles.fab}><Text style={styles.fabText}>＋</Text></Pressable>

      <Modal visible={sheetOpen} transparent animationType="none" onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setSheetOpen(false)} />
        <Animated.View style={[styles.sheet, { transform: [{ translateY: sheetY }] }]}>
          <View style={styles.grab} />
          <Text style={styles.sheetTitle}>{editingId ? 'Edit medicine' : 'Add medicine'}</Text>
          <TextInput placeholder="Name *" value={name} onChangeText={setName} style={styles.input} />
          <TextInput placeholder="Batch" value={batch} onChangeText={setBatch} style={styles.input} />
          {Platform.OS === 'web' ? (
            <TextInput placeholder="Expiry YYYY-MM-DD (blank = no expiry)" value={expWebText} onChangeText={setExpWebText} style={styles.input} />
          ) : (
            <View style={styles.dateRow}>
              <Pressable onPress={() => setShowPicker(true)} style={[styles.input, styles.dateBtn]}>
                <Text style={expDate ? styles.dateText : styles.datePlaceholder}>
                  {expDate ? expDate.toLocaleDateString() : 'Pick expiry date (optional)'}
                </Text>
              </Pressable>
              {expDate ? <Pressable onPress={() => setExpDate(null)} style={styles.clearDate}><Text style={styles.clearDateText}>✕</Text></Pressable> : null}
            </View>
          )}
          {showPicker && Platform.OS !== 'web' && (
            <DateTimePicker
              value={expDate || new Date()} mode="date"
              onChange={(e, d) => { setShowPicker(false); if (d) setExpDate(d); }}
            />
          )}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput placeholder="Qty" value={quantity} onChangeText={setQuantity} keyboardType="numeric" style={[styles.input, { flex: 1 }]} />
            <TextInput placeholder="Notes" value={notes} onChangeText={setNotes} style={[styles.input, { flex: 2 }]} />
          </View>
          {formError ? <Text style={styles.err}>{formError}</Text> : null}
          <Btn title={editingId ? 'Save changes' : 'Save medicine'} onPress={saveMedicine} />
          <View style={{ height: 8 }} />
          <Btn title="Cancel" onPress={() => { setSheetOpen(false); resetForm(); }} variant="ghost" />
        </Animated.View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { fontSize: 40, fontWeight: '800', color: '#fff' },
  heroSmall: { fontSize: 26, fontWeight: '800', color: '#fff' },
  heroSub: { color: '#d7efef', marginBottom: 16, fontSize: 15 },
  headerSub: { color: '#d7efef', fontSize: 13 },
  header: { paddingHorizontal: 20, paddingBottom: 18, borderBottomLeftRadius: 24, borderBottomRightRadius: 24 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  logout: { backgroundColor: 'rgba(255,255,255,.18)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  logoutText: { color: '#fff', fontWeight: '600' },
  modeToggle: { backgroundColor: 'rgba(255,255,255,.22)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20 },
  modeToggleOff: { backgroundColor: '#ffb74d' },
  modeToggleText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  offlineBar: { backgroundColor: '#e8f4f4', borderWidth: 1, borderColor: T.teal, borderRadius: 14, padding: 10, marginBottom: 10, alignItems: 'center' },
  offlineText: { color: T.tealDark, fontWeight: '700', fontSize: 13 },
  stats: { flexDirection: 'row', marginTop: 14, gap: 8 },
  stat: { flex: 1, backgroundColor: 'rgba(255,255,255,.12)', borderRadius: 14, padding: 10, alignItems: 'center' },
  statNum: { fontSize: 20, fontWeight: '800', color: '#fff' },
  statLbl: { fontSize: 11, fontWeight: '600', color: '#d7efef' },
  body: { flex: 1, padding: 16 },
  statsToggle: { marginBottom: 8 },
  statsToggleText: { color: T.teal, fontWeight: '700', fontSize: 15 },
  statsCard: { backgroundColor: '#fff', borderRadius: 16, padding: 14, marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8 },
  statsTitle: { fontWeight: '800', color: T.ink, marginBottom: 10 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', height: 130 },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  barNum: { fontSize: 12, color: T.muted, fontWeight: '700' },
  barTrack: { width: 26, height: 84, backgroundColor: '#edf3f3', borderRadius: 6, justifyContent: 'flex-end', overflow: 'hidden', marginVertical: 4 },
  barFillV: { width: 26, borderRadius: 6 },
  barLbl: { fontSize: 11, color: T.muted },
  clearFilter: { color: T.teal, fontWeight: '700', marginTop: 8 },
  pills: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  pillBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#e4eeed' },
  pillBtnActive: { backgroundColor: T.teal },
  pillBtnText: { color: T.muted, fontWeight: '700' },
  pillBtnTextActive: { color: '#fff' },
  uploadBtn: { marginTop: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: T.line, padding: 12, borderRadius: 14, alignItems: 'center' },
  uploadText: { color: T.teal, fontWeight: '700' },
  hintCenter: { textAlign: 'center', color: T.muted, marginTop: 24 },
  importNote: { color: T.teal, fontWeight: '600', marginTop: 6 },
  card: { flexDirection: 'row', backgroundColor: T.card, borderRadius: 16, padding: 14, gap: 10, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  cardName: { fontSize: 16, fontWeight: '700', color: T.ink, flex: 1 },
  pill: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  pillText: { fontSize: 11, fontWeight: '700' },
  cardSub: { color: T.muted, fontSize: 13, marginTop: 2 },
  cardNotes: { color: T.ink, fontSize: 13, marginTop: 2, fontStyle: 'italic' },
  bar: { height: 6, backgroundColor: '#edf3f3', borderRadius: 3, marginTop: 8, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },
  banner: { backgroundColor: '#fff7e6', borderWidth: 1, borderColor: '#f0c36d', borderRadius: 16, padding: 14, marginBottom: 12 },
  bannerTitle: { fontWeight: '800', color: '#8a5a00', marginBottom: 8 },
  bannerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  bannerText: { color: T.ink, flex: 1, fontSize: 13 },
  bannerAck: { backgroundColor: T.teal, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 },
  bannerAckText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  bannerAll: { marginTop: 8, alignSelf: 'flex-start' },
  bannerAllText: { color: T.teal, fontWeight: '700' },
  ackBtn: { alignSelf: 'flex-start' },
  ackText: { color: T.teal, fontWeight: '600' },
  cardActions: { flexDirection: 'row', gap: 16, marginTop: 8 },
  editBtn: { alignSelf: 'flex-start' },
  editText: { color: T.teal, fontWeight: '600' },
  delBtn: { alignSelf: 'flex-start' },
  delText: { color: T.expired, fontWeight: '600' },
  fab: { position: 'absolute', right: 20, bottom: 28, width: 60, height: 60, borderRadius: 30, backgroundColor: T.teal, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8 },
  fabText: { color: '#fff', fontSize: 30, marginTop: -2 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,.4)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 32 },
  grab: { width: 44, height: 5, borderRadius: 3, backgroundColor: '#d5e2e1', alignSelf: 'center', marginBottom: 12 },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: T.ink, marginBottom: 12 },
  input: { borderWidth: 1, borderColor: T.line, borderRadius: 12, padding: 12, marginBottom: 10, backgroundColor: '#fbfdfd', fontSize: 15 },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dateBtn: { flex: 1, justifyContent: 'center' },
  dateText: { color: T.ink, fontSize: 15 },
  datePlaceholder: { color: '#9ab5b4', fontSize: 15 },
  clearDate: { backgroundColor: '#e4eeed', borderRadius: 12, padding: 12, marginBottom: 10 },
  clearDateText: { color: T.teal, fontWeight: '700' },
  err: { color: T.expired, marginBottom: 8 },
  btn: { borderRadius: 14, padding: 14, alignItems: 'center' },
  btnPrimary: { backgroundColor: T.teal },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  btnGhost: { backgroundColor: '#e4eeed' },
  btnGhostText: { color: T.teal, fontWeight: '700', fontSize: 15 },
  authCard: { backgroundColor: '#fff', borderRadius: 20, padding: 20, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 12, elevation: 4 },
});

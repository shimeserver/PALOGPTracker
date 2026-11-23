import { View, Text, StyleSheet, TouchableOpacity, Switch, ActivityIndicator, Alert } from 'react-native';
import { useExternalGpsStore, RecordHz, ExternalGpsStatus, isExternalGpsLive } from '../store/externalGpsStore';
import { useTrackingStore } from '../store/trackingStore';

const STATUS_LABEL: Record<ExternalGpsStatus, string> = {
  off: '未接続',
  scanning: '検索中…',
  connecting: '接続中…',
  connected: '接続済み',
  reconnecting: '再接続中…',
  error: 'エラー',
};

const HZ_OPTIONS: RecordHz[] = [1, 2, 5];

export default function ExternalGpsSettings() {
  const s = useExternalGpsStore();
  const isTracking = useTrackingStore(t => t.isTracking);
  const live = isExternalGpsLive(s);
  const fix = s.lastFix;
  const scanning = s.status === 'scanning' || (s.scanResults.length > 0);

  const confirmForget = () => {
    Alert.alert('登録解除', `${s.deviceName ?? 'この機器'} の登録を解除しますか？`, [
      { text: 'キャンセル', style: 'cancel' },
      { text: '解除', style: 'destructive', onPress: () => s.forgetDevice() },
    ]);
  };

  return (
    <View style={styles.card}>
      <Text style={styles.desc}>
        RaceBox Mini / Mini S / Micro を Bluetooth で接続すると、記録に外部GPS（最大25Hz・高精度）を使います。
        外部GPSが途切れた区間は自動でスマホのGPSに切り替わります。
      </Text>

      {s.deviceId ? (
        <>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.deviceName}>📡 {s.deviceName ?? s.deviceId}</Text>
              <Text style={[styles.status, live ? styles.ok : s.status === 'error' ? styles.ng : null]}>
                {STATUS_LABEL[s.status]}
                {s.status === 'connected' && fix && !fix.validFix ? '（測位待ち）' : ''}
              </Text>
            </View>
            <Switch value={s.enabled} onValueChange={v => s.setEnabled(v)} />
          </View>

          {s.status === 'connected' && fix && (
            <View style={styles.liveBox}>
              <Live label="測位" value={fix.validFix ? '3D' : fix.fixType === 2 ? '2D' : 'なし'} />
              <Live label="衛星" value={String(fix.satellites)} />
              <Live label="精度" value={`±${fix.hAcc < 10 ? fix.hAcc.toFixed(1) : Math.round(fix.hAcc)}m`} />
              <Live label="受信" value={`${s.measuredHz}Hz`} />
              <Live label="電池" value={fix.battery != null ? `${fix.battery}%${fix.charging ? '⚡' : ''}` : '-'} />
            </View>
          )}

          {s.error && s.status !== 'connected' && <Text style={styles.error}>{s.error}</Text>}

          <View style={styles.btnRow}>
            {s.enabled && (s.status === 'off' || s.status === 'error') && (
              <TouchableOpacity style={styles.btnPrimary} onPress={() => s.connect()}>
                <Text style={styles.btnPrimaryText}>接続</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.btn} onPress={() => s.startScan()} disabled={isTracking}>
              <Text style={[styles.btnText, isTracking && { opacity: 0.4 }]}>別の機器を検索</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btn} onPress={confirmForget} disabled={isTracking}>
              <Text style={[styles.btnDanger, isTracking && { opacity: 0.4 }]}>登録解除</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          {s.error && <Text style={styles.error}>{s.error}</Text>}
          <TouchableOpacity style={styles.btnPrimary} onPress={() => s.startScan()} disabled={s.status === 'scanning'}>
            <Text style={styles.btnPrimaryText}>🔍 RaceBox を検索</Text>
          </TouchableOpacity>
        </>
      )}

      {scanning && (
        <View style={styles.scanBox}>
          <View style={styles.row}>
            {s.status === 'scanning' && <ActivityIndicator size="small" color="#2563eb" style={{ marginRight: 8 }} />}
            <Text style={styles.scanTitle}>
              {s.scanResults.length === 0 ? 'RaceBox の電源を入れて近づけてください…' : 'タップして接続'}
            </Text>
            <TouchableOpacity onPress={() => { s.stopScan(); useExternalGpsStore.setState({ scanResults: [] }); }}>
              <Text style={styles.btnText}>閉じる</Text>
            </TouchableOpacity>
          </View>
          {s.scanResults.map(r => (
            <TouchableOpacity key={r.id} style={styles.scanItem} onPress={() => s.selectDevice(r)}>
              <Text style={styles.deviceName}>{r.name}</Text>
              <Text style={styles.rssi}>{r.rssi != null ? `${r.rssi} dBm` : ''}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {s.deviceId && (
        <>
          <View style={styles.divider} />
          <Text style={styles.label}>記録間隔（外部GPS使用時）</Text>
          <View style={styles.segment}>
            {HZ_OPTIONS.map(hz => (
              <TouchableOpacity
                key={hz}
                style={[styles.segBtn, s.recordHz === hz && styles.segBtnActive]}
                onPress={() => s.setRecordHz(hz)}
              >
                <Text style={[styles.segText, s.recordHz === hz && styles.segTextActive]}>{hz}Hz</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.note}>
            1Hz=1秒ごと。サーキット走行など細かく残したいときは 2〜5Hz（データ量が増えます）。
          </Text>
        </>
      )}
    </View>
  );
}

function Live({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.liveItem}>
      <Text style={styles.liveValue}>{value}</Text>
      <Text style={styles.liveLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 24, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  desc: { color: '#6b7280', fontSize: 12, lineHeight: 18, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center' },
  deviceName: { color: '#1f2937', fontSize: 15, fontWeight: '600' },
  status: { color: '#9ca3af', fontSize: 12, marginTop: 2 },
  ok: { color: '#16a34a', fontWeight: '600' },
  ng: { color: '#dc2626' },
  liveBox: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#f8fafc', borderRadius: 10, padding: 10, marginTop: 12 },
  liveItem: { alignItems: 'center', flex: 1 },
  liveValue: { color: '#1f2937', fontSize: 14, fontWeight: '700' },
  liveLabel: { color: '#9ca3af', fontSize: 10, marginTop: 2 },
  error: { color: '#dc2626', fontSize: 12, marginVertical: 8 },
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  btn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#f3f4f6' },
  btnText: { color: '#2563eb', fontSize: 13, fontWeight: '600' },
  btnDanger: { color: '#dc2626', fontSize: 13, fontWeight: '600' },
  btnPrimary: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#2563eb', alignItems: 'center' },
  btnPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  scanBox: { marginTop: 12, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, padding: 10 },
  scanTitle: { flex: 1, color: '#6b7280', fontSize: 12 },
  scanItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#f3f4f6', marginTop: 6 },
  rssi: { color: '#9ca3af', fontSize: 12 },
  divider: { height: 1, backgroundColor: '#f3f4f6', marginVertical: 14 },
  label: { color: '#374151', fontSize: 13, fontWeight: '600', marginBottom: 8 },
  segment: { flexDirection: 'row', gap: 6 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: '#f3f4f6', alignItems: 'center' },
  segBtnActive: { backgroundColor: '#2563eb' },
  segText: { color: '#374151', fontSize: 13, fontWeight: '600' },
  segTextActive: { color: '#fff' },
  note: { color: '#9ca3af', fontSize: 11, marginTop: 6 },
});

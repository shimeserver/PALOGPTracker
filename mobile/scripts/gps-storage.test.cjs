const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function environment() {
  const values = new Map(), files = new Map(), cache = new Map();
  const calls = { writes: 0, failKey: null, failFile: false, offline: true, uploaded: [] };
  const storage = {
    async getItem(key) { if (calls.failRead === key) throw Error('read failed'); return values.get(key) ?? null; },
    async setItem(key, value) { if (calls.failKey === key) throw Error('disk full'); values.set(key, value); },
    async removeItem(key) { values.delete(key); },
  };
  const mocks = {
    '@react-native-async-storage/async-storage': storage,
    'expo-file-system/legacy': {
      documentDirectory: 'file:///documents/',
      async makeDirectoryAsync() {},
      async writeAsStringAsync(key, value) {
        // Native file:// handling decodes URI escapes before opening the file.
        const filename = decodeURIComponent(key).slice('file:///documents/gps-point-chunks/'.length);
        assert.ok(!filename.includes('/'), 'chunk filename must not decode into nested directories');
        if (calls.failFile) throw Error('disk full'); calls.writes++; files.set(key, value);
      },
      async readAsStringAsync(key) { if (!files.has(key)) throw Error('missing'); return files.get(key); },
      async deleteAsync(key) { files.delete(key); },
    },
    '../firebase/routes': { async saveRoute(route) {
      if (calls.offline) throw Error('offline');
      calls.onUpload?.();
      if (calls.uploadWait) await calls.uploadWait;
      calls.uploaded.push(route); return route.userId + '_' + route.startTime;
    } },
    '../utils/gapBridge': { bridgeGaps: async points => points },
    'expo-location': {
      Accuracy: { BestForNavigation: 6 },
      requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
      requestBackgroundPermissionsAsync: async () => ({ status: 'granted' }),
      hasStartedLocationUpdatesAsync: async () => true,
      startLocationUpdatesAsync: async () => {}, stopLocationUpdatesAsync: async () => {},
    },
    'expo-task-manager': { defineTask() {} },
    zustand: { create(init) {
      let state;
      const get = () => state;
      const set = update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) }; };
      state = init(set, get);
      return { getState: get, setState: set };
    } },
  };
  function load(file) {
    file = path.resolve(__dirname, '../src', file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    new Function('require', 'module', 'exports', code)(name => {
      if (mocks[name]) return mocks[name];
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
      throw Error('Unexpected import: ' + name);
    }, module, module.exports);
    return module.exports;
  }
  return { values, files, calls, load };
}
const points = count => Array.from({ length: count }, (_, i) => ({ lat: 35 + i * 0.000001, lng: 139, speed: 4, timestamp: 100000 + i * 100 }));
const route = count => ({ userId: 'user', startTime: 100000, endTime: 100000 + count * 100, points: points(count), name: 'test', mode: 'walk', tags: [], totalDistance: 1, avgSpeed: 4, maxSpeed: 4, createdAt: 100000, source: 'recorded' });

test('25Hz input produces 10Hz, handles gaps, duplicates and rate changes', () => {
  const { FixSampler } = environment().load('utils/fixSampler.ts');
  for (const hz of [1, 2, 5, 10]) {
    const sampler = new FixSampler();
    const selected = Array.from({ length: 250 }, (_, i) => 100000 + i * 40).filter(t => sampler.accept(t, hz));
    assert.equal(selected.length, hz * 10);
    assert.equal(sampler.accept(selected.at(-1), hz), false);
    assert.equal(sampler.accept(200000, hz), true);
    assert.equal(sampler.accept(200040, hz === 10 ? 5 : 10), true);
  }
});

test('10Hz hour round-trips; append only writes new full chunks', async () => {
  const env = environment(), store = env.load('utils/pointStorage.ts');
  const data = route(36000);
  await store.writePointData('recovery', data, true);
  assert.equal(env.calls.writes, 72);
  await store.writePointData('recovery', route(36300), true);
  assert.equal(env.calls.writes, 72);
  assert.deepEqual((await store.readPointData('recovery')).points, points(36300));
  await store.writePointData('recovery', route(36600), true);
  assert.equal(env.calls.writes, 73);
  assert.ok(env.values.get('recovery').length < 100000);
});

test('failed data/manifest writes preserve the last readable snapshot', async () => {
  const env = environment(), store = env.load('utils/pointStorage.ts');
  await store.writePointData('recovery', route(600), true);
  env.calls.failFile = true;
  await assert.rejects(store.writePointData('recovery', route(1200), true));
  env.calls.failFile = false; env.calls.failKey = 'recovery';
  await assert.rejects(store.writePointData('recovery', route(1200), true));
  assert.deepEqual((await store.readPointData('recovery')).points, points(600));
  env.calls.failKey = null;
  await store.writePointData('recovery', route(1200), true);
  assert.equal((await store.readPointData('recovery')).points.length, 1200);
  await store.removePointData('recovery');
  assert.equal(env.files.size, 0);
});

test('missing chunks raise errors instead of returning an empty recording', async () => {
  const env = environment(), store = env.load('utils/pointStorage.ts');
  await store.writePointData('recovery', route(1000));
  env.files.delete(env.files.keys().next().value);
  await assert.rejects(store.readPointData('recovery'));
  assert.ok(env.values.has('recovery'));
});

test('legacy queue migration and repeated upload failures never drop routes', async () => {
  const env = environment();
  env.values.set('pending_routes', JSON.stringify([route(1600)]));
  const queue = env.load('utils/uploadQueue.ts');
  assert.equal((await queue.getPendingRoutes())[0].points.length, 1600);
  assert.equal(env.values.has('pending_routes'), false);
  for (let i = 0; i < 7; i++) assert.deepEqual(await queue.flushPendingRoutes(), { uploaded: 0, remaining: 1, dropped: 0 });
  env.calls.offline = false;
  await Promise.all([queue.flushPendingRoutes(), queue.flushPendingRoutes()]);
  assert.equal(env.calls.uploaded.length, 1);
  assert.equal((await queue.getPendingRoutes()).length, 0);
  assert.equal(env.files.size, 0);
});

test('failed queue migration keeps the original; read failure blocks overwrite', async () => {
  const env = environment();
  const raw = JSON.stringify([route(1600)]);
  env.values.set('pending_routes', raw);
  env.calls.failKey = 'pending_routes_v2';
  const queue = env.load('utils/uploadQueue.ts');
  await assert.rejects(queue.getPendingRoutes());
  assert.equal(env.values.get('pending_routes'), raw);
  env.calls.failKey = null;
  await queue.getPendingRoutes();
  env.calls.failRead = 'pending_routes_v2';
  await assert.rejects(queue.enqueuePendingRoute({ ...route(5), startTime: 999 }));
  assert.equal(JSON.parse(env.values.get('pending_routes_v2')).length, 1);
});

test('recording buffers preserve all points on pause/stop and restore old recovery', async () => {
  const env = environment();
  env.values.set('route_recovery', JSON.stringify({ points: points(600), startTime: 100000, mode: 'walk', savedAt: 1 }));
  const tracking = env.load('store/trackingStore.ts');
  assert.equal((await tracking.loadRecovery()).points.length, 600);
  await tracking.clearRecovery();
  const store = tracking.useTrackingStore;
  await store.getState().startTracking();
  store.getState().setTrackingMode('walk');
  const locations = points(100).map(p => ({ timestamp: p.timestamp, coords: { latitude: p.lat, longitude: p.lng, speed: 1, accuracy: 1 } }));
  store.getState().addPoints(locations);
  await store.getState().pauseTracking();
  assert.equal(store.getState().currentPoints.length, 100);
  assert.ok(store.getState().currentDistance > 0);
  assert.equal((await tracking.loadRecovery()).points.length, 100);
  assert.equal(await store.getState().stopTracking('user'), 'queued');
  const queue = env.load('utils/uploadQueue.ts');
  assert.equal((await queue.getPendingRoutes())[0].points.length, 100);
  assert.equal(await tracking.loadRecovery(), null);
});

test('map preview bounds display size and preserves endpoints without mutating recording', () => {
  const { mapPreview } = environment().load('utils/mapPreview.ts');
  const data = points(36000), preview = mapPreview(data);
  assert.equal(preview.length, 2000);
  assert.deepEqual(preview[0], [data[0].lat, data[0].lng]);
  assert.deepEqual(preview.at(-1), [data.at(-1).lat, data.at(-1).lng]);
  assert.equal(data.length, 36000);
});

test('enqueue during an in-flight upload is not blocked or removed by its completion', async () => {
  const env = environment(), queue = env.load('utils/uploadQueue.ts');
  await queue.enqueuePendingRoute(route(600));
  env.calls.offline = false;
  let finish;
  env.calls.uploadWait = new Promise(resolve => { finish = resolve; });
  const upload = queue.flushPendingRoutes();
  await queue.enqueuePendingRoute({ ...route(800), startTime: 200000 });
  assert.equal(await queue.getPendingRouteCount(), 2);
  finish();
  await upload;
  assert.equal(await queue.getPendingRouteCount(), 1);
  assert.equal((await queue.getPendingRoutes())[0].startTime, 200000);
});

test('new recording cannot silently overwrite a previous recovery', async () => {
  const env = environment();
  env.values.set('route_recovery', JSON.stringify({ points: points(600), startTime: 100000, mode: 'walk', savedAt: 1 }));
  const tracking = env.load('store/trackingStore.ts');
  await assert.rejects(tracking.useTrackingStore.getState().startTracking());
  assert.equal((await tracking.loadRecovery()).points.length, 600);
});

test('failed final save keeps all points and allows retry', async () => {
  const env = environment(), tracking = env.load('store/trackingStore.ts');
  const store = tracking.useTrackingStore;
  await store.getState().startTracking();
  store.getState().setTrackingMode('walk');
  store.getState().addPoints(points(100).map(p => ({ timestamp: p.timestamp, coords: { latitude: p.lat, longitude: p.lng, speed: 1, accuracy: 1 } })));
  env.calls.failKey = 'route_recovery_v2';
  await assert.rejects(store.getState().stopTracking('user'));
  assert.equal(store.getState().currentPoints.length, 100);
  assert.equal(store.getState().isSaving, false);
  env.calls.failKey = null;
  assert.equal(await store.getState().stopTracking('user'), 'queued');
  assert.equal((await env.load('utils/uploadQueue.ts').getPendingRoutes())[0].points.length, 100);
});

test('resumed recovery replaces an older queued snapshot without losing added points', async () => {
  const env = environment(), queue = env.load('utils/uploadQueue.ts');
  await queue.enqueuePendingRoute(route(600));
  env.values.set('route_recovery', JSON.stringify({ points: points(600), startTime: 100000, mode: 'walk', savedAt: 1 }));
  const tracking = env.load('store/trackingStore.ts');
  await tracking.useTrackingStore.getState().resumeFromRecovery(await tracking.loadRecovery());
  tracking.useTrackingStore.getState().addPoints(points(700).slice(600).map(p => ({ timestamp: p.timestamp, coords: { latitude: p.lat, longitude: p.lng, speed: 1, accuracy: 1 } })));
  assert.equal(await tracking.useTrackingStore.getState().stopTracking('user'), 'queued');
  assert.equal((await queue.getPendingRoutes())[0].points.length, 700);
  await queue.enqueuePendingRoute(route(600));
  assert.equal((await queue.getPendingRoutes())[0].points.length, 700);
  assert.equal(await tracking.loadRecovery(), null);
});

test('completion of an older upload cannot delete a resumed queued recording', async () => {
  const env = environment(), queue = env.load('utils/uploadQueue.ts');
  await queue.enqueuePendingRoute(route(600));
  env.calls.offline = false;
  let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  env.calls.onUpload = started;
  env.calls.uploadWait = new Promise(resolve => { finish = resolve; });
  const upload = queue.flushPendingRoutes();
  await began;
  await queue.enqueuePendingRoute(route(700));
  finish();
  await upload;
  assert.equal((await queue.getPendingRoutes())[0].points.length, 700);
  env.calls.uploadWait = null;
  await queue.flushPendingRoutes();
  assert.equal(env.calls.uploaded.at(-1).points.length, 700);
  assert.equal((await queue.getPendingRoutes()).length, 0);
});

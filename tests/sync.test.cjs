const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test: nodeTest } = require('node:test');
const vm = require('node:vm');
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn);

// Execute the real browser script; only DOM, storage and network are substituted.
const source = readFileSync(process.env.SYNC_SOURCE || path.join(__dirname, '../sync.js'), 'utf8');
const html = readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const saveSource = html.match(/const save=\(\)=>\{.*?\};/)[0];
const defaults = { status: 'want', favorite: false, note: '', rating: null, want_to_buy: false };
const progress = overrides => ({ ...defaults, ...overrides });
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(local = {}) {
  const nodes = new Map();
  const events = new Map();
  const storage = new Map([['pga-v1', JSON.stringify(local)]]);
  const reads = [], writes = [], cloud = new Map();
  let authChanged;
  const session = id => ({ user: { id, email: `${id}@example.invalid` } });
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: '', value: '', prepend() {} });
    return nodes.get(id);
  }
  function request(list, details) {
    return new Promise((resolve, reject) => list.push({ ...details, resolve, reject }));
  }
  const client = {
    from(table) {
      assert.equal(table, 'game_progress');
      return {
        select(columns) {
          return { eq: (column, id) => {
            assert.equal(column, 'user_id');
            return request(reads, { user: id, columns });
          } };
        },
        upsert(row, options) {
          assert.equal(options.onConflict, 'user_id,game_id');
          return request(writes, { rows: copy(Array.isArray(row) ? row : [row]) });
        }
      };
    },
    auth: {
      getSession: async () => ({ data: { session: session('user-a') }, error: null }),
      onAuthStateChange: callback => { authChanged = callback; },
      signOut: async () => {},
    },
  };
  const context = vm.createContext({
    document: {
      readyState: 'loading', getElementById: node, createElement: () => ({}),
      addEventListener: (name, callback) => events.set(name, callback),
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { supabase: { createClient: () => client }, addEventListener: (name, callback) => events.set(name, callback) },
    state: copy(local), render() {}, structuredClone, confirm: () => true,
    location: { origin: 'https://archive.example.invalid', pathname: '/' },
  });
  vm.runInContext(saveSource + ';globalThis.saveFromUI=save;', context);
  vm.runInContext(source, context, { filename: 'sync.js' });
  const started = events.get('DOMContentLoaded')();
  const h = {
    reads, writes, cloud, storage, node, context, started,
    read: () => JSON.parse(storage.get('pga-v1')),
    edit(id, fields) { context.state[id] = { ...context.state[id], ...fields }; context.saveFromUI(); },
    replace(data) { context.state = copy(data); context.saveFromUI(); },
    click(id) { return node(id).onclick(); },
    auth(id) { authChanged(id ? 'SIGNED_IN' : 'SIGNED_OUT', id ? session(id) : null); },
    async load(index, entries = {}, error = null) {
      reads[index].resolve({ data: Object.entries(entries).map(([game_id, d]) => ({ game_id, ...d })), error });
      await tick();
    },
    async complete(index, { error = null, reject = false, committed = !error && !reject } = {}) {
      const req = writes[index];
      assert.ok(req, `expected write ${index + 1}`);
      if (committed) for (const row of req.rows) cloud.set(`${row.user_id}/${row.game_id}`, row);
      if (reject) req.reject(new Error('network offline'));
      else req.resolve({ data: null, error });
      await tick();
    },
    async boot(entries = local) { await tick(); await h.load(0, entries); await started; return h; },
  };
  return h;
}

test('regression: sends playing, then done edited during the first request', async () => {
  const h = await harness().boot();
  h.edit('game', { status: 'playing', note: 'Keep my note', rating: 8, favorite: true, want_to_buy: true });
  await tick();
  h.edit('game', { status: 'done' });
  await tick();
  assert.equal(h.writes.length, 1, 'only one writer may run');
  assert.equal(h.writes[0].rows[0].status, 'playing');
  await h.complete(0);
  assert.equal(h.writes.length, 2, 'the newer edit must remain queued');
  assert.equal(h.writes[1].rows[0].status, 'done');
  await h.complete(1);
  for (const [key, value] of Object.entries(h.read().game)) assert.equal(h.cloud.get('user-a/game')[key], value);
  assert.equal(h.writes.length, 2);
});

test('coalesces rapid edits but sends the latest values, including explicit clears', async () => {
  const h = await harness().boot();
  h.edit('game', progress({ status: 'playing', note: 'Old', rating: 10, favorite: true, want_to_buy: true }));
  await tick();
  for (let n = 1; n <= 20; n++) h.edit('game', { note: `Draft ${n}`, rating: n % 10 + 1 });
  h.edit('game', progress());
  await h.complete(0);
  assert.equal(h.writes.length, 2);
  assert.deepEqual(Object.fromEntries(Object.keys(defaults).map(k => [k, h.writes[1].rows[0][k]])), defaults);
  await h.complete(1);
});

test('a second edit to the same value after an intervening edit is acknowledged separately', async () => {
  const h = await harness().boot();
  h.edit('game', { status: 'playing' }); await tick();
  h.edit('game', { status: 'done' });
  h.edit('game', { status: 'playing', note: 'Final' });
  await h.complete(0);
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].rows[0].note, 'Final');
  await h.complete(1);
});

for (const failure of ['returned error', 'rejected promise', 'lost acknowledgement']) {
  test(`retains edits after ${failure}; retry sends latest full record`, async () => {
    const h = await harness().boot();
    h.edit('game', progress({ status: 'playing', note: 'Original note', rating: 9 })); await tick();
    h.edit('game', { status: 'done', note: 'Latest note' });
    await h.complete(0, failure === 'returned error' ? { error: { message: '503 unavailable' } } : { reject: true, committed: failure === 'lost acknowledgement' });
    assert.match(h.node('cloudMessage').textContent, /Не удалось сохранить/);
    assert.equal(h.writes.length, 1, 'no tight automatic retry loop');
    const retry = h.click('cloudRetry'); await tick();
    assert.equal(h.writes[1].rows[0].note, 'Latest note');
    assert.equal(h.writes[1].rows[0].rating, 9);
    await h.complete(1); await retry;
    assert.equal(h.cloud.size, 1, 'same conflict key must be retried');
    assert.equal(h.cloud.get('user-a/game').status, 'done');
  });
}

test('multiple games survive a partial failure and repeated retry clicks', async () => {
  const h = await harness().boot();
  h.edit('a', { note: 'A' }); await tick();
  h.edit('b', { note: 'B', rating: 7 });
  h.edit('c', { status: 'done' });
  await h.complete(0);
  await h.complete(1, { error: { message: 'offline' } });
  const retry = h.click('cloudRetry'); h.click('cloudRetry'); await tick();
  assert.equal(h.writes.length, 3);
  assert.equal(h.writes[2].rows[0].game_id, 'b');
  await h.complete(2); await h.complete(3); await retry;
  assert.deepEqual([...h.cloud.keys()].sort(), ['user-a/a', 'user-a/b', 'user-a/c']);
});

test('cloud reload is blocked while writes are pending, including after a failure', async () => {
  const h = await harness().boot();
  h.edit('game', { note: 'Unsaved' }); await tick();
  await h.click('cloudReload'); assert.equal(h.reads.length, 1);
  await h.complete(0, { reject: true });
  await h.click('cloudReload'); assert.equal(h.reads.length, 1);
  assert.equal(h.read().game.note, 'Unsaved');
});

for (const finishWriteFirst of [false, true]) {
  test(`stale cloud read cannot overwrite an edit (write completed: ${finishWriteFirst})`, async () => {
    const initial = { game: progress({ note: 'Cloud old', status: 'playing', rating: 5 }) };
    const h = await harness(initial).boot();
    const reload = h.click('cloudReload'); await tick();
    h.edit('game', { note: 'New local', status: 'done', rating: 10 }); await tick();
    if (finishWriteFirst) await h.complete(0);
    const response = h.load(1, initial); await tick();
    assert.equal(h.read().game.note, 'New local');
    assert.equal(h.read().game.rating, 10);
    if (!finishWriteFirst) await h.complete(0);
    await response; await reload;
  });
}

test('edits during initial login load are retained and sent once loading finishes', async () => {
  const h = harness({ game: progress({ note: 'Local' }) }); await tick();
  h.edit('game', { status: 'done', note: 'Edited during login', rating: 8 });
  const load = h.load(0, { game: progress({ note: 'Stale cloud' }) }); await tick();
  assert.equal(h.read().game.note, 'Edited during login');
  assert.equal(h.writes.length, 1);
  await h.complete(0); await load; await h.started;
});

test('unchanged cloud reload retains normal cloud precedence and local-only records', async () => {
  const local = { game: progress({ note: 'Local conflict', rating: 6 }), localOnly: progress({ note: 'Offline' }) };
  const remote = { game: progress({ note: 'Cloud note', rating: 9, status: 'done' }) };
  const h = await harness(local).boot(remote);
  assert.deepEqual(h.read().game, remote.game);
  assert.deepEqual(h.read().localOnly, local.localOnly);
  assert.equal(h.node('cloudImport').hidden, false);
  assert.equal(h.writes.length, 0, 'login must not upload local data implicitly');
});

test('a missing queued record is not uploaded as empty defaults after JSON replacement', async () => {
  const h = await harness().boot();
  h.edit('a', { note: 'A' }); await tick();
  h.edit('b', { note: 'B' });
  h.replace({ a: h.read().a });
  await h.complete(0);
  assert.equal(h.writes.length, 1, 'absence does not authorize resetting a cloud row');
});

test('confirmed local import uses the same serialized writer as card edits', async () => {
  const h = await harness({ game: progress({ note: 'Import me', rating: 8 }) }).boot({ game: progress({ note: 'Cloud' }) });
  const importing = h.click('cloudImport'); await tick();
  h.edit('game', { note: 'Edited during import', status: 'done' }); await tick();
  assert.equal(h.writes.length, 1, 'import and card save must not race');
  await h.complete(0);
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].rows[0].note, 'Edited during import');
  assert.equal(h.writes[1].rows[0].rating, 8);
  await h.complete(1); await importing;
  assert.equal(h.read().game.note, 'Edited during import');
});

test('failed confirmed import remains retryable without claiming success', async () => {
  const h = await harness({ game: progress({ note: 'Import note', rating: 7 }) }).boot({ game: progress() });
  const importing = h.click('cloudImport'); await tick();
  await h.complete(0, { reject: true }); await importing;
  assert.match(h.node('cloudMessage').textContent, /Не удалось сохранить/);
  assert.equal(h.read().game.note, 'Import note');
  const retry = h.click('cloudRetry'); await tick();
  assert.equal(h.writes.length, 2);
  await h.complete(1); await retry;
  assert.equal(h.cloud.get('user-a/game').note, 'Import note');
});

test('editing a cloud-loaded card invalidates its older import candidate', async () => {
  const h = await harness({ game: progress({ note: 'Old import' }) }).boot({ game: progress({ note: 'Cloud' }) });
  h.edit('game', { note: 'Latest' }); await tick(); await h.complete(0);
  const importing = h.click('cloudImport'); await tick();
  assert.equal(h.writes.length, 1);
  await importing;
  assert.equal(h.read().game.note, 'Latest');
});

test('retry reports cloud read failures instead of rejecting the UI event handler', async () => {
  const h = await harness().boot();
  const retry = h.click('cloudRetry');
  const checked = assert.doesNotReject(retry);
  await tick(); await h.load(1, {}, { message: 'read offline' }); await checked;
  assert.match(h.node('cloudMessage').textContent, /read offline/);
});

test('out-of-order cloud reads only apply the most recently requested snapshot', async () => {
  const h = await harness().boot();
  const first = h.click('cloudReload'), second = h.click('cloudReload'); await tick();
  await h.load(2, { game: progress({ note: 'Newest', rating: 10 }) }); await second;
  await h.load(1, { game: progress({ note: 'Stale', rating: 2 }) }); await first;
  assert.equal(h.read().game.note, 'Newest');
  assert.equal(h.read().game.rating, 10);
});

test('failed initial read with queued edits recovers through the retry button', async () => {
  const h = harness(); await tick();
  h.edit('game', { status: 'done', note: 'Offline note', rating: 9 });
  await h.load(0, {}, { message: 'offline' }); await h.started;
  assert.equal(h.writes.length, 0);
  const retry = h.click('cloudRetry'); await tick();
  await h.load(1, { game: progress({ note: 'Stale' }) });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].rows[0].note, 'Offline note');
  await h.complete(0); await retry;
});

test('a stale read after sign-out cannot update local data or report success', async () => {
  const h = await harness({ game: progress({ note: 'Keep' }) }).boot();
  const reload = h.click('cloudReload'); await tick();
  await h.click('cloudSignOut');
  await h.load(1, { game: progress({ note: 'Stale response' }) }); await reload;
  assert.equal(h.read().game.note, 'Keep');
  assert.match(h.node('cloudMessage').textContent, /Локальный режим/);
});

test('an old writer cannot drain the next account queue or overlap its cloud read', async () => {
  const h = await harness().boot();
  h.edit('old', { note: 'Account A' }); await tick();
  h.edit('notSent', { note: 'Private A' });
  h.auth('user-b'); await tick();
  h.edit('new', { note: 'Account B', rating: 6 });
  assert.equal(h.reads.length, 1, 'wait for old in-flight write before reading');
  await h.complete(0);
  assert.equal(h.reads[1].user, 'user-b');
  await h.load(1);
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].rows[0].user_id, 'user-b');
  assert.equal(h.writes[1].rows[0].game_id, 'new');
  await h.complete(1);
  assert.equal(h.cloud.has('user-b/notSent'), false, 'old local records need explicit import');
  assert.equal(h.read().notSent.note, 'Private A');
});

test('a late failure after sign-out does not replace the local-mode message', async () => {
  const h = await harness().boot();
  h.edit('game', { note: 'Keep offline' }); await tick();
  await h.click('cloudSignOut'); await h.complete(0, { reject: true });
  assert.match(h.node('cloudMessage').textContent, /Локальный режим/);
  assert.equal(h.read().game.note, 'Keep offline');
});

test('all missing queued IDs release the writer so later saves still work', async () => {
  const h = await harness().boot();
  h.edit('game', { note: 'A' }); await tick();
  await h.complete(0, { reject: true });
  h.replace({}); await tick();
  h.edit('other', { note: 'B' }); await tick();
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].rows[0].game_id, 'other');
  await h.complete(1);
});

test('import candidates removed by a JSON replacement are not resurrected', async () => {
  const h = await harness({ game: progress({ note: 'Old candidate' }) }).boot({ game: progress({ note: 'Cloud' }) });
  h.replace({}); await tick();
  const importing = h.click('cloudImport'); await tick();
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.read(), {});
  await importing;
});

test('retains storage format, row keys and legacy fields; cancelling import writes nothing', async () => {
  const h = await harness({ game: { status: 'playing', note: 'Legacy', rating: '8', extra: 'Keep local' } }).boot({});
  h.context.confirm = () => false;
  await h.click('cloudImport');
  assert.equal(h.writes.length, 0);
  h.edit('game', { favorite: true }); await tick();
  assert.equal(h.read().game.extra, 'Keep local');
  assert.deepEqual([...h.storage.keys()], ['pga-v1']);
  assert.deepEqual(Object.keys(h.writes[0].rows[0]).sort(), [...Object.keys(defaults), 'game_id', 'user_id', 'updated_at'].sort());
  assert.equal(h.writes[0].rows[0].rating, 8);
  assert.equal(h.writes[0].rows[0].note, 'Legacy');
  await h.complete(0);
});

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import type { ScreenMap } from '../src/map.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/ts-app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const copies: string[] = [];
after(() => copies.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const CALLED = {
  calledApiModules: ['contracts/api/index.ts'],
  requestFunction: { import: './contracts/api/request', name: 'executeRequest', method: '0.endpoint.method', url: '0.url' },
};

function fixtureCopy(files: Record<string, string | null>, keys: Record<string, unknown> = {}) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(copy);
  fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(copy, 'client/src', rel)), { recursive: true });
    fs.writeFileSync(path.join(copy, 'client/src', rel), text);
  }
  const configFile = path.join(copy, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (files['sagas/SagaRoutes.tsx']) config.routesFile.push('sagas/SagaRoutes.tsx');
  fs.writeFileSync(configFile, JSON.stringify({ ...config, ...CALLED, ...keys }, null, 2));
  return configFile;
}

const TYPES = `export const ActionTypes = {
  LOAD_NOTICES: 'LOAD_NOTICES',
  NOTICES_LOADED: 'NOTICES_LOADED',
  LOAD_CONTRACTS: 'LOAD_CONTRACTS',
  SEARCH_NOTES: 'SEARCH_NOTES',
  TAG_NOTES: 'TAG_NOTES',
  REMOVE_NOTES: 'REMOVE_NOTES',
  LOAD_SIGNED: 'LOAD_SIGNED',
  UPDATE_TERMS: 'UPDATE_TERMS',
  UNWATCHED: 'UNWATCHED',
};

export const SCHEDULE_REPORT = 'SCHEDULE_REPORT';
`;

const ACTIONS = `import { ActionTypes } from './constants';

export const loadNotices = () => ({ type: ActionTypes.LOAD_NOTICES });

export function loadContracts(workspace: string) {
  return { type: ActionTypes.LOAD_CONTRACTS, payload: workspace };
}

export const tagNotes = (tag: string) => {
  if (!tag) return { type: ActionTypes.TAG_NOTES, payload: 'all' };
  return { type: ActionTypes.TAG_NOTES, payload: tag };
};

export const noticeSlice = { actions: { load: () => ({ type: 'notices/load' }) } };
`;

const HANDLERS = `import { call, put } from 'redux-saga/effects';
import { ajaxReportSchedule, contractApi, fetchNotices, noteApi } from '../contracts/api';
import { ActionTypes } from './types';

export function* loadNoticesSaga() {
  const notices = yield call(fetchNotices);
  yield put({ type: ActionTypes.NOTICES_LOADED, payload: notices });
}

export function* loadContractsSaga(action: { payload: string }) {
  yield call(contractApi.loadList, action.payload);
}

export function* searchNotesSaga(action: { payload: string }) {
  yield call(noteApi.search, action.payload);
}

export function* tagNotesSaga() {
  yield call(noteApi.tagNotes);
}

export function* removeNotesSaga() {
  yield call(noteApi.removeNotes);
}

export function* loadSignedSaga() {
  yield call(contractApi.loadSigned, 'w', 'c');
}

export function* afterNoticesSaga() {
  yield call(contractApi.loadByDay, 'w', 'd');
}

export function* updateTermsSaga() {
  yield call(contractApi.updateTerms, 'w', 'c');
}

export function* scheduleSaga() {
  yield call(ajaxReportSchedule);
}
`;

const ROOT = `import { actionChannel, all, call, debounce, fork, take, takeEvery, takeLatest, takeLeading } from 'redux-saga/effects';
import * as handlers from './handlers';
import { ActionTypes, SCHEDULE_REPORT } from './types';

const blocking = {
  [ActionTypes.TAG_NOTES]: handlers.tagNotesSaga,
  [ActionTypes.REMOVE_NOTES]: handlers.removeNotesSaga,
};

const lazy = {
  [ActionTypes.UPDATE_TERMS]: handlers.updateTermsSaga,
};

function* watchBlocking() {
  const channel = yield actionChannel(Object.keys(blocking));
  while (true) {
    const action = yield take(channel);
    yield call(blocking[action.type], action);
  }
}

function* watchLazy() {
  for (const type of Object.keys(lazy)) yield takeLatest(type, lazy[type]);
}

function* watchSigned() {
  while (true) {
    yield take(ActionTypes.LOAD_SIGNED);
    yield call(handlers.loadSignedSaga);
  }
}

function* afterNotices() {
  yield take(ActionTypes.NOTICES_LOADED);
  yield call(handlers.afterNoticesSaga);
}

export function* rootSaga() {
  yield all([
    takeLatest(ActionTypes.LOAD_NOTICES, handlers.loadNoticesSaga),
    takeEvery([ActionTypes.LOAD_CONTRACTS], handlers.loadContractsSaga),
    debounce(300, ActionTypes.SEARCH_NOTES, handlers.searchNotesSaga),
    takeLeading(SCHEDULE_REPORT, function* () {
      yield call(handlers.scheduleSaga);
    }),
    fork(watchBlocking),
    fork(watchLazy),
    fork(watchSigned),
    fork(afterNotices),
  ]);
}
`;

const UNUSED = `import { takeLatest } from 'redux-saga/effects';
import { removeNotesSaga } from './handlers';
import { ActionTypes } from './types';

export function* unusedSaga() {
  yield takeLatest(ActionTypes.UNWATCHED, removeNotesSaga);
}
`;

const STORE = `import createSagaMiddleware from 'redux-saga';
import { rootSaga } from './root';

const sagaMiddleware = createSagaMiddleware();

export const runSagas = () => sagaMiddleware.run(rootSaga);
`;

const UNUSED_RUN = `import createSagaMiddleware from 'redux-saga';
import { unusedSaga } from './unused';

const sagaMiddleware = createSagaMiddleware();
sagaMiddleware.run(unusedSaga);
`;

const ROUTES = `import { Route, Routes } from 'react-router-dom';
import Notices from './screens/Notices';
import Contracts from './screens/Contracts';
import Notes from './screens/Notes';
import Signed from './screens/Signed';
import Quiet from './screens/Quiet';

export default function SagaRoutes() {
  return (
    <Routes>
      <Route path="/notices" element={<Notices />} />
      <Route path="/contracts" element={<Contracts />} />
      <Route path="/notes" element={<Notes />} />
      <Route path="/signed" element={<Signed />} />
      <Route path="/quiet" element={<Quiet />} />
    </Routes>
  );
}
`;

const SCREENS = {
  'sagas/screens/Notices.tsx': `import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { loadNotices } from '../actions';

export default function Notices() {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch(loadNotices());
  }, []);
  return <main />;
}
`,
  'sagas/screens/Contracts.tsx': `import { connect } from 'react-redux';
import { loadContracts } from '../actions';

function Contracts({ loadContracts }: { loadContracts: (w: string) => void }) {
  return <button onClick={() => loadContracts('w')} />;
}

export default connect(null, { loadContracts })(Contracts);
`,
  'sagas/screens/Notes.tsx': `import { useDispatch } from 'react-redux';
import { store } from '../appStore';
import { tagNotes } from '../actions';
import { ActionTypes } from '../constants';

export default function Notes() {
  const dispatch = useDispatch();
  const search = (q: string) => dispatch({ type: ActionTypes.SEARCH_NOTES, payload: q });
  const tag = () => store.dispatch(tagNotes('red'));
  const remove = () => dispatch({ type: 'REMOVE_NOTES' });
  return <input onChange={(e) => search(e.target.value)} onBlur={tag} onFocus={remove} />;
}
`,
  'sagas/screens/Signed.tsx': `import { useDispatch } from 'react-redux';
import { ActionTypes } from '../types';

export default function Signed() {
  const dispatch = useDispatch();
  const action = { type: ActionTypes.LOAD_SIGNED };
  return (
    <div>
      <button onClick={() => dispatch(action)} />
      <button onClick={() => dispatch({ type: 'SCHEDULE_REPORT' })} />
      <button onClick={() => dispatch({ type: ActionTypes.UPDATE_TERMS })} />
    </div>
  );
}
`,
  'sagas/screens/Quiet.tsx': `import { useDispatch } from 'react-redux';
import { noticeSlice } from '../actions';
import { ActionTypes } from '../types';

export default function Quiet() {
  const dispatch = useDispatch();
  return (
    <div>
      <button onClick={() => dispatch({ type: ActionTypes.NOTICES_LOADED })} />
      <button onClick={() => dispatch({ type: ActionTypes.UNWATCHED })} />
      <button onClick={() => dispatch(noticeSlice.actions.load())} />
    </div>
  );
}
`,
};

const SAGA_APP = {
  'sagas/types.ts': TYPES,
  'sagas/constants.ts': "export * from './types';\n",
  'sagas/actions.ts': ACTIONS,
  'sagas/handlers.ts': HANDLERS,
  'sagas/root.ts': ROOT,
  'sagas/unused.ts': UNUSED,
  'sagas/store.ts': STORE,
  'sagas/unused.test.ts': UNUSED_RUN,
  'sagas/SagaRoutes.tsx': ROUTES,
  'sagas/appStore.ts': 'export const store = { dispatch: (action: unknown) => action };\n',
  ...SCREENS,
};

const build = (configFile: string) => buildMap(loadConfig(configFile));
const bySaga = (map: ScreenMap, id: string) => map.screens.find((s) => s.id === id)!.apiCalls.filter((c) => c.actions).map((c) => [c.fn, `${c.file}:${c.line}`, c.actions!.map((a) => `${a.type} ← ${a.dispatchedAt.join(', ')}`)]);

test('a request a saga sends is a call of each screen that dispatches an action type the saga is watching for, matched by the constant the type is declared as, or by its text when that constant is a single string, whether the screen dispatches an object, an action creator or creators handed to connect', async () => {
  const map = await build(fixtureCopy(SAGA_APP));
  assert.deepEqual(bySaga(map, '/notices#Notices'), [
    ['fetchNotices', 'sagas/handlers.ts:6', ['ActionTypes.LOAD_NOTICES ← sagas/screens/Notices.tsx:8']],
  ]);
  assert.deepEqual(bySaga(map, '/contracts#Contracts'), [
    ['contractApi.loadList', 'sagas/handlers.ts:11', ['ActionTypes.LOAD_CONTRACTS ← sagas/screens/Contracts.tsx:8']],
  ]);
  assert.deepEqual(bySaga(map, '/notes#Notes'), [
    ['noteApi.search', 'sagas/handlers.ts:15', ['ActionTypes.SEARCH_NOTES ← sagas/screens/Notes.tsx:8']],
    ['noteApi.tagNotes', 'sagas/handlers.ts:19', ['ActionTypes.TAG_NOTES ← sagas/screens/Notes.tsx:9']],
  ]);
  assert.deepEqual(bySaga(map, '/signed#Signed'), [
    ['contractApi.loadSigned', 'sagas/handlers.ts:27', ['ActionTypes.LOAD_SIGNED ← sagas/screens/Signed.tsx:9']],
    ['contractApi.updateTerms', 'sagas/handlers.ts:35', ['ActionTypes.UPDATE_TERMS ← sagas/screens/Signed.tsx:11']],
    ['contracts/api/index.ts#ajaxReportSchedule', 'sagas/handlers.ts:39', ['SCHEDULE_REPORT ← sagas/screens/Signed.tsx:10']],
  ]);
  const signed = map.screens.find((s) => s.id === '/signed#Signed')!.apiCalls.find((c) => c.fn === 'contractApi.loadSigned')!;
  assert.deepEqual(signed.endpoints!.map((e) => `${e.method} ${e.url}`), ['GET /internal/v2/workspace/{?}/contract/{?}/signed']);
  assert.ok(map.calls.find((c) => c.id === 'GET:/internal/v2/workspace/{?}/contract/{?}/signed')!.screens.includes('/signed#Signed'));
  assert.deepEqual(map.sagas, { runs: ['sagas/store.ts:6'], watchers: 8 });
});

test('a saga does not send for a screen when the screen dispatches a type only waited for outside a loop, a type whose watcher no run reaches, a slice action, or the text of a type the watcher names by a constant, and a saga reached through put stays with the saga that put it', async () => {
  const map = await build(fixtureCopy(SAGA_APP));
  assert.deepEqual(bySaga(map, '/quiet#Quiet'), []);
  const fns = map.screens.flatMap((s) => s.apiCalls.filter((c) => c.actions).map((c) => c.fn));
  assert.ok(!fns.includes('contractApi.loadByDay'));
  assert.ok(!fns.includes('noteApi.removeNotes'));
});

test('a middleware made with @redux-saga/core in one file and run in another, effects from typed-redux-saga and a saga declared inside the function that watches for it are read too', async () => {
  const map = await build(fixtureCopy({
    ...SAGA_APP,
    'sagas/store.ts': "import createSagaMiddleware from '@redux-saga/core';\n\nexport default createSagaMiddleware();\n",
    'sagas/entry.ts': "import sagaMiddleware from './store';\nimport { rootSaga } from './root';\nimport { localSaga } from './local';\n\nsagaMiddleware.run(rootSaga);\nsagaMiddleware.run(localSaga);\n",
    'sagas/local.ts': [
      "import { call, takeLatest } from 'typed-redux-saga';",
      "import { noteApi } from '../contracts/api';",
      "import { ActionTypes } from './types';",
      '',
      'export function* localSaga() {',
      '  function* fetchItems() { yield* call(noteApi.fetchItems); }',
      '  yield* takeLatest(ActionTypes.UNWATCHED, fetchItems);',
      '}',
      '',
    ].join('\n'),
  }));
  assert.deepEqual(map.sagas, { runs: ['sagas/entry.ts:5', 'sagas/entry.ts:6'], watchers: 9 });
  assert.deepEqual(bySaga(map, '/quiet#Quiet'), [
    ['noteApi.fetchItems', 'sagas/local.ts:6', ['ActionTypes.UNWATCHED ← sagas/screens/Quiet.tsx:10']],
  ]);
});

test('without a saga run, or without redux-saga, no request or link of a saga comes to a screen, and the summary says when redux-saga is imported but nothing runs it', async () => {
  const unrun = fixtureCopy({ ...MOVING_APP, 'sagas/store.ts': null }, HISTORY);
  const map = await build(unrun);
  assert.deepEqual(map.screens.flatMap((s) => s.apiCalls.filter((c) => c.actions)), []);
  assert.deepEqual(map.screens.flatMap((s) => s.links.filter((l) => l.actions)), []);
  assert.deepEqual(map.sagas, { runs: [], watchers: 0 });
  const out = spawnSync(process.execPath, [CLI, 'extract', unrun], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^redux-saga is imported, but no run of a createSagaMiddleware\(\) result was found, so no request or link of a saga is put on a screen$/m);

  const ran = fixtureCopy(SAGA_APP);
  const summary = spawnSync(process.execPath, [CLI, 'extract', ran], { encoding: 'utf8' });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /^redux-saga runs from sagas\/store\.ts:6 \| watchers 8 \| requests of sagas on screens 7 \| links of sagas on screens 0$/m);

  const plain = await build(fixtureCopy({}));
  assert.equal(plain.sagas, undefined);
});

const MOVES = `import { call, fork, takeEvery, takeLatest, takeLeading } from 'redux-saga/effects';
import Option from '../_define/Option';
import history from './history';
import { goNotes } from './go';
import { goTail } from './tail';
import { ActionTypes } from './types';

function* afterContracts(action: { payload: string; url: string }) {
  history.push('/contracts');
  history.push(Option.ROUTE_PATH.HOME);
  history.push(\`/notes/\${action.payload}\`);
  history.push(action.url);
  history.push(urlOf(action.payload));
  history.push(Option.ROUTE_PATH.NOWHERE);
  goNotes();
  goTail();
}

function* afterSigned() {
  history.replace('/quiet');
}

function* onSigned() {
  yield call(afterSigned);
}

function* unwatched() {
  history.push('/signed');
}

export function* moveSaga() {
  yield takeLatest(ActionTypes.LOAD_CONTRACTS, afterContracts);
  yield takeEvery([ActionTypes.LOAD_SIGNED, ActionTypes.UPDATE_TERMS], afterSigned);
  yield takeLeading(ActionTypes.LOAD_SIGNED, onSigned);
  yield fork(unwatched);
}

const urlOf = (x: string) => '/' + x;
`;

const MOVING_APP = {
  ...SAGA_APP,
  'sagas/history.ts': "import { createBrowserHistory } from 'history';\n\nexport default createBrowserHistory();\n",
  'sagas/go.ts': "import history from './history';\nexport const goNotes = () => history.push('/notes');\n",
  'sagas/tail.ts': "import Option from '../_define/Option';\nimport history from './history';\nexport const goTail = () => history.push(Option.ROUTE_PATH.HOME + '/tail');\n",
  'sagas/moves.ts': MOVES,
  'sagas/root.ts': ROOT.replace("import * as handlers from './handlers';", "import * as handlers from './handlers';\nimport { moveSaga } from './moves';").replace('fork(afterNotices),', 'fork(afterNotices),\n    fork(moveSaga),'),
  'sagas/screens/Notes.tsx': `import { useDispatch } from 'react-redux';
import { store } from '../appStore';
import { tagNotes } from '../actions';
import { ActionTypes } from '../constants';
import { goNotes } from '../go';

export default function Notes() {
  const dispatch = useDispatch();
  const search = (q: string) => dispatch({ type: ActionTypes.SEARCH_NOTES, payload: q });
  const tag = () => store.dispatch(tagNotes('red'));
  const remove = () => dispatch({ type: 'REMOVE_NOTES' });
  const reload = () => {
    goNotes();
    dispatch({ type: ActionTypes.LOAD_CONTRACTS });
  };
  return <input onChange={(e) => search(e.target.value)} onBlur={tag} onFocus={remove} onClick={reload} />;
}
`,
};
const HISTORY = { history: { import: './sagas/history', name: 'default' } };

const lineOf = (text: string, part: string) => text.split('\n').findIndex((l) => l.includes(part)) + 1;
const moved = (part: string) => `sagas/moves.ts:${lineOf(MOVES, part)}`;
const linksOf = (map: ScreenMap, id: string) =>
  map.screens.find((s) => s.id === id)!.links.map((l) => [l.to, `${l.file}:${l.line}`, l.targets, l.actions?.map((a) => `${a.type} ← ${a.dispatchedAt.join(', ')}`)]);

test('a move a saga makes is a link of each screen that dispatches an action the saga waits for, with the action types and the places the screen dispatches them, sorted by file and line, and listed once when two watchers of one type reach it', async () => {
  const map = await build(fixtureCopy(MOVING_APP, HISTORY));
  const loaded = ['ActionTypes.LOAD_CONTRACTS ← sagas/screens/Contracts.tsx:8'];
  assert.deepEqual(linksOf(map, '/contracts#Contracts'), [
    ['/notes', 'sagas/go.ts:2', ['/notes#Notes'], loaded],
    ['/contracts', moved("push('/contracts')"), ['/contracts#Contracts'], loaded],
    ['/home', moved('ROUTE_PATH.HOME)'), ['/home#Home'], loaded],
    ['/notes/{*}', moved('/notes/'), ['/notes#Notes'], loaded],
    ['/home/tail', 'sagas/tail.ts:3', ['/home#Home'], loaded],
  ]);
  assert.deepEqual(linksOf(map, '/signed#Signed'), [
    ['/quiet', moved("replace('/quiet')"), ['/quiet#Quiet'], ['ActionTypes.LOAD_SIGNED ← sagas/screens/Signed.tsx:9', 'ActionTypes.UPDATE_TERMS ← sagas/screens/Signed.tsx:11']],
  ]);
  const entries = map.entries.map((e) => e.screen);
  for (const id of ['/contracts#Contracts', '/notes#Notes', '/quiet#Quiet']) assert.ok(!entries.includes(id), id);
  assert.ok(entries.includes('/signed#Signed'));
});

test('a saga move whose address comes from the action or cannot be read gives no link and no {?}, nor does a move in a saga no watcher starts, and a move the screen\'s own code also reaches is listed once without actions', async () => {
  const map = await build(fixtureCopy(MOVING_APP, HISTORY));
  const fromSagas = map.screens.flatMap((s) => s.links.filter((l) => l.file === 'sagas/moves.ts'));
  assert.ok(!fromSagas.some((l) => l.to === '{?}'));
  assert.ok(!fromSagas.some((l) => l.to === '/signed'));
  assert.ok(!fromSagas.some((l) => l.route === 'NOWHERE'));
  const loaded = ['ActionTypes.LOAD_CONTRACTS ← sagas/screens/Notes.tsx:14'];
  assert.deepEqual(linksOf(map, '/notes#Notes'), [
    ['/notes', 'sagas/go.ts:2', ['/notes#Notes'], undefined],
    ['/contracts', moved("push('/contracts')"), ['/contracts#Contracts'], loaded],
    ['/home', moved('ROUTE_PATH.HOME)'), ['/home#Home'], loaded],
    ['/notes/{*}', moved('/notes/'), ['/notes#Notes'], loaded],
    ['/home/tail', 'sagas/tail.ts:3', ['/home#Home'], loaded],
  ]);
  assert.deepEqual(linksOf(map, '/notices#Notices'), []);
});

test('the summary counts the moves of sagas that are links of some screen', () => {
  const out = spawnSync(process.execPath, [CLI, 'extract', fixtureCopy(MOVING_APP, HISTORY)], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^redux-saga runs from sagas\/store\.ts:6 \| watchers 12 \| requests of sagas on screens 7 \| links of sagas on screens 6$/m);
});

const RUN_AT_LOAD = (exports: string, imports = '') => `import createSagaMiddleware from 'redux-saga';
import { createBrowserHistory } from 'history';
${imports}import { rootSaga } from './root';

export const history = createBrowserHistory();
const sagaMiddleware = createSagaMiddleware();
${exports}
sagaMiddleware.run(rootSaga);
`;
const MOVES_FROM_STORE = (imports: string, guard: string, after = '') => `import { call, fork, select, takeEvery, takeLatest } from 'redux-saga/effects';
${imports}
import { ActionTypes } from './types';

function* afterContracts() {
  ${guard}history.push('/contracts');
}

function* afterSigned() {
  history.replace('/quiet');${after}
}

function* unwatched() {
  history.push('/signed');
}

export function* moveSaga() {
  yield takeLatest(ActionTypes.LOAD_CONTRACTS, afterContracts);
  yield takeEvery(ActionTypes.LOAD_SIGNED, afterSigned);
  yield fork(unwatched);
}
`;
const STORE_SHAPES = [
  {
    name: 'a history and a saga the store file makes',
    store: RUN_AT_LOAD('export function* refresh() {\n  yield call(noteApi.fetchItems);\n}', "import { call } from 'redux-saga/effects';\nimport { noteApi } from '../contracts/api';\n"),
    moves: MOVES_FROM_STORE("import { history, refresh } from './store';", '', '\n  yield call(refresh);'),
    history: { history: { import: './sagas/store', name: 'history' } },
    helper: true,
  },
  {
    name: 'a type imported from the store file without import type',
    store: RUN_AT_LOAD('export const store = { getState: () => ({ user: null as string | null }) };\nexport type RootState = ReturnType<typeof store.getState>;'),
    moves: MOVES_FROM_STORE("import history from './history';\nimport { RootState } from './store';", 'const user: string | null = yield select((s: RootState) => s.user);\n  if (!user) '),
    history: HISTORY,
  },
];

for (const shape of STORE_SHAPES) {
  test(`when the store file runs the root saga as it loads, a saga that imports ${shape.name} does not reach the run again: a move only fork starts gives no link, and requests and links stay with the screens that dispatch what the saga waits for`, async () => {
    const configFile = fixtureCopy({
      ...SAGA_APP,
      'sagas/root.ts': MOVING_APP['sagas/root.ts'],
      'sagas/store.ts': shape.store,
      'sagas/moves.ts': shape.moves,
      'sagas/history.ts': "import { createBrowserHistory } from 'history';\n\nexport default createBrowserHistory();\n",
    }, shape.history);
    const map = await build(configFile);
    const at = (part: string) => `sagas/moves.ts:${lineOf(shape.moves, part)}`;
    assert.deepEqual(linksOf(map, '/notices#Notices'), []);
    assert.deepEqual(linksOf(map, '/contracts#Contracts'), [
      ['/contracts', at("push('/contracts')"), ['/contracts#Contracts'], ['ActionTypes.LOAD_CONTRACTS ← sagas/screens/Contracts.tsx:8']],
    ]);
    const signed = ['ActionTypes.LOAD_SIGNED ← sagas/screens/Signed.tsx:9'];
    assert.deepEqual(linksOf(map, '/signed#Signed'), [['/quiet', at("replace('/quiet')"), ['/quiet#Quiet'], signed]]);
    const fromStore = shape.helper ? [['noteApi.fetchItems', `sagas/store.ts:${lineOf(shape.store, 'fetchItems')}`, signed]] : [];
    assert.deepEqual(bySaga(map, '/signed#Signed').filter(([fn]) => fn === 'noteApi.fetchItems'), fromStore);
    assert.deepEqual(bySaga(map, '/notices#Notices'), [
      ['fetchNotices', 'sagas/handlers.ts:6', ['ActionTypes.LOAD_NOTICES ← sagas/screens/Notices.tsx:8']],
    ]);
    const entries = map.entries.map((e) => e.screen);
    for (const id of ['/signed#Signed', '/notices#Notices']) assert.ok(entries.includes(id), id);
    const out = spawnSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const runAt = lineOf(shape.store, 'sagaMiddleware.run');
    assert.match(out.stdout, new RegExp(`^redux-saga runs from sagas/store\\.ts:${runAt} \\| watchers 10 \\| requests of sagas on screens ${shape.helper ? 8 : 7} \\| links of sagas on screens 2$`, 'm'));
  });
}

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import type { ScreenMap } from '../src/map.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/ts-app');
const copies: string[] = [];
after(() => copies.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function fixtureCopy(files: Record<string, string>) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(copy);
  fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(copy, 'client/src', rel)), { recursive: true });
    fs.writeFileSync(path.join(copy, 'client/src', rel), text);
  }
  const configFile = path.join(copy, 'config.json');
  const config = { ...JSON.parse(fs.readFileSync(configFile, 'utf8')), requestFunction: { import: './lib/http', name: 'http', object: true } };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  return configFile;
}

const build = (configFile: string) => buildMap(loadConfig(configFile));
const INBOX = '/inbox#Inbox';
const OUTBOX = '/outbox#Outbox';
const ARCHIVE = '/archive#Archive';
const storeCalls = (map: ScreenMap, id: string) => map.screens.find((s) => s.id === id)!.apiCalls
  .filter((c) => c.file!.startsWith('stores/') || c.file!.startsWith('models/'))
  .map((c) => `${c.endpoints!.map((e) => `${e.method} ${e.url}`).join()} ← ${c.file}:${c.line}`)
  .sort();

const HOOK_INBOX = `import { useEffect } from 'react';
import useStores from '../hooks/useStores';

export default function Inbox() {
  const { mail } = useStores();
  useEffect(() => {
    mail.markRead();
  }, [mail]);
  return <button onClick={mail.send}>{mail.unread}</button>;
}
`;

const STORES = {
  'lib/http.ts': `import axios from 'axios';\n\nexport const http = axios.create();\n`,
  'stores/BaseStore.ts': `import { http } from '../lib/http';
import type RootStore from './RootStore';

export default abstract class BaseStore {
  root: RootStore;

  constructor(root: RootStore) {
    this.root = root;
  }

  fetchList = () => http.post('/api/items/list');

  remove(id: string) {
    return http.post('/api/items/remove', { id });
  }
}
`,
  'stores/MailStore.ts': `import { http } from '../lib/http';
import BaseStore from './BaseStore';

export default class MailStore extends BaseStore {
  unread = 0;

  markRead() {
    return http.post('/api/mail/read');
  }

  archive() {
    return http.post('/api/mail/archive');
  }

  send = () => {
    this.validate();
    return http.post('/api/mail/send');
  };

  validate() {
    return http.post('/api/mail/validate');
  }

  remove(id: string) {
    return http.post('/api/mail/remove', { id });
  }
}
`,
  'stores/FolderStore.ts': `import { http } from '../lib/http';
import BaseStore from './BaseStore';

export default class FolderStore extends BaseStore {
  create() {
    return http.post('/api/folders/create');
  }

  rename() {
    this.root.mail.archive();
    return http.post('/api/folders/rename');
  }
}
`,
  'stores/RootStore.ts': `import FolderStore from './FolderStore';
import MailStore from './MailStore';

export default class RootStore {
  mail: MailStore;
  folders: FolderStore;

  constructor() {
    this.mail = new MailStore(this);
    this.folders = new FolderStore(this);
  }
}
`,
  'stores/index.ts': `import RootStore from './RootStore';\n\nexport default new RootStore();\n`,
  'hooks/useStores.ts': `import { createContext, useContext } from 'react';
import type RootStore from '../stores/RootStore';

export const StoresContext = createContext<RootStore | null>(null);

export default function useStores(): RootStore {
  return useContext(StoresContext)!;
}
`,
};

test('a method of a store a screen gets from a React context hook brings the requests it sends, and those of the methods it calls on this or on other stores, to that screen only, while the store files stay out of the screen sources', async () => {
  const map = await build(fixtureCopy({
    ...STORES,
    'screens/Inbox.tsx': HOOK_INBOX,
    'screens/Outbox.tsx': `import useStores from '../hooks/useStores';

export default function Outbox() {
  const stores = useStores();
  return <button onClick={() => { stores.folders.rename(); stores.mail.remove('x'); stores.folders.fetchList(); }} />;
}
`,
  }));
  assert.deepEqual(storeCalls(map, INBOX), [
    'POST /api/mail/read ← stores/MailStore.ts:8',
    'POST /api/mail/send ← stores/MailStore.ts:17',
    'POST /api/mail/validate ← stores/MailStore.ts:21',
  ]);
  assert.deepEqual(storeCalls(map, OUTBOX), [
    'POST /api/folders/rename ← stores/FolderStore.ts:11',
    'POST /api/items/list ← stores/BaseStore.ts:11',
    'POST /api/mail/archive ← stores/MailStore.ts:12',
    'POST /api/mail/remove ← stores/MailStore.ts:25',
  ]);
  assert.ok(!map.screens.find((s) => s.id === INBOX)!.sourceFiles!.some((f) => f!.startsWith('stores/')));
});

test('a screen that imports the store instance gets the requests of the store methods it calls rather than every request written in the store files, and a request sent while the store is made comes with the import', async () => {
  const map = await build(fixtureCopy({
    ...STORES,
    'stores/RootStore.ts': STORES['stores/RootStore.ts'].replace('this.folders = new FolderStore(this);', 'this.folders = new FolderStore(this);\n    this.folders.fetchList();'),
    'screens/Inbox.tsx': HOOK_INBOX,
    'screens/Archive.tsx': `import stores from '../stores';

export default function Archive() {
  return <button onClick={() => stores.folders.create()} />;
}
`,
  }));
  assert.deepEqual(storeCalls(map, ARCHIVE), [
    'POST /api/folders/create ← stores/FolderStore.ts:6',
    'POST /api/items/list ← stores/BaseStore.ts:11',
  ]);
});

test('a value whose type is not known counts as a store when the name it is read under is a field of the store the context hook gives, a store read by a computed name brings all its methods, and a class read whole calls store methods only in files the screen imports', async () => {
  const map = await build(fixtureCopy({
    ...STORES,
    'models/Message.ts': `import type MailStore from '../stores/MailStore';

export default class Message {
  store!: MailStore;

  save() {
    return this.store.archive();
  }
}
`,
    'screens/Inbox.tsx': `import Message from '../models/Message';

function perform(context: any, thing: any) {
  context.stores.mail.markRead();
  thing.validate();
}

export default function Inbox() {
  return <button onClick={() => perform({}, new Message())} />;
}
`,
    'screens/Outbox.tsx': `import useStores from '../hooks/useStores';

export default function Outbox({ action }: { action: 'create' | 'rename' }) {
  const { folders } = useStores();
  return <button onClick={() => folders[action]()} />;
}
`,
  }));
  assert.deepEqual(storeCalls(map, INBOX), ['POST /api/mail/read ← stores/MailStore.ts:8']);
  assert.deepEqual(storeCalls(map, OUTBOX), [
    'POST /api/folders/create ← stores/FolderStore.ts:6',
    'POST /api/folders/rename ← stores/FolderStore.ts:11',
    'POST /api/items/list ← stores/BaseStore.ts:11',
    'POST /api/items/remove ← stores/BaseStore.ts:14',
    'POST /api/mail/archive ← stores/MailStore.ts:12',
  ]);
});

test('a method called on super reaches the parent definition, this inside a method means the class the method was called on, and a store reached through a file that re-exports it or a file saved with a byte order mark is read the same way', async () => {
  const map = await build(fixtureCopy({
    ...STORES,
    'stores/BaseStore.ts': STORES['stores/BaseStore.ts'].replace('  fetchList =', `  reload() {
    return this.load();
  }

  load() {
    return http.post('/api/items/load');
  }

  fetchList =`),
    'stores/MailStore.ts': '\uFEFF' + STORES['stores/MailStore.ts'].replace('  markRead() {', `  removeAll() {
    return super.remove('all');
  }

  load() {
    return http.post('/api/mail/load');
  }

  markRead() {`),
    'stores/FolderStore.ts': '\uFEFF' + STORES['stores/FolderStore.ts'].replace('  create() {', `  load() {
    return http.post('/api/folders/load');
  }

  create() {`),
    'stores/types.ts': `export * from './root';\n`,
    'stores/root/index.ts': `export { default as RootStore } from '../RootStore';\n`,
    'hooks/useStores.ts': STORES['hooks/useStores.ts'].replace(`import type RootStore from '../stores/RootStore';`, `import type { RootStore } from '../stores/types';`),
    'screens/Inbox.tsx': `﻿import useStores from '../hooks/useStores';

export default function Inbox() {
  const { mail } = useStores();
  return <button onClick={() => { mail.removeAll(); mail.reload(); }} />;
}
`,
  }));
  assert.deepEqual(storeCalls(map, INBOX), [
    'POST /api/items/remove ← stores/BaseStore.ts:22',
    'POST /api/mail/load ← stores/MailStore.ts:12',
  ]);
});

test('a store method called on a value whose type has no store class (an untyped prop or parameter, an interface, a type parameter with or without a constraint, optional or not) brings only that method to a screen that imports the store, a type parameter whose constraint allows undefined is read as the store in it, and a typed value no store fits or a computed name on an untyped value brings none', async () => {
  const map = await build(fixtureCopy({
    ...STORES,
    'hooks/useStores.ts': `import { createContext, useContext } from 'react';
import stores from '../stores';
import type RootStore from '../stores/RootStore';

export const StoresContext = createContext(stores);

export default function useStores(): RootStore {
  return useContext(StoresContext);
}
`,
    'screens/FolderRow.jsx': `export default function FolderRow({ store }) {
  return <button onClick={() => store.create()} />;
}
`,
    'screens/Archive.tsx': `import useStores from '../hooks/useStores';
import FolderRow from './FolderRow';

export default function Archive() {
  const { folders } = useStores();
  return <FolderRow store={folders} />;
}
`,
    'screens/Outbox.tsx': `import stores from '../stores';
import type FolderStore from '../stores/FolderStore';

function save(s, options) {
  return options[s.kind] && s.rename();
}

function make<S extends { create(): unknown }>(s?: S) {
  return s?.create();
}

function drop<S extends FolderStore | undefined>(s: S) {
  const { remove } = s!;
  return remove('x');
}

export default function Outbox() {
  return <button onClick={() => { save(stores.folders, {}); make(stores.folders); drop(stores.folders); }} />;
}
`,
    'screens/Inbox.tsx': `import stores from '../stores';

interface Reader {
  markRead(): unknown;
}

function pick<T, K extends keyof T>(obj: T, key: K) {
  return obj[key];
}

function check<T>(store?: T) {
  return store?.validate();
}

export default function Inbox({ options }: { options: { archive: boolean } }) {
  const reader: Reader = stores.mail;
  return <button onClick={() => { if (pick(options, 'archive')) reader.markRead(); check(stores.mail); }} />;
}
`,
  }));
  assert.deepEqual(storeCalls(map, ARCHIVE), ['POST /api/folders/create ← stores/FolderStore.ts:6']);
  assert.deepEqual(storeCalls(map, OUTBOX), [
    'POST /api/folders/create ← stores/FolderStore.ts:6',
    'POST /api/folders/rename ← stores/FolderStore.ts:11',
    'POST /api/items/remove ← stores/BaseStore.ts:14',
    'POST /api/mail/archive ← stores/MailStore.ts:12',
  ]);
  assert.deepEqual(storeCalls(map, INBOX), [
    'POST /api/mail/read ← stores/MailStore.ts:8',
    'POST /api/mail/validate ← stores/MailStore.ts:21',
  ]);
});

test('in an app with both a context hook store and redux-saga, a store request that the screen sends and a saga waiting for the screen\'s action also reaches is listed once as the screen\'s own', async () => {
  const map = await build(fixtureCopy({
    ...STORES,
    'state/redux.ts': `import createSagaMiddleware from 'redux-saga';
import { rootSaga } from './sagas';

const sagaMiddleware = createSagaMiddleware();

export const reduxStore = { dispatch: (action: { type: string }) => action };
export const runSagas = () => sagaMiddleware.run(rootSaga);
`,
    'state/sagas.ts': `import { takeLatest } from 'redux-saga/effects';
import { http } from '../lib/http';
import stores from '../stores';

function* loadSaga() {
  yield http.post('/api/saga/load');
  stores.mail.markRead();
}

export function* rootSaga() {
  yield takeLatest('LOAD', loadSaga);
}
`,
    'screens/Inbox.tsx': HOOK_INBOX
      .replace("import useStores from '../hooks/useStores';", "import useStores from '../hooks/useStores';\nimport { reduxStore } from '../state/redux';")
      .replace('    mail.markRead();\n', "    mail.markRead();\n    reduxStore.dispatch({ type: 'LOAD' });\n"),
  }));
  const calls = map.screens.find((s) => s.id === INBOX)!.apiCalls;
  const urls = (url: string) => calls.filter((c) => c.endpoints!.some((e) => e.url === url));
  assert.deepEqual(urls('/api/saga/load').map((c) => [c.file, c.actions]), [['state/sagas.ts', [{ type: 'LOAD', dispatchedAt: ['screens/Inbox.tsx:9'] }]]]);
  assert.deepEqual(urls('/api/mail/read').map((c) => [c.file, c.actions ?? null]), [['stores/MailStore.ts', null]]);
});

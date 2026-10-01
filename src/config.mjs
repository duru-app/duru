import fs from 'node:fs';
import path from 'node:path';
import { DEPTHS, READERS } from './test-links.mjs';

const TEST_FORMATS = Object.keys(READERS);
const NAME = '[A-Za-z_$][\\w$]*';
const ROLE_NAME = new RegExp(`^${NAME}$`);
const ROLE_MEMBER = new RegExp(`^(${NAME})(?:\\[(?:'([^']*)'|"([^"]*)")\\]|\\.(${NAME}))$`);

export function parseRoleEntry(entry) {
  if (typeof entry === 'string' && ROLE_NAME.test(entry)) return { name: entry };
  const m = typeof entry === 'string' && entry.match(ROLE_MEMBER);
  if (m) return { object: m[1], key: m[2] ?? m[3] ?? m[4] };
  throw new Error(`roleIdentifiers entry ${JSON.stringify(entry)} is neither an identifier (memberRole) nor one member of an object (workspace['member.role'])`);
}

const isText = (v) => typeof v === 'string' && v.length > 0;
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isWebAddress = (v) => isText(v) && /^https?:\/\/[^/]/.test(v);

const isAccount = (v) => isPlainObject(v) && isText(v.id) && isText(v.passwordEnv) && !('password' in v);
const ACCOUNT = '{ "id", "passwordEnv" } with the name of an environment variable that holds the password, never the password itself';

function appSettings(app, at) {
  // login · account · roles 에는 비밀번호가 잘못 들어 있을 수 있어 값을 메시지에 싣지 않는다.
  const fail = (key, expected) => {
    const shown = ['login', 'account', 'roles'].includes(key.split('.')[0]) ? '' : `, not ${JSON.stringify(app[key])}`;
    throw new Error(`app.${key} must be ${expected}${shown}`);
  };
  if (!isPlainObject(app)) throw new Error(`app must be an object, not ${JSON.stringify(app)}`);
  if (!isText(app.files)) fail('files', "the app's build folder or the address it is deployed at");
  if (!isWebAddress(app.server)) fail('server', `the address of the server the app's API requests go to, such as "http://localhost:8080"`);
  if (!Array.isArray(app.apiPaths) || !app.apiPaths.length || !app.apiPaths.every((p) => isText(p) && p.startsWith('/'))) {
    fail('apiPaths', 'a list of path prefixes sent to the server, such as ["/api/"]');
  }
  const { login, account } = app;
  if (!isPlainObject(login) || !isText(login.path) || !isPlainObject(login.body) || !isText(login.token)
    || !isPlainObject(login.storage) || !isText(login.storage.key) || !(isText(login.storage.value) || isPlainObject(login.storage.value))) {
    fail('login', '{ "path", "body", "token", "storage": { "key", "value" } }, such as { "path": "/auth/login", "body": { "id": "{id}", "password": "{password}" }, "token": "accessToken", "storage": { "key": "auth", "value": "{token}" } }');
  }
  if (!isAccount(account)) fail('account', ACCOUNT);
  const roles = app.roles ?? {};
  if (!isPlainObject(roles)) fail('roles', 'an object from each role value the app compares to that role\'s account, such as { "ADMIN": { "id": "duru-admin", "passwordEnv": "DURU_ADMIN_PASSWORD" } }');
  for (const [role, roleAccount] of Object.entries(roles)) {
    if (!isText(role) || !isAccount(roleAccount)) fail(`roles.${role}`, ACCOUNT);
  }
  const signedOutPaths = app.signedOutPaths ?? [];
  if (!Array.isArray(signedOutPaths) || !signedOutPaths.every((p) => isText(p) && p.startsWith('/'))) {
    fail('signedOutPaths', 'a list of route paths shown signed out, such as ["/signin"]');
  }
  return { ...app, roles, signedOutPaths, files: isWebAddress(app.files) ? app.files : at(app.files) };
}

export function loadConfig(configPath) {
  const configDir = path.dirname(path.resolve(configPath));
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const at = (p) => path.resolve(configDir, p);
  const tests = (raw.tests ?? []).map((t) => {
    if (!TEST_FORMATS.includes(t.format)) throw new Error(`unknown test format "${t.format}" (expected one of ${TEST_FORMATS.join(', ')})`);
    if (!DEPTHS.includes(t.depth)) throw new Error(`unknown depth "${t.depth}" for ${t.path} (expected one of ${DEPTHS.join(', ')})`);
    return { ...t, path: at(t.path) };
  });
  (raw.roleIdentifiers ?? []).forEach(parseRoleEntry);
  const bodyArgKeys = raw.bodyArgKeys ?? [];
  if (!Array.isArray(bodyArgKeys) || !bodyArgKeys.every((k) => typeof k === 'string')) {
    throw new Error(`bodyArgKeys must be a list of property names, such as ["data"], not ${JSON.stringify(raw.bodyArgKeys)}`);
  }
  const bodyOptions = raw.bodyOptions ?? {};
  const isKeyList = (keys) => Array.isArray(keys) && keys.every((k) => typeof k === 'string');
  if (typeof bodyOptions !== 'object' || Array.isArray(bodyOptions) || !Object.values(bodyOptions).every(isKeyList)) {
    throw new Error(`bodyOptions must map call IDs to lists of body keys, such as {"POST:/api/v1/report/export": ["withHistory"]}, not ${JSON.stringify(raw.bodyOptions)}`);
  }
  const settingsDefaults = raw.settingsDefaults ?? {};
  for (const [root, entry] of Object.entries(settingsDefaults)) {
    if (!(raw.settingsRoots ?? []).includes(root)) throw new Error(`settingsDefaults root "${root}" is not listed in settingsRoots`);
    if (typeof entry?.file !== 'string' || typeof entry?.const !== 'string') throw new Error(`settingsDefaults.${root} needs "file" and "const"`);
  }
  const app = raw.app === undefined ? null : appSettings(raw.app, at);
  const outDir = at(raw.outDir ?? '.');
  return {
    ...raw,
    configDir,
    srcRoot: at(raw.srcRoot),
    roleIdentifiers: raw.roleIdentifiers ?? [],
    bodyArgKeys,
    bodyOptions,
    settingsDefaults,
    redirectElements: raw.redirectElements ?? ['Redirect'],
    entryPaths: raw.entryPaths ?? [],
    serverEndpoints: [raw.serverEndpoints].flat().map(at),
    outDir,
    marksDir: raw.marksDir ? at(raw.marksDir) : path.join(outDir, 'marks'),
    tests,
    app,
  };
}

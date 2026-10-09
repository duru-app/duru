import fs from 'node:fs';
import path from 'node:path';
import { DEPTHS, READERS } from './test-links.ts';
import { loadAliases } from './tsconfig.ts';
import type { AliasRule } from './resolve.ts';

const TEST_FORMATS = Object.keys(READERS);
const NAME = '[A-Za-z_$][\\w$]*';
const IDENTIFIER = new RegExp(`^${NAME}$`);
const PACKAGE_NAME = /^(@[\w.-]+\/)?[\w.-]+$/;
const ROLE_MEMBER = new RegExp(`^(${NAME})(?:\\[(?:'([^']*)'|"([^"]*)")\\]|\\.(${NAME}))$`);

export function parseRoleEntry(entry: unknown) {
  if (typeof entry === 'string' && IDENTIFIER.test(entry)) return { name: entry };
  const m = typeof entry === 'string' && entry.match(ROLE_MEMBER);
  if (m) return { object: m[1], key: m[2] ?? m[3] ?? m[4] };
  throw new Error(`roleIdentifiers entry ${JSON.stringify(entry)} is neither an identifier (memberRole) nor one member of an object (workspace['member.role'])`);
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
export const isPlainObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
export const compare = <T>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);
const isOneLine = (v: unknown) => typeof v === 'string' && /\S/.test(v) && !/[\r\n]/.test(v);
const isRoutePath = (v: unknown) => isText(v) && v.startsWith('/');
const isWebAddress = (v: unknown) => isText(v) && /^https?:\/\/[^/]/.test(v);
const MOVE_KEYS = ['from', 'to', 'reason'];
const CALL_LINK_KEYS = ['from', 'to', 'note'];
const SETTINGS_FUNCTION_KEYS = ['import', 'name', 'root', 'section'];
const LIST_API_KEYS = ['api', 'list', 'value', 'method', 'body'];
const ISSUING_API_KEYS = ['api', 'method', 'header', 'keyEnv', 'body', 'value'];
const HEADER_EXAMPLE = '{ "Authorization": "Bearer {token}" }';

const isRequest = (v: Record<string, any>) => isText(v.api) && v.api.startsWith('/') && typeof v.value === 'string'
  && (v.method === undefined || /^[A-Z]+$/.test(v.method))
  && (v.body === undefined || (v.method ?? 'GET') !== 'GET');
const isListApi = (v: any) => isPlainObject(v) && Object.keys(v).every((k) => LIST_API_KEYS.includes(k)) && isRequest(v) && typeof v.list === 'string';
const isIssuingApi = (v: any) => isPlainObject(v) && Object.keys(v).every((k) => ISSUING_API_KEYS.includes(k)) && isRequest(v) && isText(v.keyEnv)
  && isPlainObject(v.header) && Object.values(v.header).every(isText) && Object.values(v.header).some((h) => (h as string).includes('{key}'));

function pathValuesSettings(pathValues: any) {
  if (!isPlainObject(pathValues)) {
    throw new Error(`app.pathValues must map route paths to their path variables, such as { "/document/:tab": { "tab": "draft" } }, not ${JSON.stringify(pathValues)}`);
  }
  for (const [routePath, variables] of Object.entries<any>(pathValues)) {
    const at = `app.pathValues[${JSON.stringify(routePath)}]`;
    if (!routePath.startsWith('/')) throw new Error(`app.pathValues key ${JSON.stringify(routePath)} must be a route path as in the map, starting with "/"`);
    if (!isPlainObject(variables)) {
      throw new Error(`${at} must map variable names to values, such as { "tab": "draft" }, not ${JSON.stringify(variables)}`);
    }
    for (const [name, value] of Object.entries<any>(variables)) {
      if (name === '?') throw new Error(`${at} has the key "?" without a query parameter name, such as "?token"`);
      if (isText(value) || isListApi(value) || isIssuingApi(value)) continue;
      // 발급 API 를 잘못 적은 값에는 header 에 키가 그대로 들어 있을 수 있어, 목록 API 에 없는 이름이 하나라도 있으면 값을 메시지에 싣지 않는다.
      const shown = isPlainObject(value) && Object.keys(value).some((k) => !LIST_API_KEYS.includes(k)) ? '' : `, not ${JSON.stringify(value)}`;
      throw new Error(`${at}.${name} must be a fixed value such as "draft", a list API such as { "api": "/api/v1/documents", "list": "contents.list", "value": "id" }, `
        + 'or an API that issues the value such as { "api": "/api/v1/codes", "method": "POST", "header": { "X-API-KEY": "{key}" }, "keyEnv": "APP_API_KEY", "value": "contents.code" } '
        + 'with the name of an environment variable that holds the key, never the key itself; '
        + `each with an optional "method" and, for a method other than GET, a JSON "body"${shown}`);
    }
  }
  return pathValues;
}

const isAccount = (v: any) => isPlainObject(v) && isText(v.id) && isText(v.passwordEnv) && !('password' in v);
const ACCOUNT = '{ "id", "passwordEnv" } with the name of an environment variable that holds the password, never the password itself';

const DOTTED_NAME = new RegExp(`^${NAME}(?:\\.${NAME})*$`);
const ARGUMENT_PLACE = new RegExp(`^\\d+(?:\\.${NAME})*$`);

function settingsFileOf(file: any, raw: any) {
  if (file === undefined) return null;
  const { path: filePath, global, root, merged } = isPlainObject(file) ? file : {};
  if (!isText(filePath) || !filePath.startsWith('/') || !isText(global) || !DOTTED_NAME.test(global) || !isText(root)
    || !Array.isArray(merged) || !merged.length || !merged.every((m) => isText(m) && IDENTIFIER.test(m))) {
    throw new Error(`app.settingsFile must be { "path", "global", "root", "merged" }, such as { "path": "/settings.js", "global": "window.INTO_SETTINGS", "root": "globalSettings", "merged": ["SYSTEM", "CUSTOM"] }, not ${JSON.stringify(file)}`);
  }
  if (!(raw.settingsRoots ?? []).includes(root)) throw new Error(`app.settingsFile.root "${root}" is not listed in settingsRoots`);
  if (!raw.settingsDefaults?.[root]) {
    throw new Error(`app.settingsFile.root "${root}" has no settingsDefaults entry, so the defaults the app merges the file over are unknown`);
  }
  return { path: filePath, global, root, merged };
}

function appSettings(app: any, at: (p: string) => string, raw: any) {
  // login · account · roles 에는 비밀번호가 잘못 들어 있을 수 있어 값을 메시지에 싣지 않는다.
  const fail = (key: string, expected: string) => {
    const shown = ['login', 'account', 'roles'].includes(key.split('.')[0]) ? '' : `, not ${JSON.stringify(app[key])}`;
    throw new Error(`app.${key} must be ${expected}${shown}`);
  };
  if (!isPlainObject(app)) throw new Error(`app must be an object, not ${JSON.stringify(app)}`);
  if (!isText(app.files)) fail('files', "the app's build folder or the address it is deployed at");
  if (!isWebAddress(app.server)) fail('server', `the address of the server the app's API requests go to, such as "http://localhost:8080"`);
  if (!Array.isArray(app.apiPaths) || !app.apiPaths.length || !app.apiPaths.every((p: unknown) => isText(p) && p.startsWith('/'))) {
    fail('apiPaths', 'a list of path prefixes sent to the server, such as ["/api/"]');
  }
  const { login, account } = app;
  if (!isPlainObject(login) || !isText(login.path) || !isPlainObject(login.body) || !isText(login.token)
    || !isPlainObject(login.storage) || !isText(login.storage.key) || !(isText(login.storage.value) || isPlainObject(login.storage.value))) {
    fail('login', '{ "path", "body", "token", "storage": { "key", "value" } }, such as { "path": "/auth/login", "body": { "id": "{id}", "password": "{password}" }, "token": "accessToken", "storage": { "key": "auth", "value": "{token}" } }');
  }
  if (login.header !== undefined && !(isPlainObject(login.header) && Object.values(login.header).every(isText))) {
    throw new Error(`app.login.header must map header names to values with {token} in them, such as ${HEADER_EXAMPLE}`);
  }
  if (!isAccount(account)) fail('account', ACCOUNT);
  const roles = app.roles ?? {};
  if (!isPlainObject(roles)) fail('roles', 'an object from each role value the app compares to that role\'s account, such as { "ADMIN": { "id": "duru-admin", "passwordEnv": "DURU_ADMIN_PASSWORD" } }');
  for (const [role, roleAccount] of Object.entries(roles)) {
    if (!isText(role) || !isAccount(roleAccount)) fail(`roles.${role}`, ACCOUNT);
  }
  const signedOutPaths = app.signedOutPaths ?? [];
  if (!Array.isArray(signedOutPaths) || !signedOutPaths.every(isRoutePath)) {
    fail('signedOutPaths', 'a list of route paths shown signed out, such as ["/signin"]');
  }
  const pathValues = pathValuesSettings(app.pathValues ?? {});
  if (!login.header && Object.values<any>(pathValues).some((variables) => Object.values(variables).some(isListApi))) {
    throw new Error(`app.login.header is needed to call the list APIs in app.pathValues with the login token, such as ${HEADER_EXAMPLE}`);
  }
  return { ...app, roles, signedOutPaths, pathValues, settingsFile: settingsFileOf(app.settingsFile, raw), files: isWebAddress(app.files) ? app.files : at(app.files) };
}

export const ROUTES_FILE = 'a route file as a path from srcRoot, or a list of them with each file once, such as "Routes.js" or ["Routes.js", "admin/Routes.js"]';

function routeFilesOf(value: unknown, srcRoot: string) {
  const given = Array.isArray(value) ? value : [value];
  const files = given.map((f) => (isText(f) ? path.relative(srcRoot, path.join(srcRoot, f)) : null));
  if (!files.length || files.includes(null) || new Set(files).size < files.length) throw new Error(`routesFile must be ${ROUTES_FILE}, not ${JSON.stringify(value)}`);
  return files;
}

export function loadConfig(configPath: string) {
  const configDir = path.dirname(path.resolve(configPath));
  const { routesFile, ...raw } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const at = (p: string) => path.resolve(configDir, p);
  const tests = (raw.tests ?? []).map((t: any) => {
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
  const isKeyList = (keys: unknown) => Array.isArray(keys) && keys.every((k) => typeof k === 'string');
  if (typeof bodyOptions !== 'object' || Array.isArray(bodyOptions) || !Object.values(bodyOptions).every(isKeyList)) {
    throw new Error(`bodyOptions must map call IDs to lists of body keys, such as {"POST:/api/v1/report/export": ["withHistory"]}, not ${JSON.stringify(raw.bodyOptions)}`);
  }
  const bodyTypeExclusions = raw.bodyTypeExclusions ?? {};
  if (!isPlainObject(bodyTypeExclusions) || !Object.values(bodyTypeExclusions).every(isKeyList)) {
    throw new Error(`bodyTypeExclusions must map call IDs to lists of body fields read from the body type, as the map names them, such as {"POST:/api/v1/documents": ["enabledPkiSign", "signers[].required"]}, not ${JSON.stringify(raw.bodyTypeExclusions)}`);
  }
  const roleGuards = raw.roleGuards ?? {};
  if (!isPlainObject(roleGuards) || !Object.entries(roleGuards).every(([guard, roles]) => isText(guard) && Array.isArray(roles) && roles.length > 0 && roles.every((r) => isText(r) && !/\s/.test(r)))) {
    throw new Error(`roleGuards must map role guards as in the map to the roles that pass them, such as { "menuPolicy.canAccessAdminRoutes": ["member:ADMINISTRATOR"] }, with no spaces in a role, not ${JSON.stringify(raw.roleGuards)}`);
  }
  const moves = raw.moves ?? [];
  const isMove = (m: any) => isPlainObject(m) && Object.keys(m).every((k) => MOVE_KEYS.includes(k)) && isRoutePath(m.from) && isRoutePath(m.to) && isOneLine(m.reason);
  if (!Array.isArray(moves) || !moves.every(isMove)) {
    throw new Error(`moves must be a list of { "from", "to", "reason" }, with the reason on one line, for screen moves the code shows no link for, with route paths as in the map, such as [{ "from": "/signin", "to": "/user-home", "reason": "로그인 뒤" }], not ${JSON.stringify(raw.moves)}`);
  }
  const callLinks = raw.callLinks ?? [];
  const isCallLink = (l: any) => isPlainObject(l) && Object.keys(l).every((k) => CALL_LINK_KEYS.includes(k)) && isText(l.from) && isText(l.to) && l.from !== l.to && isOneLine(l.note);
  if (!Array.isArray(callLinks) || !callLinks.every(isCallLink)) {
    throw new Error(`callLinks must be a list of { "from", "to", "note" }, with the note on one line, joining a call whose on/off options change what another call gives back ("from") to that other call ("to"), with two different call IDs as in the map, such as [{ "from": "POST:/api/v1/report/export", "to": "GET:/api/v1/report/{reportId}/file", "note": "내보내기가 만든 파일을 내려받는다" }], not ${JSON.stringify(raw.callLinks)}`);
  }
  const constants = raw.constants ?? {};
  if (!isPlainObject(constants) || !Object.values(constants).every(isText)) {
    throw new Error(`constants must map each name the app's code imports a constants module by to its file as a path from srcRoot, such as { "Option": "_define/Option.js" }, not ${JSON.stringify(raw.constants)}`);
  }
  if (raw.routeConstant != null && raw.routeConstant !== '') {
    if (!isText(raw.routeConstant) || !DOTTED_NAME.test(raw.routeConstant)) {
      throw new Error(`routeConstant must be the dotted name of the object that holds the route paths, such as "Option.ROUTE_PATH", not ${JSON.stringify(raw.routeConstant)}`);
    }
    const name = raw.routeConstant.split('.')[0];
    if (!Object.hasOwn(constants, name)) {
      const names = Object.keys(constants);
      throw new Error(`routeConstant "${raw.routeConstant}" starts with "${name}", which is not a name in constants (${names.length ? names.map((n) => JSON.stringify(n)).join(', ') : 'none'}); add it to constants, or leave routeConstant out when the route paths are written in place`);
    }
  }
  const settingsDefaults: Record<string, any> = raw.settingsDefaults ?? {};
  for (const [root, entry] of Object.entries(settingsDefaults)) {
    if (!(raw.settingsRoots ?? []).includes(root)) throw new Error(`settingsDefaults root "${root}" is not listed in settingsRoots`);
    const fromFile = entry?.file !== undefined || entry?.const !== undefined;
    if (fromFile && entry?.constant !== undefined) {
      throw new Error(`settingsDefaults.${root} takes either "file" and "const" or "constant", not both`);
    }
    if (entry?.constant !== undefined) {
      if (!isText(entry.constant) || !DOTTED_NAME.test(entry.constant)) {
        throw new Error(`settingsDefaults.${root}.constant must be a constants name, or a dotted path starting with one, such as "Settings.defaults", not ${JSON.stringify(entry.constant)}`);
      }
      const name = entry.constant.split('.')[0];
      if (!Object.hasOwn(constants, name)) {
        throw new Error(`settingsDefaults.${root}.constant "${entry.constant}" starts with "${name}", which is not a name in constants`);
      }
      continue;
    }
    if (typeof entry?.file !== 'string' || typeof entry?.const !== 'string') throw new Error(`settingsDefaults.${root} needs "file" and "const", or "constant"`);
  }
  const settingsFunctions = raw.settingsFunctions ?? [];
  const isSettingsFunction = (f: any) => isPlainObject(f) && Object.keys(f).every((k) => SETTINGS_FUNCTION_KEYS.includes(k))
    && isText(f.import) && isText(f.name) && (f.name === 'default' || IDENTIFIER.test(f.name)) && isText(f.root) && isText(f.section) && !f.section.includes('.');
  if (!Array.isArray(settingsFunctions) || !settingsFunctions.every(isSettingsFunction)) {
    throw new Error('settingsFunctions must be a list of { "import", "name", "root", "section" }: the import path and name the app imports a function returning settings by, '
      + 'and the settingsRoots entry and the key under it whose settings that function reads, '
      + `such as [{ "import": "@/config/readSettings", "name": "readSettings", "root": "settings", "section": "SYSTEM" }], not ${JSON.stringify(raw.settingsFunctions)}`);
  }
  for (const { root } of settingsFunctions) {
    if (!(raw.settingsRoots ?? []).includes(root)) throw new Error(`settingsFunctions root "${root}" is not listed in settingsRoots`);
  }
  const visitRecords = raw.visitRecords ?? [];
  if (!Array.isArray(visitRecords) || !visitRecords.every(isText)) {
    throw new Error(`visitRecords must be a list of record files or folders, such as ["qa/records"], not ${JSON.stringify(raw.visitRecords)}`);
  }
  if (raw.author !== undefined && !(typeof raw.author === 'string' && raw.author.trim())) {
    throw new Error(`author must be the name to sign review marks and judgments with, such as "Kim Min", not ${JSON.stringify(raw.author)}`);
  }
  const stubs = raw.constantStubs ?? {};
  if (!isPlainObject(stubs) || !Object.values(stubs).every((v) => typeof v === 'string')) {
    throw new Error(`constantStubs must map imports to the module source that stands in for them, such as { "axios": "export default { create: () => ({}) };" }, not ${JSON.stringify(raw.constantStubs)}`);
  }
  const calledApiModules = raw.calledApiModules ?? [];
  if (!Array.isArray(calledApiModules) || !calledApiModules.every(isText) || new Set(calledApiModules).size < calledApiModules.length) {
    throw new Error(`calledApiModules must be a list of files exporting API objects or API functions, as paths from srcRoot with each file once, such as ["api/index.ts"], not ${JSON.stringify(raw.calledApiModules)}`);
  }
  const twice = calledApiModules.find((f) => (raw.apiModules ?? []).includes(f));
  if (twice) throw new Error(`${twice} is in both apiModules and calledApiModules; list it in one of them`);
  const requestFunction = raw.requestFunction ?? null;
  const { import: from, name, method, url, body, object, ...extraKeys } = isPlainObject(requestFunction) ? requestFunction : {};
  const isArgumentPlace = (v: unknown) => typeof v === 'string' && ARGUMENT_PLACE.test(v);
  const places = object === true ? method === undefined && url === undefined && body === undefined
    : (object === undefined || object === false) && isArgumentPlace(url) && [method, body].every((v) => v === undefined || isArgumentPlace(v));
  if (requestFunction !== null && !(isText(from) && isText(name) && (name === 'default' || IDENTIFIER.test(name)) && places && !Object.keys(extraKeys).length)) {
    throw new Error(`requestFunction must be { "import", "name", "method", "url", "body" }: the import path and name the app's API code imports the function sending its requests by, `
      + 'and where the method, the address and the request body (optional) are among the values it is given, as the place of the value counted from 0 followed by the keys inside it, '
      + 'such as { "import": "@/api/request", "name": "executeRequest", "method": "0.endpoint.method", "url": "0.url", "body": "0.body" }; '
      + 'or, when the API code calls get, post, put, patch and delete of a request object with the address first, { "import", "name", "object": true }, '
      + `such as { "import": "axios", "name": "default", "object": true }, not ${JSON.stringify(requestFunction)}`);
  }
  if (requestFunction && !calledApiModules.length) throw new Error('requestFunction is set but calledApiModules lists no file to call');
  if (raw.tsconfig !== undefined && !isText(raw.tsconfig)) {
    throw new Error(`tsconfig must be the path of the tsconfig file that declares the import aliases, such as "client/tsconfig.json", not ${JSON.stringify(raw.tsconfig)}`);
  }
  const tsconfig = raw.tsconfig === undefined ? null : at(raw.tsconfig);
  const sourcePackages = raw.sourcePackages ?? {};
  if (!isPlainObject(sourcePackages) || !Object.entries(sourcePackages).every(([name, folder]) => PACKAGE_NAME.test(name) && isText(folder))) {
    throw new Error(`sourcePackages must map package names the app imports to the folders holding their source, as paths from the config file, such as { "@mattermost/client": "webapp/platform/client/src" }, not ${JSON.stringify(raw.sourcePackages)}`);
  }
  for (const [name, folder] of Object.entries<string>(sourcePackages)) {
    if (!fs.existsSync(at(folder)) || !fs.statSync(at(folder)).isDirectory()) throw new Error(`sourcePackages ${name}: ${folder} is not a folder`);
  }
  const packageRules: AliasRule[] = Object.entries<string>(sourcePackages).flatMap(([name, folder]) => [
    { name, targets: [at(folder)], anywhere: true },
    { name: `${name}/*`, targets: [path.join(at(folder), '*')], anywhere: true },
  ]);
  const app = raw.app === undefined ? null : appSettings(raw.app, at, raw);
  const outDir = at(raw.outDir ?? '.');
  return {
    ...raw,
    constants,
    routeConstant: raw.routeConstant || null,
    configDir,
    author: raw.author?.trim() ?? null,
    srcRoot: at(raw.srcRoot),
    routeFiles: routesFile === undefined ? [] : routeFilesOf(routesFile, at(raw.srcRoot)),
    tsconfig,
    aliases: tsconfig || packageRules.length ? [...packageRules, ...(tsconfig ? loadAliases(tsconfig) : [])] : null,
    roleIdentifiers: raw.roleIdentifiers ?? [],
    roleGuards: Object.fromEntries(Object.entries<any>(roleGuards).map(([guard, roles]) => [guard, [...new Set(roles)].sort()])),
    calledApiModules,
    requestFunction,
    bodyArgKeys,
    bodyOptions,
    bodyTypeExclusions,
    moves,
    callLinks,
    settingsDefaults,
    settingsFunctions,
    redirectElements: raw.redirectElements ?? ['Redirect', 'Navigate'],
    entryPaths: raw.entryPaths ?? [],
    serverEndpoints: [raw.serverEndpoints ?? []].flat().map(at),
    outDir,
    marksDir: raw.marksDir ? at(raw.marksDir) : path.join(outDir, 'marks'),
    judgmentsDir: raw.judgmentsDir ? at(raw.judgmentsDir) : path.join(outDir, 'judgments'),
    storiesDir: raw.storiesDir ? at(raw.storiesDir) : path.join(outDir, 'stories'),
    visitRecords: visitRecords.map(at),
    tests,
    app,
  };
}

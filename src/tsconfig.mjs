import fs from 'node:fs';
import path from 'node:path';

const PATHS_EXAMPLE = '{ "@domains/*": ["src/domains/*"] }';
const CONFIG_DIR = '${configDir}';

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function stripJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      out += ' ';
    } else if (ch === '}' || ch === ']') {
      out = out.replace(/,(\s*)$/, '$1') + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function readJsonc(file) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
  } catch (err) {
    throw new Error(`tsconfig file ${file} cannot be read as JSON (comments and trailing commas are allowed): ${err.message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`tsconfig file ${file} must hold a JSON object, not ${JSON.stringify(parsed)}`);
  return parsed;
}

const isFile = (file) => fs.existsSync(file) && fs.statSync(file).isFile();

function extendedFile(from, spec) {
  const dir = path.dirname(from);
  const relative = spec.startsWith('.') || path.isAbsolute(spec);
  const bases = relative ? [path.resolve(dir, spec)] : ancestors(dir).map((d) => path.join(d, 'node_modules', spec));
  const found = bases.flatMap((base) => [base, `${base}.json`, path.join(base, 'tsconfig.json')]).find(isFile);
  if (!found) throw new Error(`tsconfig file ${from} extends ${JSON.stringify(spec)}, which was not found`);
  return found;
}

function ancestors(dir) {
  const parent = path.dirname(dir);
  return parent === dir ? [dir] : [dir, ...ancestors(parent)];
}

function ownOptions(file, json, rootDir) {
  const options = json.compilerOptions ?? {};
  if (!isPlainObject(options)) throw new Error(`compilerOptions in ${file} must be an object, not ${JSON.stringify(options)}`);
  const { baseUrl, paths } = options;
  if (baseUrl !== undefined && typeof baseUrl !== 'string') {
    throw new Error(`compilerOptions.baseUrl in ${file} must be a folder path such as "src", not ${JSON.stringify(baseUrl)}`);
  }
  if (paths !== undefined) {
    const valid = isPlainObject(paths) && Object.values(paths).every((targets) => Array.isArray(targets) && targets.every((t) => typeof t === 'string'));
    if (!valid) throw new Error(`compilerOptions.paths in ${file} must map names to lists of paths, such as ${PATHS_EXAMPLE}, not ${JSON.stringify(paths)}`);
    const tooMany = Object.entries(paths).find(([name, targets]) => [name, ...targets].some((s) => s.split('*').length > 2));
    if (tooMany) throw new Error(`compilerOptions.paths in ${file} may have at most one "*" in a name and in each of its paths, but ${JSON.stringify(tooMany[0])} has more`);
  }
  return {
    ...(baseUrl !== undefined && { baseUrl: path.resolve(path.dirname(file), expanded(baseUrl, rootDir)) }),
    ...(paths !== undefined && { paths, pathsDir: path.dirname(file) }),
  };
}

// 이어받은 paths 는 항목마다 합쳐지지 않고 통째로 바뀐다.
function effectiveOptions(file, rootDir, chain = []) {
  if (chain.includes(file)) throw new Error(`tsconfig file ${file} extends itself through ${chain.join(' → ')} → ${file}`);
  const json = readJsonc(file);
  const parents = json.extends === undefined ? [] : [json.extends].flat();
  if (!parents.every((p) => typeof p === 'string')) {
    throw new Error(`extends in ${file} must be a file path or a list of them, such as "./tsconfig.base.json", not ${JSON.stringify(json.extends)}`);
  }
  const inherited = parents.map((p) => effectiveOptions(extendedFile(file, p), rootDir, [...chain, file]));
  return Object.assign({}, ...inherited, ownOptions(file, json, rootDir));
}

const expanded = (text, rootDir) => (text.startsWith(CONFIG_DIR) ? rootDir + text.slice(CONFIG_DIR.length) : text);

// 돌려주는 targets 는 절대 경로이고 `*` 가 남아 있을 수 있다.
export function loadAliases(tsconfigFile) {
  const file = path.resolve(tsconfigFile);
  if (!isFile(file)) throw new Error(`tsconfig file ${file} does not exist, but tsconfig must be the path of a tsconfig file such as "client/tsconfig.json"`);
  const rootDir = path.dirname(file);
  const { baseUrl, paths = {}, pathsDir } = effectiveOptions(file, rootDir);
  if (!Object.keys(paths).length) {
    throw new Error(`tsconfig file ${file} declares no import aliases: compilerOptions.paths is missing or empty, in it and in the files it extends; `
      + 'name the tsconfig file that holds them (a file that only lists "references" holds none), such as "client/tsconfig.app.json"');
  }
  const base = baseUrl ?? pathsDir;
  return Object.entries(paths).map(([name, targets]) => ({ name, targets: targets.map((t) => path.resolve(base, expanded(t, rootDir))) }));
}

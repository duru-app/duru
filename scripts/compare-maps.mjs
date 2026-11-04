#!/usr/bin/env node
// 두 duru 로 같은 클라이언트를 rebuild 해서 지도와 출력의 차이를 보고한다.
// 사용: node scripts/compare-maps.mjs <head: 커밋·브랜치·폴더> [--base <ref>] [--config <file>]
// 기본 설정은 ~/duru-verify-out/compare.config.json 이고, 결과는 ~/duru-verify-out/compare/ 에 쌓인다.
// 종료 코드: 0 차이 없음, 3 차이 있음, 4 PR 쪽 설치나 rebuild 실패, 2 잘못된 사용, 1 그 밖의 실행 실패.
// 결과에 비공개 클라이언트의 경로와 이름이 들어 있으므로 공개 저장소나 PR 본문에 옮기지 않는다.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const REPO = path.resolve(import.meta.dirname, '..');
const DEFAULT_CONFIG = path.join(HOME, 'duru-verify-out/compare.config.json');
const REPORTS = path.join(HOME, 'duru-verify-out/compare');
const IGNORED_KEYS = new Set(['generatedAt', 'duruCommit']);
const KEPT_FOLDERS = { marksDir: 'marks', storiesDir: 'stories', judgmentsDir: 'judgments' };

class HeadFailed extends Error {}

function parseArgs(argv) {
  const opts = { base: 'origin/main', config: DEFAULT_CONFIG, head: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') opts.base = argv[++i];
    else if (argv[i] === '--config') opts.config = path.resolve(argv[++i]);
    else if (!opts.head) opts.head = argv[i];
    else opts.head = null, i = argv.length;
  }
  if (!opts.head || !opts.base) {
    console.error('usage: node scripts/compare-maps.mjs <head commit, branch or folder> [--base <ref>] [--config <file>]');
    process.exit(2);
  }
  return opts;
}

const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const short = (sha) => sha.slice(0, 8);

function lockedVersions(file) {
  const { packages } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return JSON.stringify(Object.entries(packages).filter(([name]) => name).map(([name, { version }]) => [name, version]).sort());
}

function installedFrom(dir) {
  const hidden = path.join(REPO, 'node_modules/.package-lock.json');
  return fs.existsSync(hidden) && lockedVersions(hidden) === lockedVersions(path.join(dir, 'package-lock.json'));
}

function checkout(sha, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const tar = spawnSync('sh', ['-c', `git -C "${REPO}" archive ${sha} | tar -x -C "${dir}"`], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`could not unpack ${sha}: ${tar.stderr}`);
  if (installedFrom(dir)) {
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
    return 'shared node_modules';
  }
  execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1 << 28 });
  return 'own npm ci';
}

const rebuildFailed = (run) => run.status !== 0 || run.error;
const howItEnded = (run) => run.error?.message ?? run.signal ?? `exit ${run.status}`;

function rebuild(duruDir, config, configFile, outDir, baselineMap) {
  const written = { ...config, outDir };
  if (baselineMap) written.baselineMap = baselineMap;
  else delete written.baselineMap;
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const [key, name] of Object.entries(KEPT_FOLDERS)) {
    const from = path.resolve(configDir, config[key] || path.join(config.outDir, name));
    written[key] = path.join(outDir, name);
    if (fs.existsSync(from)) fs.cpSync(from, written[key], { recursive: true });
  }
  fs.writeFileSync(configFile, JSON.stringify(written, null, 2));
  const started = Date.now();
  const run = spawnSync('node', [path.join(duruDir, 'src/cli.ts'), 'rebuild', configFile], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return { status: run.status, signal: run.signal, error: run.error, stdout: run.stdout ?? '', stderr: run.stderr ?? '', seconds: Math.round((Date.now() - started) / 1000) };
}

// 기준 지도를 준 쪽에만 찍히는 내용은 빼야 두 출력을 견줄 수 있다.
function comparableOutput(text) {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('changes since '))
    .map((line) => line.replace(/ \| new since \S+ \d+/, '').replace(/, \d+ of them new since \S+/, ''))
    .join('\n');
}

const isKeyedList = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x?.id === 'string') && new Set(v.map((x) => x.id)).size === v.length;
const patternKey = (k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : '{}');

function diffOrder(a, b, at, pattern, out) {
  const [left, right] = [a, b].map((names) => new Set(names));
  const before = a.filter((name) => right.has(name));
  const after = b.filter((name) => left.has(name));
  const moved = before.findIndex((name, i) => name !== after[i]);
  if (moved >= 0) out.push({ at: `${at}(order)`, pattern: `${pattern}(order)`, before: before.slice(moved), after: after.slice(moved) });
}

function diffJson(a, b, at, pattern, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (isKeyedList(a) && isKeyedList(b)) {
    const [left, right] = [a, b].map((list) => new Map(list.map((x) => [x.id, x])));
    diffOrder(a.map((x) => x.id), b.map((x) => x.id), at, pattern, out);
    for (const id of new Set([...left.keys(), ...right.keys()])) diffJson(left.get(id), right.get(id), `${at}[${id}]`, `${pattern}[]`, out);
    return;
  }
  const plain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (plain(a) && plain(b)) {
    const compared = (o) => Object.keys(o).filter((k) => !IGNORED_KEYS.has(k));
    diffOrder(compared(a), compared(b), at, pattern, out);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (IGNORED_KEYS.has(k)) continue;
      diffJson(a[k], b[k], `${at}.${k}`, `${pattern}.${patternKey(k)}`, out);
    }
    return;
  }
  out.push({ at, pattern, before: a, after: b });
}

function listFiles(root, dir = '') {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(root, rel) : [rel];
  });
}

// rebuild 가 만드는 후보 파일은 이름에 난수가 들어가고 내용에 만든 시각이 들어가므로, 그 둘을 뺀 내용끼리 견준다.
const RANDOM_NAMED = /^\d{4}-\d\d-\d\d-[0-9a-f]{8}\.json$/;
const isRandomNamed = (file) => RANDOM_NAMED.test(path.basename(file));

function randomNamedContents(root, files) {
  const contents = new Map();
  for (const file of files) {
    const { date, ...rest } = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const key = `${path.dirname(file)}\0${JSON.stringify(rest)}`;
    contents.set(key, { folder: path.dirname(file), name: rest.name, count: (contents.get(key)?.count ?? 0) + 1 });
  }
  return contents;
}

function compareRandomNamed(left, right, l, r) {
  const [a, b] = [randomNamedContents(left, l), randomNamedContents(right, r)];
  const lines = [];
  for (const [key, { folder, name, count }] of a) if (b.get(key)?.count !== count) lines.push(`only in base: ${folder}: ${name}`);
  for (const [key, { folder, name, count }] of b) if (a.get(key)?.count !== count) lines.push(`only in head: ${folder}: ${name}`);
  return lines;
}

function compareFolders(left, right) {
  const jsonDiffs = {};
  const [allLeft, allRight] = [listFiles(left), listFiles(right)];
  const other = compareRandomNamed(left, right, allLeft.filter(isRandomNamed), allRight.filter(isRandomNamed));
  const [l, r] = [allLeft, allRight].map((files) => new Set(files.filter((f) => !isRandomNamed(f))));
  for (const file of [...new Set([...l, ...r])].sort()) {
    if (!l.has(file) || !r.has(file)) {
      other.push(`${l.has(file) ? 'only in base' : 'only in head'}: ${file}`);
      continue;
    }
    const [x, y] = [left, right].map((root) => fs.readFileSync(path.join(root, file)));
    if (x.equals(y)) continue;
    if (file.endsWith('.json')) {
      const found = [];
      diffJson(JSON.parse(x.toString()), JSON.parse(y.toString()), '', '', found);
      if (found.length) jsonDiffs[file] = found;
    } else other.push(`differs: ${file}`);
  }
  return { jsonDiffs, other };
}

function lineDiff(a, b) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-maps-'));
  const [x, y] = [path.join(dir, 'base'), path.join(dir, 'head')];
  fs.writeFileSync(x, a);
  fs.writeFileSync(y, b);
  const run = spawnSync('diff', ['-a', '-U0', '--label', 'base', '--label', 'head', x, y], { encoding: 'utf8', maxBuffer: 1 << 28 });
  fs.rmSync(dir, { recursive: true, force: true });
  if (run.status !== 0 && run.status !== 1) throw new Error(`diff of the two outputs failed: ${run.error?.message ?? run.stderr}`);
  return run.stdout;
}

const clip = (v) => {
  const text = JSON.stringify(v) ?? 'absent';
  return text.length > 400 ? `${text.slice(0, 400)}…(${text.length} chars)` : text;
};

function summarize(found) {
  const byPattern = new Map();
  for (const d of found) byPattern.set(d.pattern, [...(byPattern.get(d.pattern) ?? []), d]);
  return [...byPattern.entries()].sort((a, b) => b[1].length - a[1].length).map(([pattern, list]) => `  ${pattern || '(root)'}: ${list.length}, e.g. ${list.slice(0, 2).map((d) => d.at).join(' ; ')}`);
}

const opts = parseArgs(process.argv.slice(2));
if (!fs.existsSync(opts.config)) {
  console.error(`no client config at ${opts.config}; pass one with --config`);
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(opts.config, 'utf8'));
const configDir = path.dirname(opts.config);
config.outDir = path.resolve(configDir, config.outDir ?? '.');

const fetched = spawnSync('git', ['-C', REPO, 'fetch', 'origin', '--quiet']).status === 0;
if (!fetched) console.error('fetch failed: comparing with the origin refs already on this PC');
const headIsFolder = fs.existsSync(path.join(opts.head, 'src/cli.ts'));
const headSha = headIsFolder ? null : git('rev-parse', '--verify', `${opts.head}^{commit}`);
// 기준 브랜치가 앞서 나갔을 때 그 변경이 PR 의 변경으로 보이지 않도록 갈라진 지점과 견준다.
const baseSha = headSha ? git('merge-base', opts.base, headSha) : git('rev-parse', '--verify', `${opts.base}^{commit}`);
const label = `${short(baseSha)}..${headSha ? short(headSha) : `folder-${path.basename(path.resolve(opts.head))}`}`;

// 설정 안의 상대 경로가 그대로 맞도록 임시 설정은 원본 옆에 둔다. 출력 폴더 경로가 같아야 두 결과에 경로 차이가 생기지 않는다.
const work = path.join(configDir, `.compare-${process.pid}`);
const configFile = path.join(configDir, `.compare-${process.pid}.config.json`);
const outDir = path.join(work, 'out');
const reportDir = path.join(REPORTS, `${label}.${process.pid}`);
let exitCode = 1;

try {
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });
  const report = [`base ${baseSha}`, `head ${headSha ?? path.resolve(opts.head)}`, `client ${config.srcRoot}`];
  if (!fetched) report.push('fetch failed: compared with the origin refs already on this PC');

  const baseDir = path.join(work, 'duru-base');
  report.push(`base install: ${checkout(baseSha, baseDir)}`);
  let headDir = path.resolve(opts.head);
  if (headSha) {
    headDir = path.join(work, 'duru-head');
    try {
      report.push(`head install: ${checkout(headSha, headDir)}`);
    } catch (err) {
      throw new HeadFailed(`head install failed: ${err.message}`);
    }
  }

  const baseRun = rebuild(baseDir, config, configFile, outDir, null);
  fs.writeFileSync(path.join(reportDir, 'base.log'), baseRun.stdout + baseRun.stderr);
  if (rebuildFailed(baseRun)) throw new Error(`base rebuild failed (${howItEnded(baseRun)}); see ${reportDir}/base.log`);
  const baseOut = path.join(work, 'base-out');
  fs.renameSync(outDir, baseOut);
  const baselineMap = path.join(work, 'baseline-map.json');
  fs.copyFileSync(path.join(baseOut, 'map.json'), baselineMap);

  let headRun = rebuild(headDir, config, configFile, outDir, baselineMap);
  let refused = null;
  if (headRun.status !== 0 && headRun.stderr.includes('baselineMap')) {
    refused = headRun.stderr.trim();
    headRun = rebuild(headDir, config, configFile, outDir, null);
  }
  fs.writeFileSync(path.join(reportDir, 'head.log'), headRun.stdout + headRun.stderr);
  if (rebuildFailed(headRun)) throw new HeadFailed(`head rebuild failed (${howItEnded(headRun)}); see ${reportDir}/head.log`);

  const changes = headRun.stdout.split('\n').find((line) => line.startsWith('changes since '));
  const { jsonDiffs, other } = compareFolders(baseOut, outDir);
  const outputDiff = lineDiff(comparableOutput(baseRun.stdout), comparableOutput(headRun.stdout));
  fs.writeFileSync(path.join(reportDir, 'output.diff'), outputDiff);
  const details = Object.entries(jsonDiffs).flatMap(([file, found]) => found.map((d) => `${file}${d.at}\n  - ${clip(d.before)}\n  + ${clip(d.after)}`));
  fs.writeFileSync(path.join(reportDir, 'json-details.txt'), details.join('\n') + (details.length ? '\n' : ''));

  const counted = changes?.replace(/^changes since \S+ \| /, '') ?? null;
  const countedTotal = counted ? [...counted.matchAll(/ (\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0) : null;
  const outputLines = outputDiff.split('\n').slice(2).filter((l) => /^[-+]/.test(l)).length;
  const jsonCount = Object.values(jsonDiffs).reduce((sum, found) => sum + found.length, 0);
  const different = refused !== null || (countedTotal ?? 0) > 0 || jsonCount > 0 || other.length > 0 || outputLines > 0;

  report.push(`rebuild seconds: base ${baseRun.seconds}, head ${headRun.seconds}`);
  report.push(refused ? `baseline refused by head, rebuilt without it: ${refused}` : `changes since: ${counted}`);
  report.push(`output lines differing: ${outputLines} (output.diff)`);
  report.push(`json values differing: ${jsonCount} (json-details.txt)`);
  for (const [file, found] of Object.entries(jsonDiffs)) report.push(`${file}: ${found.length}`, ...summarize(found).slice(0, 40));
  report.push(`other files differing: ${other.length}`, ...other.slice(0, 40).map((l) => `  ${l}`));
  report.push(`result: ${different ? 'DIFFERENT' : 'SAME'}`);
  fs.writeFileSync(path.join(reportDir, 'report.txt'), report.join('\n') + '\n');
  console.log(report.join('\n'));
  console.log(`report ${reportDir}/report.txt`);
  exitCode = different ? 3 : 0;
} catch (err) {
  if (err instanceof HeadFailed) exitCode = 4;
  console.error(err.message);
  console.error(`report folder ${reportDir}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(configFile, { force: true });
}
process.exit(exitCode);

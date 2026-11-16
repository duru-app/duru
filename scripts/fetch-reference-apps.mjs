#!/usr/bin/env node
// 기준 앱의 소스를 고정한 커밋으로 받고, duru 설정이 있는 앱에는 설정을 옆에 놓는다.
// 사용: node scripts/fetch-reference-apps.mjs [--dir <folder>] [앱 이름...]
// 기본 자리는 ~/duru-target-apps 이고, 앱마다 <앱>/src 에 소스가, <앱>/<설정 이름>.config.json 에 설정이 놓인다.
// 종료 코드: 0 모두 받음, 1 받지 못한 앱이 있음, 2 잘못된 사용.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.join(import.meta.dirname, 'reference-apps');
const APPS = JSON.parse(fs.readFileSync(path.join(HERE, 'apps.json'), 'utf8'));
const ROOT_FILES = ['/package.json', '/tsconfig*.json', '/*.md'];

function parseArgs(argv) {
  const opts = { dir: path.join(os.homedir(), 'duru-target-apps'), names: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) opts.dir = path.resolve(argv[++i]);
    else if (argv[i].startsWith('-')) usage();
    else opts.names.push(argv[i]);
  }
  const unknown = opts.names.filter((n) => !APPS.some((a) => a.name === n));
  if (unknown.length) {
    console.error(`unknown app: ${unknown.join(', ')} (known: ${APPS.map((a) => a.name).join(', ')})`);
    process.exit(2);
  }
  return opts;
}

function usage() {
  console.error('usage: node scripts/fetch-reference-apps.mjs [--dir <folder>] [app name...]');
  process.exit(2);
}

const run = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function headOf(src) {
  try {
    return run(src, 'rev-parse', 'HEAD');
  } catch {
    return null;
  }
}

function fetchApp(app, dir) {
  const src = path.join(dir, app.name, 'src');
  fs.mkdirSync(src, { recursive: true });
  if (!fs.existsSync(path.join(src, '.git'))) {
    run(src, 'init', '-q');
    run(src, 'remote', 'add', 'origin', `https://github.com/${app.repo}.git`);
  }
  run(src, 'sparse-checkout', 'init', '--no-cone');
  fs.writeFileSync(path.join(src, '.git/info/sparse-checkout'), [...app.paths, ...ROOT_FILES].join('\n') + '\n');
  if (headOf(src) === app.commit) {
    run(src, 'sparse-checkout', 'reapply');
  } else {
    run(src, 'fetch', '-q', '--depth', '1', '--no-tags', '--filter=blob:none', 'origin', app.commit);
    run(src, 'checkout', '-q', '--detach', 'FETCH_HEAD');
  }
  for (const name of app.configs) {
    fs.copyFileSync(path.join(HERE, `${name}.config.json`), path.join(dir, app.name, `${name}.config.json`));
  }
  return src;
}

const opts = parseArgs(process.argv.slice(2));
const wanted = APPS.filter((a) => !opts.names.length || opts.names.includes(a.name));
let failed = 0;
for (const app of wanted) {
  try {
    const src = fetchApp(app, opts.dir);
    const configs = app.configs.length ? `, 설정 ${app.configs.map((c) => `${c}.config.json`).join(' ')}` : ', 설정 없음';
    console.log(`${app.name} ${app.commit.slice(0, 8)} ${src}${configs}`);
  } catch (e) {
    failed++;
    console.error(`${app.name}: 받지 못함 — ${(e.stderr || e.message).toString().trim().split('\n').pop()}`);
  }
}
process.exit(failed ? 1 : 0);

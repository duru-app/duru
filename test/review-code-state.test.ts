import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { addJudgment, loadJudgments } from '../src/judgments.ts';
import { addMark, loadMarks } from '../src/marks.ts';
import { reviewData } from '../src/review.ts';
import type { PageData } from '../src/review.ts';
import { taskList } from '../src/tasks.ts';
import { browserMissing, CASE_KINDS, decideCase, DOCUMENT_TABLE, HOME_NODE, postJudgment, postMark, rebuild, withPage, withRebuiltFixture, withServer } from './review-helpers.ts';
import type { Config } from './review-helpers.ts';

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const mapOf = (config: { outDir: string }) => readJson(path.join(config.outDir, 'map.json'));
const hashOf = (config: { outDir: string }, id: string): string => [...mapOf(config).screens, ...mapOf(config).calls].find((n: { id: string }) => n.id === id).codeHash;

test('a mark saved on a screen or a call, or on a part of one, keeps the code hash the map has for it; one on a story or on several targets, and a reply, keep none; and a hash sent by the page is not taken', () =>
  withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const call = 'GET:/api/v1/document/list';
      const saved = async (body: object) => {
        const res = await postMark(base, body);
        assert.equal(res.status, 201, await res.clone().text());
        return (await res.json()).id;
      };
      const ids = {
        screen: await saved({ target: { node: '/help#Help' }, status: 'fine', note: '', codeHash: 'from the page' }),
        call: await saved({ target: { node: call, depth: 'api' }, status: 'needs-more', note: '' }),
        part: await saved({ target: { node: '/help#Help', part: { kind: 'condition', key: 'role:ADMIN' } }, note: 'why?' }),
        several: await saved({ targets: [{ node: '/help#Help' }, { node: HOME_NODE }], note: 'both' }),
        listedAlone: await saved({ targets: [{ node: HOME_NODE }], note: 'one in a list' }),
      };
      const reply = await fetch(`${base}/api/replies`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replyTo: ids.part, note: 'because' }) });
      assert.equal(reply.status, 201);
      const marks = loadMarks(config.marksDir);
      const hashIn = (id: string) => marks.find((m) => m.id === id)!.codeHash;
      assert.equal(hashIn(ids.screen), hashOf(config, '/help#Help'));
      assert.equal(hashIn(ids.call), hashOf(config, call));
      assert.equal(hashIn(ids.part), hashOf(config, '/help#Help'));
      assert.equal(hashIn(ids.several), undefined);
      assert.equal(hashIn(ids.listedAlone), hashOf(config, HOME_NODE));
      assert.equal(marks.find((m) => m.replyTo === ids.part)!.codeHash, undefined);
      assert.match(hashOf(config, '/help#Help'), /^[0-9a-f]{64}$/);
    })));

test('a judgment on a test pair keeps the code hash of the screen or call and the hash of the test file the test links keep for it, and only the first when the test file is not under srcRoot', () =>
  withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const tests = readJson(path.join(config.outDir, 'tests.json'));
      const res = await postJudgment(base, { test: DOCUMENT_TABLE, node: HOME_NODE, kind: 'discard', reason: 'judged', codeHash: 'from the page', testFileHash: 'from the page' });
      assert.equal(res.status, 201, await res.clone().text());
      const outside = await postJudgment(base, { test: { source: 'results/playwright/report.json', file: 'e2e/help.spec.ts', title: 'opens help' }, node: '/help#Help', kind: 'hand-over', reason: '' });
      assert.equal(outside.status, 201, await outside.clone().text());
      const judged = loadJudgments(config.judgmentsDir).judgments;
      const home = judged.find((j) => j.node === HOME_NODE)!;
      assert.equal(home.codeHash, hashOf(config, HOME_NODE));
      assert.equal(home.testFileHash, tests.testFileHashes[DOCUMENT_TABLE.file]);
      const help = judged.find((j) => j.node === '/help#Help')!;
      assert.equal(help.codeHash, hashOf(config, '/help#Help'));
      assert.equal('testFileHash' in help, false);
    })));

test('a case mark written by duru case keeps the code hash of its screen or call', () =>
  withRebuiltFixture({ caseKinds: CASE_KINDS }, async (config, copy) => {
    await decideCase(copy, 'boundary', '/help#Help', 'needed');
    const [mark] = loadMarks(config.marksDir);
    assert.equal(mark.codeHash, hashOf(config, '/help#Help'));
  }));

const LIST_NODE = '/document/:tab#DocumentList';
const pageData = (config: Config): PageData => JSON.parse(JSON.stringify(reviewData(config, null)));
const edit = (copy: string, file: string) => {
  const at = path.join(copy, 'client/src', file);
  fs.writeFileSync(at, `${fs.readFileSync(at, 'utf8')}\n// changed after the review\n`);
};

async function judgedAndChanged(config: Config, copy: string, base: string) {
  const tests = readJson(path.join(config.outDir, 'tests.json'));
  const help = tests.importers['/help#Help'].find((t: { title: string }) => t.title.includes('renders the help text'));
  const helpRef = { source: help.source, file: help.testFile, title: help.title };
  for (const body of [
    { target: { node: '/help#Help' }, status: 'fine', note: '' },
    { target: { node: HOME_NODE }, status: 'needs-more', note: 'more' },
    { target: { node: '/help#Help', depth: 'ui' }, status: 'fine', note: '' },
  ]) assert.equal((await postMark(base, body)).status, 201);
  assert.equal((await postJudgment(base, { test: DOCUMENT_TABLE, node: HOME_NODE, kind: 'discard', reason: 'judged' })).status, 201);
  assert.equal((await postJudgment(base, { test: helpRef, node: '/help#Help', kind: 'hand-over', reason: '' })).status, 201);
  addMark(config.marksDir, { target: { node: '/lab#Lab' }, status: 'fine', note: '', author: 'older duru' });
  addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: LIST_NODE, kind: 'discard', reason: 'older duru', author: 'older duru' });
  const before = pageData(config);
  const tasksBefore = taskList(config);
  edit(copy, 'components/formatDate.js');
  edit(copy, 'components/DocumentTable.spec.js');
  edit(copy, 'components/Lab.js');
  rebuild(copy);
  return { before, after: pageData(config), tasksBefore };
}

test('after a rebuild, a mark whose screen or call code changed and a judgment whose node code or test file changed carry codeChanged in the review data, and the rest, with marks and judgments saved without hashes, are as they were', () =>
  withRebuiltFixture({}, (config, copy) =>
    withServer(config, 'reviewer', async (base) => {
      const { before, after } = await judgedAndChanged(config, copy, base);
      const entry = (data: PageData, key: string) => data.marks.attached.find((m) => m.key === key)!;
      assert.equal(entry(after, '/help#Help').codeChanged, true);
      assert.equal(entry(after, '/help#Help ui').codeChanged, true);
      assert.deepEqual(entry(after, HOME_NODE), entry(before, HOME_NODE));
      assert.deepEqual(entry(after, '/lab#Lab'), entry(before, '/lab#Lab'));
      assert.equal('codeChanged' in entry(after, '/lab#Lab'), false);
      const pair = (data: PageData, list: 'discarded' | 'awaitingTag', node: string) => data.tests[list][node]?.[0];
      assert.equal(pair(after, 'discarded', HOME_NODE)!.codeChanged, true);
      assert.equal(pair(before, 'discarded', HOME_NODE)!.codeChanged, undefined);
      assert.equal(pair(after, 'awaitingTag', '/help#Help')!.codeChanged, true);
      assert.deepEqual(pair(after, 'discarded', LIST_NODE), pair(before, 'discarded', LIST_NODE));
      assert.equal('codeChanged' in pair(after, 'discarded', LIST_NODE)!, false);
    })));

const VERSION = readJson(path.join(import.meta.dirname, '../package.json')).version;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

test('in a browser, the header names the commit and duru version of the map and of the baseline map, and 「판정 뒤 코드가 바뀜」 shows beside a mark or judgment whose code changed and nowhere else', { skip: browserMissing }, () =>
  withRebuiltFixture({}, async (_, copy) => {
    git(copy, 'init', '-q');
    git(copy, 'add', '.');
    git(copy, 'commit', '-q', '-m', 'first');
    const head = git(copy, 'rev-parse', 'HEAD').slice(0, 7);
    rebuild(copy);
    fs.mkdirSync(path.join(copy, 'v1'));
    fs.copyFileSync(path.join(copy, 'out/map.json'), path.join(copy, 'v1/map.json'));
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...readJson(configFile), baselineMap: 'v1/map.json' }));
    const config = loadConfig(configFile);
    await withServer(config, 'reviewer', async (base) => {
      await judgedAndChanged(config, copy, base);
      await withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.match((await p.textContent('#meta .code-state'))!, new RegExp(`^커밋 ${head} \\+ 커밋 안 한 수정 · duru ${VERSION.replaceAll('.', '\\.')}( \\([0-9a-f]{7}\\))?$`));
        assert.match((await p.getAttribute('#meta .code-state', 'title'))!, /커밋하지 않은 수정이 섞여 있음/);
        assert.match((await p.textContent('#baseline .code-state'))!, new RegExp(`^커밋 ${head} · duru ${VERSION.replaceAll('.', '\\.')}`));
        const changedIn = (route: string) => p.locator(`#screen-list li:has-text("${route}") .badges .chip.code-changed`).count();
        assert.equal(await changedIn('/help'), 1);
        assert.equal(await changedIn('/home'), 0);
        assert.equal(await changedIn('/lab'), 0);
        assert.equal(await p.textContent('#screen-list li:has-text("/help") .chip.code-changed'), '판정 뒤 코드가 바뀜');
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.locator('#center td.mark .chip.code-changed').count(), 2);
        assert.equal(await p.locator('#center .awaiting-tag .chip.code-changed').count(), 1);
        await p.click('#screen-list li:has-text("/home")');
        assert.equal(await p.locator('#center td.mark .chip.code-changed').count(), 0);
        assert.equal(await p.locator('#center .discarded .chip.code-changed').count(), 1);
        await p.click('#screen-list li:has-text("/document/:tab")');
        assert.equal(await p.locator('#center .discarded .importer').count(), 1);
        assert.equal(await p.locator('#center .chip.code-changed').count(), 0);
      });
    });
  }));

test('the task list names under its own heading each mark and judgment whose code changed after it was left, and has no such heading while none did', () =>
  withRebuiltFixture({}, (config, copy) =>
    withServer(config, 'reviewer', async (base) => {
      const { tasksBefore } = await judgedAndChanged(config, copy, base);
      assert.doesNotMatch(tasksBefore, /Code changed after/);
      const tasks = taskList(config);
      const section = tasks.slice(tasks.indexOf('# Code changed after a mark or a judgment'));
      assert.match(section, /^# Code changed after a mark or a judgment\n\nduru keeps a hash [^\n]*「판정 뒤 코드가 바뀜」[^\n]*do not mark or judge them yourself\.\n\n/);
      const items = section.split('\n\n')[2].split('\n').filter((line) => line.startsWith('- '));
      const helpTitle = readJson(path.join(config.outDir, 'tests.json')).importers['/help#Help'].find((t: { title: string }) => t.title.includes('renders the help text')).title;
      assert.deepEqual(items.map((line) => line.replace(/ \(reviewer, \d{4}-\d{2}-\d{2}\)$/, '')), [
        '- /help#Help — marked `fine`',
        '- /help#Help, ui depth — marked `fine`',
        `- /help#Help — test "${helpTitle}" in components/Help.spec.js handed over for tagging`,
        `- ${HOME_NODE} — test "${DOCUMENT_TABLE.title}" in ${DOCUMENT_TABLE.file} discarded "judged"`,
      ]);
    })));

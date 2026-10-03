import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { addJudgment, applyJudgments, loadJudgments } from '../src/judgments.mjs';
import { buildMap } from '../src/map.mjs';
import { linkTests } from '../src/test-links.mjs';

const HELP_TEST = { source: 'results/vitest/client-unit.json', file: 'components/Help.spec.js', title: 'renders the help text' };
const REPORTED_PATH = '/builds/client/src/components/Help.spec.js';

function withJudgmentsDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    return fn(path.join(dir, 'judgments'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const snapshot = (dir) =>
  Object.fromEntries(fs.readdirSync(dir, { recursive: true }).sort().map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? fs.readFileSync(path.join(dir, f), 'utf8') : null]));

test('a discard is written with its test, node, kind, reason, author and date, and read back', () => {
  withJudgmentsDir((dir) => {
    assert.deepEqual(loadJudgments(dir), { judgments: [], notices: [] });
    const judgment = addJudgment(dir, { test: HELP_TEST, node: '/help#Help', kind: 'discard', reason: 'only renders a shared header', author: 'reviewer' }, new Date('2026-10-04T01:00:00Z'));
    assert.match(judgment.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(loadJudgments(dir), {
      judgments: [{ id: judgment.id, test: HELP_TEST, node: '/help#Help', kind: 'discard', reason: 'only renders a shared header', author: 'reviewer', date: '2026-10-04T01:00:00.000Z' }],
      notices: [],
    });
  });
});

test('a judgment names its test by result source, test file and title without tags, never by line or project', () => {
  withJudgmentsDir((dir) => {
    const judgment = addJudgment(dir, {
      test: { ...HELP_TEST, title: 'renders the help text @depth:code', line: 4, project: 'chromium', testFile: 'elsewhere/Help.spec.js' },
      node: '/help#Help', kind: 'discard', reason: 'r', author: 'a',
    });
    assert.deepEqual(judgment.test, HELP_TEST);
  });
});

test('each judgment is a new file in its node\'s folder, and earlier files are never rewritten', () => {
  withJudgmentsDir((dir) => {
    const first = addJudgment(dir, { test: HELP_TEST, node: '/help#Help', kind: 'discard', reason: 'r', author: 'Kim Min' }, new Date('2026-10-04T01:00:00Z'));
    const before = snapshot(dir);
    const second = addJudgment(dir, { test: HELP_TEST, node: '/help#Help', kind: 'undo', author: 'Kim Min' }, new Date('2026-10-05T01:00:00Z'));
    const after = snapshot(dir);
    for (const [file, text] of Object.entries(before)) assert.equal(after[file], text);
    assert.deepEqual(fs.readdirSync(path.join(dir, '_help#Help')).sort(), [
      `2026-10-04-Kim_Min-${first.id.slice(0, 8)}.json`,
      `2026-10-05-Kim_Min-${second.id.slice(0, 8)}.json`,
    ]);
  });
});

test('a judgment is refused when its kind is unknown, a discard has no reason, or the test, node or author is missing', () => {
  withJudgmentsDir((dir) => {
    const ok = { test: HELP_TEST, node: '/help#Help', kind: 'discard', reason: 'r', author: 'a' };
    assert.throws(() => addJudgment(dir, { ...ok, kind: 'keep' }), /unknown judgment kind "keep"/);
    assert.throws(() => addJudgment(dir, { ...ok, reason: '  ' }), /discard needs a reason/);
    assert.throws(() => addJudgment(dir, { ...ok, test: { source: HELP_TEST.source, file: HELP_TEST.file } }), /test needs a result source, a test file and a title/);
    assert.throws(() => addJudgment(dir, { ...ok, node: '' }), /needs a node ID/);
    assert.throws(() => addJudgment(dir, { ...ok, author: '' }), /needs an author/);
    assert.equal(fs.existsSync(dir), false);
  });
});

test('a judgment file that cannot be read is collected as a notice with its file and reason, and the others are still read', () => {
  withJudgmentsDir((dir) => {
    addJudgment(dir, { test: HELP_TEST, node: '/help#Help', kind: 'discard', reason: 'r', author: 'a' });
    fs.writeFileSync(path.join(dir, '_help#Help', 'broken.json'), '{');
    fs.writeFileSync(path.join(dir, '_help#Help', 'odd.json'), JSON.stringify({ id: 'x', test: HELP_TEST, node: '/help#Help', kind: 'keep', reason: '', author: 'a', date: '2026-10-04T01:00:00.000Z' }));
    const { judgments, notices } = loadJudgments(dir);
    assert.equal(judgments.length, 1);
    assert.deepEqual(notices.map((n) => n.file), [path.join('_help#Help', 'broken.json'), path.join('_help#Help', 'odd.json')]);
    assert.match(notices[0].reason, /JSON/);
    assert.match(notices[1].reason, /keep/);
  });
});

test('a judgments folder that is a file, or a folder named like a judgment file, is not read as judgments', () => {
  withJudgmentsDir((dir) => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'not a folder');
    const unreadable = loadJudgments(dir);
    assert.deepEqual(unreadable.judgments, []);
    assert.equal(unreadable.notices.length, 1);
    assert.equal(unreadable.notices[0].file, dir);
    assert.ok(unreadable.notices[0].reason);
    fs.rmSync(dir);

    addJudgment(dir, { test: HELP_TEST, node: '/help#Help', kind: 'discard', reason: 'r', author: 'a' });
    fs.mkdirSync(path.join(dir, '_help#Help', 'x.json'));
    const { judgments, notices } = loadJudgments(dir);
    assert.equal(judgments.length, 1);
    assert.deepEqual(notices, []);
  });
});

test('a judgment names its test with forward slashes when it is written', () => {
  withJudgmentsDir((dir) => {
    const judgment = addJudgment(dir, { test: { ...HELP_TEST, source: 'results\\vitest\\client-unit.json', file: 'components\\Help.spec.js' }, node: '/help#Help', kind: 'discard', reason: 'r', author: 'a' });
    assert.deepEqual(judgment.test, HELP_TEST);
  });
});

test('one judgments subfolder that cannot be listed is reported by itself and the other subfolders are still read', { skip: (process.getuid?.() === 0 || process.platform === 'win32') && 'permissions do not stop this user from listing' }, () => {
  withJudgmentsDir((dir) => {
    addJudgment(dir, { test: HELP_TEST, node: '/help#Help', kind: 'discard', reason: 'r', author: 'a' });
    addJudgment(dir, { test: HELP_TEST, node: '/home#Home', kind: 'discard', reason: 'r', author: 'a' });
    const locked = path.join(dir, '_home#Home');
    fs.chmodSync(locked, 0o000);
    try {
      const { judgments, notices } = loadJudgments(dir);
      assert.deepEqual(judgments.map((j) => j.node), ['/help#Help']);
      assert.equal(notices.length, 1);
      assert.equal(notices[0].file, '_home#Home');
      assert.match(notices[0].reason, /EACCES/);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});

test('a judgment file reached through a symbolic link is read, and one that points nowhere is reported', () => {
  withJudgmentsDir((dir) => {
    const written = addJudgment(dir, { test: HELP_TEST, node: '/help#Help', kind: 'discard', reason: 'r', author: 'a' });
    const file = fs.readdirSync(path.join(dir, '_help#Help'))[0];
    fs.mkdirSync(path.join(dir, 'linked'));
    fs.symlinkSync(path.join(dir, '_help#Help', file), path.join(dir, 'linked', 'one.json'));
    fs.symlinkSync(path.join(dir, 'missing.json'), path.join(dir, 'linked', 'gone.json'));
    const { judgments, notices } = loadJudgments(dir);
    assert.deepEqual(judgments.map((j) => j.id), [written.id, written.id]);
    assert.deepEqual(notices.map((n) => n.file), [path.join('linked', 'gone.json')]);
  });
});

test('a symbolic link back to a folder above it does not make the folder walk endless', () => {
  withJudgmentsDir((dir) => {
    addJudgment(dir, { test: HELP_TEST, node: '/help#Help', kind: 'discard', reason: 'r', author: 'a' });
    fs.symlinkSync(dir, path.join(dir, '_help#Help', 'up'));
    const { judgments, notices } = loadJudgments(dir);
    assert.equal(judgments.length, 1);
    assert.deepEqual(notices, []);
  });
});

const config = loadConfig(path.join(import.meta.dirname, 'fixtures/app/config.json'));
const map = await buildMap(config);

function withResults(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-judged-'));
  try {
    const file = path.join(dir, 'results.json');
    const rebuild = (line, reportedPath = REPORTED_PATH) => {
      const assertionResults = [
        { ancestorTitles: [], title: 'renders the help text', status: 'passed', location: { line } },
        { ancestorTitles: [], title: 'shows the day the help was last updated', status: 'passed', location: { line: line + 4 } },
      ];
      fs.writeFileSync(file, JSON.stringify({ testResults: [{ assertionResults, name: reportedPath }] }));
      return linkTests({ ...config, tests: [{ format: 'vitest', path: file, depth: 'code' }] }, map);
    };
    return fn(rebuild, path.relative(config.configDir, file), path.join(dir, 'judgments'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const titles = (tests) => (tests ?? []).map((t) => t.title);

test('a discarded pair is gone from the tests importing the screen after a rebuild, even when the test moved to another line, and is back after an undo', () => {
  withResults((rebuild, source, dir) => {
    const test = { ...HELP_TEST, source };
    addJudgment(dir, { test, node: '/help#Help', kind: 'discard', reason: 'only renders a shared header', author: 'a' }, new Date('2026-10-04T01:00:00Z'));

    const judged = applyJudgments(rebuild(4), loadJudgments(dir).judgments);
    assert.deepEqual(titles(judged.importers['/help#Help']), ['shows the day the help was last updated']);
    assert.deepEqual(judged.discarded['/help#Help'].map((t) => [t.title, t.judgment.reason]), [['renders the help text', 'only renders a shared header']]);

    const moved = applyJudgments(rebuild(10), loadJudgments(dir).judgments);
    assert.deepEqual(titles(moved.importers['/help#Help']), ['shows the day the help was last updated']);

    addJudgment(dir, { test, node: '/help#Help', kind: 'undo', author: 'b' }, new Date('2026-10-04T02:00:00Z'));
    const undone = applyJudgments(rebuild(10), loadJudgments(dir).judgments);
    assert.deepEqual(titles(undone.importers['/help#Help']), ['renders the help text', 'shows the day the help was last updated']);
    assert.deepEqual(undone.discarded, {});
  });
});

test('a discarded pair stays discarded when the results were written on another computer, with the test file under another folder', () => {
  withResults((rebuild, source, dir) => {
    const { ref } = applyJudgments(rebuild(4), []).importers['/help#Help'][0];
    addJudgment(dir, { test: ref, node: '/help#Help', kind: 'discard', reason: 'only renders a shared header', author: 'a' });

    const elsewhere = applyJudgments(rebuild(4, '/home/someone/checkout/client/src/components/Help.spec.js'), loadJudgments(dir).judgments);
    assert.deepEqual(titles(elsewhere.importers['/help#Help']), ['shows the day the help was last updated']);
  });
});

test('the newest judgment of a pair wins, whatever order its files were written in', () => {
  withResults((rebuild, source, dir) => {
    const test = { ...HELP_TEST, source };
    addJudgment(dir, { test, node: '/help#Help', kind: 'undo', author: 'a' }, new Date('2026-10-04T03:00:00Z'));
    addJudgment(dir, { test, node: '/help#Help', kind: 'discard', reason: 'r', author: 'a' }, new Date('2026-10-04T01:00:00Z'));
    const judged = applyJudgments(rebuild(4), loadJudgments(dir).judgments);
    assert.deepEqual(titles(judged.importers['/help#Help']), ['renders the help text', 'shows the day the help was last updated']);
    assert.deepEqual(judged.discarded, {});
  });
});

test('a discarded pair whose test is not in the results shows nowhere', () => {
  withResults((rebuild, source, dir) => {
    addJudgment(dir, { test: { ...HELP_TEST, source, title: 'a test that was removed' }, node: '/help#Help', kind: 'discard', reason: 'r', author: 'a' });
    const judged = applyJudgments(rebuild(4), loadJudgments(dir).judgments);
    assert.equal(judged.importers['/help#Help'].length, 2);
    assert.deepEqual(judged.discarded, {});
  });
});

test('each test importing a screen carries the reference a judgment names it by', () => {
  withResults((rebuild, source) => {
    const judged = applyJudgments(rebuild(4), []);
    assert.deepEqual(judged.importers['/help#Help'][0].ref, { ...HELP_TEST, source });
  });
});

test('the judgments folder defaults to judgments in outDir and can be set in the config', () => {
  assert.equal(config.judgmentsDir, path.join(config.outDir, 'judgments'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-config-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ srcRoot: 'src', serverEndpoints: 'endpoints.txt', judgmentsDir: 'review/judgments' }));
    assert.equal(loadConfig(file).judgmentsDir, path.join(dir, 'review/judgments'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const writeRaw = (dir, name, judgment) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(judgment));
};

test('a discard written on Windows, with backslashes in its paths, still discards the pair', () => {
  withResults((rebuild, source, dir) => {
    const windows = (p) => p.replaceAll('/', '\\');
    writeRaw(dir, 'win.json', {
      id: 'win-1', test: { source: windows(source), file: windows(HELP_TEST.file), title: HELP_TEST.title },
      node: '/help#Help', kind: 'discard', reason: 'r', author: 'a', date: '2026-10-04T01:00:00.000Z',
    });
    const judged = applyJudgments(rebuild(4), loadJudgments(dir).judgments);
    assert.deepEqual(titles(judged.importers['/help#Help']), ['shows the day the help was last updated']);
  });
});

test('judgments are ordered by the instant they name, not by their date text', () => {
  withResults((rebuild, source, dir) => {
    const base = { test: { ...HELP_TEST, source }, node: '/help#Help', reason: 'r', author: 'a' };
    writeRaw(dir, 'discard.json', { ...base, id: 'd', kind: 'discard', date: '2026-10-04T10:00:00+09:00' });
    writeRaw(dir, 'undo.json', { ...base, id: 'u', kind: 'undo', date: '2026-10-04T02:00:00.000Z' });
    const judged = applyJudgments(rebuild(4), loadJudgments(dir).judgments);
    assert.deepEqual(titles(judged.importers['/help#Help']), ['renders the help text', 'shows the day the help was last updated']);
    assert.deepEqual(judged.discarded, {});
  });
});

test('a judgment whose date names no time zone is reported, so its order never depends on the machine', () => {
  withResults((rebuild, source, dir) => {
    const base = { test: { ...HELP_TEST, source }, node: '/help#Help', reason: 'r', author: 'a', kind: 'discard' };
    writeRaw(dir, 'local.json', { ...base, id: 'l', date: '2026-10-04T05:00:00' });
    writeRaw(dir, 'day.json', { ...base, id: 'd', date: '2026-10-04' });
    writeRaw(dir, 'zoned.json', { ...base, id: 'z', date: '2026-10-04T05:00:00-03:00' });
    const { judgments, notices } = loadJudgments(dir);
    assert.deepEqual(judgments.map((j) => j.id), ['z']);
    assert.deepEqual(notices.map((n) => n.file), ['day.json', 'local.json']);
    assert.match(notices[0].reason, /time zone/);
  });
});

test('a stored judgment whose title carries a tag and doubled spaces still discards the pair', () => {
  withResults((rebuild, source, dir) => {
    writeRaw(dir, 'hand.json', {
      id: 'h', test: { source, file: HELP_TEST.file, title: 'renders  the help text @depth:code' },
      node: '/help#Help', kind: 'discard', reason: 'r', author: 'a', date: '2026-10-04T01:00:00.000Z',
    });
    const judged = applyJudgments(rebuild(4), loadJudgments(dir).judgments);
    assert.deepEqual(titles(judged.importers['/help#Help']), ['shows the day the help was last updated']);
  });
});

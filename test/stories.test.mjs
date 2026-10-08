import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { screenAccess } from '../src/access.mjs';
import { UNKNOWN } from '../src/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { buildMap } from '../src/map.mjs';
import { loadStories } from '../src/stories.mjs';
import { checkStories, checkStoryFiles } from '../src/story-paths.mjs';
import { linkTests } from '../src/test-links.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const EXAMPLES = path.join(FIXTURE, 'example-stories');
const config = loadConfig(path.join(FIXTURE, 'config.json'));
const map = await buildMap(config);
const examples = loadStories(EXAMPLES);
const checked = Object.fromEntries(checkStories(map, examples.stories).map((s) => [s.id, s]));

const verdicts = (story) => story.links.map((l) => `${l.from} → ${l.to} ${l.verdict}`);
const places = (ways) => ways.map((w) => `${w.file}:${w.line}`);

function withStoriesDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const STORY = { name: '문서를 연다', screens: ['/home#Home', '/lab#Lab'], memo: '', author: 'a', date: '2026-10-02' };

test('the story folder defaults to stories in the output folder', () => {
  assert.equal(config.storiesDir, path.join(config.outDir, 'stories'));
  assert.deepEqual(loadStories(path.join(os.tmpdir(), 'duru-no-such-folder')), { stories: [], notices: [] });
});

test('each story file becomes a story whose ID is its file name, sorted by ID', () => {
  assert.deepEqual(examples.stories.map((s) => s.id), ['change-settings', 'help-from-home', 'open-document', 'read-reports', 'run-lab']);
  assert.deepEqual(examples.stories.find((s) => s.id === 'run-lab'), {
    id: 'run-lab',
    name: '실험실을 열어 결과를 본다',
    screens: ['/home#Home', '/lab#Lab', '/lab/result#LabResult'],
    memo: '실험실은 고객사 설정에서 켜야 보인다.',
    author: 'Kim Min',
    date: '2026-10-01',
    file: 'run-lab.json',
  });
});

test('a story whose every step follows an unguarded link connects end to end with nothing more to meet', () => {
  const story = checked['open-document'];
  assert.deepEqual(verdicts(story), [
    '/signin#SignIn → /home#Home open',
    '/home#Home → /document/:tab_draft_done_#DocumentList open',
    '/document/:tab_draft_done_#DocumentList → /document/:id#DocumentDetail open',
  ]);
  assert.deepEqual(story.links.map((l) => places(l.ways)), [['components/SignIn.js:12'], ['components/DocumentTable.js:13'], ['components/DocumentTable.js:13']]);
  assert.deepEqual(story.reach, []);
  assert.equal(story.broken, false);
  assert.equal(story.detached, false);
});

test('a story through a guarded link carries the link\'s condition and source, and gathers it with the route guards of the screens on the way', () => {
  const story = checked['run-lab'];
  assert.deepEqual(verdicts(story), ['/home#Home → /lab#Lab conditioned', '/lab#Lab → /lab/result#LabResult open']);
  const lab = { guard: 'globalSettings.SYSTEM.LAB_ENABLED', kinds: ['setting'], settings: [{ root: 'globalSettings', path: ['SYSTEM', 'LAB_ENABLED'], need: 'on', default: false }] };
  assert.deepEqual(story.links[0].ways, [{ file: 'components/Home.js', line: 19, conditions: [lab] }]);
  assert.deepEqual(story.reach, [
    { kind: 'link', from: '/home#Home', to: '/lab#Lab', ways: [{ file: 'components/Home.js', line: 19, conditions: [lab] }] },
    { kind: 'route', screen: '/lab#Lab', file: 'Routes.js', line: 44, guards: [lab] },
  ]);
  assert.equal(story.broken, false);
});

test('a story with no link between two neighbouring screens marks that spot as broken', () => {
  const story = checked['help-from-home'];
  assert.deepEqual(verdicts(story), ['/signin#SignIn → /home#Home open', '/home#Home → /help#Help broken']);
  assert.deepEqual(story.links[1].ways, []);
  assert.equal(story.broken, true);
  assert.equal(story.detached, false);
});

test('a story with a screen the map does not have is detached, and the links next to that screen are not judged', () => {
  const story = checked['change-settings'];
  assert.deepEqual(story.steps, [{ screen: '/home#Home', onMap: true }, { screen: '/settings#Settings', onMap: false }]);
  assert.deepEqual(verdicts(story), ['/home#Home → /settings#Settings off-map']);
  assert.equal(story.detached, true);
  assert.equal(story.broken, false);
});

test('a malformed story file is left out and reported with its file name and why, without stopping the others', () => {
  assert.deepEqual(examples.notices, [{ file: 'lab-shortcut.json', reason: 'screens 는 화면 ID 를 하나 이상 차례대로 담은 목록이어야 합니다' }]);
});

test('the same story files and the same map give the same result, whatever order the files were written in or when the map was built', async () => {
  const names = fs.readdirSync(EXAMPLES).reverse();
  await withStoriesDir(Object.fromEntries(names.map((n) => [n, fs.readFileSync(path.join(EXAMPLES, n), 'utf8')])), async (dir) => {
    const again = loadStories(dir);
    const rebuilt = await buildMap(config);
    assert.equal(JSON.stringify(checkStories(rebuilt, again.stories)), JSON.stringify(checkStories(map, examples.stories)));
    assert.deepEqual(again.notices, examples.notices);
  });
});

test('the first screen\'s own opening condition is gathered when the story starts behind a setting or a role', () => {
  const [story] = checkStories(map, [{ id: 'audit', screens: ['/admin/member#AdminMember', '/admin/audit#AdminAudit'] }]);
  assert.deepEqual(verdicts(story), ['/admin/member#AdminMember → /admin/audit#AdminAudit open']);
  assert.deepEqual(story.reach, [
    { kind: 'start', screen: '/admin/member#AdminMember', kinds: ['role'], roleValues: ['ADMIN'] },
    { kind: 'route', screen: '/admin/member#AdminMember', file: 'Routes.js', line: 42, guards: [{ guard: 'isAdminRole(memberRole)', kinds: ['role'], roles: ['ADMIN'] }] },
  ]);
});

test('a link guarded through the handler it sits in carries that guard with the handler\'s name', () => {
  const [story] = checkStories(map, [{ id: 'help', screens: ['/signin#SignIn', '/help#Help'] }]);
  assert.deepEqual(story.links[0].verdict, 'conditioned');
  assert.deepEqual(story.links[0].ways[0].conditions.map((c) => [c.guard, c.via, c.kinds]), [['globalSettings.SYSTEM.HELP_LINK_ENABLED', 'openHelp', ['setting']]]);
});

test('a step that a move in the config joins, such as the screen opening after sign-in, is configured with the move\'s reason, not a missing link', async () => {
  const story = { id: 'signin-lab', screens: ['/signin#SignIn', '/lab/result#LabResult'] };
  assert.equal(checkStories(map, [story])[0].links[0].verdict, 'broken');
  const signedIn = await buildMap({ ...config, moves: [{ from: '/signin', to: '/lab/result', reason: '로그인 뒤' }] });
  const [checkedStory] = checkStories(signedIn, [story]);
  assert.deepEqual(checkedStory.links, [{ from: '/signin#SignIn', to: '/lab/result#LabResult', verdict: 'configured', reasons: ['로그인 뒤'], ways: [] }]);
  assert.equal(checkedStory.broken, false);
  assert.deepEqual(checkedStory.reach, []);
});

const TINY_CONFIG = { settingsRoots: ['globalSettings'], roleIdentifiers: ['memberRole'], entryPaths: [] };
const NO_SETTING_READ = { settings: null, settingsReason: '조건에서 설정을 읽는 곳을 찾지 못했습니다' };

function tinyMap(links) {
  const screens = Object.entries(links).map(([id, out]) => ({ id, path: id, line: 1, routeGuards: [], links: out }));
  const { access, linkConditions } = screenAccess(screens, [], TINY_CONFIG, new Map(), {}, new Map());
  return { screens: screens.map((s, i) => ({ ...s, access: access[i], links: s.links.map((l, j) => ({ ...l, conditions: linkConditions[i][j] })) })) };
}

test('a link guarded by a condition that is neither a setting nor a role is still a condition on the way', () => {
  const tiny = tinyMap({ '/a': [{ to: '/b', file: 'A.js', line: 3, guards: ['doc.type !== \'FLEX\''] }], '/b': [] });
  const [story] = checkStories(tiny, [{ id: 's', screens: ['/a', '/b'] }]);
  assert.deepEqual(story.links[0], { from: '/a', to: '/b', verdict: 'conditioned', ways: [{ file: 'A.js', line: 3, conditions: [{ guard: 'doc.type !== \'FLEX\'', kinds: [] }] }] });
  assert.deepEqual(story.reach.map((r) => r.kind), ['link']);
});

test('a link whose handler is used once under a setting and once under another guard keeps the setting guard\'s kinds, while access still sees the link as open', () => {
  const uses = [{ via: 'go', line: 9, guards: ['globalSettings.SYSTEM.B'] }, { via: 'go', line: 12, guards: ['doc.type !== \'FLEX\''] }];
  const tiny = tinyMap({ '/a': [{ to: '/b', file: 'A.js', line: 5, guards: [], inheritedGuards: uses }], '/b': [] });
  assert.deepEqual(tiny.screens[1].access.links.map((l) => l.guards), [[]]);
  const [story] = checkStories(tiny, [{ id: 's', screens: ['/a', '/b'] }]);
  assert.equal(story.links[0].verdict, 'conditioned');
  assert.deepEqual(story.links[0].ways[0].conditions, [
    { guard: 'globalSettings.SYSTEM.B', kinds: ['setting'], via: 'go', ...NO_SETTING_READ },
    { guard: 'doc.type !== \'FLEX\'', kinds: [], via: 'go' },
  ]);
});

test('two links on one line to the same screen each keep their own conditions', () => {
  const tiny = tinyMap({
    '/a': [
      { to: '/b', file: 'A.js', line: 7, guards: ['memberRole === \'ADMIN\''] },
      { to: '/b', file: 'A.js', line: 7, guards: ['!(memberRole === \'ADMIN\')', 'globalSettings.SYSTEM.B'] },
    ],
    '/b': [],
  });
  const [story] = checkStories(tiny, [{ id: 's', screens: ['/a', '/b'] }]);
  assert.deepEqual(story.links[0].ways.map((w) => w.conditions.map((c) => [c.guard, c.kinds])), [
    [['memberRole === \'ADMIN\'', ['role']]],
    [['!(memberRole === \'ADMIN\')', ['role']], ['globalSettings.SYSTEM.B', ['setting']]],
  ]);
});

test('when two screens have no link between them but the first has links to a path duru cannot read, the step is not judged and the story is not broken', () => {
  const tiny = tinyMap({
    '/a': [
      { to: '/', file: 'A.js', line: 9, guards: [] },
      { to: `/doc/${UNKNOWN}`, file: 'A.js', line: 6, guards: [] },
      { to: '/c', file: 'A.js', line: 3, guards: [] },
      { to: null, file: 'A.js', line: 4, guards: [] },
    ],
    '/b': [],
    '/c': [],
  });
  const [story] = checkStories(tiny, [{ id: 's', screens: ['/a', '/b'] }]);
  assert.deepEqual(story.links[0], {
    from: '/a', to: '/b', verdict: 'unknown', ways: [],
    unknownLinks: [{ file: 'A.js', line: 4, to: null }, { file: 'A.js', line: 6, to: `/doc/${UNKNOWN}` }],
  });
  assert.equal(story.broken, false);
  assert.equal(story.unjudged, true);
});

test('a step joined by a link keeps the verdict of that link, and also lists the first screen\'s links whose destination duru cannot tell', () => {
  const tiny = tinyMap({
    '/a': [
      { to: '/b', file: 'A.js', line: 3, guards: ['globalSettings.SYSTEM.B'] },
      { to: `/doc/${UNKNOWN}`, file: 'A.js', line: 9, guards: [] },
    ],
    '/b': [],
  });
  const [story] = checkStories(tiny, [{ id: 's', screens: ['/a', '/b'] }]);
  const unknownLinks = [{ file: 'A.js', line: 9, to: `/doc/${UNKNOWN}` }];
  assert.equal(story.links[0].verdict, 'conditioned');
  assert.deepEqual(story.links[0].unknownLinks, unknownLinks);
  assert.deepEqual(story.reach.map((r) => [r.kind, r.unknownLinks]), [['link', unknownLinks]]);
  assert.equal(story.unjudged, false);
});

test('a step joined by a link without conditions is open and lists no left-out links, since none of them could change that', () => {
  const tiny = tinyMap({
    '/a': [
      { to: '/b', file: 'A.js', line: 3, guards: [] },
      { to: `/doc/${UNKNOWN}`, file: 'A.js', line: 9, guards: [] },
    ],
    '/b': [],
  });
  const [story] = checkStories(tiny, [{ id: 's', screens: ['/a', '/b'] }]);
  assert.deepEqual(story.links[0], { from: '/a', to: '/b', verdict: 'open', ways: [{ file: 'A.js', line: 3, conditions: [] }] });
});

test('when two screens have no link between them and every link of the first has a path duru can read, the step is broken, even with a link to a path no screen has', () => {
  const tiny = tinyMap({ '/a': [{ to: '/c', file: 'A.js', line: 3, guards: [] }, { to: '/', file: 'A.js', line: 9, guards: [] }], '/b': [], '/c': [] });
  const [story] = checkStories(tiny, [{ id: 's', screens: ['/a', '/b'] }]);
  assert.deepEqual(story.links[0], { from: '/a', to: '/b', verdict: 'broken', ways: [] });
  assert.equal(story.broken, true);
  assert.equal(story.unjudged, false);
});

test('a map built before links carried their conditions checks no story and says to rebuild apart from the story file notes, still naming the stories read, unless there is no story to check', () => {
  const old = { screens: map.screens.map((s) => ({ ...s, links: s.links.map(({ conditions, ...l }) => l) })) };
  withStoriesDir({ 'ok.json': STORY, 'bad.json': '{' }, (dir) => {
    const { ids, list, notices, stale } = checkStoryFiles(old, dir, 'out/map.json');
    assert.deepEqual([ids, list], [['bad', 'ok'], []]);
    assert.deepEqual(notices.map((n) => n.file), ['bad.json']);
    assert.match(stale, /^out\/map\.json 은 .* duru rebuild 로 맵을 다시 만드세요$/);
  });
  assert.deepEqual(checkStoryFiles(old, path.join(os.tmpdir(), 'duru-no-such-folder'), 'out/map.json'), { ids: [], list: [], notices: [], unknownTags: [] });
  assert.equal(checkStoryFiles(map, EXAMPLES, 'out/map.json').stale, undefined);
});

test('the story IDs named are those of every story file in the folder, read or not, and not of files whose name breaks the ID rule', () => {
  withStoriesDir({ 'ok.json': STORY, 'broken.json': '{', 'no-name.json': { ...STORY, name: '' }, 'sub/ok.json': STORY, 'Bad Name.json': STORY }, (dir) => {
    const { ids, list, notices } = checkStoryFiles(map, dir, 'out/map.json');
    assert.deepEqual(list.map((s) => s.id), ['ok']);
    assert.deepEqual(notices.map((n) => n.file), ['Bad Name.json', 'broken.json', 'no-name.json', 'sub/ok.json']);
    assert.deepEqual(ids, ['broken', 'no-name', 'ok']);
  });
});

test('the map carries every link with all of its conditions, and no redirects', () => {
  assert.equal(map.redirects, undefined);
  const help = map.screens.find((s) => s.id === '/signin#SignIn').links.find((l) => l.to === '/help');
  assert.deepEqual(help.conditions.map((c) => [c.guard, c.via, c.kinds]), [['globalSettings.SYSTEM.HELP_LINK_ENABLED', 'openHelp', ['setting']]]);
});

for (const [name, files, notices] of [
  ['not valid JSON', { 'a.json': '{' }, [{ file: 'a.json', reason: /^JSON 으로 읽지 못했습니다: / }]],
  ['a file name outside the ID rule', { 'Open Doc.json': STORY }, [{ file: 'Open Doc.json', reason: /스토리 ID 규칙/ }]],
  ['an ID inside the file', { 'a.json': { ...STORY, id: 'a' } }, [{ file: 'a.json', reason: /모르는 항목이 있습니다: id \(스토리 ID 는 파일 이름에서 정합니다\)/ }]],
  ['no name', { 'a.json': { ...STORY, name: ' ' } }, [{ file: 'a.json', reason: /^name / }]],
  ['an empty screen list', { 'a.json': { ...STORY, screens: [] } }, [{ file: 'a.json', reason: /^screens / }]],
  ['the same screen twice in a row', { 'a.json': { ...STORY, screens: ['/home#Home', '/home#Home'] } }, [{ file: 'a.json', reason: /1 번째와 2 번째가 같은 화면/ }]],
  ['a memo that is not text', { 'a.json': { ...STORY, memo: 3 } }, [{ file: 'a.json', reason: /^memo / }]],
  ['no author', { 'a.json': { ...STORY, author: undefined } }, [{ file: 'a.json', reason: /^author / }]],
  ['a date that is not a date', { 'a.json': { ...STORY, date: '어제' } }, [{ file: 'a.json', reason: /^date / }]],
  ['a day the month does not have', { 'a.json': { ...STORY, date: '2026-02-30' } }, [{ file: 'a.json', reason: /^date / }]],
  ['a source without its step range', { 'a.json': { ...STORY, source: { record: 'qa/a.json' } } }, [{ file: 'a.json', reason: /^source / }]],
  ['a source whose last step comes before its first', { 'a.json': { ...STORY, source: { record: 'qa/a.json', steps: [3, 2] } } }, [{ file: 'a.json', reason: /^source / }]],
  ['an ID two files share', { 'docs/a.json': STORY, 'lab/a.json': STORY }, [{ file: 'lab/a.json', reason: '스토리 ID a 는 docs/a.json 에서 이미 썼습니다' }]],
  ['an ID that a malformed file earlier in path order has', { 'docs/a.json': '{', 'lab/a.json': STORY }, [
    { file: 'docs/a.json', reason: /^JSON 으로 읽지 못했습니다: / },
    { file: 'lab/a.json', reason: '스토리 ID a 는 docs/a.json 에서 이미 썼습니다' },
  ]],
]) {
  test(`a story file with ${name} is reported and the rest are read`, () => {
    withStoriesDir({ ...files, 'ok.json': STORY }, (dir) => {
      const { stories, notices: got } = loadStories(dir);
      assert.equal(got.length, notices.length);
      notices.forEach((n, i) => {
        assert.equal(got[i].file, n.file);
        if (n.reason instanceof RegExp) assert.match(got[i].reason, n.reason);
        else assert.equal(got[i].reason, n.reason);
      });
      assert.ok(stories.some((s) => s.id === 'ok'));
    });
  });
}

test('a story folder that is a file is read as the only story file, and a subfolder whose name ends in .json is searched like any other', () => {
  withStoriesDir({ 'one.json': STORY, 'two.json/b.json': STORY }, (dir) => {
    assert.deepEqual(loadStories(path.join(dir, 'one.json')), { stories: [{ id: 'one', ...STORY, file: 'one.json' }], notices: [] });
    const { stories, notices } = loadStories(dir);
    assert.deepEqual(notices, []);
    assert.deepEqual(stories.map((s) => [s.id, s.file]), [['b', path.join('two.json', 'b.json')], ['one', 'one.json']]);
  });
});

test('a story file reached through a symbolic link is read, and a link to a folder is searched like the folder', () => {
  withStoriesDir({ 'shared/one.json': STORY, 'shared/more/two.json': STORY }, (dir) => {
    const stories = path.join(dir, 'stories');
    fs.mkdirSync(stories);
    fs.symlinkSync(path.join(dir, 'shared/one.json'), path.join(stories, 'linked.json'));
    fs.symlinkSync(path.join(dir, 'shared/more'), path.join(stories, 'more.json'));
    const { stories: read, notices } = loadStories(stories);
    assert.deepEqual(notices, []);
    assert.deepEqual(read.map((s) => [s.id, s.file]), [['linked', 'linked.json'], ['two', path.join('more.json', 'two.json')]]);
  });
});

test('a story file whose symbolic link points nowhere or cannot be followed is reported with why, and the rest are read', () => {
  withStoriesDir({ 'ok.json': STORY }, (dir) => {
    fs.symlinkSync(path.join(dir, 'missing.json'), path.join(dir, 'gone.json'));
    fs.symlinkSync('loop.json', path.join(dir, 'loop.json'));
    const { stories, notices } = loadStories(dir);
    assert.deepEqual(notices.map((n) => n.file), ['gone.json', 'loop.json']);
    assert.equal(notices[0].reason, '링크가 가리키는 파일이 없습니다');
    assert.match(notices[1].reason, /^링크를 따라가지 못했습니다: ELOOP/);
    assert.deepEqual(stories.map((s) => s.id), ['ok']);
  });
});

test('a story subfolder that cannot be listed is reported with why while the other stories are still read', { skip: process.getuid?.() === 0 && 'root can list any folder' }, () => {
  withStoriesDir({ 'ok.json': STORY, 'locked/a.json': STORY }, (dir) => {
    const locked = path.join(dir, 'locked');
    fs.chmodSync(locked, 0o000);
    try {
      const { stories, notices } = loadStories(dir);
      assert.deepEqual(stories.map((s) => s.id), ['ok']);
      assert.deepEqual(notices.map((n) => n.file), ['locked']);
      assert.match(notices[0].reason, /^스토리 폴더를 읽지 못했습니다: EACCES/);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});

test('a story date may carry the time, and the memo may be left out', () => {
  withStoriesDir({ 'a.json': { ...STORY, memo: undefined, date: '2026-10-02T09:30:00.000Z' } }, (dir) => {
    const { stories, notices } = loadStories(dir);
    assert.deepEqual(notices, []);
    assert.deepEqual([stories[0].memo, stories[0].date], ['', '2026-10-02T09:30:00.000Z']);
  });
});

const NO_TESTS = { nodes: {}, stories: {} };
const statuses = (dir, tests) => checkStoryFiles(map, dir, 'out/map.json', tests).list.map((s) => [s.id, s.status]);

test('each example story takes its status from the example results: its story tests when it has any, else the tests of the screens on its path', () => {
  const tests = linkTests(config, map);
  assert.deepEqual(statuses(EXAMPLES, tests), [
    ['change-settings', 'partial'],
    ['help-from-home', 'pending'],
    ['open-document', 'pass'],
    ['read-reports', 'untested'],
    ['run-lab', 'fail'],
  ]);
});

test('a story fails when one story test fails whatever the others did, waits when one is pending and none fails, and passes when every one passes, whatever the tests of its screens did', () => {
  const t = (status) => ({ title: status, status });
  const tests = {
    nodes: { '/home#Home': [t('fail')] },
    stories: { failing: [t('pass'), t('pending'), t('fail')], waiting: [t('pass'), t('pending')], passing: [t('pass'), t('pass')] },
  };
  withStoriesDir({ 'failing.json': STORY, 'waiting.json': STORY, 'passing.json': STORY }, (dir) => {
    assert.deepEqual(statuses(dir, tests), [['failing', 'fail'], ['passing', 'pass'], ['waiting', 'pending']]);
  });
});

test('without story tests a story is partly covered when any screen on its path has a test of any status, and has no tests when none has, even with tests on other stories or screens', () => {
  const failing = [{ title: 'x', status: 'fail' }];
  withStoriesDir({ 'lab.json': STORY, 'gone.json': { ...STORY, screens: ['/settings#Settings', '/admin/report#AdminReport'] } }, (dir) => {
    assert.deepEqual(statuses(dir, { nodes: { '/lab#Lab': failing }, stories: { gone: [] } }), [['gone', 'untested'], ['lab', 'partial']]);
    assert.deepEqual(statuses(dir, { nodes: { '/help#Help': failing }, stories: { other: failing } }), [['gone', 'untested'], ['lab', 'untested']]);
    assert.deepEqual(statuses(dir, NO_TESTS), [['gone', 'untested'], ['lab', 'untested']]);
  });
});

test('story tags are matched against the story files read now: a tag pointing at no story file is listed with its test, and one whose story file is written later attaches then', () => {
  const tests = linkTests(config, map);
  const { unknownTags } = checkStoryFiles(map, EXAMPLES, 'out/map.json', tests);
  assert.deepEqual(unknownTags, [{ tag: 'story:print-document', test: { title: 'prints a document @story:print-document', file: 'stories.spec.ts', line: 12 } }]);
  withStoriesDir({ 'print-document.json': STORY }, (dir) => {
    const now = checkStoryFiles(map, dir, 'out/map.json', tests);
    assert.deepEqual(now.list.map((s) => [s.id, s.status]), [['print-document', 'pass']]);
    assert.deepEqual(now.unknownTags.map((u) => u.tag), ['story:help-from-home', 'story:open-document', 'story:run-lab', 'story:run-lab']);
  });
});

test('a story tag on a test that runs in two projects is listed once', () => {
  const t = { title: 'x @story:gone', file: 'a.spec.ts', line: 1, source: 'r/e2e.json', status: 'pass' };
  const { unknownTags } = checkStoryFiles(map, EXAMPLES, 'out/map.json', { nodes: {}, stories: { gone: [{ ...t, project: 'chromium' }, { ...t, project: 'firefox' }] } });
  assert.deepEqual(unknownTags, [{ tag: 'story:gone', test: { title: 'x @story:gone', file: 'a.spec.ts', line: 1 } }]);
});

test('without tests every story has no tests', () => {
  assert.deepEqual(checkStoryFiles(map, EXAMPLES, 'out/map.json').list.map((s) => s.status), ['untested', 'untested', 'untested', 'untested', 'untested']);
});

test('story IDs and screen IDs that are names of object members take their status like any other', () => {
  const read = (tests) => JSON.parse(JSON.stringify(tests));
  const files = { 'constructor.json': { ...STORY, screens: ['constructor', 'toString'] }, '__proto__.json': { ...STORY, screens: ['hasOwnProperty', 'valueOf'] } };
  withStoriesDir(files, (dir) => {
    assert.deepEqual(statuses(dir, read(NO_TESTS)), [['__proto__', 'untested'], ['constructor', 'untested']]);
    const pass = [{ title: 'x', status: 'pass' }];
    const tests = read({ nodes: {}, stories: Object.fromEntries([['constructor', pass], ['__proto__', pass]]) });
    assert.deepEqual(statuses(dir, tests), [['__proto__', 'pass'], ['constructor', 'pass']]);
    assert.deepEqual(checkStoryFiles(map, dir, 'out/map.json', tests).unknownTags, []);
  });
});

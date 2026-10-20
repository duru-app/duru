import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { screenAccess } from '../src/access.ts';
import { UNKNOWN } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import { editStory, FileChanged, loadStories, writeStoryFields, writeStorySteps } from '../src/stories.ts';
import { checkStories, checkStoryFiles } from '../src/story-paths.ts';
import type { StoryTests } from '../src/story-paths.ts';
import { linkTests } from '../src/test-links.ts';

type Checked = ReturnType<typeof checkStories>[number];
type StoryFiles = Record<string, string | Record<string, unknown>>;

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const EXAMPLES = path.join(FIXTURE, 'example-stories');
const config = loadConfig(path.join(FIXTURE, 'config.json'));
const map = await buildMap(config);
const examples = loadStories(EXAMPLES);
const checked = Object.fromEntries(checkStories(map, examples.stories).map((s) => [s.id, s]));

const verdicts = (story: Checked) => story.links.map((l) => `${l.from} → ${l.to} ${l.verdict}`);
const places = (ways: { file: string; line: number }[]) => ways.map((w) => `${w.file}:${w.line}`);

function withStoriesDir<T>(files: StoryFiles, fn: (dir: string) => T) {
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

const hashOf = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

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
    contentHash: hashOf(path.join(EXAMPLES, 'run-lab.json')),
  });
});

test('a story whose every step follows an unguarded link connects end to end with nothing more to meet', () => {
  const story = checked['open-document'];
  assert.deepEqual(verdicts(story), [
    '/signin#SignIn → /home#Home open',
    '/home#Home → /document/:tab#DocumentList open',
    '/document/:tab#DocumentList → /document/:id#DocumentDetail open',
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

type TinyLink = Parameters<typeof screenAccess>[0][number]['links'][number];

function tinyMap(links: Record<string, TinyLink[]>) {
  const screens = Object.entries(links).map(([id, out]) => ({ id, path: id, line: 1, routeGuards: [], routeFile: 'routes.js', links: out }));
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
    assert.match(stale!, /^out\/map\.json 은 .* duru rebuild 로 맵을 다시 만드세요$/);
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
  assert.equal('redirects' in map, false);
  const help = map.screens.find((s) => s.id === '/signin#SignIn')!.links.find((l) => l.to === '/help')!;
  assert.deepEqual(help.conditions.map((c) => [c.guard, c.via, c.kinds]), [['globalSettings.SYSTEM.HELP_LINK_ENABLED', 'openHelp', ['setting']]]);
});

const NOTICE_CASES: [string, StoryFiles, { file: string; reason: string | RegExp }[]][] = [
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
  ['a source from a report without test titles', { 'a.json': { ...STORY, source: { report: 'results/e2e.json', tests: [] } } }, [{ file: 'a.json', reason: /^source / }]],
  ['a source that mixes a record and a report', { 'a.json': { ...STORY, source: { report: 'results/e2e.json', tests: ['opens home'], steps: [1, 2] } } }, [{ file: 'a.json', reason: /^source / }]],
  ['a need that is empty text', { 'a.json': { ...STORY, needs: ['반려된 문서가 하나 있다', ' '] } }, [{ file: 'a.json', reason: 'needs 는 조건을 하나씩 글이나 { "use": 공통 조건 파일 이름 } 으로 적은 목록이어야 합니다' }]],
  ['a need that uses no file', { 'a.json': { ...STORY, needs: [{ use: ' ' }] } }, [{ file: 'a.json', reason: 'needs 는 조건을 하나씩 글이나 { "use": 공통 조건 파일 이름 } 으로 적은 목록이어야 합니다' }]],
  ['a need that uses a file and says more', { 'a.json': { ...STORY, needs: [{ use: 'member-account.json', as: 'admin' }] } }, [{ file: 'a.json', reason: 'needs 는 조건을 하나씩 글이나 { "use": 공통 조건 파일 이름 } 으로 적은 목록이어야 합니다' }]],
  ['expects that are not a list', { 'a.json': { ...STORY, expects: '문서가 열린다' } }, [{ file: 'a.json', reason: 'expects 는 기대 결과를 하나씩 글로 적은 목록이어야 합니다' }]],
  ['a step object without its screen', { 'a.json': { ...STORY, screens: ['/home#Home', { needs: ['x'] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 screen 에 화면 ID 를 적어야 합니다' }]],
  ['a step object with a key it does not know', { 'a.json': { ...STORY, screens: [{ screen: '/home#Home', clicks: [] }, '/lab#Lab'] } }, [{ file: 'a.json', reason: 'screens 의 1 번째 단계에 모르는 항목이 있습니다: clicks' }]],
  ['a step need that is not text', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', needs: [3] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 needs 는 조건을 하나씩 글이나 { "use": 공통 조건 파일 이름 } 으로 적은 목록이어야 합니다' }]],
  ['a step need written as an object without use', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', needs: [{ file: 'member-account.json' }] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 needs 는 조건을 하나씩 글이나 { "use": 공통 조건 파일 이름 } 으로 적은 목록이어야 합니다' }]],
  ['a step expect that is empty text', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', expects: [''] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 expects 는 기대 결과를 하나씩 글로 적은 목록이어야 합니다' }]],
  ['a step that is neither a screen ID nor an object', { 'a.json': { ...STORY, screens: ['/home#Home', ['/lab#Lab']] } }, [{ file: 'a.json', reason: /^screens 의 2 번째 단계는 / }]],
  ['conditions on the link into the first step, which no link comes into', { 'a.json': { ...STORY, screens: [{ screen: '/home#Home', linkNeeds: ['반려된 경우'] }, '/lab#Lab'] } }, [{ file: 'a.json', reason: 'screens 의 1 번째 단계에는 앞 단계가 없어 linkNeeds(들어오는 링크 조건)를 둘 수 없습니다' }]],
  ['a condition on the link into a step that is empty text', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', linkNeeds: ['반려된 경우', ''] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 linkNeeds 는 들어오는 링크 조건을 하나씩 글이나 { "use": 공통 조건 파일 이름 } 으로 적은 목록이어야 합니다' }]],
  ['a condition on the link into a step that uses no file', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', linkNeeds: [{ use: ' ' }] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 linkNeeds 는 들어오는 링크 조건을 하나씩 글이나 { "use": 공통 조건 파일 이름 } 으로 적은 목록이어야 합니다' }]],
  ['conditions on the link into a step that are not a list', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', linkNeeds: '반려된 경우' }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 linkNeeds 는 들어오는 링크 조건을 하나씩 글이나 { "use": 공통 조건 파일 이름 } 으로 적은 목록이어야 합니다' }]],
  ['conditions on an incoming link at the top of the story', { 'a.json': { ...STORY, linkNeeds: ['반려된 경우'] } }, [{ file: 'a.json', reason: '모르는 항목이 있습니다: linkNeeds' }]],
  ['inputs that are not a list', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', inputs: { box: { label: '이름' }, value: '실험' } }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 inputs 는 입력값을 { "box", "value" } 객체로 하나씩 적은 목록이어야 합니다' }]],
  ['an input written as one line of text', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', inputs: ['이름 칸에 실험'] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 1 번째 입력값은 { "box", "value" } 객체여야 합니다' }]],
  ['an input with a key it does not know', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', inputs: [{ box: { label: '이름' }, value: '실험', press: 'Enter' }] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 1 번째 입력값에 모르는 항목이 있습니다: press' }]],
  ['an input without its box', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', inputs: [{ value: '실험' }] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 1 번째 입력값의 box 에 상자를 찾는 말(placeholder, label, testId)을 하나 이상 적어야 합니다' }]],
  ['an empty box', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', inputs: [{ box: { label: '이름' }, value: '실험' }, { box: {}, value: '실험' }] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 2 번째 입력값의 box 에 상자를 찾는 말(placeholder, label, testId)을 하나 이상 적어야 합니다' }]],
  ['a box with only its number', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', inputs: [{ box: { nth: 2 }, value: '실험' }] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 1 번째 입력값의 box 에 상자를 찾는 말(placeholder, label, testId)을 하나 이상 적어야 합니다' }]],
  ['a box found by a kind duru does not know', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', inputs: [{ box: { label: '이름', css: '#name' }, value: '실험' }] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 1 번째 입력값의 box 에 모르는 종류가 있습니다: css (상자를 찾는 말은 placeholder, label, testId 가운데서 고릅니다)' }]],
  ['a box whose words are empty', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', inputs: [{ box: { placeholder: ' ', testId: 'lab-name' }, value: '실험' }] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 1 번째 입력값의 box 의 placeholder 에 화면에 보이는 문구를 적어야 합니다' }]],
  ['a box number below 1', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', inputs: [{ box: { label: '서명자 메모', nth: 0 }, value: '확인했습니다' }] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 1 번째 입력값의 box 의 nth 는 1 이상의 정수여야 합니다' }]],
  ['a box number that is not a whole number', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', inputs: [{ box: { label: '서명자 메모', nth: '2' }, value: '확인했습니다' }] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 1 번째 입력값의 box 의 nth 는 1 이상의 정수여야 합니다' }]],
  ['an input without its value', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', inputs: [{ box: { label: '이름' }, value: 3 }] }] } }, [{ file: 'a.json', reason: 'screens 의 2 번째 단계의 1 번째 입력값의 value 에 넣을 값을 글로 적어야 합니다' }]],
  ['inputs at the top of the story', { 'a.json': { ...STORY, inputs: [{ box: { label: '이름' }, value: '실험' }] } }, [{ file: 'a.json', reason: '모르는 항목이 있습니다: inputs' }]],
  ['the same screen twice in a row, once inside a step object', { 'a.json': { ...STORY, screens: ['/home#Home', { screen: '/home#Home', expects: ['x'] }] } }, [{ file: 'a.json', reason: /1 번째와 2 번째가 같은 화면/ }]],
  ['an ID two files share', { 'docs/a.json': STORY, 'lab/a.json': STORY }, [{ file: 'lab/a.json', reason: '스토리 ID a 는 docs/a.json 에서 이미 썼습니다' }]],
  ['an ID that a malformed file earlier in path order has', { 'docs/a.json': '{', 'lab/a.json': STORY }, [
    { file: 'docs/a.json', reason: /^JSON 으로 읽지 못했습니다: / },
    { file: 'lab/a.json', reason: '스토리 ID a 는 docs/a.json 에서 이미 썼습니다' },
  ]],
];

for (const [name, files, notices] of NOTICE_CASES) {
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
    assert.deepEqual(loadStories(path.join(dir, 'one.json')), { stories: [{ id: 'one', ...STORY, file: 'one.json', contentHash: hashOf(path.join(dir, 'one.json')) }], notices: [] });
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

const WRITTEN = {
  name: '문서를 연다',
  needs: ['완료된 문서가 하나 있다'],
  screens: ['/home#Home', { screen: '/lab#Lab', needs: ['실험실 설정을 켠다'], expects: ['실험 목록이 보인다', '「실행」 단추가 보인다'] }, { screen: '/lab/result#LabResult' }],
  expects: ['실행 기록이 한 줄 늘어난다'],
  memo: '',
  author: 'a',
  date: '2026-10-02',
};

test('a story may carry needs and expects for the whole story and for each step written as an object, and reads with its screen IDs in order and the step fields beside them', () => {
  withStoriesDir({ 'a.json': WRITTEN }, (dir) => {
    const { stories, notices } = loadStories(dir);
    assert.deepEqual(notices, []);
    assert.deepEqual(stories, [{
      id: 'a',
      name: '문서를 연다',
      needs: ['완료된 문서가 하나 있다'],
      screens: ['/home#Home', '/lab#Lab', '/lab/result#LabResult'],
      stepFields: [{}, { needs: ['실험실 설정을 켠다'], expects: ['실험 목록이 보인다', '「실행」 단추가 보인다'] }, {}],
      expects: ['실행 기록이 한 줄 늘어난다'],
      memo: '',
      author: 'a',
      date: '2026-10-02',
      file: 'a.json',
      contentHash: hashOf(path.join(dir, 'a.json')),
    }]);
  });
});

test('a step from the second on may carry the conditions of the link that comes into it from the step before, read beside its own needs and expects', () => {
  const story = { ...WRITTEN, screens: ['/home#Home', { screen: '/lab#Lab', needs: ['실험실 설정을 켠다'], linkNeeds: ['실험실 메뉴를 누른 경우'] }, { screen: '/lab/result#LabResult', linkNeeds: ['실행이 끝난 경우', '결과가 하나 이상인 경우'] }] };
  withStoriesDir({ 'a.json': story }, (dir) => {
    const { stories, notices } = loadStories(dir);
    assert.deepEqual(notices, []);
    assert.deepEqual(stories[0].screens, ['/home#Home', '/lab#Lab', '/lab/result#LabResult']);
    assert.deepEqual(stories[0].stepFields, [{}, { needs: ['실험실 설정을 켠다'], linkNeeds: ['실험실 메뉴를 누른 경우'] }, { linkNeeds: ['실행이 끝난 경우', '결과가 하나 이상인 경우'] }]);
    editStory(dir, 'a', { name: '실험을 돌린다', memo: '' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).screens, story.screens, 'editing the name keeps the link conditions in the file');
  });
});

test('a step may carry the boxes to fill and the values to put in them, each box found by one or more words on the screen and by its number among boxes found by the same words, read as written', () => {
  const inputs = [
    { box: { placeholder: '이메일', testId: 'login-email' }, value: 'member@example.com' },
    { box: { label: '서명자 메모', nth: 2 }, value: '확인했습니다' },
  ];
  const story = { ...WRITTEN, screens: ['/home#Home', { screen: '/lab#Lab', inputs, expects: ['실험 목록이 보인다'] }, { screen: '/lab/result#LabResult', linkNeeds: ['실행이 끝난 경우'], inputs: [] }] };
  withStoriesDir({ 'a.json': story }, (dir) => {
    const { stories, notices } = loadStories(dir);
    assert.deepEqual(notices, []);
    assert.deepEqual(stories[0].screens, ['/home#Home', '/lab#Lab', '/lab/result#LabResult']);
    assert.deepEqual(stories[0].stepFields, [{}, { inputs, expects: ['실험 목록이 보인다'] }, { linkNeeds: ['실행이 끝난 경우'], inputs: [] }]);
    editStory(dir, 'a', { name: '실험을 돌린다', memo: '' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).screens, story.screens, 'editing the name keeps the inputs in the file');
  });
});

test('a need may pick a file of the needs folder with { "use" }, for the whole story or a step, and reads as written whether or not the file is there', () => {
  const story = { ...STORY, needs: [{ use: 'member-account.json' }, '완료된 문서가 하나 있다'], screens: ['/home#Home', { screen: '/lab#Lab', needs: [{ use: 'old-admin.json' }] }] };
  withStoriesDir({ 'a.json': story, 'needs/member-account.json': { name: '일반 회원 계정', text: '역할 USER 계정' } }, (dir) => {
    const { stories, notices } = loadStories(dir);
    assert.deepEqual(notices, []);
    assert.deepEqual(stories[0].needs, [{ use: 'member-account.json' }, '완료된 문서가 하나 있다']);
    assert.deepEqual(stories[0].stepFields, [{}, { needs: [{ use: 'old-admin.json' }] }]);
  });
});

test('a condition on the link into a step may pick a file of the needs folder with { "use" } as well', () => {
  const story = { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', linkNeeds: [{ use: 'member-account.json' }, '반려된 경우'] }] };
  withStoriesDir({ 'a.json': story }, (dir) => {
    const { stories, notices } = loadStories(dir);
    assert.deepEqual(notices, []);
    assert.deepEqual(stories[0].stepFields, [{}, { linkNeeds: [{ use: 'member-account.json' }, '반려된 경우'] }]);
  });
});

test('the files in the needs folder are neither stories nor story files that could not be read', () => {
  withStoriesDir({ 'ok.json': STORY, 'needs/member-account.json': { name: '일반 회원 계정', text: '역할 USER 계정' }, 'needs/broken.json': '{', 'needs/more/x.json': STORY }, (dir) => {
    const { stories, notices } = loadStories(dir);
    assert.deepEqual(stories.map((s) => s.id), ['ok']);
    assert.deepEqual(notices, []);
  });
});

test('a story whose steps are objects is checked against the map step by step exactly like the same story with screen IDs', () => {
  withStoriesDir({ 'a.json': WRITTEN, 'b.json': { ...WRITTEN, screens: ['/home#Home', '/lab#Lab', '/lab/result#LabResult'] } }, (dir) => {
    const [a, b] = checkStoryFiles(map, dir, 'out/map.json').list;
    for (const key of ['screens', 'steps', 'links', 'reach', 'detached', 'broken', 'unjudged', 'status'] as const) assert.deepEqual(a[key], b[key], key);
    assert.deepEqual(verdicts(a), ['/home#Home → /lab#Lab conditioned', '/lab#Lab → /lab/result#LabResult open']);
  });
});

test('editing a story\'s name and memo keeps its needs, expects and step objects in the file as they were', () => {
  withStoriesDir({ 'a.json': WRITTEN }, (dir) => {
    const before = hashOf(path.join(dir, 'a.json'));
    const edited = editStory(dir, 'a', { name: '실험을 돌린다', memo: '메모' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')), { ...WRITTEN, name: '실험을 돌린다', memo: '메모' });
    assert.deepEqual(edited, { ...loadStories(dir).stories[0], previousHash: before }, 'the reply carries the mark of the file it wrote over, beside the mark of the file it wrote');
    assert.deepEqual(edited.stepFields?.[1], { needs: ['실험실 설정을 켠다'], expects: ['실험 목록이 보인다', '「실행」 단추가 보인다'] });
  });
});

test('each story read carries a mark of its file content, which changes when the file changes', () => {
  withStoriesDir({ 'a.json': STORY }, (dir) => {
    const file = path.join(dir, 'a.json');
    const before = loadStories(dir).stories[0].contentHash;
    assert.equal(before, hashOf(file));
    fs.writeFileSync(file, JSON.stringify({ ...STORY, memo: '다른 곳에서 고쳤다' }));
    assert.notEqual(loadStories(dir).stories[0].contentHash, before);
  });
});

const fileOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'));
const LINKED_SCREENS = ['/home#Home', '/lab#Lab', '/lab/result#LabResult'];
const at = (kind: 'step' | 'link', step: number) => ({ kind, step, screen: LINKED_SCREENS[step - 1] });
const writeFields = (dir: string, place: unknown, fields: unknown, contentHash: unknown = hashOf(path.join(dir, 'a.json'))) => writeStoryFields(dir, 'a', { place, fields, contentHash });

test('the needs and expects of the whole story are written into a story file that had none, and the story then reads with them', () => {
  withStoriesDir({ 'a.json': STORY }, (dir) => {
    const needs = ['완료된 문서가 하나 있다', { use: 'member-account.json' }];
    const before = hashOf(path.join(dir, 'a.json'));
    const written = writeFields(dir, { kind: 'story' }, { needs, expects: ['열람 기록이 한 줄 는다'] });
    assert.deepEqual(fileOf(dir), { ...STORY, needs, expects: ['열람 기록이 한 줄 는다'] });
    assert.equal(written.file, 'a.json');
    assert.deepEqual(written, { ...loadStories(dir).stories[0], previousHash: before });
    assert.equal(written.contentHash, hashOf(path.join(dir, 'a.json')));
  });
});

const LINKED = { ...WRITTEN, screens: ['/home#Home', { screen: '/lab#Lab', linkNeeds: ['실험실 메뉴를 누른 경우'], needs: ['실험실 설정을 켠다'] }, '/lab/result#LabResult'] };

test('the needs, inputs and expects sent for one step replace that step\'s own, turning a screen ID into a step object, while the fields not sent, its link conditions and the other steps stay as they were', () => {
  withStoriesDir({ 'a.json': LINKED }, (dir) => {
    const inputs = [{ box: { label: '이름', testId: 'lab-name', nth: 2 }, value: '실험' }];
    writeFields(dir, at('step', 3), { needs: ['실행이 끝났다'], inputs, expects: ['결과가 보인다'] });
    writeFields(dir, at('step', 2), { expects: ['실험 목록이 보인다'] });
    assert.deepEqual(fileOf(dir).screens, [
      '/home#Home',
      { screen: '/lab#Lab', linkNeeds: ['실험실 메뉴를 누른 경우'], needs: ['실험실 설정을 켠다'], expects: ['실험 목록이 보인다'] },
      { screen: '/lab/result#LabResult', needs: ['실행이 끝났다'], inputs, expects: ['결과가 보인다'] },
    ]);
    assert.deepEqual({ ...fileOf(dir), screens: [] }, { ...LINKED, screens: [] });
  });
});

test('the conditions of the link into a step replace that step\'s link conditions, and its own fields stay as they were', () => {
  withStoriesDir({ 'a.json': LINKED }, (dir) => {
    writeFields(dir, at('link', 2), { linkNeeds: ['반려된 경우', { use: 'member-account.json' }] });
    writeFields(dir, at('link', 3), { linkNeeds: ['실행이 끝난 경우'] });
    assert.deepEqual(fileOf(dir).screens, [
      '/home#Home',
      { screen: '/lab#Lab', linkNeeds: ['반려된 경우', { use: 'member-account.json' }], needs: ['실험실 설정을 켠다'] },
      { screen: '/lab/result#LabResult', linkNeeds: ['실행이 끝난 경우'] },
    ]);
  });
});

test('a step whose fields are all emptied goes back to its screen ID, and an emptied list is left out of the file', () => {
  withStoriesDir({ 'a.json': LINKED }, (dir) => {
    writeFields(dir, at('step', 2), { needs: [], inputs: [], expects: [] });
    assert.deepEqual(fileOf(dir).screens[1], { screen: '/lab#Lab', linkNeeds: ['실험실 메뉴를 누른 경우'] });
    writeFields(dir, at('link', 2), { linkNeeds: [] });
    writeFields(dir, { kind: 'story' }, { needs: [], expects: [] });
    const { needs, expects, ...plain } = LINKED;
    assert.deepEqual(fileOf(dir), { ...plain, screens: ['/home#Home', '/lab#Lab', '/lab/result#LabResult'] });
    assert.deepEqual(Object.keys(fileOf(dir)), ['name', 'screens', 'memo', 'author', 'date']);
    assert.equal(loadStories(dir).stories[0].stepFields, undefined);
  });
});

test('a field left out of what is sent keeps what the file has, and an empty list clears it', () => {
  withStoriesDir({ 'a.json': LINKED }, (dir) => {
    writeFields(dir, { kind: 'story' }, { needs: ['N2'] });
    assert.deepEqual([fileOf(dir).needs, fileOf(dir).expects], [['N2'], LINKED.expects]);
    writeFields(dir, { kind: 'story' }, { expects: [] });
    assert.deepEqual([fileOf(dir).needs, fileOf(dir).expects], [['N2'], undefined]);
    writeFields(dir, at('step', 2), { inputs: [{ box: { label: '이름' }, value: '실험' }] });
    assert.deepEqual(fileOf(dir).screens[1], { screen: '/lab#Lab', linkNeeds: ['실험실 메뉴를 누른 경우'], needs: ['실험실 설정을 켠다'], inputs: [{ box: { label: '이름' }, value: '실험' }] });
  });
});

const REFUSED_FIELDS: [string, unknown, unknown, string][] = [
  ['a need that is empty text', at('step', 2), { needs: ['실험실 설정을 켠다', ' '] }, 'screens 의 2 번째 단계의 needs 는 조건을 하나씩 글이나 { "use": 공통 조건 파일 이름 } 으로 적은 목록이어야 합니다'],
  ['a need that uses no file', { kind: 'story' }, { needs: [{ use: '' }] }, 'needs 는 조건을 하나씩 글이나 { "use": 공통 조건 파일 이름 } 으로 적은 목록이어야 합니다'],
  ['expects that are not a list', { kind: 'story' }, { expects: '문서가 열린다' }, 'expects 는 기대 결과를 하나씩 글로 적은 목록이어야 합니다'],
  ['a box with no words to find it by', at('step', 2), { inputs: [{ box: { nth: 2 }, value: '실험' }] }, 'screens 의 2 번째 단계의 1 번째 입력값의 box 에 상자를 찾는 말(placeholder, label, testId)을 하나 이상 적어야 합니다'],
  ['a box whose words are empty', at('step', 2), { inputs: [{ box: { label: '이름' }, value: '실험' }, { box: { placeholder: ' ' }, value: '실험' }] }, 'screens 의 2 번째 단계의 2 번째 입력값의 box 의 placeholder 에 화면에 보이는 문구를 적어야 합니다'],
  ['a box number below 1', at('step', 2), { inputs: [{ box: { label: '서명자 메모', nth: 0 }, value: '확인했습니다' }] }, 'screens 의 2 번째 단계의 1 번째 입력값의 box 의 nth 는 1 이상의 정수여야 합니다'],
  ['an input without its value', at('step', 2), { inputs: [{ box: { label: '이름' }, value: '' }] }, 'screens 의 2 번째 단계의 1 번째 입력값의 value 에 넣을 값을 글로 적어야 합니다'],
  ['conditions on the link into the first step', at('link', 1), { linkNeeds: ['반려된 경우'] }, 'screens 의 1 번째 단계에는 앞 단계가 없어 linkNeeds(들어오는 링크 조건)를 둘 수 없습니다'],
  ['inputs for the whole story', { kind: 'story' }, { inputs: [{ box: { label: '이름' }, value: '실험' }] }, '스토리 전체에는 needs, expects 만 적을 수 있습니다: inputs'],
  ['link conditions sent as a step\'s own fields', at('step', 2), { linkNeeds: ['반려된 경우'] }, 'screens 의 2 번째 단계에는 needs, inputs, expects 만 적을 수 있습니다: linkNeeds'],
  ['a step\'s own fields sent for the link into it', at('link', 2), { expects: ['실험 목록이 보인다'] }, 'screens 의 2 번째 단계로 들어오는 링크에는 linkNeeds 만 적을 수 있습니다: expects'],
  ['a step the story does not have', { kind: 'step', step: 4, screen: '/lab#Lab' }, { expects: ['x'] }, '스토리 a 에는 4 번째 단계가 없습니다'],
  ['a place that is neither the story, a step nor a link', { kind: 'hop', step: 2 }, {}, 'place 는 { "kind": "story" } 나 { "kind": "step" 또는 "link", "step": 단계 번호, "screen": 그 단계의 화면 ID } 여야 합니다'],
  ['a step place that does not name its screen', { kind: 'step', step: 2 }, { expects: ['x'] }, 'place 는 { "kind": "story" } 나 { "kind": "step" 또는 "link", "step": 단계 번호, "screen": 그 단계의 화면 ID } 여야 합니다'],
  ['a step whose screen is no longer the one the page read', { kind: 'step', step: 2, screen: '/lab/result#LabResult' }, { expects: ['x'] }, '스토리 a 의 2 번째 단계는 /lab/result#LabResult 이 아니라 /lab#Lab 화면이라 쓰지 않았습니다'],
  ['the link into a step whose screen is no longer the one the page read', { kind: 'link', step: 3, screen: '/lab#Lab' }, { linkNeeds: ['x'] }, '스토리 a 의 3 번째 단계는 /lab#Lab 이 아니라 /lab/result#LabResult 화면이라 쓰지 않았습니다'],
  ['a missing mark of the file read', { kind: 'story' }, { needs: ['x'] }, 'contentHash 에 페이지가 읽은 스토리 파일 내용의 SHA-256 을 보내야 합니다'],
  ['fields that are not an object', { kind: 'story' }, ['x'], 'fields 는 칸 이름마다 목록을 담은 객체여야 합니다'],
];

for (const [name, place, fields, reason] of REFUSED_FIELDS) {
  test(`writing ${name} is refused with the reason reading would give, and the file stays as it was`, () => {
    withStoriesDir({ 'a.json': LINKED }, (dir) => {
      const before = fs.readFileSync(path.join(dir, 'a.json'), 'utf8');
      const contentHash = name === 'a missing mark of the file read' ? null : hashOf(path.join(dir, 'a.json'));
      assert.throws(() => writeFields(dir, place, fields, contentHash), (err: Error) => !(err instanceof FileChanged) && err.message === reason);
      assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), before);
    });
  });
}

test('a story file changed since its mark was read is not written over, and the refusal says so', () => {
  withStoriesDir({ 'a.json': LINKED }, (dir) => {
    const file = path.join(dir, 'a.json');
    const read = hashOf(file);
    fs.writeFileSync(file, JSON.stringify({ ...LINKED, memo: '다른 곳에서 고쳤다' }));
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => writeFields(dir, { kind: 'story' }, { needs: ['x'] }, read), (err: Error) => err instanceof FileChanged && err.message === '스토리 파일 a.json 이 읽은 뒤에 바뀌어 덮어쓰지 않았습니다');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.throws(() => writeStoryFields(dir, 'nope', { place: { kind: 'story' }, fields: {}, contentHash: read }), /^Error: 스토리 nope 를 찾지 못했습니다$/);
  });
});

const writeSteps = (dir: string, steps: unknown, contentHash: unknown = hashOf(path.join(dir, 'a.json'))) => writeStorySteps(dir, 'a', { steps, contentHash });
const kept = (step: number) => ({ step, screen: LINKED_SCREENS[step - 1] });
const FILLED = {
  ...WRITTEN,
  screens: ['/home#Home', { screen: '/lab#Lab', needs: ['실험실 설정을 켠다'], expects: ['실험 목록이 보인다'] }, { screen: '/lab/result#LabResult', inputs: [{ box: { label: '이름' }, value: '실험' }], expects: ['결과가 보인다'] }],
};

test('a step put in before another or at the end changes the screens of the story file, and every kept step keeps its own fields while a new step has none', () => {
  withStoriesDir({ 'a.json': FILLED }, (dir) => {
    const before = hashOf(path.join(dir, 'a.json'));
    const written = writeSteps(dir, [kept(1), { screen: '/help#Help' }, kept(2), kept(3), { screen: '/home#Home' }]);
    assert.deepEqual(fileOf(dir).screens, ['/home#Home', '/help#Help', FILLED.screens[1], FILLED.screens[2], '/home#Home']);
    assert.deepEqual({ ...fileOf(dir), screens: [] }, { ...FILLED, screens: [] });
    assert.deepEqual(written, { ...loadStories(dir).stories[0], previousHash: before });
    assert.deepEqual(written.screens, ['/home#Home', '/help#Help', '/lab#Lab', '/lab/result#LabResult', '/home#Home']);
  });
});

test('a step taken out leaves the story file, and the steps after it keep their own fields', () => {
  withStoriesDir({ 'a.json': FILLED }, (dir) => {
    writeSteps(dir, [kept(1), kept(3)]);
    assert.deepEqual(fileOf(dir).screens, ['/home#Home', FILLED.screens[2]]);
  });
});

test('the conditions of the link into a kept step stay only while the step before it is the one it had, since otherwise that link is gone', () => {
  const screens = ['/home#Home', { screen: '/lab#Lab', linkNeeds: ['실험실 메뉴를 누른 경우'], needs: ['실험실 설정을 켠다'] }, { screen: '/lab/result#LabResult', linkNeeds: ['실행이 끝난 경우'] }];
  withStoriesDir({ 'a.json': { ...WRITTEN, screens } }, (dir) => {
    writeSteps(dir, [kept(1), { screen: '/help#Help' }, kept(2), kept(3)]);
    assert.deepEqual(fileOf(dir).screens, ['/home#Home', '/help#Help', { screen: '/lab#Lab', needs: ['실험실 설정을 켠다'] }, screens[2]]);
  });
  withStoriesDir({ 'a.json': { ...WRITTEN, screens } }, (dir) => {
    writeSteps(dir, [kept(2), kept(3)]);
    assert.deepEqual(fileOf(dir).screens, [{ screen: '/lab#Lab', needs: ['실험실 설정을 켠다'] }, screens[2]], 'a step that becomes the first has no link coming into it');
  });
  withStoriesDir({ 'a.json': { ...WRITTEN, screens } }, (dir) => {
    writeSteps(dir, [kept(1), kept(3)]);
    assert.deepEqual(fileOf(dir).screens, ['/home#Home', '/lab/result#LabResult'], 'a step left with nothing but its screen goes back to its screen ID');
  });
});

const REFUSED_STEPS: [string, unknown, string][] = [
  ['no steps at all', [], 'steps 에 단계를 하나 이상 차례대로 담아야 합니다'],
  ['steps that are not a list', '/home#Home', 'steps 에 단계를 하나 이상 차례대로 담아야 합니다'],
  ['a step that is a bare screen ID', [kept(1), '/lab#Lab'], 'steps 의 2 번째는 남길 단계의 { "step": 단계 번호, "screen": 그 단계의 화면 ID } 나 새로 넣을 단계의 { "screen": 화면 ID } 여야 합니다'],
  ['a new step that brings fields of its own', [kept(1), { screen: '/help#Help', needs: ['x'] }], 'steps 의 2 번째는 남길 단계의 { "step": 단계 번호, "screen": 그 단계의 화면 ID } 나 새로 넣을 단계의 { "screen": 화면 ID } 여야 합니다'],
  ['the same screen twice in a row', [kept(1), { screen: '/home#Home' }, kept(2)], 'screens 의 1 번째와 2 번째가 같은 화면입니다'],
  ['a kept step the story does not have', [kept(1), { step: 4, screen: '/lab#Lab' }], '스토리 a 에는 4 번째 단계가 없습니다'],
  ['a kept step whose screen is no longer the one the page read', [kept(1), { step: 2, screen: '/help#Help' }], '스토리 a 의 2 번째 단계는 /help#Help 이 아니라 /lab#Lab 화면이라 쓰지 않았습니다'],
  ['a step kept twice', [kept(1), kept(2), { screen: '/help#Help' }, kept(2)], '2 번째 단계를 두 번 남길 수 없습니다'],
  ['a step moved before another kept step', [kept(1), kept(3), kept(2)], '남기는 단계는 파일에 있던 차례대로 적어야 하는데, 2 번째 단계가 3 번째 단계 뒤에 왔습니다'],
  ['a missing mark of the file read', [kept(1)], 'contentHash 에 페이지가 읽은 스토리 파일 내용의 SHA-256 을 보내야 합니다'],
];

for (const [name, steps, reason] of REFUSED_STEPS) {
  test(`writing an order with ${name} is refused with why, and the file stays as it was`, () => {
    withStoriesDir({ 'a.json': FILLED }, (dir) => {
      const before = fs.readFileSync(path.join(dir, 'a.json'), 'utf8');
      const contentHash = name === 'a missing mark of the file read' ? null : hashOf(path.join(dir, 'a.json'));
      assert.throws(() => writeSteps(dir, steps, contentHash), (err: Error) => !(err instanceof FileChanged) && err.message === reason);
      assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), before);
    });
  });
}

test('an order is not written over a story file changed since its mark was read', () => {
  withStoriesDir({ 'a.json': FILLED }, (dir) => {
    const file = path.join(dir, 'a.json');
    const read = hashOf(file);
    fs.writeFileSync(file, JSON.stringify({ ...FILLED, memo: '다른 곳에서 고쳤다' }));
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => writeSteps(dir, [kept(1), kept(3)], read), (err: Error) => err instanceof FileChanged && err.message === '스토리 파일 a.json 이 읽은 뒤에 바뀌어 덮어쓰지 않았습니다');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
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
const statuses = (dir: string, tests?: StoryTests) => checkStoryFiles(map, dir, 'out/map.json', tests).list.map((s) => [s.id, s.status]);

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
  const t = (status: string) => ({ title: status, status, depth: 'ui' });
  const tests = {
    nodes: { '/home#Home': [t('fail')] },
    stories: { failing: [t('pass'), t('pending'), t('fail')], waiting: [t('pass'), t('pending')], passing: [t('pass'), t('pass')] },
  };
  withStoriesDir({ 'failing.json': STORY, 'waiting.json': STORY, 'passing.json': STORY }, (dir) => {
    assert.deepEqual(statuses(dir, tests), [['failing', 'fail'], ['passing', 'pass'], ['waiting', 'pending']]);
  });
});

const SIGNIN = '/signin#SignIn';
const HOME = '/home#Home';
const LAB = '/lab#Lab';
const ran = (screens?: string[], status = 'pass') => ({ title: 'x', status, depth: 'ui', ...(screens && { screens }) });
const walkOf = (screens: string[], tests: StoryTests) => withStoriesDir({ 'walk.json': { ...STORY, screens } }, (dir) => {
  const [s] = checkStoryFiles(map, dir, 'out/map.json', tests).list;
  return { walked: s.walked, walks: s.links.map((l) => l.walks), passedBy: s.links.map((l) => l.passedBy) };
});
const storyRuns = (...runs: ReturnType<typeof ran>[]) => ({ nodes: {}, stories: { walk: runs } });

test('a passing story is gone through when a story test passed with a trace that went through its screens one after another, leaving out addresses off the map, and each link counts the story tests that went straight across it', () => {
  const steps = [SIGNIN, HOME, LAB];
  assert.deepEqual(walkOf(steps, storyRuns(ran([SIGNIN, '/nowhere', SIGNIN, HOME, LAB, '/help#Help']), ran([HOME, LAB]))), { walked: 'yes', walks: [1, 2], passedBy: [undefined, undefined] });
  assert.deepEqual(walkOf(steps, storyRuns(ran([SIGNIN, HOME, '/help#Help', LAB]))), { walked: 'no', walks: [1, 0], passedBy: [undefined, undefined] });
  assert.deepEqual(walkOf(steps, storyRuns(ran([SIGNIN, LAB]), ran([HOME, LAB, SIGNIN, HOME]))), { walked: 'no', walks: [1, 1], passedBy: [undefined, undefined] });
});

test('a passing story is not known to be gone through when a story test without a trace passed and none with one went through, or when a screen is off the map, and a story that does not pass gets no answer', () => {
  const steps = [SIGNIN, HOME];
  assert.deepEqual(walkOf(steps, storyRuns(ran())), { walked: 'unknown', walks: [undefined], passedBy: [undefined] });
  assert.deepEqual(walkOf(steps, storyRuns(ran(), ran([HOME]))), { walked: 'unknown', walks: [0], passedBy: [undefined] });
  assert.deepEqual(walkOf(steps, storyRuns(ran(), ran(steps))), { walked: 'yes', walks: [1], passedBy: [undefined] });
  assert.equal(walkOf([HOME, '/gone#Gone'], storyRuns(ran([HOME]))).walked, 'unknown');
  assert.deepEqual(walkOf(steps, storyRuns(ran(steps), ran(undefined, 'fail'))), { walked: undefined, walks: [undefined], passedBy: [undefined] });
  assert.deepEqual(walkOf(steps, storyRuns(ran(steps), ran(undefined, 'pending'))), { walked: undefined, walks: [undefined], passedBy: [undefined] });
});

test('a link the map has no link for counts the passing runs with a trace that went straight across it, whatever the story tests did, and a link the map has does not', () => {
  const traced = [{ screens: [HOME, '/help#Help'] }, { screens: [HOME, '/nowhere', '/help#Help'] }, { screens: ['/help#Help', HOME] }, { screens: [HOME, LAB] }];
  assert.deepEqual(walkOf([HOME, '/help#Help', LAB], { nodes: {}, stories: {}, traced }), { walked: undefined, walks: [undefined, undefined], passedBy: [2, undefined] });
  assert.deepEqual(walkOf([HOME, LAB], { nodes: {}, stories: {}, traced }).passedBy, [undefined]);
});

test('without story tests a story is partly covered when any screen on its path has a test of any status, and has no tests when none has, even with tests on other stories or screens', () => {
  const failing = [{ title: 'x', status: 'fail', depth: 'ui' }];
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
  const t = { title: 'x @story:gone', file: 'a.spec.ts', line: 1, source: 'r/e2e.json', status: 'pass', depth: 'ui' };
  const runs = [{ ...t, project: 'chromium' }, { ...t, project: 'firefox' }];
  const { unknownTags } = checkStoryFiles(map, EXAMPLES, 'out/map.json', { nodes: {}, stories: { gone: runs } });
  assert.deepEqual(unknownTags, [{ tag: 'story:gone', test: { title: 'x @story:gone', file: 'a.spec.ts', line: 1 } }]);
});

test('without tests every story has no tests', () => {
  assert.deepEqual(checkStoryFiles(map, EXAMPLES, 'out/map.json').list.map((s) => s.status), ['untested', 'untested', 'untested', 'untested', 'untested']);
});

test('story IDs and screen IDs that are names of object members take their status like any other', () => {
  const read = (tests: StoryTests) => JSON.parse(JSON.stringify(tests));
  const files = { 'constructor.json': { ...STORY, screens: ['constructor', 'toString'] }, '__proto__.json': { ...STORY, screens: ['hasOwnProperty', 'valueOf'] } };
  withStoriesDir(files, (dir) => {
    assert.deepEqual(statuses(dir, read(NO_TESTS)), [['__proto__', 'untested'], ['constructor', 'untested']]);
    const pass = [{ title: 'x', status: 'pass', depth: 'ui' }];
    const tests = read({ nodes: {}, stories: Object.fromEntries([['constructor', pass], ['__proto__', pass]]) });
    assert.deepEqual(statuses(dir, tests), [['__proto__', 'pass'], ['constructor', 'pass']]);
    assert.deepEqual(checkStoryFiles(map, dir, 'out/map.json', tests).unknownTags, []);
  });
});

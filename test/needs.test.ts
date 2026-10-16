import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkNeeds } from '../src/needs.ts';
import { loadStories } from '../src/stories.ts';

type Files = Record<string, string | Record<string, unknown>>;

function withStoriesDir<T>(files: Files, fn: (dir: string) => T) {
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

const needsOf = (dir: string) => checkNeeds(dir, loadStories(dir).stories);

const STORY = { name: '문서를 연다', screens: ['/home#Home', '/lab#Lab'], memo: '', author: 'a', date: '2026-10-02' };
const MEMBER = { name: '일반 회원 계정', text: '역할 USER 로 가입한 계정.\n이메일 member@example.com' };
const DONE = { name: '완료된 문서 하나', text: '서명이 모두 끝난 문서가 하나 이상 있다' };

test('each file in the needs folder is a need with its name and text, named by its path under the folder, with the stories that pick it from the whole story or a step, and each pick of a file that is not there counts as missing', () => {
  withStoriesDir({
    'open.json': { ...STORY, needs: [{ use: 'member-account.json' }, '반려된 문서가 하나 있다'], screens: ['/home#Home', { screen: '/lab#Lab', needs: [{ use: 'docs/done.json' }, { use: 'old-admin.json' }] }] },
    'lab/run.json': { ...STORY, needs: [{ use: 'member-account.json' }, { use: 'old-admin.json' }] },
    'plain.json': STORY,
    'needs/member-account.json': MEMBER,
    'needs/docs/done.json': DONE,
    'needs/unused.json': { name: '쓰지 않는 준비물', text: '아무도 고르지 않는다' },
  }, (dir) => {
    assert.deepEqual(needsOf(dir), {
      list: [
        { file: 'docs/done.json', ...DONE, stories: ['open'] },
        { file: 'member-account.json', ...MEMBER, stories: ['open', 'run'] },
        { file: 'unused.json', name: '쓰지 않는 준비물', text: '아무도 고르지 않는다', stories: [] },
      ],
      notices: [],
      missing: 2,
    });
  });
});

test('a story folder without a needs folder, or one that is not there, has no needs, and a pick in it counts as missing', () => {
  withStoriesDir({ 'a.json': { ...STORY, needs: [{ use: 'member-account.json' }] } }, (dir) => {
    assert.deepEqual(needsOf(dir), { list: [], notices: [], missing: 1 });
    assert.deepEqual(checkNeeds(path.join(dir, 'a.json'), loadStories(path.join(dir, 'a.json')).stories), { list: [], notices: [], missing: 1 });
  });
  assert.deepEqual(checkNeeds(path.join(os.tmpdir(), 'duru-no-such-folder'), []), { list: [], notices: [], missing: 0 });
});

const NOTICE_CASES: [string, Files, { file: string; reason: string | RegExp }][] = [
  ['not valid JSON', { 'needs/a.json': '{' }, { file: 'needs/a.json', reason: /^JSON 으로 읽지 못했습니다: / }],
  ['a list instead of an object', { 'needs/a.json': '[]' }, { file: 'needs/a.json', reason: '준비물은 { "name", "text" } JSON 객체여야 합니다' }],
  ['no name', { 'needs/a.json': { text: '역할 USER 계정' } }, { file: 'needs/a.json', reason: 'name 에 준비물 이름을 적어야 합니다' }],
  ['empty text', { 'needs/a.json': { name: '일반 회원 계정', text: ' ' } }, { file: 'needs/a.json', reason: 'text 에 준비물 내용을 적어야 합니다' }],
  ['a key it does not know', { 'needs/a.json': { ...MEMBER, role: 'USER' } }, { file: 'needs/a.json', reason: '모르는 항목이 있습니다: role' }],
  ['a file name outside the story ID rule', { 'needs/Member Account.json': MEMBER }, { file: 'needs/Member Account.json', reason: '파일 이름이 스토리 ID 와 같은 규칙(영문 소문자 · 숫자 · - · _)에 맞지 않습니다' }],
];

for (const [name, files, notice] of NOTICE_CASES) {
  test(`a need file with ${name} is reported with why, the rest are read, and a pick of it does not count as missing`, () => {
    const use = notice.file.slice('needs/'.length);
    withStoriesDir({ ...files, 'needs/ok.json': MEMBER, 'a.json': { ...STORY, needs: [{ use }, { use: 'ok.json' }] } }, (dir) => {
      const { list, notices, missing } = needsOf(dir);
      assert.deepEqual(list.map((n) => [n.file, n.stories]), [['ok.json', ['a']]]);
      assert.equal(notices.length, 1);
      assert.equal(notices[0].file, notice.file);
      if (notice.reason instanceof RegExp) assert.match(notices[0].reason, notice.reason);
      else assert.equal(notices[0].reason, notice.reason);
      assert.equal(missing, 0);
    });
  });
}

test('a needs folder that is a file is reported as such', () => {
  withStoriesDir({ needs: 'x', 'a.json': STORY }, (dir) => {
    assert.deepEqual(needsOf(dir), { list: [], notices: [{ file: 'needs', reason: 'needs 는 준비물 파일을 담는 폴더여야 합니다' }], missing: 0 });
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addNeed, checkNeeds, editNeed } from '../src/needs.ts';
import { FileChanged, loadStories } from '../src/stories.ts';

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
const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const STORY = { name: '문서를 연다', screens: ['/home#Home', '/lab#Lab'], memo: '', author: 'a', date: '2026-10-02' };
const MEMBER = { name: '일반 회원 계정', text: '역할 USER 로 가입한 계정.\n이메일 member@example.com' };
const DONE = { name: '완료된 문서 하나', text: '서명이 모두 끝난 문서가 하나 이상 있다' };

const hashed = <T extends { file: string }>(dir: string, need: T) => ({ ...need, contentHash: sha256(path.join(dir, 'needs', need.file)) });

test('each file in the needs folder is a need with its name, its text and the mark of its content, named by its path under the folder, with the stories that pick it from the whole story or a step, and each pick of a file that is not there counts as missing', () => {
  withStoriesDir({
    'open.json': { ...STORY, needs: [{ use: 'member-account.json' }, '반려된 문서가 하나 있다'], screens: ['/home#Home', { screen: '/lab#Lab', needs: [{ use: 'docs/done.json' }, { use: 'old-admin.json' }] }] },
    'lab/run.json': { ...STORY, needs: [{ use: 'member-account.json' }, { use: 'old-admin.json' }] },
    'plain.json': STORY,
    'needs/member-account.json': MEMBER,
    'needs/docs/done.json': DONE,
    'needs/unused.json': { name: '쓰지 않는 공통 조건', text: '아무도 고르지 않는다' },
  }, (dir) => {
    assert.deepEqual(needsOf(dir), {
      list: [
        { file: 'docs/done.json', ...DONE, stories: ['open'] },
        { file: 'member-account.json', ...MEMBER, stories: ['open', 'run'] },
        { file: 'unused.json', name: '쓰지 않는 공통 조건', text: '아무도 고르지 않는다', stories: [] },
      ].map((need) => hashed(dir, need)),
      notices: [],
      missing: 2,
    });
  });
});

test('a condition on the link into a step that picks a need file counts the story among the stories that pick it, and a pick of a file that is not there counts as missing', () => {
  withStoriesDir({
    'open.json': { ...STORY, screens: ['/home#Home', { screen: '/lab#Lab', linkNeeds: [{ use: 'member-account.json' }, { use: 'old-admin.json' }] }] },
    'needs/member-account.json': MEMBER,
  }, (dir) => {
    assert.deepEqual(needsOf(dir), { list: [hashed(dir, { file: 'member-account.json', ...MEMBER, stories: ['open'] })], notices: [], missing: 1 });
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
  ['a list instead of an object', { 'needs/a.json': '[]' }, { file: 'needs/a.json', reason: '공통 조건은 { "name", "text" } JSON 객체여야 합니다' }],
  ['no name', { 'needs/a.json': { text: '역할 USER 계정' } }, { file: 'needs/a.json', reason: 'name 에 공통 조건 이름을 적어야 합니다' }],
  ['empty text', { 'needs/a.json': { name: '일반 회원 계정', text: ' ' } }, { file: 'needs/a.json', reason: 'text 에 공통 조건 내용을 적어야 합니다' }],
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
    assert.deepEqual(needsOf(dir), { list: [], notices: [{ file: 'needs', reason: 'needs 는 공통 조건 파일을 담는 폴더여야 합니다' }], missing: 0 });
  });
});

test('a need added with a file name, a name and a text is a new file in the needs folder, made when the folder is not there, and the reply is the need read back with no story picking it yet and the mark of its file', () => {
  withStoriesDir({ 'a.json': STORY }, (dir) => {
    const added = addNeed(dir, { file: 'member-account.json', name: ' 일반 회원 계정 ', text: MEMBER.text });
    const file = path.join(dir, 'needs/member-account.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), MEMBER);
    assert.deepEqual(added, { file: 'member-account.json', ...MEMBER, stories: [], contentHash: sha256(file) });
    assert.deepEqual(needsOf(dir).list, [added]);
  });
});

const BAD_FILE_NAME = '공통 조건 파일 이름은 영문 소문자 · 숫자 · - · _ 로 쓰고 .json 을 붙입니다';
const ADD_REFUSALS: [string, Files, Record<string, unknown>, string][] = [
  ['a file name outside the story ID rule', {}, { file: 'Member Account.json', name: MEMBER.name, text: MEMBER.text }, BAD_FILE_NAME],
  ['a file name in a folder', {}, { file: 'docs/done.json', name: DONE.name, text: DONE.text }, BAD_FILE_NAME],
  ['a file name going out of the folder', {}, { file: '../a.json', name: DONE.name, text: DONE.text }, BAD_FILE_NAME],
  ['a file name without .json', {}, { file: 'member-account', name: MEMBER.name, text: MEMBER.text }, BAD_FILE_NAME],
  ['a file that is already there', { 'needs/member-account.json': DONE }, { file: 'member-account.json', name: MEMBER.name, text: MEMBER.text }, '공통 조건 파일 needs/member-account.json 이 이미 있습니다'],
  ['a file that is already there and could not be read', { 'needs/member-account.json': '{' }, { file: 'member-account.json', name: MEMBER.name, text: MEMBER.text }, '공통 조건 파일 needs/member-account.json 이 이미 있습니다'],
  ['no name', {}, { file: 'member-account.json', name: ' ', text: MEMBER.text }, 'name 에 공통 조건 이름을 적어야 합니다'],
  ['no text', {}, { file: 'member-account.json', name: MEMBER.name }, 'text 에 공통 조건 내용을 적어야 합니다'],
  ['a needs folder that is a file', { needs: 'x' }, { file: 'member-account.json', name: MEMBER.name, text: MEMBER.text }, 'needs 는 공통 조건 파일을 담는 폴더여야 합니다'],
];

for (const [name, files, input, reason] of ADD_REFUSALS) {
  test(`adding a need with ${name} is refused with why and writes nothing`, () => {
    withStoriesDir({ 'a.json': STORY, ...files }, (dir) => {
      const contents = () => fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort().map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? fs.readFileSync(path.join(dir, f), 'utf8') : null]);
      const before = contents();
      assert.throws(() => addNeed(dir, input as never), (err: Error) => err.message === reason);
      assert.deepEqual(contents(), before);
    });
  });
}

test('adding a need to a story folder that is one file is refused', () => {
  withStoriesDir({ 'a.json': STORY }, (dir) => {
    assert.throws(() => addNeed(path.join(dir, 'a.json'), { file: 'member-account.json', name: MEMBER.name, text: MEMBER.text }), /가 파일이라 새 파일을 쓸 수 없습니다$/);
  });
});

test('a need edited with the mark of the file it was read from gets the new name and text in its file, the stories that pick it stay as they were, and the reply is the need read back with the marks of the file before and after', () => {
  withStoriesDir({ 'a.json': { ...STORY, needs: [{ use: 'docs/done.json' }] }, 'needs/docs/done.json': DONE }, (dir) => {
    const file = path.join(dir, 'needs/docs/done.json');
    const story = fs.readFileSync(path.join(dir, 'a.json'), 'utf8');
    const read = needsOf(dir).list[0].contentHash;
    assert.equal(read, sha256(file));
    const edited = editNeed(dir, { file: 'docs/done.json', name: '서명이 끝난 문서 하나 ', text: '서명이 모두 끝난 문서가 두 개 있다', contentHash: read });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { name: '서명이 끝난 문서 하나', text: '서명이 모두 끝난 문서가 두 개 있다' });
    assert.deepEqual(edited, { file: 'docs/done.json', name: '서명이 끝난 문서 하나', text: '서명이 모두 끝난 문서가 두 개 있다', stories: ['a'], contentHash: sha256(file), previousHash: read });
    assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), story);
  });
});

test('a need edit is refused with why, and the file stays as it was, when the mark of the file read is missing, when the name or text is empty, when the file is not there or could not be read, and when the file changed since it was read', () => {
  withStoriesDir({ 'needs/member-account.json': MEMBER, 'needs/broken.json': '{' }, (dir) => {
    const file = path.join(dir, 'needs/member-account.json');
    const read = sha256(file);
    const refused = (input: Record<string, unknown>, reason: string | RegExp, changed = false) => assert.throws(() => editNeed(dir, input as never),
      (err: Error) => (err instanceof FileChanged) === changed && (typeof reason === 'string' ? err.message === reason : reason.test(err.message)));
    refused({ file: 'member-account.json', name: MEMBER.name, text: MEMBER.text }, 'contentHash 에 페이지가 읽은 공통 조건 파일 내용의 SHA-256 을 보내야 합니다');
    refused({ file: 'member-account.json', name: '', text: MEMBER.text, contentHash: read }, 'name 에 공통 조건 이름을 적어야 합니다');
    refused({ file: 'member-account.json', name: MEMBER.name, text: ' ', contentHash: read }, 'text 에 공통 조건 내용을 적어야 합니다');
    refused({ file: 'old-admin.json', name: MEMBER.name, text: MEMBER.text, contentHash: read }, '공통 조건 파일 needs/old-admin.json 이 없습니다');
    refused({ file: 'broken.json', name: MEMBER.name, text: MEMBER.text, contentHash: read }, /^공통 조건 파일 needs\/broken\.json 을 읽지 못해 고치지 않았습니다: JSON 으로 읽지 못했습니다: /);
    fs.writeFileSync(file, JSON.stringify({ ...MEMBER, text: '다른 곳에서 고쳤다' }));
    const changed = fs.readFileSync(file, 'utf8');
    refused({ file: 'member-account.json', name: MEMBER.name, text: MEMBER.text, contentHash: read }, '공통 조건 파일 needs/member-account.json 이 읽은 뒤에 바뀌어 덮어쓰지 않았습니다', true);
    assert.equal(fs.readFileSync(file, 'utf8'), changed);
    assert.equal(fs.readFileSync(path.join(dir, 'needs/broken.json'), 'utf8'), '{');
  });
});

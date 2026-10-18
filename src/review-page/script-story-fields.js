const FIELD_PARTS = {
  story: [['needs', '조건'], ['expects', '끝난 뒤 기대 결과']],
  step: [['needs', '조건'], ['inputs', '입력값'], ['expects', '기대 결과']],
  link: [['linkNeeds', LINK_NEEDS_LABEL]],
};
const ADD_LINE = { needs: '조건 더하기', linkNeeds: '조건 더하기', inputs: '입력값 더하기', expects: '기대 결과 더하기' };
const LINE_NAME = { needs: 'need', linkNeeds: 'link-need', expects: 'expect' };
const FIELDS_TITLE = {
  story: '스토리 전체에 걸리는 조건과 스토리가 끝난 뒤의 기대 결과를 표에서',
  step: '이 단계의 조건, 입력값, 기대 결과를 표에서',
  link: '앞 단계에서 이 단계로 들어오는 링크의 조건을 표에서',
};
const FIELDS_LABEL = { story: '스토리 전체의 조건 · 기대 결과', step: '이 단계의 조건 · 입력값 · 기대 결과', link: '들어오는 링크의 조건' };
const PENCIL = () => svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, svg('path', { d: 'M10.5 2.5l3 3-8 8-3.5.5.5-3.5zM9 4l3 3' }));

let lastRowKey = 0;
const nextRowKey = () => ++lastRowKey;

const sameFieldsPlace = (a, b) => a.kind === b.kind && a.step === b.step && a.screen === b.screen;
const storyById = (id) => state.data.stories.list.find((st) => st.id === id);

const tableStillFits = (edit, st) => edit.place.kind === 'story' || st.screens[edit.place.step - 1] === edit.place.screen;

function openTable() {
  const edit = state.fieldsEdit;
  const st = edit && edit.story === state.story && storyById(edit.story);
  return st && tableStillFits(edit, st) ? edit : null;
}

function dropLostTable() {
  const edit = state.fieldsEdit;
  if (!edit) return;
  const st = storyById(edit.story);
  if (st && tableStillFits(edit, st)) return;
  state.fieldsEdit = null;
  state.storyError = st
    ? `${edit.place.step} 번째 단계가 다른 곳에서 바뀌어 열린 표를 닫았습니다. 표에 적던 내용은 저장하지 않았습니다.`
    : `스토리 ${edit.story} 가 없어져 열린 표를 닫았습니다. 표에 적던 내용은 저장하지 않았습니다.`;
}

const editingAt = (story, place) => {
  const edit = openTable();
  return Boolean(edit && edit.story === story && sameFieldsPlace(edit.place, place));
};

const wordRow = (kind, text) => ({ key: nextRowKey(), kind, text });
const inputRowOf = (input) => ({
  key: nextRowKey(),
  words: Object.keys(BOX_WORDS).filter((k) => input.box[k] !== undefined).map((k) => wordRow(k, input.box[k])),
  nth: input.box.nth === undefined ? '' : String(input.box.nth),
  value: input.value,
});
const lineRowOf = (line) => (typeof line === 'string' ? { key: nextRowKey(), text: line } : { key: nextRowKey(), use: line.use });

function openFields(story, place) {
  const st = storyById(story);
  const fields = (place.kind === 'story' ? st : st.stepFields?.[place.step - 1]) ?? {};
  const rows = Object.fromEntries(FIELD_PARTS[place.kind].map(([key]) => [key, (fields[key] ?? []).map(key === 'inputs' ? inputRowOf : lineRowOf)]));
  state.fieldsEdit = { story, place, contentHash: st.contentHash, changedHash: null, rows, error: null, saving: false };
  state.fieldsSaved = null;
  renderCenter();
}

function fieldsButton(story, place, written) {
  if (editingAt(story, place)) return null;
  const busy = Boolean(openTable());
  return h('button', {
    type: 'button',
    class: 'edit-fields',
    disabled: busy,
    title: busy ? '열린 표를 저장하거나 취소한 뒤에 고칩니다' : `${FIELDS_TITLE[place.kind]} ${written ? '고칩니다' : '적습니다'}`,
    'aria-label': `${FIELDS_LABEL[place.kind]} ${written ? '고치기' : '적기'}`,
    onclick: (e) => {
      e.stopPropagation();
      openFields(story, place);
    },
  }, PENCIL());
}

const savedLine = (story, place) => (state.fieldsSaved?.story === story && sameFieldsPlace(state.fieldsSaved.place, place)
  ? h('p', { class: 'fields-saved muted' }, `스토리 파일 ${state.fieldsSaved.file} 에 썼습니다`)
  : null);

function fieldsBelow(story, place, written) {
  if (editingAt(story, place)) return [fieldsEditor()];
  return [written, savedLine(story, place)].flat().filter(Boolean);
}

function redrawTable(focusRow = null) {
  renderCenter();
  if (focusRow !== null) /** @type {HTMLElement | null} */ (document.querySelector(`.fields-edit [data-row="${focusRow}"] input`))?.focus();
}

const removeButton = (rows, row, cls = 'remove-line') => h('button', {
  type: 'button',
  class: cls,
  onclick: () => {
    rows.splice(rows.indexOf(row), 1);
    redrawTable();
  },
}, '빼기');

const textField = (name, label, value, set) => h('input', { type: 'text', name, 'aria-label': label, value, oninput: (e) => set(e.target.value) });

const lineEditRow = (key, label, rows, row) => h('tr', { 'data-row': row.key },
  h('td', { class: 'line-text' }, row.use !== undefined ? needItem({ use: row.use }) : textField(`${LINE_NAME[key]}-${row.key}`, label, row.text, (v) => { row.text = v; })),
  h('td', {}, removeButton(rows, row)));

const unusedWord = (row) => Object.keys(BOX_WORDS).find((k) => !row.words.some((w) => w.kind === k));

function wordEdit(row, word) {
  const kinds = Object.entries(BOX_WORDS).filter(([k]) => k === word.kind || !row.words.some((w) => w.kind === k));
  return h('div', { class: 'input-word' },
    h('select', {
      name: `input-${row.key}-kind-${word.key}`,
      'aria-label': '찾는 말 종류',
      onchange: (e) => {
        word.kind = e.target.value;
        redrawTable();
      },
    }, kinds.map(([k, label]) => h('option', { value: k, selected: k === word.kind }, label))),
    textField(`input-${row.key}-word-${word.key}`, '찾는 말', word.text, (v) => { word.text = v; }),
    row.words.length > 1 ? removeButton(row.words, word, 'remove-word') : null);
}

const inputEditRow = (rows, row) => h('tr', { 'data-row': row.key },
  h('td', { class: 'input-words' },
    row.words.map((word) => wordEdit(row, word)),
    unusedWord(row) ? h('button', {
      type: 'button',
      class: 'add-word',
      title: '같은 상자를 다른 말로도 찾게 합니다',
      onclick: () => {
        row.words.push(wordRow(unusedWord(row), ''));
        redrawTable();
      },
    }, '찾는 말 더하기') : null),
  h('td', {}, h('input', { type: 'number', min: 1, step: 1, name: `input-${row.key}-nth`, 'aria-label': '몇 번째', title: '같은 말로 찾히는 상자가 여럿일 때 몇 번째 상자인지', value: row.nth, oninput: (e) => { row.nth = e.target.value; } })),
  h('td', {}, textField(`input-${row.key}-value`, '값', row.value, (v) => { row.value = v; })),
  h('td', {}, removeButton(rows, row)));

function addLine(key) {
  const row = key === 'inputs' ? { key: nextRowKey(), words: [wordRow('placeholder', '')], nth: '', value: '' } : { key: nextRowKey(), text: '' };
  state.fieldsEdit.rows[key].push(row);
  redrawTable(row.key);
}

function fieldsPart(key, label, rows) {
  const head = key === 'inputs' ? h('thead', {}, h('tr', {}, h('th', {}, '찾는 말'), h('th', {}, '몇 번째'), h('th', {}, '값'), h('th', {}))) : null;
  return h('div', { class: `fields-part ${key === 'linkNeeds' ? 'link-needs' : key}` },
    h('h4', {}, label),
    rows.length ? h('table', {}, head, h('tbody', {}, rows.map((row) => (key === 'inputs' ? inputEditRow(rows, row) : lineEditRow(key, label, rows, row))))) : null,
    h('button', { type: 'button', class: 'add-line', onclick: () => addLine(key) }, ADD_LINE[key]));
}

function fieldsEditor() {
  const edit = state.fieldsEdit;
  return h('div', { class: 'fields-edit', onclick: (e) => e.stopPropagation() },
    h('fieldset', { disabled: edit.saving },
      FIELD_PARTS[edit.place.kind].map(([key, label]) => fieldsPart(key, label, edit.rows[key])),
      edit.error ? h('p', { class: 'error fields-error' }, edit.error) : null,
      h('div', { class: 'fields-acts' },
        edit.changedHash === null
          ? h('button', { type: 'button', class: 'save-fields', title: '이 자리의 칸만 스토리 파일에 고쳐 씁니다', onclick: saveFields }, '저장')
          : [
            h('button', { type: 'button', class: 'reread-fields', title: '바뀐 스토리 파일의 이 자리 칸을 표에 불러오고, 표에 적던 내용은 버립니다', onclick: () => openFields(edit.story, edit.place) }, '새로 읽기'),
            h('button', { type: 'button', class: 'overwrite-fields', title: '다른 곳에서 바뀐 이 자리의 칸을 표에 적은 내용으로 덮어씁니다', onclick: overwriteFields }, '덮어쓰기'),
          ],
        h('button', { type: 'button', class: 'cancel-fields', title: '스토리 파일은 그대로 둡니다', onclick: cancelFields }, '취소'))));
}

function overwriteFields() {
  const edit = state.fieldsEdit;
  edit.contentHash = edit.changedHash;
  saveFields();
}

function cancelFields() {
  state.fieldsEdit = null;
  renderCenter();
}

// 반만 채운 입력값 줄은 그대로 보내 서버가 빠진 항목을 알려 주게 한다.
function fieldsToSend(rows) {
  const lines = (list) => list.flatMap((r) => (r.use !== undefined ? [{ use: r.use }] : r.text.trim() ? [r.text.trim()] : []));
  const inputs = (list) => list
    .filter((r) => r.words.some((w) => w.text.trim()) || r.nth.trim() || r.value.trim())
    .map((r) => ({ box: { ...Object.fromEntries(r.words.map((w) => [w.kind, w.text.trim()])), ...(r.nth.trim() && { nth: Number(r.nth) }) }, value: r.value }));
  return Object.fromEntries(Object.entries(rows).map(([key, list]) => [key, key === 'inputs' ? inputs(list) : lines(list)]));
}

async function saveFields() {
  const edit = state.fieldsEdit;
  Object.assign(edit, { error: null, changedHash: null, saving: true });
  renderCenter();
  /** @type {{ file: string } | null} */
  let written = null;
  /** @type {{ reason: string, changed: boolean } | null} */
  let refused = null;
  /** @type {string | null} */
  let failed = null;
  await whileWritingStories(async () => {
    try {
      const res = await fetch('/api/stories/fields', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: edit.story, place: edit.place, fields: fieldsToSend(edit.rows), contentHash: edit.contentHash }),
      });
      if (res.ok) written = await res.json();
      else refused = { reason: await res.text(), changed: res.status === 409 };
      if (written || refused.changed) await load();
    } catch (err) {
      failed = written
        ? `저장했지만 다시 읽지 못했습니다: ${err.message}`
        : refused ? `저장하지 않았습니다: ${refused.reason}. 바뀐 파일을 다시 읽지 못했습니다: ${err.message}` : `저장하지 못했습니다: ${err.message}`;
    }
  });
  edit.saving = false;
  if (written) {
    state.fieldsEdit = null;
    state.fieldsSaved = { story: edit.story, place: edit.place, file: written.file };
    state.error = failed;
  } else if (refused && !failed) {
    if (refused.changed) edit.changedHash = storyById(edit.story)?.contentHash ?? null;
    edit.error = `저장하지 않았습니다: ${refused.reason}${edit.changedHash !== null ? '. 바뀐 파일을 새로 읽거나, 지금 적은 내용으로 덮어쓸 수 있습니다.' : ''}`;
  } else {
    edit.error = failed;
  }
  render();
}

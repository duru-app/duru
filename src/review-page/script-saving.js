const shownTarget = () => (state.side !== 'stories' ? state.target : state.candidate !== null ? { candidate: state.candidate } : { story: state.story });
const isShown = (target) => {
  const shown = shownTarget();
  return !!shown && keyOf(shown) === keyOf(target);
};

function showSaveError(reason, target) {
  state.error = isShown(target) ? `저장하지 못했습니다: ${reason}` : `「${targetName(target)}」 코멘트를 저장하지 못했습니다: ${reason}`;
  if (!state.ended) renderRight();
}

// 지금 상태를 다시 매기는 것은 아무것도 바꾸지 않으므로, 함께 쓴 글은 코멘트로 보낸다.
const asComment = (target, draft) => draft.note.trim() !== '' && draft.status === (markOf(target)?.current?.status ?? null);

const ownerOf = (draftKey) => (draftKey === 'storyDraft' ? { story: state.story } : draftKey === 'candidateTalk' ? { candidate: state.candidate } : state.target);
const saveMark = (tags, draftKey, statusOn) => trackOwnSave(() => postMark(tags, draftKey, statusOn));

async function postMark(tags, draftKey, statusOn) {
  state.error = null;
  const draft = state[draftKey];
  const owner = ownerOf(draftKey);
  const target = tags.length === 1 ? tags[0] : owner;
  let saved;
  try {
    const res = await fetch('/api/marks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tags.length === 1
        ? { target, status: statusOn && !asComment(target, draft) ? draft.status : null, note: draft.note }
        : { targets: tags, note: draft.note }),
    });
    if (!res.ok) throw new Error(await res.text());
    saved = await res.json();
  } catch (err) {
    showSaveError(err.message, target);
    return null;
  }
  const here = ownerOf(draftKey);
  const untouched = !!here && keyOf(here) === keyOf(target) && !unsaved(target, state[draftKey]);
  if (state[draftKey] === draft || untouched) state[draftKey] = null;
  try {
    await load();
  } catch (err) {
    state.error = isShown(target) ? `저장했지만 다시 읽지 못했습니다: ${err.message}` : `「${targetName(target)}」 코멘트는 저장했지만 다시 읽지 못했습니다: ${err.message}`;
  }
  render();
  return saved.id;
}

async function postJudgment(judgment) {
  try {
    const res = await fetch('/api/judgments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(judgment) });
    if (!res.ok) throw new Error(await res.text());
  } catch (err) {
    return `저장하지 못했습니다: ${err.message}`;
  }
  return null;
}

const judgmentsInFlight = new Set();

async function postAndReload(judgment, key) {
  judgmentsInFlight.add(key);
  try {
    const failure = await postJudgment(judgment);
    if (failure) return { failure, reloadError: null };
    try {
      await load();
    } catch (err) {
      return { failure: null, reloadError: `저장했지만 다시 읽지 못했습니다: ${err.message}` };
    }
    return { failure: null, reloadError: null };
  } finally {
    judgmentsInFlight.delete(key);
  }
}

// 오류가 붙은 짝의 줄과 초점을 보이도록, 그 짝이 든 「호출 정보」를 다시 연다.
function setJudgmentError(key, message) {
  state.judgmentError = message ? { key, message } : null;
  if (message && state.callInfoShut && pairKeys(state.callInfoShut).includes(key)) state.callInfoShut = null;
}

async function saveJudgment(judgment, key) {
  if (judgmentsInFlight.has(key)) return;
  state.judgmentError = null;
  const { failure, reloadError } = await postAndReload(judgment, key);
  if (failure ?? reloadError) setJudgmentError(key, failure ?? reloadError);
  renderKeepingJudgeRowFocus();
}

async function saveBulk(t, bulk, kind, reason) {
  const chosen = pickedPairs(t, bulk);
  bulk.error = null;
  state.bulkBusy = true;
  render();
  const names = (list) => list.map((p) => screenLabel(p.id)).join(', ');
  const saved = [];
  let failure = null;
  for (const p of chosen) {
    failure = await postJudgment({ test: t.ref, node: p.id, kind, reason });
    if (failure) break;
    saved.push(p);
    bulk.picked.delete(p.id);
  }
  let reloadError = null;
  try {
    await load();
  } catch (err) {
    reloadError = `${saved.length ? '저장했지만 ' : ''}다시 읽지 못했습니다: ${err.message}`;
  }
  state.bulkBusy = false;
  bulk.error = failure
    ? [failure, `저장한 짝 ${saved.length}: ${names(saved) || '없음'}. 저장하지 못한 짝 ${chosen.length - saved.length}: ${names(chosen.slice(saved.length))}.`, reloadError].filter(Boolean).join('\n')
    : reloadError;
  return failure ? bulk.error : null;
}


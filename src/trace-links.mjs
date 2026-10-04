import { screenFinder } from './address-match.mjs';
import { readTrace } from './playwright-trace.mjs';

export const PASS_LEVELS = ['visit', 'interact', 'assert'];

// 돌려주는 함수는 trace 파일 하나를 받아 { screens: 화면 ID → 그 화면에서 한 일 가운데 가장 높은 단계 } 를, 읽지 못하면 { reason } 을 돌려준다.
export function traceLinker(map) {
  let screenAt;
  return (traceFile) => {
    const { steps, reason } = readTrace(traceFile);
    if (reason) return { reason };
    screenAt ??= screenFinder(map);
    const screens = new Map();
    for (const { url, kind } of steps) {
      const id = screenAt(url);
      if (id && PASS_LEVELS.indexOf(kind) > PASS_LEVELS.indexOf(screens.get(id))) screens.set(id, kind);
    }
    return { screens };
  };
}

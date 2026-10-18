import fs from 'node:fs';
import zlib from 'node:zlib';
import type { InputBox, StepInput } from './stories.ts';

type StepKind = 'visit' | 'assert' | 'interact';

export interface TraceStep {
  url: string;
  kind: StepKind;
  input?: StepInput;
  inputSkipped?: true;
}

export interface TraceRequest {
  method: string;
  url: string;
}

export type TraceResult = { reason: string } | { steps: TraceStep[]; requests: TraceRequest[] };

interface TimelineEntry {
  at: number;
  page: string;
  url?: string;
  kind?: 'assert' | 'interact';
  fill?: StepInput | 'skipped';
}

const KNOWN_VERSIONS = [8];
const ASSERTIONS = new Set(['expect', 'expectScreenshot']);
const INTERACTIONS = new Set([
  'click', 'dblclick', 'tap', 'fill', 'type', 'press', 'check', 'uncheck', 'selectOption', 'setInputFiles', 'dragAndDrop', 'drop',
  'hover', 'dispatchEvent', 'keyboardDown', 'keyboardUp', 'keyboardType', 'keyboardPress', 'keyboardInsertText',
  'mouseMove', 'mouseClick', 'mouseDown', 'mouseUp', 'mouseWheel', 'touchscreenTap',
]);
const QUOTED = '("(?:[^"\\\\]|\\\\.)*")';
const BOX_SELECTORS: [keyof InputBox, RegExp][] = [
  ['label', new RegExp(`^internal:label=${QUOTED}[is]?(?: >> nth=(\\d+))?$`)],
  ['placeholder', new RegExp(`^internal:attr=\\[placeholder=${QUOTED}[is]?\\](?: >> nth=(\\d+))?$`)],
  ['testId', new RegExp(`^internal:testid=\\[data-testid=${QUOTED}[is]?\\](?: >> nth=(\\d+))?$`)],
];
const NOT_THE_APP = /^(about|data|blob|chrome|chrome-error):/;
const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;

function fillOf(params: any): StepInput | 'skipped' {
  const value = params?.value;
  if (typeof value !== 'string' || !value.trim() || typeof params.selector !== 'string') return 'skipped';
  for (const [word, pattern] of BOX_SELECTORS) {
    const found = params.selector.match(pattern);
    if (!found) continue;
    try {
      return { box: { [word]: JSON.parse(found[1]), ...(found[2] !== undefined && { nth: Number(found[2]) + 1 }) }, value };
    } catch {
      return 'skipped';
    }
  }
  return 'skipped';
}

function zipEntries(buffer: Buffer): Map<string, () => Buffer> {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== END_OF_DIRECTORY) end -= 1;
  if (end < 0) throw new Error('not a zip file');
  const entries = new Map<string, () => Buffer>();
  let at = buffer.readUInt32LE(end + 16);
  for (let i = buffer.readUInt16LE(end + 10); i > 0; i -= 1) {
    if (buffer.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new Error('broken zip directory');
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, () => {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      return method === 0 ? data : zlib.inflateRawSync(data);
    });
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return entries;
}

const jsonLines = (read: () => Buffer) => read().toString('utf8').split('\n').filter(Boolean).map((line: string) => JSON.parse(line));

export function readTrace(file: string): TraceResult {
  if (!fs.existsSync(file)) return { reason: 'trace 파일이 없습니다' };
  let events: any[];
  let network: any[];
  try {
    const entries = zipEntries(fs.readFileSync(file));
    const named = (ending: string) => [...entries].filter(([name]) => name.endsWith(ending) && name !== 'test.trace').flatMap(([, read]) => jsonLines(read));
    events = named('.trace');
    network = named('.network');
  } catch (err) {
    return { reason: `trace 파일을 열지 못했습니다: ${(err as Error).message}` };
  }
  const contexts = events.filter((e) => e.type === 'context-options');
  if (!contexts.length) return { reason: 'trace 파일에서 브라우저 기록을 찾지 못했습니다' };
  const unknown = contexts.find((c) => !KNOWN_VERSIONS.includes(c.version));
  if (unknown) return { reason: `두루가 모르는 trace 파일 버전입니다: ${unknown.version} (Playwright ${unknown.playwrightVersion})` };

  const snapshots = new Map(
    events.filter((e) => e.type === 'frame-snapshot' && e.snapshot.isMainFrame).map((e) => [e.snapshot.snapshotName, e.snapshot]),
  );
  const kindOf = (method: string) => (ASSERTIONS.has(method) ? 'assert' : INTERACTIONS.has(method) ? 'interact' : null);
  const actions = events.filter((e) => e.type === 'before' && e.pageId);
  if (!snapshots.size && actions.some((a) => a.method === 'goto' || kindOf(a.method))) {
    return { reason: 'trace 파일에 화면 스냅숏이 없어 테스트가 연 주소를 알 수 없습니다' };
  }

  const ends = new Map(events.filter((e) => e.type === 'after').map((e) => [e.callId, e]));
  const timeline: TimelineEntry[] = [];
  for (const action of actions) {
    const end = ends.get(action.callId);
    const endTime = end?.endTime ?? action.startTime;
    const input = snapshots.get(`input@${action.callId}`);
    const seen = [['before', action.startTime], ['input', input?.timestamp], ['after', endTime]];
    for (const [name, at] of seen) {
      const snapshot = snapshots.get(`${name}@${action.callId}`);
      if (snapshot) timeline.push({ at, page: action.pageId, url: snapshot.frameUrl });
    }
    const kind = kindOf(action.method);
    if (kind === 'assert') timeline.push({ at: endTime, page: action.pageId, kind });
    else if (kind && !end?.error) {
      const fill = action.method === 'fill' ? fillOf(action.params) : undefined;
      timeline.push({ at: input?.timestamp ?? action.startTime, page: action.pageId, kind, ...(fill && { fill }) });
    }
  }
  timeline.sort((a, b) => a.at - b.at || Number(Boolean(a.kind)) - Number(Boolean(b.kind)));
  const current = new Map();
  const steps: TraceStep[] = [];
  for (const { page, url, kind, fill } of timeline) {
    if (kind) {
      if (current.has(page)) steps.push({ url: current.get(page), kind, ...(fill === 'skipped' ? { inputSkipped: true as const } : fill && { input: fill }) });
    } else if (NOT_THE_APP.test(url!)) {
      current.delete(page);
    } else if (current.get(page) !== url) {
      current.set(page, url);
      steps.push({ url: url!, kind: 'visit' });
    }
  }
  const requests = network
    .filter((e) => e.type === 'resource-snapshot')
    .sort((a, b) => a.snapshot._monotonicTime - b.snapshot._monotonicTime)
    .map((e) => ({ method: e.snapshot.request.method, url: e.snapshot.request.url }));
  return { steps, requests };
}

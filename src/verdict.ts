import fs from 'node:fs';
import path from 'node:path';

export type TestStatus = 'pass' | 'fail' | 'pending';

export interface VerdictResult {
  title: string;
  file: string;
  line: number;
  project: null;
  tags: string[];
  status: TestStatus;
  detail?: string;
}

const STATUS: Record<string, TestStatus> = {
  UPHOLDS: 'pass',
  FIXED: 'pass',
  HEALTHY: 'pass',
  REPRODUCES: 'fail',
  VIOLATE: 'fail',
  VIOLATES: 'fail',
  REGRESSED: 'fail',
  BROKEN: 'fail',
  INCONCLUSIVE: 'pending',
  KNOWN_DROP: 'pending',
  ENTRY_HEALTHY: 'pending',
  PARTIAL: 'pending',
};
const PREFIX = 'VERDICT ';
const isTag = (token: string) => /^@\S/.test(token);
export const withoutTags = (text: string) => text.split(/\s+/).filter((t) => t && !isTag(t)).join(' ');

// 판정 줄: `VERDICT <이름>: <판정> — <설명> @screen:<id>`
export function readVerdicts(file: string): VerdictResult[] {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read verdict log ${file}: ${(err as Error).message}`);
  }

  const out: VerdictResult[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line.startsWith(PREFIX)) return;
    const rest = line.slice(PREFIX.length).trimStart();
    const sep = `${rest} `.indexOf(': ');
    const title = sep === -1 ? withoutTags(rest) : rest.slice(0, sep).trimEnd();
    const body = sep === -1 ? '' : rest.slice(sep + 1);
    const tokens = body.split(/\s+/).filter(Boolean);
    const status = Object.hasOwn(STATUS, tokens[0] ?? '') ? STATUS[tokens[0]] : undefined;
    const dash = body.indexOf('— ');
    const detail = withoutTags(status ? (dash === -1 ? '' : body.slice(dash + 2)) : body);
    out.push({
      title,
      file: path.basename(file),
      line: i + 1,
      project: null,
      tags: tokens.filter(isTag).map((t) => t.slice(1)),
      status: status ?? 'pending',
      ...(detail && { detail }),
    });
  });
  return out;
}

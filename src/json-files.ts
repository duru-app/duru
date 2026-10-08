import fs from 'node:fs';
import path from 'node:path';
import { compare } from './config.mjs';

interface Say {
  folder: (message: string) => string;
  link: (message: string) => string;
  missing: () => string;
}

interface JsonFile {
  file: string;
  reason?: string;
}

// 돌려주는 항목에 reason 이 있으면 읽지 못한 폴더나 링크이고, file 은 dir 기준 상대 경로다.
export function jsonFiles(dir: string, say: Say): JsonFile[] {
  const found: JsonFile[] = [];
  const walk = (folder: string, above: string[] = []) => {
    const here = path.relative(dir, folder) || dir;
    let entries: fs.Dirent[];
    try {
      const real = fs.realpathSync(folder);
      if (above.includes(real)) return;
      above = [...above, real];
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch (err) {
      found.push({ file: here, reason: say.folder((err as Error).message) });
      return;
    }
    for (const e of entries) {
      const full = path.join(folder, e.name);
      if (e.isDirectory()) walk(full, above);
      else if (e.isSymbolicLink()) walkLink(full, above);
      else if (e.isFile() && e.name.endsWith('.json')) found.push({ file: path.relative(dir, full) });
    }
  };
  const walkLink = (link: string, above: string[]) => {
    let stat;
    try {
      stat = fs.statSync(link, { throwIfNoEntry: false });
    } catch (err) {
      if (link.endsWith('.json')) found.push({ file: path.relative(dir, link), reason: say.link((err as Error).message) });
      return;
    }
    if (stat?.isDirectory()) walk(link, above);
    else if (link.endsWith('.json')) found.push({ file: path.relative(dir, link), ...(stat ? {} : { reason: say.missing() }) });
  };
  walk(dir);
  return found.sort((a, b) => compare(a.file, b.file));
}

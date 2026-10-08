import { compare } from './config.ts';

export interface RemovedField {
  call: string;
  field: string;
}

export interface UnknownExclusion {
  call: string;
  field?: string;
}

export interface RemovedFields {
  removed: RemovedField[];
  unknown: UnknownExclusion[];
}

const byCallAndField = (a: UnknownExclusion, b: UnknownExclusion): number => compare(a.call, b.call) || compare(a.field ?? '', b.field ?? '');

export function removeExcludedFields(typeFields: Map<string, Set<string>>, exclusions: Record<string, string[]>): RemovedFields {
  const removed: RemovedField[] = [];
  const unknown: UnknownExclusion[] = [];
  for (const [call, fields] of Object.entries(exclusions)) {
    const read = typeFields.get(call);
    if (!read) {
      unknown.push({ call });
      continue;
    }
    for (const field of new Set(fields)) {
      if (read.delete(field)) removed.push({ call, field });
      else unknown.push({ call, field });
    }
  }
  return { removed: removed.sort(byCallAndField), unknown: unknown.sort(byCallAndField) };
}

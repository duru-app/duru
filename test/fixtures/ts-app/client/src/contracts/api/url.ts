export const WORKSPACE_PREFIX = '/internal/v2/workspace/{workspaceId}';

export function buildUrl(prefix: string, path: string, values: Record<string, unknown>) {
  return (prefix + path).replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Invalid path value: ${name}`);
    return encodeURIComponent(String(value));
  });
}

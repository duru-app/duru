export type RouteKey = 'HOME' | 'DOCUMENT' | 'ADMIN' | 'LAB' | 'REPORT' | 'ARCHIVE' | 'PROFILE' | 'INBOX' | 'OUTBOX';

export const joinPath = (base: string, segment: string): string => `${base}/${segment}`;

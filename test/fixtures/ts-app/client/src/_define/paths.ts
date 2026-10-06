export type RouteKey = 'HOME' | 'DOCUMENT' | 'ADMIN' | 'LAB' | 'REPORT';

export const joinPath = (base: string, segment: string): string => `${base}/${segment}`;

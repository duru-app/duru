import { formatDate } from './formatDate';

test('formats a date as year-month-day', () => {
  expect(formatDate(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05');
});

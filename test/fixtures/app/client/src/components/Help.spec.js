import Help from './Help';
import { formatDate } from './formatDate';

test('renders the help text', () => {
  expect(Help).toBeDefined();
});

test('shows the day the help was last updated', () => {
  expect(formatDate(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05');
});

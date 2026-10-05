import { ajaxReportSchedule } from '../_ajax/AjaxFunc';
import { type BadgeProps } from '../components/Badge';
import type { Settings } from '../store/settings';

export default function Report({ ids, globalSettings }: { ids: string[]; globalSettings: Settings; badge?: BadgeProps }) {
  const archived = (globalSettings satisfies Settings).SYSTEM.REPORT_ENABLED;
  ajaxReportSchedule({ ids, archived, monthly: true } satisfies Record<string, unknown>);
  return null;
}

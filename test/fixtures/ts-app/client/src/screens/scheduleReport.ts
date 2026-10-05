import { ajaxReportSchedule } from '../_ajax/AjaxFunc';

type ScheduleBody = { ids: string[]; weekly: boolean; notify: boolean };

export function scheduleReport(ids: string[]) {
  const body = <ScheduleBody>{ ids, weekly: true, notify: false };
  return ajaxReportSchedule(body);
}

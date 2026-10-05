import Option from '../_define/Option';

type Body = Record<string, unknown>;

const request = async (info: unknown, body?: Body) => ({ info, body });

export const ajaxReportArchive = async ({ data }: { data: Body }) => request(Option.REST_API.REPORT.ARCHIVE, data);

export const ajaxReportSchedule = async (body: Body) => request(Option.REST_API.REPORT.SCHEDULE, body);

import { Link } from 'react-router-dom';
import Option from '../_define/Option';
import { ajaxReportArchive } from '../_ajax/AjaxFunc';
import { scheduleReport } from './scheduleReport';

type ArchiveBody = { ids: string[]; signedOnly: boolean };

export default function Lab({ ids, session }: { ids: string[]; session: Record<string, string> }) {
  return (
    <section>
      <button onClick={() => ajaxReportArchive({ data: { ids, signedOnly: true } as ArchiveBody })}>Archive</button>
      <button onClick={() => scheduleReport(ids)}>Every week</button>
      {session!['member.role'] === 'AUDITOR' && <Link to={Option.ROUTE_PATH.DOCUMENT}>All documents</Link>}
    </section>
  );
}

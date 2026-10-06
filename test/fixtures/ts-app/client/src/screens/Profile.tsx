import { Link } from 'react-router-dom';
import Option from '../_define/Option';
import type { Settings } from '../store/settings';

export default function Profile({ globalSettings }: { globalSettings: Settings }) {
  return <section>{globalSettings.SYSTEM.REPORT_ENABLED && <Link to={Option.ROUTE_PATH.ARCHIVE}>Archive</Link>}</section>;
}

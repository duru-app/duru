import { Link } from 'react-router-dom';
import Option from '../_define/Option';
import type { Settings } from '../store/settings';

export type BadgeProps = { globalSettings: Settings };

export default function Badge({ globalSettings }: BadgeProps) {
  return globalSettings.SYSTEM.REPORT_ENABLED ? <Link to={Option.ROUTE_PATH.ADMIN}>Admin</Link> : null;
}

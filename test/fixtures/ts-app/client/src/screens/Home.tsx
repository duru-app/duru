import { Link } from 'react-router-dom';
import Option from '../_define/Option';
import type { Settings } from '../store/settings';
import type { BadgeProps } from '../components/Badge';
import { type BannerProps, Banner } from '../components';

type Props = { memberRole: string; globalSettings: Settings; recent?: string; badge?: BadgeProps };

export default function Home({ memberRole, globalSettings, recent }: Props) {
  const banner: BannerProps = { title: 'Welcome' };
  return (
    <main>
      <Banner {...banner} />
      <Link to={Option.ROUTE_PATH.DOCUMENT as string}>Documents</Link>
      <Link to={`${(Option.ROUTE_PATH.DOCUMENT as string)}/${recent!}`}>Recent document</Link>
      {(memberRole as string) === 'ADMIN' && <Link to={Option.ROUTE_PATH.ADMIN}>Admin</Link>}
      {(globalSettings as Settings).SYSTEM.REPORT_ENABLED && <Link to={Option.ROUTE_PATH.REPORT}>Report</Link>}
    </main>
  );
}

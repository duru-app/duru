import type { ComponentType } from 'react';
import { Route, Routes } from 'react-router-dom';
import Option from '../_define/Option';
import type { Settings } from '../store/settings';
import Admin from '../screens/Admin';
import Lab from '../screens/Lab';
import Report from '../screens/Report';

type Role = 'ADMIN' | 'MEMBER';

const Checked = ({ Page }: { Page: ComponentType }) => <Page />;

export default function AdminRoutes({ memberRole, globalSettings }: { memberRole: string; globalSettings?: Settings }) {
  return (
    <Routes>
      {(memberRole as Role) === 'ADMIN' && <Route path={Option.ROUTE_PATH.ADMIN} element={<Admin />} />}
      {(globalSettings!.SYSTEM.LAB_ENABLED as boolean) && <Route path={Option.ROUTE_PATH.LAB} element={<Checked Page={Lab} />} />}
      <Route path={Option.ROUTE_PATH.REPORT satisfies string} element={<Checked Page={Report} />} />
    </Routes>
  );
}

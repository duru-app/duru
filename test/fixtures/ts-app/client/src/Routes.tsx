import { Route, Switch } from 'react-router-dom';
import Option from './_define/Option';
import type { Settings } from './store/settings';
import Home from './screens/Home';
import DocumentList from './screens/DocumentList';
import DocumentDetail from './screens/DocumentDetail';
import Admin from './screens/Admin';
import Lab from './screens/Lab';
import Report from './screens/Report';

type Role = 'ADMIN' | 'MEMBER';

export default function Routes({ memberRole, globalSettings }: { memberRole: string; globalSettings?: Settings }) {
  return (
    <Switch>
      <Route path={Option.ROUTE_PATH.HOME as string} component={Home} exact />
      <Route path={Option.ROUTE_PATH.DOCUMENT} component={DocumentList} exact />
      <Route path={`${Option.ROUTE_PATH.DOCUMENT!}/:id`} component={DocumentDetail} exact />
      {(memberRole as Role) === 'ADMIN' && <Route path={Option.ROUTE_PATH.ADMIN} component={Admin} exact />}
      {(globalSettings!.SYSTEM.LAB_ENABLED as boolean) && <Route path={Option.ROUTE_PATH.LAB} component={Lab} exact />}
      <Route path={Option.ROUTE_PATH.REPORT satisfies string} component={Report} exact />
    </Switch>
  );
}

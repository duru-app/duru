import { lazy } from 'react';
import { Redirect, Route, Switch } from 'react-router-dom';
import Option from './_define/Option';
import Enum from './_define/Enum';
import SignIn from './components/SignIn';
import Home from './components/Home';
import Layout from './components/Layout';

const waitFor = (Tag) =>
  function WaitFor(props) {
    return <Tag {...props} />;
  };

const isAdminRole = (role) => role === Enum.ROLE.ADMIN;

const DocumentList = lazy(() => import('./components/DocumentList'));
const DocumentDetail = lazy(() => import('./components/DocumentDetail'));
const Help = lazy(() => import('./components/Help'));
const AdminMember = lazy(() => import('./components/AdminMember'));
const AdminGroup = lazy(() => import('./components/AdminGroup'));
const Lab = lazy(() => import('./components/Lab'));
const LabResult = lazy(() => import('./components/LabResult'));
const AdminAudit = lazy(() => import('./components/AdminAudit'));
const AdminReport = lazy(() => import('./components/AdminReport'));

export default function Routes({ memberRole, session, globalSettings }) {
  const isAdmin = canManageGroups(memberRole);

  return (
    <Switch>
      <Route path={Option.ROUTE_PATH.SIGN_IN} component={SignIn} exact />
      <Route>
        <Layout session={session} globalSettings={globalSettings}>
          <Switch>
            <Route path={Option.ROUTE_PATH.HOME} component={waitFor(Home)} exact />
            <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)`} component={waitFor(DocumentList)} exact />
            <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />
          </Switch>
        </Layout>
      </Route>
      <Route path={Option.ROUTE_PATH.HELP} component={Help} exact />
      {isAdminRole(memberRole) && <Route path={Option.ROUTE_PATH.ADMIN_MEMBER} component={AdminMember} exact />}
      {isAdmin && <Route path={Option.ROUTE_PATH.ADMIN_GROUP} component={AdminGroup} exact />}
      {globalSettings.SYSTEM.LAB_ENABLED ? <Route path={Option.ROUTE_PATH.LAB} component={waitFor(Lab)} exact /> : null}
      <Route path={Option.ROUTE_PATH.LAB_RESULT} component={waitFor(LabResult)} exact />
      <Route path={Option.ROUTE_PATH.ADMIN_AUDIT} component={AdminAudit} exact />
      <Route path={Option.ROUTE_PATH.ADMIN_REPORT} component={AdminReport} exact />
      <Redirect to={Option.ROUTE_PATH.SIGN_IN} />
    </Switch>
  );
}

function canManageGroups(role) {
  if (!role) return false;
  return isAdminRole(role);
}

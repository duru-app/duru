import { Route, Routes } from 'react-router-dom';
import Option from '../_define/Option';
import Inbox from '../screens/Inbox';
import Outbox from '../screens/Outbox';

export default function MailRoutes() {
  return (
    <Routes>
      <Route path={Option.ROUTE_PATH.INBOX} element={<Inbox />} />
      <Route path={Option.ROUTE_PATH.OUTBOX} element={<Outbox />} />
    </Routes>
  );
}

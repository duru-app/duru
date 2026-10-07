import { Link, useNavigate } from 'react-router-dom';
import Option from '../_define/Option';
import { navigateLazyPage } from '../pages/navigateLazyPage';

export default function Inbox() {
  const navigate = useNavigate();
  return (
    <main>
      <Link to={Option.ROUTE_PATH.INBOX}>Refresh</Link>
      <button onClick={() => navigateLazyPage(navigate, 'Outbox', Option.ROUTE_PATH.OUTBOX)}>Outbox</button>
    </main>
  );
}

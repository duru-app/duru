import { useNavigate } from 'react-router-dom';
import Option from '../_define/Option';
import { navigateLazyPage } from '../pages/navigateLazyPage';

export default function Outbox() {
  const navigate = useNavigate();
  return <button onClick={() => navigateLazyPage(navigate, 'Archive', Option.ROUTE_PATH.ARCHIVE)}>Archive</button>;
}

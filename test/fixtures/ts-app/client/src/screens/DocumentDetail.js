import { Link } from 'react-router-dom';
import Option from '../_define/Option';

export default function DocumentDetail() {
  return <Link to={Option.ROUTE_PATH.HOME}>Home</Link>;
}

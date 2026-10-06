import { Link } from 'react-router-dom';
import Option from '../_define/Option';

export default function Archive() {
  return <Link to={Option.ROUTE_PATH.PROFILE}>Profile</Link>;
}

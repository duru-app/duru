import { Link } from 'react-router-dom';
import Option from '../_define/Option';

export default function DocumentList({ ids }) {
  return (
    <ul>
      {ids.map((id) => (
        <li key={id}>
          <Link to={`${Option.ROUTE_PATH.DOCUMENT}/${id}`}>{id}</Link>
        </li>
      ))}
    </ul>
  );
}

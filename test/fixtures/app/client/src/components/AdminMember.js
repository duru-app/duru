import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import Option from '_define/Option';
import { ajaxMemberList } from '_ajax/AjaxFunc';

export default function AdminMember() {
  useEffect(() => {
    ajaxMemberList({ page: 1, showError: false });
  }, []);

  return (
    <section>
      Members
      <Link to={Option.ROUTE_PATH.ADMIN_AUDIT}>Audit log</Link>
    </section>
  );
}
import { formatDate } from './formatDate';

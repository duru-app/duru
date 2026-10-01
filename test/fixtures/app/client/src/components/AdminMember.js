import { useEffect } from 'react';
import { ajaxMemberList } from '_ajax/AjaxFunc';

export default function AdminMember() {
  useEffect(() => {
    ajaxMemberList({ page: 1, showError: false });
  }, []);

  return <section>Members</section>;
}

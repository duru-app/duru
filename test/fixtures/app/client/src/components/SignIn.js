import { useHistory } from 'react-router-dom';
import Option from '_define/Option';
import { ajaxSignIn } from '_ajax/AjaxFunc';

export default function SignIn({ globalSettings }) {
  const history = useHistory();

  const openHelp = () => history.push(Option.ROUTE_PATH.HELP);

  const submit = async (form) => {
    await ajaxSignIn(form);
    history.push(Option.ROUTE_PATH.HOME);
  };

  return (
    <form onSubmit={submit}>
      {globalSettings.SYSTEM.HELP_LINK_ENABLED && (
        <button type="button" onClick={openHelp}>
          Help
        </button>
      )}
    </form>
  );
}
import { formatDate } from './formatDate';

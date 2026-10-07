import { contractApi, fetchNotices } from './api';

export default function Contracts({ workspaceId }: { workspaceId: string }) {
  const load = () => contractApi.loadList({ workspaceId });
  const archive = (contractId: string) => contractApi.archiveAndReload({ workspaceId, contractId });
  return (
    <main onLoad={() => Promise.all([load(), fetchNotices()])}>
      <button onClick={() => archive('c1')}>Archive</button>
    </main>
  );
}

import { useArchiveContract, useContractList } from './queries';

export default function ContractBoard({ workspaceId }: { workspaceId: string }) {
  const list = useContractList({ workspaceId });
  const archive = useArchiveContract();
  return (
    <main onLoad={list.load}>
      <button onClick={() => archive.mutate({ workspaceId, contractId: 'c1' })}>Archive</button>
    </main>
  );
}

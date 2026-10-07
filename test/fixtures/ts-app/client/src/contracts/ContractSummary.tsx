import { useContractDetail, useNotices } from './queries';

export default function ContractSummary({ workspaceId, contractId }: { workspaceId: string; contractId: string }) {
  const detail = useContractDetail({ workspaceId, contractId });
  const notices = useNotices();
  return <main onLoad={() => Promise.all([detail.load(), notices.queryFn()])} />;
}

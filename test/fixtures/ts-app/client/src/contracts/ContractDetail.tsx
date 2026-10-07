import * as api from './api';

export default function ContractDetail({ workspaceId, contractId }: { workspaceId: string; contractId: string }) {
  const detail = () => api.contractApi.loadDetail({ workspaceId, contractId });
  const signer = () => api.contractApi.loadParticipant({ kind: 'signer', workspaceId, contractId });
  const exported = () => api.contractApi.exportContract({ format: 'pdf', workspaceId, contractId });
  return (
    <main onLoad={detail}>
      <button onClick={signer}>Signer</button>
      <button onClick={exported}>Export</button>
    </main>
  );
}

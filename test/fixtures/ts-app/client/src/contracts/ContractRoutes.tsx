import { Route, Routes } from 'react-router-dom';
import Contracts from './Contracts';
import ContractDetail from './ContractDetail';
import ContractBoard from './ContractBoard';
import ContractSummary from './ContractSummary';
import Notes from './Notes';

export default function ContractRoutes() {
  return (
    <Routes>
      <Route path="/contracts" element={<Contracts workspaceId="w1" />} />
      <Route path="/contracts/:contractId" element={<ContractDetail workspaceId="w1" contractId="c1" />} />
      <Route path="/contract-board" element={<ContractBoard workspaceId="w1" />} />
      <Route path="/contract-summary" element={<ContractSummary workspaceId="w1" contractId="c1" />} />
      <Route path="/notes" element={<Notes />} />
    </Routes>
  );
}

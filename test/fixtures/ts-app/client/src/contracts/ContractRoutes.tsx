import { Route, Routes } from 'react-router-dom';
import Contracts from './Contracts';
import ContractDetail from './ContractDetail';

export default function ContractRoutes() {
  return (
    <Routes>
      <Route path="/contracts" element={<Contracts workspaceId="w1" />} />
      <Route path="/contracts/:contractId" element={<ContractDetail workspaceId="w1" contractId="c1" />} />
    </Routes>
  );
}

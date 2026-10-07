import { Route, Routes } from 'react-router-dom';
import Invoices from './Invoices';
import InvoiceDetail from './InvoiceDetail';

export default function InvoiceRoutes() {
  return (
    <Routes>
      <Route path="/invoices" element={<Invoices />} />
      <Route path="/invoices/:invoiceId" element={<InvoiceDetail invoiceId="i1" />} />
    </Routes>
  );
}

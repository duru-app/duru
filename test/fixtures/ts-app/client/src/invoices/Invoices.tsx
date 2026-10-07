import { fetchInvoiceSummary, fetchRates, invoiceApi } from './api';

export default function Invoices() {
  return (
    <main onLoad={() => Promise.all([invoiceApi.list(1), fetchInvoiceSummary(), fetchRates()])}>
      <button onClick={() => invoiceApi.create({ name: 'new' })}>New</button>
    </main>
  );
}

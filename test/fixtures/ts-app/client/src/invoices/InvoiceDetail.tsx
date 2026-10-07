import { invoiceApi } from './api';

export default function InvoiceDetail({ invoiceId }: { invoiceId: string }) {
  return (
    <main onLoad={() => invoiceApi.detail(invoiceId)}>
      <button onClick={() => invoiceApi.rename(invoiceId, 'renamed')}>Rename</button>
      <button onClick={() => invoiceApi.remove(invoiceId)}>Delete</button>
    </main>
  );
}

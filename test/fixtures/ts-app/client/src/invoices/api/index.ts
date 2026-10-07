import axios from 'axios';
import { http } from './http';

export { reportApi } from './reports';

const slowHttp = http.create({ timeout: 30000 });
const auditHttp = http.create({ baseURL: import.meta.env.VITE_AUDIT_API });

export const { get: getFromBilling } = http;

interface Invoice {
  name: string;
}

export const invoiceApi = {
  list: (page: number) => http.get(`/invoices?page=${page}`),
  detail: (invoiceId: string) => http.get<Invoice>(`/invoices/${invoiceId}`),
  create: (invoice: Invoice) => http.post('/invoices', invoice),
  replace: (invoiceId: string, invoice: Invoice) => http.put(`/invoices/${invoiceId}`, invoice),
  rename: (invoiceId: string, name: string) => http.patch(`/invoices/${invoiceId}`, { name }),
  remove: (invoiceId: string) => http.delete(`/invoices/${invoiceId}`),
  send: (invoiceId: string) => http({ method: 'post', url: `/invoices/${invoiceId}/send` }),
  archive: (invoiceId: string) => slowHttp.request(`/invoices/${invoiceId}/archive`, { method: 'post' }),
};

export const fetchAudit = () => auditHttp.get('/internal/v2/audit');

export async function fetchInvoiceSummary() {
  const { data } = await http.get('/invoices/summary');
  return data;
}

export const fetchRates = () => axios.get('/internal/v2/rates');

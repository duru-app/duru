import axios from 'axios';

const reportHttp = axios.create({ baseURL: (import.meta as any).env.VITE_REPORTS_API });

export const reportApi = {
  monthly: () => reportHttp.get('/internal/v2/reports/monthly'),
};

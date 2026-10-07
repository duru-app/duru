import { executeRequest } from './request';
import { ContractApi } from './contract.api';
import { endpointTables } from './endpoints';
import { NoteApi } from './note.api';

export type { Endpoint } from './request';

export const contractApi = new ContractApi(executeRequest, endpointTables, () => {});

export const noteApi = new NoteApi(executeRequest);

export const fetchNotices = () => executeRequest({ endpoint: { method: 'GET', path: '/notice/list' }, url: '/internal/v2/notice/list' });

export const ajaxReportSchedule = () => executeRequest({ endpoint: { method: 'POST', path: '' }, url: '/internal/v2/report/schedule' });

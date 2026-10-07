import axios from 'axios';

export const http = axios.create({ baseURL: '/internal/v2/billing/' });

http.interceptors.request.use((config) => config);

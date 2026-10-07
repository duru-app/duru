import ky from 'ky';

export interface Endpoint {
  method: string;
  path: string;
}

export interface RequestOptions {
  endpoint: Endpoint;
  url: string;
  body?: unknown;
}

export async function executeRequest({ endpoint, url, body }: RequestOptions) {
  return ky(url, { method: endpoint.method, json: body }).json();
}

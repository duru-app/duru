export const contractEndpoints = {
  list: { method: 'GET', path: '/contract/list' },
  detail: { method: 'GET', path: '/contract/{contractId}' },
  archive: { method: 'POST', path: '/contract/{contractId}/archive' },
  export: { method: 'POST', path: '/contract/{contractId}/export' },
  update: { method: 'POST', path: '/contract/{contractId}/update' },
} as const;

export const participantEndpoints = {
  detail: { method: 'GET', path: '/participant/{contractId}' },
} as const;

export const endpointTables = { contract: contractEndpoints, participant: participantEndpoints };

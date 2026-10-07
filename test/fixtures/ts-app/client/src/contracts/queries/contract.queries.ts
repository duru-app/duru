import { contractApi, fetchNotices } from '../api';
import { createMutation } from './createMutation';

type ContractArgs = Parameters<typeof contractApi.loadDetail>[0];

export function useContractList(args: ContractArgs) {
  return { load: () => contractApi.loadList(args) };
}

export function useContractDetail(args: ContractArgs) {
  return { load: () => contractApi.loadDetail(args) };
}

export const useArchiveContract = createMutation((args: ContractArgs) => contractApi.archiveAndReload(args));

export function useNotices() {
  return { queryKey: ['notices'], queryFn: fetchNotices };
}

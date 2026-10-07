export function createMutation<Args>(send: (args: Args) => Promise<unknown>) {
  return () => ({ mutate: (args: Args) => send(args) });
}

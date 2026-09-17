// A URL is a network request, not authority to override deployed RPC/contracts.
export function matchesRequestedNetwork(query, runtimeNetwork) {
  if (runtimeNetwork !== 'mainnet' && runtimeNetwork !== 'testnet') return false;
  if (!Object.hasOwn(query, 'network')) return true;
  return typeof query.network === 'string' && query.network === runtimeNetwork;
}

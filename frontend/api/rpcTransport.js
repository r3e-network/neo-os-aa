import { apiFetch } from './outboundFetch.js';

async function send(rpcUrl, body, label, config) {
  const response = await apiFetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, config?.timeout ? { timeoutMs: config.timeout } : {});
  if (!response.ok) {
    throw new Error(`Encountered HTTP code ${response.status} while executing ${label}`);
  }
  return response.json();
}

// neon-js 5.9 drops caller-supplied redirect options when it builds cross-fetch requests.
// Keep its RPC surface, but route every call through the mandatory no-redirect API transport.
export function createNoRedirectRpcClient({ rpc, rpcUrl }) {
  class NoRedirectRpcClient extends rpc.RPCClient {
    async execute(query, config = {}) {
      const payload = await send(rpcUrl, query.export(), `Query[${query.method}]`, config);
      if (payload.error) throw new rpc.RpcError(payload.error);
      return payload.result;
    }

    async executeAll(batchQuery, config = {}) {
      const queries = Array.isArray(batchQuery) ? batchQuery : batchQuery.queries;
      const label = `Query[${queries.map((query) => query.method).join(',')}]`;
      const responses = await send(rpcUrl, queries.map((query) => query.export()), label, config);
      if (responses.some((response) => response.error)) {
        const errors = {};
        responses.forEach((response, index) => {
          if (response.error) errors[`query[${index}]`] = response.error;
        });
        throw new rpc.RpcError({ code: -1, message: JSON.stringify(errors) });
      }
      return responses.map((response) => response.result);
    }
  }
  return new NoRedirectRpcClient(rpcUrl);
}

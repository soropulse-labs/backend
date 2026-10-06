import type { RawRpcEvent } from './decoder.js';

interface RpcResult<T> { jsonrpc: '2.0'; id: number; result?: T; error?: { code: number; message: string } }
export interface EventsResponse { events: RawRpcEvent[]; cursor?: string; latestLedger: number; oldestLedger: number }
export interface HealthResponse { status: string; latestLedger: number; oldestLedger: number; ledgerRetentionWindow: number }

export class StellarRpc {
  constructor(private readonly url: string, private readonly timeoutMs = 10000) {}

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Stellar RPC HTTP ${response.status}`);
    const json = await response.json() as RpcResult<T>;
    if (json.error) throw new Error(`Stellar RPC ${json.error.code}: ${json.error.message}`);
    if (!json.result) throw new Error(`Stellar RPC ${method} returned no result`);
    return json.result;
  }

  getHealth(): Promise<HealthResponse> { return this.call('getHealth'); }
  getTransaction(hash: string): Promise<Record<string, unknown>> { return this.call('getTransaction', { hash }); }
  getEvents(params: { startLedger?: number; endLedger?: number; cursor?: string; contractId: string; topic0Xdr?: string | null; limit?: number }): Promise<EventsResponse> {
    const { contractId, topic0Xdr, limit = 100, cursor, startLedger, endLedger } = params;
    const filter: Record<string, unknown> = { type: 'contract', contractIds: [contractId] };
    if (topic0Xdr) filter.topics = [[topic0Xdr, '**']];
    return this.call('getEvents', {
      ...(cursor ? {} : { startLedger, endLedger }),
      filters: [filter], pagination: { limit, ...(cursor ? { cursor } : {}) },
    });
  }
}

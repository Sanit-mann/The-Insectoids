import type { HostRequestMethod } from '../brain-host/messages';
import type { Broker } from './broker';

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const isStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const strList = (v: unknown, re?: RegExp): string[] | null =>
  Array.isArray(v) && v.length <= 10 && v.every((x) => typeof x === 'string' && x.length <= 64 && (!re || re.test(x))) ? (v as string[]) : null;

/**
 * The host's requests to main for outside services (Phase 2 A3). Inputs are checked here, because the
 * host is a separate process: a bad message gets a plain refusal, never a token.
 */
export function handleBrokerRequest(broker: Broker, method: HostRequestMethod, params: unknown): unknown {
  const p = (params ?? {}) as Record<string, unknown>;
  // A4 adds two LLM methods. Compared as plain strings so main also understands them before the host's
  // HostRequestMethod type lists them.
  const name: string = method;
  if (name === 'broker.issueLlm') {
    if (!isStr(p['runId']) || typeof p['providerId'] !== 'string' || !ID.test(p['providerId'])) {
      throw new Error('An LLM pass request needs a run and a provider.');
    }
    return broker.issueLlm({ runId: p['runId'], providerId: p['providerId'] });
  }
  if (name === 'broker.llmUsage') {
    if (!isStr(p['pass'])) throw new Error('No pass given.');
    return broker.llmUsage(p['pass']);
  }
  if (method === 'broker.available') return broker.available();
  if (method === 'broker.issue') {
    const integrations = strList(p['integrations'], ID);
    const approvedRules = strList(p['approvedRules'] ?? []);
    if (!isStr(p['cardId']) || !isStr(p['agentId'], 64) || !integrations || !approvedRules) {
      throw new Error('A service token request needs a card, an agent and a list of integrations.');
    }
    return broker.issue({
      cardId: p['cardId'],
      agentId: p['agentId'],
      ...(isStr(p['runId']) ? { runId: p['runId'] } : {}),
      integrations,
      approvedRules,
    });
  }
  if (method === 'broker.revoke') {
    if (!isStr(p['token'])) throw new Error('No token to revoke.');
    broker.revoke(p['token']);
    return { ok: true };
  }
  throw new Error(`Unknown request ${String(method)}`);
}

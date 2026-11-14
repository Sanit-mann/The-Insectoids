import { describe, expect, it } from 'vitest';
import { CadenceInputSchema, CadenceRunOutcomeSchema, CadenceWhenSchema, isScheduled } from './cadence-api';
import { ApprovalKindSchema } from './approvals';
import { WEBHOOK_MESSAGE_MAX_CHARS, WebhookCallSchema, WebhookReplySchema } from './webhook-api';

describe('webhook cadences (Phase 3 A4)', () => {
  it('trusts outside senders for communication only by default (05-D4)', () => {
    expect(CadenceWhenSchema.parse({ type: 'webhook' })).toEqual({ type: 'webhook', trust: 'communication-only' });
    expect(CadenceWhenSchema.parse({ type: 'webhook', trust: 'strict' })).toEqual({ type: 'webhook', trust: 'strict' });
    expect(CadenceWhenSchema.safeParse({ type: 'webhook', trust: 'everything' }).success).toBe(false);
  });

  it('is not a schedule: it waits for a call', () => {
    expect(isScheduled({ type: 'webhook', trust: 'allow-all' })).toBe(false);
    const c = CadenceInputSchema.parse({ name: 'CI failed', when: { type: 'webhook' }, goal: 'Look at the failing build' });
    expect(c.when).toEqual({ type: 'webhook', trust: 'communication-only' });
  });

  it('has outcomes for calls that wait, are noted, refused or declined, and a webhook approval kind', () => {
    for (const o of ['waiting', 'noted', 'refused', 'declined']) expect(CadenceRunOutcomeSchema.parse(o)).toBe(o);
    expect(ApprovalKindSchema.parse('webhook')).toBe('webhook');
  });

  it('carries calls from main to the host, with the body cut to size', () => {
    const call = { cadenceId: 'cad_1', kind: 'run', accepted: true, refusal: null, message: '{"build":"failed"}' };
    expect(WebhookCallSchema.parse(call)).toEqual(call);
    expect(WebhookCallSchema.safeParse({ ...call, message: 'x'.repeat(WEBHOOK_MESSAGE_MAX_CHARS + 51) }).success).toBe(false);
    expect(WebhookCallSchema.safeParse({ ...call, kind: 'delete' }).success).toBe(false);
    expect(WebhookReplySchema.parse({ status: 202, ok: true, message: 'It waits for approval.' }).status).toBe(202);
  });
});

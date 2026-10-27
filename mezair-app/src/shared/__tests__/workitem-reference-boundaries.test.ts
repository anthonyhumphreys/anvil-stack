import { expect, it } from 'vitest';
import { validateJsonSchema } from '../surfaces/validate.js';
import { workItemReferenceSchema } from '../surfaces/kinds/validation.js';
import { validateThreadContinuation } from '../../../cloud/contract/thread-pickup.js';
const id = `https://${'enterprise.'.repeat(15)}example.com/${'a'.repeat(40)}/${'r'.repeat(100)}/issues/12345`;
const ref = { connectionId: 'connection', provider: 'github', id };
it('accepts long canonical enterprise issue URLs in validation without increasing connection limits', () => {
  expect(id.length).toBeGreaterThan(200);
  expect(validateJsonSchema(workItemReferenceSchema, ref)).toEqual([]);
  expect(
    validateJsonSchema(workItemReferenceSchema, { ...ref, connectionId: 'x'.repeat(201) }),
  ).not.toEqual([]);
  expect(validateJsonSchema(workItemReferenceSchema, { ...ref, id: 'x'.repeat(2049) })).not.toEqual(
    [],
  );
});
it('retains long issue URLs in thread pickup and rejects oversized ticket identities', () => {
  const continuation = {
    format: 'mezair-thread-continuation/v1',
    entries: [],
    context: { repoNames: [], ticket: { id, provider: 'github' } },
    items: [],
  };
  expect(validateThreadContinuation(continuation).context.ticket?.id).toBe(id);
  expect(() =>
    validateThreadContinuation({
      ...continuation,
      context: { repoNames: [], ticket: { id: 'x'.repeat(2049), provider: 'github' } },
    }),
  ).toThrow();
});

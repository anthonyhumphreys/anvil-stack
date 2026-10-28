import { isRecord } from '../rpc';
import {
  markSubscriptionDeleted,
  recordInvoiceFailed,
  recordInvoicePaid,
  refreshOrganizationTeamCapacity,
  upsertSubscriptionFromStripe,
} from './billing';
import { ensureOwnerSeatForPaidOrganization } from './organizations';
import {
  parseStripeInvoice,
  parseStripeSubscription,
  stripeRequest,
  type StripeList,
} from './stripe';

export interface StripeReconcileOwner {
  billingAccountId: string;
  organizationId: string | null;
  stripeCustomerId: string;
}

export function organizationReconcileMetaKey(organizationId: string): string {
  return `reconcile_org:${organizationId}`;
}

/** Complete provider snapshots repair missed events; partial lists never revoke mirrors. */
export async function reconcileStripeBillingOwner(
  db: D1Database,
  env: Env,
  owner: StripeReconcileOwner,
  now: number,
): Promise<number> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= 100) throw new Error('Stripe subscription pagination limit exceeded');
    const list = await stripeRequest<StripeList<unknown>>(env, '/v1/subscriptions', {
      method: 'GET',
      params: {
        customer: owner.stripeCustomerId,
        status: 'all',
        limit: 100,
        ...(cursor === undefined ? {} : { starting_after: cursor }),
      },
    });
    if (!Array.isArray(list.data)) throw new Error('Invalid Stripe subscription list');
    for (const item of list.data) {
      const sub = parseStripeSubscription(item);
      if (sub === null || sub.customer !== owner.stripeCustomerId || seen.has(sub.id)) {
        throw new Error('Invalid Stripe subscription snapshot');
      }
      seen.add(sub.id);
      await upsertSubscriptionFromStripe(
        db,
        owner.billingAccountId,
        sub,
        now,
        env,
        owner.organizationId,
      );
      // latest_invoice is the current billing attempt. An old paid invoice
      // must not clear a newer failed renewal merely because it was redelivered.
      const latest = isRecord(item) ? item.latest_invoice : null;
      const invoiceValue =
        typeof latest === 'string'
          ? await stripeRequest<unknown>(env, `/v1/invoices/${encodeURIComponent(latest)}`, {
              method: 'GET',
            })
          : latest;
      if (invoiceValue !== null && invoiceValue !== undefined) {
        const invoice = parseStripeInvoice(invoiceValue);
        if (
          invoice === null ||
          invoice.subscription !== sub.id ||
          invoice.customer !== sub.customer
        ) {
          throw new Error('Invalid Stripe invoice snapshot');
        }
        if (invoice.status === 'paid') {
          await recordInvoicePaid(db, sub.id, now);
        } else if (sub.status === 'past_due' && invoice.billing_reason === 'subscription_cycle') {
          const created = isRecord(invoiceValue) ? invoiceValue.created : null;
          if (
            typeof created === 'number' &&
            Number.isSafeInteger(created) &&
            created > 0 &&
            created * 1000 <= now
          ) {
            await recordInvoiceFailed(db, sub.id, created * 1000);
          }
        }
      }
      cursor = sub.id;
    }
    if (list.has_more !== true) break;
    if (list.data.length === 0) throw new Error('Stripe pagination did not advance');
  }
  const local = await db
    .prepare(
      owner.organizationId === null
        ? 'SELECT stripe_subscription_id FROM stripe_subscriptions WHERE billing_account_id = ? AND organization_id IS NULL'
        : 'SELECT stripe_subscription_id FROM stripe_subscriptions WHERE organization_id = ?',
    )
    .bind(owner.organizationId ?? owner.billingAccountId)
    .all<{ stripe_subscription_id: string }>();
  for (const row of local.results ?? []) {
    if (!seen.has(row.stripe_subscription_id))
      await markSubscriptionDeleted(db, row.stripe_subscription_id, now);
  }
  if (owner.organizationId !== null) {
    await refreshOrganizationTeamCapacity(db, owner.organizationId, now);
    await ensureOwnerSeatForPaidOrganization(db, owner.organizationId, now);
  }
  return seen.size;
}

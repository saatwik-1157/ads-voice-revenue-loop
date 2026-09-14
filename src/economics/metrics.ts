import type { Store } from '../store/db.ts';
import type { Economics } from '../core/types.ts';
import { divide } from '../core/util.ts';

/**
 * Step 07 of the playbook: measure the business outcome, not the click.
 *
 * The chain is spend -> leads -> leads reached -> leads qualified ->
 * appointments -> sales -> revenue. Every stage is counted separately so a
 * failure can be localized instead of guessed at.
 *
 * Every stage counts *leads*, not call rows. One lead can be called more than
 * once - `maxCallAttemptsPerLead` defaults to 2 - and joining leads to calls
 * yields a row per attempt. Counting those rows meant a second attempt doubled
 * the lead count, halving CPL and halving the connect rate at the same time: a
 * losing campaign looked twice as efficient as it was while a healthy funnel
 * looked like a pipeline fault. A lead reached on the second try was reached
 * once.
 */

/**
 * One funnel query, parameterised only by its WHERE clause.
 *
 * The run and per-ad versions used to be separate copies of the same twelve
 * lines - two places for a counting rule to drift apart.
 */
function funnelSql(scope: string): string {
  return `SELECT
       COUNT(DISTINCT l.lead_id) AS leads,
       COUNT(DISTINCT CASE WHEN c.call_id IS NOT NULL THEN l.lead_id END) AS called,
       COUNT(DISTINCT CASE WHEN l.call_status = 'pending' THEN l.lead_id END) AS awaiting,
       COUNT(DISTINCT CASE WHEN c.connected = 1 THEN l.lead_id END) AS connected,
       COUNT(DISTINCT CASE WHEN c.qualified = 1 THEN l.lead_id END) AS qualified,
       COUNT(DISTINCT CASE WHEN c.appointment_booked = 1 THEN l.lead_id END) AS appointments,
       COUNT(DISTINCT CASE WHEN c.sale_status = 'won' THEN l.lead_id END) AS sales
     FROM leads l LEFT JOIN calls c ON c.lead_id = l.lead_id
     WHERE ${scope}`;
}

interface FunnelRow {
  leads: number;
  called: number;
  awaiting: number;
  connected: number;
  qualified: number;
  appointments: number;
  sales: number;
}

export function economicsForRun(store: Store, runId: string): Economics {
  const rows = store.db.prepare(funnelSql('l.run_id = ?')).get(runId) as unknown as FunnelRow;

  const revenue = store.db
    .prepare(
      `SELECT COALESCE(SUM(r.amount_minor), 0) AS revenue
       FROM revenue r JOIN leads l ON l.lead_id = r.lead_id
       WHERE l.run_id = ?`,
    )
    .get(runId) as { revenue: number };

  return compose(store.totalSpendMinor(runId), rows, revenue.revenue);
}

export function economicsForAd(store: Store, runId: string, adId: string): Economics {
  const rows = store.db.prepare(funnelSql('l.run_id = ? AND l.ad_id = ?')).get(runId, adId) as unknown as FunnelRow;

  const revenue = store.db
    .prepare(
      `SELECT COALESCE(SUM(r.amount_minor), 0) AS revenue
       FROM revenue r JOIN leads l ON l.lead_id = r.lead_id
       WHERE l.run_id = ? AND l.ad_id = ?`,
    )
    .get(runId, adId) as { revenue: number };

  const spendRow = store.spendByAd(runId).find((s) => s.adId === adId);
  return compose(spendRow?.spendMinor ?? 0, rows, revenue.revenue);
}

function compose(spendMinor: number, rows: FunnelRow, revenueMinor: number): Economics {
  return {
    spendMinor,
    leads: rows.leads,
    calledLeads: rows.called,
    leadsAwaitingCall: rows.awaiting,
    connectedLeads: rows.connected,
    qualifiedLeads: rows.qualified,
    appointments: rows.appointments,
    sales: rows.sales,
    revenueMinor,
    cplMinor: rows.leads > 0 ? Math.round(spendMinor / rows.leads) : null,
    costPerConnectedMinor: rows.connected > 0 ? Math.round(spendMinor / rows.connected) : null,
    costPerQualifiedMinor: rows.qualified > 0 ? Math.round(spendMinor / rows.qualified) : null,
    cacMinor: rows.sales > 0 ? Math.round(spendMinor / rows.sales) : null,
    roas: divide(revenueMinor, spendMinor),
    connectRate: divide(rows.connected, rows.leads),
    qualifyRate: divide(rows.qualified, rows.connected),
  };
}

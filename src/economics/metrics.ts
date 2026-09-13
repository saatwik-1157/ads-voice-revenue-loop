import type { Store } from '../store/db.ts';
import type { Economics } from '../core/types.ts';
import { divide } from '../core/util.ts';

/**
 * Step 07 of the playbook: measure the business outcome, not the click.
 *
 * The chain is spend -> leads -> connected calls -> qualified leads ->
 * appointments -> sales -> revenue. Every stage is counted separately so a
 * failure can be localized instead of guessed at.
 */
export function economicsForRun(store: Store, runId: string): Economics {
  const rows = store.db
    .prepare(
      `SELECT
         COUNT(*) AS leads,
         COALESCE(SUM(CASE WHEN c.connected = 1 THEN 1 ELSE 0 END), 0) AS connected,
         COALESCE(SUM(CASE WHEN c.qualified = 1 THEN 1 ELSE 0 END), 0) AS qualified,
         COALESCE(SUM(CASE WHEN c.appointment_booked = 1 THEN 1 ELSE 0 END), 0) AS appointments,
         COALESCE(SUM(CASE WHEN c.sale_status = 'won' THEN 1 ELSE 0 END), 0) AS sales
       FROM leads l LEFT JOIN calls c ON c.lead_id = l.lead_id
       WHERE l.run_id = ?`,
    )
    .get(runId) as { leads: number; connected: number; qualified: number; appointments: number; sales: number };

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
  const rows = store.db
    .prepare(
      `SELECT
         COUNT(*) AS leads,
         COALESCE(SUM(CASE WHEN c.connected = 1 THEN 1 ELSE 0 END), 0) AS connected,
         COALESCE(SUM(CASE WHEN c.qualified = 1 THEN 1 ELSE 0 END), 0) AS qualified,
         COALESCE(SUM(CASE WHEN c.appointment_booked = 1 THEN 1 ELSE 0 END), 0) AS appointments,
         COALESCE(SUM(CASE WHEN c.sale_status = 'won' THEN 1 ELSE 0 END), 0) AS sales
       FROM leads l LEFT JOIN calls c ON c.lead_id = l.lead_id
       WHERE l.run_id = ? AND l.ad_id = ?`,
    )
    .get(runId, adId) as { leads: number; connected: number; qualified: number; appointments: number; sales: number };

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

function compose(
  spendMinor: number,
  rows: { leads: number; connected: number; qualified: number; appointments: number; sales: number },
  revenueMinor: number,
): Economics {
  return {
    spendMinor,
    leads: rows.leads,
    connectedCalls: rows.connected,
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

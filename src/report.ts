import type { Brief, Economics, Recommendation } from './core/types.ts';
import type { Guardrails } from './config/guardrails.ts';
import { money, pct } from './core/util.ts';

export function formatBrief(brief: Brief, g: Guardrails): string {
  const lines: string[] = [];
  lines.push(`BRIEF ${brief.briefId}  (written by: ${brief.source})`);
  lines.push('');
  lines.push(`  Niche      ${brief.niche.name}  [score ${brief.niche.score}]`);
  lines.push(`  ICP        ${brief.offer.icp}`);
  lines.push(`  Problem    ${brief.offer.problem}`);
  lines.push(`  Outcome    ${brief.offer.outcome}`);
  lines.push(`  Mechanism  ${brief.offer.mechanism}`);
  lines.push(`  Proof      ${brief.offer.proof}`);
  lines.push(`  CTA        ${brief.offer.cta}`);
  lines.push(`  Promise    ${brief.offer.deliverable}`);
  lines.push('');
  lines.push(`  Targets    CPL <= ${money(brief.successMetrics.targetCplMinor, g.currency)}`);
  lines.push(`             connect >= ${pct(brief.successMetrics.targetConnectRate)}, qualify >= ${pct(brief.successMetrics.targetQualifiedRate)}`);
  lines.push(`             CAC <= ${money(brief.successMetrics.targetCacMinor, g.currency)}, ROAS >= ${brief.successMetrics.targetRoas}`);
  lines.push('');
  lines.push(`  Creative   ${brief.creatives.length} variants`);
  for (const c of brief.creatives) {
    lines.push(`   - [${c.creativeId}] ${c.angle} / "${c.hook}"`);
  }
  return lines.join('\n');
}

export function formatEconomics(e: Economics, g: Guardrails): string {
  return [
    `  spend            ${money(e.spendMinor, g.currency)}`,
    `  leads            ${e.leads}`,
    `  connected calls  ${e.connectedCalls}   (${pct(e.connectRate)})`,
    `  qualified leads  ${e.qualifiedLeads}   (${pct(e.qualifyRate)} of connected)`,
    `  appointments     ${e.appointments}`,
    `  sales            ${e.sales}`,
    `  revenue          ${money(e.revenueMinor, g.currency)}`,
    `  CPL              ${e.cplMinor === null ? 'n/a' : money(e.cplMinor, g.currency)}`,
    `  cost/connected   ${e.costPerConnectedMinor === null ? 'n/a' : money(e.costPerConnectedMinor, g.currency)}`,
    `  cost/qualified   ${e.costPerQualifiedMinor === null ? 'n/a' : money(e.costPerQualifiedMinor, g.currency)}`,
    `  CAC              ${e.cacMinor === null ? 'n/a' : money(e.cacMinor, g.currency)}`,
    `  ROAS             ${e.roas === null ? 'n/a' : e.roas.toFixed(2)}`,
  ].join('\n');
}

export function formatRecommendation(rec: Recommendation, g: Guardrails): string {
  const lines: string[] = [];
  lines.push(`DECISION: ${rec.decision}   [signal: ${rec.signal}]`);
  lines.push(`  why     ${rec.rationale}`);
  lines.push(`  action  ${rec.action}`);
  if (rec.requiresHumanApproval) lines.push('  >> requires human approval before anything changes');
  lines.push('');
  lines.push('RUN ECONOMICS');
  lines.push(formatEconomics(rec.economics, g));
  if (rec.perAd.length) {
    lines.push('');
    lines.push('PER CREATIVE');
    for (const ad of rec.perAd) {
      lines.push(`  ${ad.decision.padEnd(7)} ${ad.adId}`);
      lines.push(`          ${ad.rationale}`);
    }
  }
  return lines.join('\n');
}

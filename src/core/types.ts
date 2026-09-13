/**
 * Domain model for the Ads -> Voice -> Revenue closed loop.
 *
 * Every record that crosses a system boundary (Meta, the voice agent, the
 * revenue source) keeps the ad identifiers with it, because the whole point of
 * the loop is being able to attribute a call outcome back to the exact creative
 * that produced it.
 */

export type Decision = 'KEEP' | 'KILL' | 'ITERATE' | 'SCALE';

export type RunState =
  | 'drafted' // brief produced, nothing published
  | 'awaiting_gate1' // waiting on human approval of niche/claims/offer/budget
  | 'approved' // gate 1 passed, safe to publish
  | 'live' // campaign published to Meta
  | 'paused'
  | 'killed';

export interface NicheCandidate {
  name: string;
  /** 1-5 on each axis; see brief/niche.ts for what each axis means. */
  urgency: number;
  ticketSize: number;
  phoneCloseable: number;
  reachability: number;
  offerSimplicity: number;
  notes: string;
}

export interface ScoredNiche extends NicheCandidate {
  score: number;
  breakdown: Record<string, number>;
}

export interface Offer {
  niche: string;
  icp: string;
  problem: string;
  outcome: string;
  mechanism: string;
  proof: string;
  cta: string;
  /** What the voice agent is actually allowed to say it will do. */
  deliverable: string;
  pricePointMinor: number;
  currency: string;
}

export interface CreativeVariant {
  creativeId: string;
  angle: string;
  hook: string;
  primaryText: string;
  headline: string;
  description: string;
  format: 'reel' | 'image' | 'video';
  /** Meta image hash, set once the artwork is uploaded. */
  assetRef: string | null;
  /** How the artwork was obtained. Surfaced at gate #1 before anyone approves spend. */
  assetProvenance: 'rendered' | 'library' | 'manual' | null;
}

export interface Brief {
  briefId: string;
  createdAt: string;
  niche: ScoredNiche;
  offer: Offer;
  creatives: CreativeVariant[];
  leadFormCopy: string;
  callScript: CallScript;
  successMetrics: SuccessMetrics;
  source: 'llm' | 'deterministic';
}

export interface CallScript {
  opener: string;
  qualifyingQuestions: string[];
  approvedAnswers: Record<string, string>;
  objectionHandling: Record<string, string>;
  conversionAsk: string;
  optOutLine: string;
}

export interface SuccessMetrics {
  targetCplMinor: number;
  targetConnectRate: number;
  targetQualifiedRate: number;
  targetCacMinor: number;
  targetRoas: number;
}

export interface CampaignRecord {
  campaignId: string;
  adsetId: string;
  runId: string;
  briefId: string;
  objective: string;
  dailyBudgetMinor: number;
  currency: string;
  status: 'PAUSED' | 'ACTIVE';
  geo: string[];
  createdAt: string;
  provider: 'meta' | 'mock';
}

export interface AdRecord {
  adId: string;
  campaignId: string;
  adsetId: string;
  creativeId: string;
  status: 'PAUSED' | 'ACTIVE';
  createdAt: string;
}

export interface Lead {
  leadId: string;
  runId: string;
  name: string;
  phoneE164: string;
  email: string | null;
  consent: boolean;
  consentSource: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  creativeId: string | null;
  createdAt: string;
  callStatus: 'pending' | 'dispatched' | 'completed' | 'suppressed' | 'failed';
}

export interface CallOutcome {
  callId: string;
  leadId: string;
  connected: boolean;
  qualified: boolean;
  intentScore: number; // 0-100
  objection: string | null;
  appointmentBooked: boolean;
  saleStatus: 'none' | 'pending' | 'won' | 'lost';
  expectedValueMinor: number;
  nextAction: string;
  summary: string;
  optOut: boolean;
  receivedAt: string;
}

export interface SpendPoint {
  runId: string;
  adId: string | null;
  spendMinor: number;
  impressions: number;
  clicks: number;
  leads: number;
  asOf: string;
}

export interface Economics {
  spendMinor: number;
  leads: number;
  connectedCalls: number;
  qualifiedLeads: number;
  appointments: number;
  sales: number;
  revenueMinor: number;
  cplMinor: number | null;
  costPerConnectedMinor: number | null;
  costPerQualifiedMinor: number | null;
  cacMinor: number | null;
  roas: number | null;
  connectRate: number | null;
  qualifyRate: number | null;
}

export interface Recommendation {
  decision: Decision;
  signal: string;
  rationale: string;
  action: string;
  requiresHumanApproval: boolean;
  economics: Economics;
  perAd: Array<{ adId: string; decision: Decision; rationale: string; economics: Economics }>;
}

export interface AuditEvent {
  eventId: string;
  runId: string | null;
  at: string;
  actor: 'agent' | 'human' | 'meta' | 'voice' | 'system';
  kind: string;
  detail: string;
}

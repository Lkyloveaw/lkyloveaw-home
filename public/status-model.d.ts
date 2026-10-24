export interface StatusItem {
  lastStatus: string | null
  lastCheckedAt: number | null
  staleAfterMs: number
  uptime?: number | null
  avgLatencyMs?: number | null
}
export interface StatusTotals {
  total: number; up: number; faults: number; stale: number; unknown: number
  avgUptime: number | null; avgLatencyMs: number | null; freshnessText: string
}
export interface IncidentClock { outcome: 'ongoing' | 'recovered' | 'unknown'; lastSeenAt: number }
export interface IncidentDetail { durationMs: number; lastSeenAt: number; endedAt: number | null }
export function stateClass(status: string | null | undefined): string
export function stateText(status: string | null | undefined): string
export function visibleState(item: StatusItem, now: number): string
export function summarizeStatus(items: ReadonlyArray<StatusItem>, now: number): StatusTotals
export function observedDuration(ms: number): string
export function formatTime(ts: number | null | undefined): string
export function formatUptime(uptime: number | null | undefined): string
export function incidentOutcome(event: IncidentClock, staleAfterMs: number | undefined, now: number): IncidentClock['outcome']
export function incidentOutcomeText(outcome: IncidentClock['outcome']): string
export function incidentDetails(event: IncidentDetail): string

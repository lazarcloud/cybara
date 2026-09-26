export function datedTurnContent(content: string, timestamp?: string): string {
  if (!timestamp) return content;
  const receivedAt = new Date(timestamp);
  if (!Number.isFinite(receivedAt.getTime())) return content;
  return `${content}\n\n<runtime-turn-context>\nTurn received at: ${receivedAt.toISOString()} (UTC). This timestamp belongs to this turn, not to subsequent turns.\n</runtime-turn-context>`;
}

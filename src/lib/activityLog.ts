import { sanitize } from './sanitizePayload'
import { dbInsert } from './dbWrite'

/** Fire-and-forget insert to activity_log */
export function logActivity(
  userId: string | null | undefined,
  action: string,
  entityType?: string,
  entityId?: string,
  details?: Record<string, unknown>,
) {
  if (!userId) return
  dbInsert('activity_log', sanitize('activity_log', {
    user_id: userId,
    action,
    entity_type: entityType ?? null,
    entity_id: entityId ?? null,
    details: details ?? null,
  })).catch(() => {})
}

import type { AppUserRole } from '../types/database'

export type Permission =
  | 'manage_users'
  | 'delete_any'
  | 'edit_recipes'
  | 'view_costs'
  | 'view_reports'
  | 'create_po'
  | 'create_shipment'
  | 'create_prod_order'
  | 'edit_po'
  | 'edit_shipment'
  | 'reconcile'
  | 'update_status'
  | 'import_data'

const matrix: Record<Permission, AppUserRole[]> = {
  manage_users:      ['owner'],
  delete_any:        ['owner', 'admin'],
  edit_recipes:      ['owner', 'admin'],
  view_costs:        ['owner', 'admin', 'manager'],
  view_reports:      ['owner', 'admin', 'manager'],
  create_po:         ['owner', 'admin', 'manager', 'viewer'],
  create_shipment:   ['owner', 'admin', 'manager', 'viewer'],
  create_prod_order: ['owner', 'admin', 'manager'],
  edit_po:           ['owner', 'admin', 'manager'],
  edit_shipment:     ['owner', 'admin', 'manager'],
  reconcile:         ['owner', 'admin', 'manager'],
  update_status:     ['owner', 'admin', 'manager', 'viewer'],
  import_data:       ['owner', 'admin'],
}

export function can(role: AppUserRole | null | undefined, permission: Permission): boolean {
  if (!role) return false
  return matrix[permission].includes(role)
}

// Roles and what they may do. Keep permissions coarse; add new ones as features land.

export const PERMISSIONS = {
  DEVICES_READ: 'devices:read',
  DEVICES_CONTROL: 'devices:control',
  CONFIG_WRITE: 'config:write', // pages, actions, AI configuration
  USERS_MANAGE: 'users:manage',
};

export const ROLES = {
  admin: {
    label: 'Admin',
    description: 'Everything, including users and configuration',
    permissions: Object.values(PERMISSIONS),
  },
  member: {
    label: 'Member',
    description: 'See and control devices',
    permissions: [PERMISSIONS.DEVICES_READ, PERMISSIONS.DEVICES_CONTROL],
  },
  guest: {
    label: 'Guest',
    description: 'See devices only',
    permissions: [PERMISSIONS.DEVICES_READ],
  },
};

export function isRole(role) {
  return Object.hasOwn(ROLES, role);
}

export function can(user, permission) {
  return Boolean(user && ROLES[user.role]?.permissions.includes(permission));
}

export function permissionsFor(role) {
  return ROLES[role]?.permissions ?? [];
}

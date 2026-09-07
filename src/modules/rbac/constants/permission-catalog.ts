/**
 * Backend-owned permission catalog. Permission identifiers are intentionally
 * fixed: roles may compose these values, but callers cannot create new ones.
 */
export type PermissionCode =
  | 'users.view'
  | 'users.create'
  | 'users.edit'
  | 'users.status'
  | 'users.delete'
  | 'users.security'
  | 'users.force_logout'
  | 'user_groups.view'
  | 'user_groups.create'
  | 'user_groups.edit'
  | 'user_groups.delete'
  | 'user_groups.membership'
  | 'devices.view'
  | 'devices.edit'
  | 'devices.status'
  | 'devices.delete'
  | 'devices.disconnect'
  | 'address_books.view'
  | 'address_books.edit'
  | 'address_books.share'
  | 'strategies.view'
  | 'strategies.create'
  | 'strategies.edit'
  | 'strategies.delete'
  | 'strategies.assign'
  | 'audit.view'
  | 'roles.view'
  | 'roles.assign';

export interface PermissionDefinition {
  code: PermissionCode;
  resource: string;
  action: string;
  name: string;
  description: string;
  scope: 'global' | 'device_group';
  requires?: PermissionCode[];
}

const definition = (
  code: PermissionCode,
  resource: string,
  action: string,
  name: string,
  scope: PermissionDefinition['scope'] = 'global',
  requires: PermissionCode[] = [],
): PermissionDefinition => ({
  code,
  resource,
  action,
  name,
  description: `${name} (${code})`,
  scope,
  ...(requires.length ? { requires } : {}),
});

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  definition('users.view', 'users', 'view', 'View users'),
  definition('users.create', 'users', 'create', 'Create users', 'global', [
    'users.view',
  ]),
  definition('users.edit', 'users', 'edit', 'Edit users', 'global', [
    'users.view',
  ]),
  definition(
    'users.status',
    'users',
    'status',
    'Change user status',
    'global',
    ['users.view'],
  ),
  definition('users.delete', 'users', 'delete', 'Delete users', 'global', [
    'users.view',
  ]),
  definition(
    'users.security',
    'users',
    'security',
    'Manage user security',
    'global',
    ['users.view'],
  ),
  definition(
    'users.force_logout',
    'users',
    'force_logout',
    'Force user logout',
    'global',
    ['users.view'],
  ),
  definition('user_groups.view', 'user_groups', 'view', 'View user groups'),
  definition(
    'user_groups.create',
    'user_groups',
    'create',
    'Create user groups',
    'global',
    ['user_groups.view'],
  ),
  definition(
    'user_groups.edit',
    'user_groups',
    'edit',
    'Edit user groups',
    'global',
    ['user_groups.view'],
  ),
  definition(
    'user_groups.delete',
    'user_groups',
    'delete',
    'Delete user groups',
    'global',
    ['user_groups.view'],
  ),
  definition(
    'user_groups.membership',
    'user_groups',
    'membership',
    'Manage user group membership',
    'global',
    ['user_groups.view'],
  ),
  definition('devices.view', 'devices', 'view', 'View devices', 'device_group'),
  definition(
    'devices.edit',
    'devices',
    'edit',
    'Edit device metadata',
    'device_group',
    ['devices.view'],
  ),
  definition(
    'devices.status',
    'devices',
    'status',
    'Change device status',
    'device_group',
    ['devices.view'],
  ),
  definition(
    'devices.delete',
    'devices',
    'delete',
    'Delete devices',
    'device_group',
    ['devices.view'],
  ),
  definition(
    'devices.disconnect',
    'devices',
    'disconnect',
    'Disconnect devices',
    'device_group',
    ['devices.view'],
  ),
  definition(
    'address_books.view',
    'address_books',
    'view',
    'View address books',
  ),
  definition(
    'address_books.edit',
    'address_books',
    'edit',
    'Edit address books',
    'global',
    ['address_books.view'],
  ),
  definition(
    'address_books.share',
    'address_books',
    'share',
    'Share address books',
    'global',
    ['address_books.view'],
  ),
  definition('strategies.view', 'strategies', 'view', 'View strategies'),
  definition(
    'strategies.create',
    'strategies',
    'create',
    'Create strategies',
    'global',
    ['strategies.view'],
  ),
  definition(
    'strategies.edit',
    'strategies',
    'edit',
    'Edit strategies',
    'global',
    ['strategies.view'],
  ),
  definition(
    'strategies.delete',
    'strategies',
    'delete',
    'Delete strategies',
    'global',
    ['strategies.view'],
  ),
  definition(
    'strategies.assign',
    'strategies',
    'assign',
    'Assign strategies',
    'device_group',
  ),
  definition('audit.view', 'audit', 'view', 'View audit data'),
  definition('roles.view', 'roles', 'view', 'View roles'),
  definition('roles.assign', 'roles', 'assign', 'Assign roles', 'global', [
    'roles.view',
    'users.view',
  ]),
];

export const PERMISSION_CODES = PERMISSION_CATALOG.map((item) => item.code);

export const isDeviceGroupScopedPermission = (
  code: string,
): code is PermissionCode =>
  PERMISSION_CATALOG.some(
    (permission) =>
      permission.code === code && permission.scope === 'device_group',
  );

export const isKnownPermissionCode = (code: string): code is PermissionCode =>
  PERMISSION_CODES.includes(code as PermissionCode);

const PERMISSION_REQUIREMENTS = new Map(
  PERMISSION_CATALOG.map((permission) => [
    permission.code,
    permission.requires || [],
  ]),
);

export const getPermissionRequirements = (
  code: PermissionCode,
): readonly PermissionCode[] => PERMISSION_REQUIREMENTS.get(code) || [];

export const filterEffectivePermissionCodes = (
  codes: readonly string[],
): PermissionCode[] => {
  const known = new Set(codes.filter(isKnownPermissionCode));
  return [...known]
    .filter((code) =>
      getPermissionRequirements(code).every((required) => known.has(required)),
    )
    .sort();
};

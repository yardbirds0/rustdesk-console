import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Peer } from '../../../common/entities/peer.entity';
import { User, UserStatus } from '../../user/entities/user.entity';
import { DeviceGroup } from '../../device-group/entities/device-group.entity';
import { RolePermission } from '../entities/role-permission.entity';
import { UserRoleAssignment } from '../entities/user-role-assignment.entity';
import { UserRoleAssignmentDeviceGroup } from '../entities/user-role-assignment-device-group.entity';
import {
  filterEffectivePermissionCodes,
  isDeviceGroupScopedPermission,
  isKnownPermissionCode,
  PERMISSION_CATALOG,
  PermissionCode,
} from '../constants/permission-catalog';
import { RbacAuditService } from './rbac-audit.service';

export interface EffectivePermissionScope {
  scope_type: 'global' | 'device_group';
  device_group_guids: string[];
}

export interface PermissionScope {
  global: boolean;
  deviceGroupGuids: Set<string>;
}

@Injectable()
export class RbacAuthorizationService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RolePermission)
    private readonly rolePermissionRepository: Repository<RolePermission>,
    @InjectRepository(UserRoleAssignment)
    private readonly assignmentRepository: Repository<UserRoleAssignment>,
    @InjectRepository(UserRoleAssignmentDeviceGroup)
    private readonly assignmentGroupRepository: Repository<UserRoleAssignmentDeviceGroup>,
    @InjectRepository(Peer)
    private readonly peerRepository: Repository<Peer>,
    @InjectRepository(DeviceGroup)
    private readonly deviceGroupRepository: Repository<DeviceGroup>,
    private readonly auditService: RbacAuditService,
  ) {}

  async getCurrentUser(userGuid: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { guid: userGuid },
    });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('账户不存在或已被禁用');
    }
    return user;
  }

  async requireSuperAdmin(userGuid: string): Promise<User> {
    const user = await this.getCurrentUser(userGuid);
    if (!user.isAdmin) {
      throw new ForbiddenException('需要超级管理员权限');
    }
    return user;
  }

  async getPermissionScope(
    userGuid: string,
    permissionCode: string,
  ): Promise<PermissionScope> {
    const user = await this.getCurrentUser(userGuid);
    if (user.isAdmin || !isKnownPermissionCode(permissionCode)) {
      return {
        global: user.isAdmin === true,
        deviceGroupGuids: new Set<string>(),
      };
    }

    const { assignments, effectivePermissionsByRole } =
      await this.loadEffectiveRoleGrants(userGuid);
    const matchingAssignments = assignments.filter(
      (assignment) =>
        effectivePermissionsByRole
          .get(assignment.roleGuid)
          ?.has(permissionCode) &&
        (assignment.scopeType === 'global' ||
          isDeviceGroupScopedPermission(permissionCode)),
    );

    const global = matchingAssignments.some(
      (assignment) => assignment.scopeType === 'global',
    );
    if (global) {
      return { global: true, deviceGroupGuids: new Set<string>() };
    }

    const scopedAssignments = matchingAssignments.filter(
      (assignment) => assignment.scopeType === 'device_group',
    );
    if (!scopedAssignments.length) {
      return { global: false, deviceGroupGuids: new Set<string>() };
    }

    const groups = await this.assignmentGroupRepository.find({
      where: {
        assignmentGuid: In(
          scopedAssignments.map((assignment) => assignment.guid),
        ),
      },
      select: ['deviceGroupGuid'],
    });

    return {
      global: false,
      deviceGroupGuids: new Set(groups.map((group) => group.deviceGroupGuid)),
    };
  }

  async requirePermission(
    userGuid: string,
    permissionCode: string,
  ): Promise<PermissionScope> {
    if (!isKnownPermissionCode(permissionCode)) {
      throw new ForbiddenException('未知权限');
    }
    const scope = await this.getPermissionScope(userGuid, permissionCode);
    if (!scope.global && scope.deviceGroupGuids.size === 0) {
      throw new ForbiddenException('无权限访问');
    }
    return scope;
  }

  async getEffectivePermissions(userGuid: string): Promise<{
    permissions: string[];
    scopes: Record<string, EffectivePermissionScope>;
  }> {
    const user = await this.getCurrentUser(userGuid);
    if (user.isAdmin) {
      const scopes = Object.fromEntries(
        PERMISSION_CATALOG.map((permission) => [
          permission.code,
          { scope_type: 'global', device_group_guids: [] },
        ]),
      ) as Record<string, EffectivePermissionScope>;
      return {
        permissions: PERMISSION_CATALOG.map((permission) => permission.code),
        scopes,
      };
    }

    const { assignments, effectivePermissionsByRole } =
      await this.loadEffectiveRoleGrants(userGuid);
    const scopeRows = new Map<
      PermissionCode,
      { global: boolean; ids: Set<string> }
    >();
    const scopedPermissionsByAssignment = new Map<string, PermissionCode[]>();
    for (const assignment of assignments) {
      for (const permissionCode of effectivePermissionsByRole.get(
        assignment.roleGuid,
      ) || []) {
        if (
          assignment.scopeType === 'device_group' &&
          !isDeviceGroupScopedPermission(permissionCode)
        ) {
          continue;
        }
        const current = scopeRows.get(permissionCode) || {
          global: false,
          ids: new Set<string>(),
        };
        if (assignment.scopeType === 'global') {
          current.global = true;
        } else {
          const scopedPermissions =
            scopedPermissionsByAssignment.get(assignment.guid) || [];
          scopedPermissions.push(permissionCode);
          scopedPermissionsByAssignment.set(assignment.guid, scopedPermissions);
        }
        scopeRows.set(permissionCode, current);
      }
    }
    if (scopedPermissionsByAssignment.size) {
      const groups = await this.assignmentGroupRepository.find({
        where: {
          assignmentGuid: In([...scopedPermissionsByAssignment.keys()]),
        },
        select: ['assignmentGuid', 'deviceGroupGuid'],
      });
      for (const group of groups) {
        for (const permission of scopedPermissionsByAssignment.get(
          group.assignmentGuid,
        ) || []) {
          scopeRows.get(permission)?.ids.add(group.deviceGroupGuid);
        }
      }
    }
    const scopes: Record<string, EffectivePermissionScope> = {};
    for (const [permission, scope] of scopeRows) {
      if (!scope.global && scope.ids.size === 0) continue;
      scopes[permission] = scope.global
        ? { scope_type: 'global', device_group_guids: [] }
        : {
            scope_type: 'device_group',
            device_group_guids: [...scope.ids].sort(),
          };
    }
    return { permissions: Object.keys(scopes).sort(), scopes };
  }

  private async loadEffectiveRoleGrants(userGuid: string): Promise<{
    assignments: UserRoleAssignment[];
    effectivePermissionsByRole: Map<string, Set<PermissionCode>>;
  }> {
    const assignments = (
      await this.assignmentRepository.find({
        where: { userGuid },
        select: ['guid', 'roleGuid', 'scopeType'],
      })
    ).filter(
      (assignment) =>
        assignment.scopeType === 'global' ||
        assignment.scopeType === 'device_group',
    );
    const rows = assignments.length
      ? await this.rolePermissionRepository.find({
          where: {
            roleGuid: In(assignments.map((assignment) => assignment.roleGuid)),
          },
        })
      : [];
    const permissionCodesByRole = new Map<string, string[]>();
    for (const row of rows) {
      const codes = permissionCodesByRole.get(row.roleGuid) || [];
      codes.push(row.permissionCode);
      permissionCodesByRole.set(row.roleGuid, codes);
    }
    return {
      assignments,
      effectivePermissionsByRole: new Map(
        [...permissionCodesByRole].map(([roleGuid, codes]) => [
          roleGuid,
          new Set(filterEffectivePermissionCodes(codes)),
        ]),
      ),
    };
  }

  async assertDeviceAccess(
    userGuid: string,
    permissionCode: PermissionCode,
    deviceUuid: string,
  ): Promise<{ peer: Peer; scope: PermissionScope }> {
    const scope = await this.requirePermission(userGuid, permissionCode);
    const peer = await this.peerRepository.findOne({
      where: { uuid: deviceUuid },
    });
    if (!peer) throw new NotFoundException('设备不存在');
    if (
      !scope.global &&
      (!peer.deviceGroupGuid ||
        !scope.deviceGroupGuids.has(peer.deviceGroupGuid))
    ) {
      return this.rejectWithAudit(
        userGuid,
        'device',
        deviceUuid,
        permissionCode,
        new ForbiddenException('设备不在授权设备组内'),
      );
    }
    return { peer, scope };
  }

  async assertDevicesAccess(
    userGuid: string,
    permissionCode: PermissionCode,
    deviceUuids: string[],
  ): Promise<{ peers: Peer[]; scope: PermissionScope }> {
    const scope = await this.requirePermission(userGuid, permissionCode);
    const unique = [...new Set(deviceUuids)];
    if (!unique.length) return { peers: [], scope };
    const peers = await this.peerRepository.find({
      where: { uuid: In(unique) },
    });
    if (!scope.global) {
      const denied = peers.find(
        (peer) =>
          !peer.deviceGroupGuid ||
          !scope.deviceGroupGuids.has(peer.deviceGroupGuid),
      );
      if (denied) {
        return this.rejectWithAudit(
          userGuid,
          'device',
          denied.uuid,
          permissionCode,
          new ForbiddenException('批量请求包含未授权设备'),
        );
      }
    }
    return { peers, scope };
  }

  async assertStrategyTargets(
    userGuid: string,
    targetType: 'device' | 'user' | 'device_group',
    targetGuids: string[],
  ): Promise<PermissionScope> {
    const scope = await this.requirePermission(userGuid, 'strategies.assign');
    if (targetType === 'user') {
      if (!scope.global) {
        return this.rejectWithAudit(
          userGuid,
          'user',
          targetGuids[0] || null,
          'strategies.assign',
          new ForbiddenException('按用户分配策略需要全局权限'),
        );
      }
      const users = await this.userRepository.find({
        where: { guid: In([...new Set(targetGuids)]) },
        select: ['guid', 'isAdmin'],
      });
      const protectedUser = users.find((user) => user.isAdmin);
      if (protectedUser) {
        try {
          await this.requireSuperAdmin(userGuid);
        } catch (error: unknown) {
          return this.rejectWithAudit(
            userGuid,
            'user',
            protectedUser.guid,
            'super_admin',
            error,
          );
        }
      }
      return scope;
    }
    if (scope.global) return scope;
    if (targetType === 'device_group') {
      const requested = [...new Set(targetGuids)];
      const groups = await this.deviceGroupRepository.find({
        where: { guid: In(requested) },
        select: ['guid'],
      });
      const selected = new Set(scope.deviceGroupGuids);
      const deniedGuid = groups.find(
        (group) => !selected.has(group.guid),
      )?.guid;
      if (deniedGuid) {
        return this.rejectWithAudit(
          userGuid,
          'device_group',
          deniedGuid,
          'strategies.assign',
          new ForbiddenException('目标设备组不在授权范围内'),
        );
      }
      return scope;
    }
    const peers = await this.peerRepository.find({
      where: { uuid: In([...new Set(targetGuids)]) },
      select: ['uuid', 'deviceGroupGuid'],
    });
    const denied = peers.find(
      (peer) =>
        !peer.deviceGroupGuid ||
        !scope.deviceGroupGuids.has(peer.deviceGroupGuid),
    );
    if (denied) {
      return this.rejectWithAudit(
        userGuid,
        'device',
        denied.uuid,
        'strategies.assign',
        new ForbiddenException('目标设备不在授权设备组内'),
      );
    }
    return scope;
  }

  async assertUserMutation(
    actorGuid: string,
    targetGuid: string,
    permissionCode: PermissionCode,
    changes?: {
      is_admin?: boolean;
    },
  ): Promise<void> {
    await this.requirePermission(actorGuid, permissionCode);

    const target = await this.userRepository.findOne({
      where: { guid: targetGuid },
      select: ['guid', 'isAdmin'],
    });
    if (!target) throw new NotFoundException('用户不存在');
    if (target.isAdmin || changes?.is_admin !== undefined) {
      try {
        await this.requireSuperAdmin(actorGuid);
      } catch (error: unknown) {
        return this.rejectWithAudit(
          actorGuid,
          'user',
          targetGuid,
          'super_admin',
          error,
        );
      }
    }
  }

  /**
   * Pre-authorize a user batch before the owning service performs any write.
   * The owning service remains responsible for its missing-target contract
   * and for making the write atomic when it promises all-or-nothing behavior.
   */
  async assertUsersMutation(
    actorGuid: string,
    targetGuids: string[],
    permissionCode: PermissionCode,
  ): Promise<void> {
    await this.requirePermission(actorGuid, permissionCode);
    const uniqueGuids = [...new Set(targetGuids)];
    if (!uniqueGuids.length) return;

    const users = await this.userRepository.find({
      where: { guid: In(uniqueGuids) },
      select: ['guid', 'isAdmin'],
    });
    const protectedUser = users.find((user) => user.isAdmin);
    if (protectedUser) {
      try {
        await this.requireSuperAdmin(actorGuid);
      } catch (error: unknown) {
        return this.rejectWithAudit(
          actorGuid,
          'user',
          protectedUser.guid,
          'super_admin',
          error,
        );
      }
    }
  }

  private async rejectWithAudit(
    actorUserGuid: string,
    targetType: string,
    targetGuid: string | null,
    action: string,
    error: unknown,
  ): Promise<never> {
    await this.auditService.recordDenied({
      actorUserGuid,
      targetType,
      targetGuid,
      action,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import * as uuid from 'uuid';
import { Strategy } from './entities/strategy.entity';
import { Peer } from '../../common/entities/peer.entity';
import { User } from '../user/entities/user.entity';
import { DeviceGroup } from '../device-group/entities/device-group.entity';
import {
  CreateStrategyDto,
  UpdateStrategyDto,
  AssignStrategyDto,
  StrategyCandidateDto,
  StrategyQueryDto,
  StrategyTargetCandidateQueryDto,
  AssignmentQueryDto,
} from './dto/strategy.dto';
import {
  PermissionScope,
  RbacAuthorizationService,
} from '../rbac/services/rbac-authorization.service';

@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);

  constructor(
    @InjectRepository(Strategy)
    private strategyRepository: Repository<Strategy>,
    @InjectRepository(Peer)
    private peerRepository: Repository<Peer>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(DeviceGroup)
    private deviceGroupRepository: Repository<DeviceGroup>,
    private readonly rbacAuthorizationService: RbacAuthorizationService,
  ) {}

  async createStrategy(dto: CreateStrategyDto) {
    const existing = await this.strategyRepository.findOne({
      where: { name: dto.name },
    });
    if (existing) {
      throw new BadRequestException('策略名称已存在');
    }

    const strategy = new Strategy();
    strategy.guid = uuid.v4();
    strategy.name = dto.name;
    strategy.note = dto.note || '';
    strategy.configOptions = dto.config_options
      ? JSON.stringify(dto.config_options)
      : '';

    await this.strategyRepository.save(strategy);

    return {
      guid: strategy.guid,
      name: strategy.name,
      note: strategy.note,
      config_options: dto.config_options || {},
      updated_at: strategy.updatedAt,
    };
  }

  async updateStrategy(guid: string, dto: UpdateStrategyDto) {
    const strategy = await this.strategyRepository.findOne({
      where: { guid },
    });
    if (!strategy) {
      throw new NotFoundException('策略不存在');
    }

    if (dto.name !== undefined) {
      const existing = await this.strategyRepository.findOne({
        where: { name: dto.name },
      });
      if (existing && existing.guid !== guid) {
        throw new BadRequestException('策略名称已存在');
      }
      strategy.name = dto.name;
    }

    if (dto.note !== undefined) {
      strategy.note = dto.note;
    }

    if (dto.config_options !== undefined) {
      strategy.configOptions = JSON.stringify(dto.config_options);
    }

    await this.strategyRepository.save(strategy);

    const configOptions: Record<string, string> = dto.config_options
      ? dto.config_options
      : (JSON.parse(strategy.configOptions || '{}') as Record<string, string>);

    return {
      guid: strategy.guid,
      name: strategy.name,
      note: strategy.note,
      config_options: configOptions,
      updated_at: strategy.updatedAt,
    };
  }

  async deleteStrategy(guid: string) {
    const strategy = await this.strategyRepository.findOne({
      where: { guid },
    });
    if (!strategy) {
      throw new NotFoundException('策略不存在');
    }

    await this.strategyRepository.remove(strategy);
  }

  async getStrategies(query: StrategyQueryDto) {
    const { current, pageSize, name } = query;
    const skip = (current - 1) * pageSize;

    let queryBuilder = this.strategyRepository
      .createQueryBuilder('strategy')
      .orderBy('strategy.name', 'ASC')
      .skip(skip)
      .take(pageSize);

    if (name) {
      queryBuilder = queryBuilder.where('strategy.name LIKE :name', {
        name: `%${name}%`,
      });
    }

    const [strategies, total] = await queryBuilder.getManyAndCount();

    return {
      data: strategies.map((s) => ({
        guid: s.guid,
        name: s.name,
        note: s.note || '',
        updated_at: s.updatedAt,
      })),
      total,
    };
  }

  async getStrategyCandidates(query: StrategyQueryDto): Promise<{
    data: StrategyCandidateDto[];
    total: number;
  }> {
    const result = await this.getStrategies(query);
    return {
      data: result.data.map(({ guid, name, note }) => ({ guid, name, note })),
      total: result.total,
    };
  }

  async getStrategyTargetCandidates(
    query: StrategyTargetCandidateQueryDto,
    actorGuid: string,
  ) {
    const { target_type, current, pageSize } = query;
    const skip = (current - 1) * pageSize;

    if (target_type === 'device') {
      const scope = await this.rbacAuthorizationService.requirePermission(
        actorGuid,
        'strategies.assign',
      );
      let queryBuilder = this.peerRepository
        .createQueryBuilder('peer')
        .select(['peer.uuid', 'peer.id']);
      if (!scope.global) {
        queryBuilder = scope.deviceGroupGuids.size
          ? queryBuilder.andWhere(
              'peer.deviceGroupGuid IN (:...deviceGroupGuids)',
              { deviceGroupGuids: [...scope.deviceGroupGuids] },
            )
          : queryBuilder.andWhere('1 = 0');
      }
      const [peers, total] = await queryBuilder
        .orderBy('peer.id', 'ASC')
        .skip(skip)
        .take(pageSize)
        .getManyAndCount();
      return {
        data: peers.map(({ uuid, id }) => ({ uuid, id })),
        total,
      };
    }

    await this.rbacAuthorizationService.assertStrategyTargets(
      actorGuid,
      'user',
      [],
    );
    const actor = await this.rbacAuthorizationService.getCurrentUser(actorGuid);
    const [users, total] = await this.userRepository.findAndCount({
      where: actor.isAdmin ? {} : { isAdmin: false },
      select: ['guid', 'username', 'displayName'],
      skip,
      take: pageSize,
      order: { username: 'ASC' },
    });
    return {
      data: users.map((user) => ({
        guid: user.guid,
        name: user.displayName || user.username,
      })),
      total,
    };
  }

  async getStrategy(guid: string) {
    const strategy = await this.strategyRepository.findOne({
      where: { guid },
    });
    if (!strategy) {
      throw new NotFoundException('策略不存在');
    }

    return {
      guid: strategy.guid,
      name: strategy.name,
      note: strategy.note || '',
      config_options: JSON.parse(strategy.configOptions || '{}') as Record<
        string,
        string
      >,
      updated_at: strategy.updatedAt,
    };
  }

  async assignStrategy(
    strategyGuid: string,
    targetType: AssignStrategyDto['target_type'],
    targetGuids: string[],
    actorGuid: string,
  ) {
    const targets = [...new Set(targetGuids)];
    const scope = await this.rbacAuthorizationService.assertStrategyTargets(
      actorGuid,
      targetType,
      targets,
    );
    const strategy = await this.strategyRepository.findOne({
      where: { guid: strategyGuid },
    });
    if (!strategy) {
      throw new NotFoundException('策略不存在');
    }

    const success: string[] = [];
    const errors: { target_guid: string; reason: string }[] = [];

    switch (targetType) {
      case 'device': {
        const peers = await this.peerRepository.find({
          where: { uuid: In(targets) },
        });
        const foundUuids = new Set(peers.map((p) => p.uuid));
        for (const targetGuid of targets) {
          if (!foundUuids.has(targetGuid)) {
            errors.push({ target_guid: targetGuid, reason: '设备不存在' });
          }
        }
        if (peers.length > 0) {
          await this.updateAuthorizedDevices(
            actorGuid,
            peers.map((peer) => peer.uuid),
            scope,
            { strategyGuid },
          );
          success.push(...peers.map((p) => p.uuid));
        }
        break;
      }
      case 'user': {
        const users = await this.userRepository.find({
          where: { guid: In(targets) },
        });
        const foundGuids = new Set(users.map((u) => u.guid));
        for (const targetGuid of targets) {
          if (!foundGuids.has(targetGuid)) {
            errors.push({ target_guid: targetGuid, reason: '用户不存在' });
          }
        }
        if (users.length > 0) {
          await this.userRepository.update(
            { guid: In(users.map((u) => u.guid)) },
            { strategyGuid },
          );
          success.push(...users.map((u) => u.guid));
        }
        break;
      }
      case 'device_group': {
        const groups = await this.deviceGroupRepository.find({
          where: { guid: In(targets) },
        });
        const foundGuids = new Set(groups.map((g) => g.guid));
        for (const targetGuid of targets) {
          if (!foundGuids.has(targetGuid)) {
            errors.push({ target_guid: targetGuid, reason: '设备组不存在' });
          }
        }
        if (groups.length > 0) {
          await this.deviceGroupRepository.update(
            { guid: In(groups.map((g) => g.guid)) },
            { strategyGuid },
          );
          success.push(...groups.map((g) => g.guid));
        }
        break;
      }
      default:
        throw new BadRequestException(
          `不支持的目标类型: ${String(targetType)}`,
        );
    }

    return { success, errors };
  }

  async unassignStrategy(
    strategyGuid: string,
    targetType: AssignStrategyDto['target_type'],
    targetGuids: string[],
    actorGuid: string,
  ) {
    const targets = [...new Set(targetGuids)];
    const scope = await this.rbacAuthorizationService.assertStrategyTargets(
      actorGuid,
      targetType,
      targets,
    );
    const success: string[] = [];
    const errors: { target_guid: string; reason: string }[] = [];

    switch (targetType) {
      case 'device': {
        const peers = await this.peerRepository.find({
          where: { uuid: In(targets) },
        });
        const existingUuids = new Set(peers.map((peer) => peer.uuid));
        const assignedPeers = peers.filter(
          (peer) => peer.strategyGuid === strategyGuid,
        );
        const assignedUuids = new Set(assignedPeers.map((peer) => peer.uuid));
        for (const targetGuid of targets) {
          if (!existingUuids.has(targetGuid)) {
            errors.push({ target_guid: targetGuid, reason: '设备不存在' });
          } else if (!assignedUuids.has(targetGuid)) {
            errors.push({
              target_guid: targetGuid,
              reason: '设备未绑定该策略',
            });
          }
        }
        if (assignedPeers.length > 0) {
          await this.updateAuthorizedDevices(
            actorGuid,
            assignedPeers.map((peer) => peer.uuid),
            scope,
            { strategyGuid: null },
            strategyGuid,
          );
          success.push(...assignedPeers.map((peer) => peer.uuid));
        }
        break;
      }
      case 'user': {
        const users = await this.userRepository.find({
          where: { guid: In(targets) },
        });
        const existingGuids = new Set(users.map((user) => user.guid));
        const assignedUsers = users.filter(
          (user) => user.strategyGuid === strategyGuid,
        );
        const assignedGuids = new Set(assignedUsers.map((user) => user.guid));
        for (const targetGuid of targets) {
          if (!existingGuids.has(targetGuid)) {
            errors.push({ target_guid: targetGuid, reason: '用户不存在' });
          } else if (!assignedGuids.has(targetGuid)) {
            errors.push({
              target_guid: targetGuid,
              reason: '用户未绑定该策略',
            });
          }
        }
        if (assignedUsers.length > 0) {
          await this.userRepository.update(
            {
              guid: In(assignedUsers.map((user) => user.guid)),
              strategyGuid,
            },
            { strategyGuid: null },
          );
          success.push(...assignedUsers.map((user) => user.guid));
        }
        break;
      }
      case 'device_group': {
        const groups = await this.deviceGroupRepository.find({
          where: { guid: In(targets) },
        });
        const existingGuids = new Set(groups.map((group) => group.guid));
        const assignedGroups = groups.filter(
          (group) => group.strategyGuid === strategyGuid,
        );
        const assignedGuids = new Set(
          assignedGroups.map((group) => group.guid),
        );
        for (const targetGuid of targets) {
          if (!existingGuids.has(targetGuid)) {
            errors.push({ target_guid: targetGuid, reason: '设备组不存在' });
          } else if (!assignedGuids.has(targetGuid)) {
            errors.push({
              target_guid: targetGuid,
              reason: '设备组未绑定该策略',
            });
          }
        }
        if (assignedGroups.length > 0) {
          await this.deviceGroupRepository.update(
            {
              guid: In(assignedGroups.map((group) => group.guid)),
              strategyGuid,
            },
            { strategyGuid: null },
          );
          success.push(...assignedGroups.map((group) => group.guid));
        }
        break;
      }
      default:
        throw new BadRequestException(
          `不支持的目标类型: ${String(targetType)}`,
        );
    }

    return { success, errors };
  }

  private async updateAuthorizedDevices(
    actorGuid: string,
    deviceUuids: string[],
    scope: PermissionScope,
    update: Partial<Peer>,
    expectedStrategyGuid?: string,
  ): Promise<void> {
    const concurrentChange = new ConflictException(
      '设备信息已发生变化，请重试',
    );
    try {
      await this.peerRepository.manager.transaction(async (manager) => {
        const result = await manager.update(
          Peer,
          {
            uuid: In(deviceUuids),
            ...(scope.global
              ? {}
              : { deviceGroupGuid: In([...scope.deviceGroupGuids]) }),
            ...(expectedStrategyGuid === undefined
              ? {}
              : { strategyGuid: expectedStrategyGuid }),
          },
          update,
        );
        if (result.affected !== deviceUuids.length) {
          throw concurrentChange;
        }
      });
    } catch (error) {
      if (error === concurrentChange) {
        await this.rbacAuthorizationService.assertStrategyTargets(
          actorGuid,
          'device',
          deviceUuids,
        );
      }
      throw error;
    }
  }

  async getStrategyAssignments(
    guid: string,
    query: AssignmentQueryDto,
    actorGuid: string,
  ) {
    const { target_type, current, pageSize } = query;
    const skip = (current - 1) * pageSize;
    const scope = await this.rbacAuthorizationService.requirePermission(
      actorGuid,
      'strategies.assign',
    );
    if (target_type === 'user') {
      await this.rbacAuthorizationService.assertStrategyTargets(
        actorGuid,
        'user',
        [],
      );
    }
    const strategy = await this.strategyRepository.findOne({
      where: { guid },
    });
    if (!strategy) {
      throw new NotFoundException('策略不存在');
    }

    switch (target_type) {
      case 'device': {
        let queryBuilder = this.peerRepository
          .createQueryBuilder('peer')
          .where('peer.strategyGuid = :strategyGuid', { strategyGuid: guid })
          .select(['peer.uuid', 'peer.id']);
        if (!scope.global) {
          queryBuilder = scope.deviceGroupGuids.size
            ? queryBuilder.andWhere(
                'peer.deviceGroupGuid IN (:...deviceGroupGuids)',
                { deviceGroupGuids: [...scope.deviceGroupGuids] },
              )
            : queryBuilder.andWhere('1 = 0');
        }
        const [peers, total] = await queryBuilder
          .orderBy('peer.id', 'ASC')
          .skip(skip)
          .take(pageSize)
          .getManyAndCount();
        return {
          data: peers.map((p) => ({
            uuid: p.uuid,
            id: p.id,
          })),
          total,
        };
      }
      case 'user': {
        const actor =
          await this.rbacAuthorizationService.getCurrentUser(actorGuid);
        const [users, total] = await this.userRepository.findAndCount({
          where: actor.isAdmin
            ? { strategyGuid: guid }
            : { strategyGuid: guid, isAdmin: false },
          select: ['guid', 'username', 'displayName'],
          skip,
          take: pageSize,
          order: { username: 'ASC' },
        });
        return {
          data: users.map((u) => ({
            guid: u.guid,
            name: u.displayName || u.username,
          })),
          total,
        };
      }
      case 'device_group': {
        let queryBuilder = this.deviceGroupRepository
          .createQueryBuilder('deviceGroup')
          .where('deviceGroup.strategyGuid = :strategyGuid', {
            strategyGuid: guid,
          })
          .select(['deviceGroup.guid', 'deviceGroup.name']);
        if (!scope.global) {
          queryBuilder = scope.deviceGroupGuids.size
            ? queryBuilder.andWhere(
                'deviceGroup.guid IN (:...deviceGroupGuids)',
                { deviceGroupGuids: [...scope.deviceGroupGuids] },
              )
            : queryBuilder.andWhere('1 = 0');
        }
        const [groups, total] = await queryBuilder
          .orderBy('deviceGroup.name', 'ASC')
          .skip(skip)
          .take(pageSize)
          .getManyAndCount();
        return {
          data: groups.map((g) => ({
            guid: g.guid,
            name: g.name,
          })),
          total,
        };
      }
      default:
        throw new BadRequestException(
          `不支持的目标类型: ${String(target_type)}`,
        );
    }
  }

  async findStrategyForDevice(deviceUuid: string): Promise<Strategy | null> {
    const peer = await this.peerRepository.findOne({
      where: { uuid: deviceUuid },
    });
    if (!peer) {
      return null;
    }

    if (peer.strategyGuid) {
      const strategy = await this.strategyRepository.findOne({
        where: { guid: peer.strategyGuid },
      });
      if (strategy) {
        return strategy;
      }
    }

    if (peer.userGuid) {
      const user = await this.userRepository.findOne({
        where: { guid: peer.userGuid },
      });
      if (user?.strategyGuid) {
        const strategy = await this.strategyRepository.findOne({
          where: { guid: user.strategyGuid },
        });
        if (strategy) {
          return strategy;
        }
      }
    }

    if (peer.deviceGroupGuid) {
      const group = await this.deviceGroupRepository.findOne({
        where: { guid: peer.deviceGroupGuid },
      });
      if (group?.strategyGuid) {
        const strategy = await this.strategyRepository.findOne({
          where: { guid: group.strategyGuid },
        });
        if (strategy) {
          return strategy;
        }
      }
    }

    return null;
  }
}

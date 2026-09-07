import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Repository } from 'typeorm';
import { Peer } from '../../common/entities/peer.entity';
import { REQUIRE_PERMISSION_KEY } from '../rbac/decorators/require-permission.decorator';
import { RbacAuditService } from '../rbac/services/rbac-audit.service';
import { RbacAuthorizationService } from '../rbac/services/rbac-authorization.service';
import { ActiveConnection } from '../heartbeat/entities/active-connection.entity';
import { AuditsController } from './audit.controller';
import { AuditService } from './audit.service';
import { ActiveConnectionQueryDto } from './dto/connection-audit.dto';
import { AlarmAudit } from './entities/alarm-audit.entity';
import { ConnectionAudit } from './entities/connection-audit.entity';
import { FileAudit } from './entities/file-audit.entity';

jest.mock('uuid', () => {
  const cryptoModule =
    jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { v4: cryptoModule.randomUUID };
});

describe('Disconnect connection reads', () => {
  const connectionAuditRepository = {
    createQueryBuilder: jest.fn(),
  };
  const activeConnectionRepository = {
    createQueryBuilder: jest.fn(),
    find: jest.fn(),
  };
  const peerRepository = { find: jest.fn() };
  const authorizationService = {
    requirePermission: jest.fn(),
    getPermissionScope: jest.fn(),
  };
  const service = new AuditService(
    connectionAuditRepository as unknown as Repository<ConnectionAudit>,
    {} as Repository<FileAudit>,
    {} as Repository<AlarmAudit>,
    activeConnectionRepository as unknown as Repository<ActiveConnection>,
    peerRepository as unknown as Repository<Peer>,
    {} as RbacAuditService,
    authorizationService as unknown as RbacAuthorizationService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    authorizationService.requirePermission.mockResolvedValue({
      global: true,
      deviceGroupGuids: new Set<string>(),
    });
    authorizationService.getPermissionScope.mockResolvedValue({
      global: true,
      deviceGroupGuids: new Set<string>(),
    });
  });

  it('guards the active list independently of audit.view', () => {
    expect(
      Reflect.getMetadata(
        REQUIRE_PERMISSION_KEY,
        AuditsController.prototype.queryActiveConnections,
      ),
    ).toEqual(['devices.disconnect']);
    expect(
      Reflect.getMetadata(
        REQUIRE_PERMISSION_KEY,
        AuditsController.prototype.queryConnectionAudits,
      ),
    ).toEqual(['audit.view']);
  });

  it('returns only active in-scope disconnect selector fields', async () => {
    const builder = {
      innerJoin: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(1),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        {
          deviceUuid: 'device-1',
          deviceId: '123456789',
          connId: '42',
          peerName: 'not exposed',
        },
      ]),
    };
    activeConnectionRepository.createQueryBuilder.mockReturnValue(builder);
    authorizationService.requirePermission.mockResolvedValue({
      global: false,
      deviceGroupGuids: new Set(['group-1']),
    });

    const result = await service.queryActiveConnections('actor', {
      current: 2,
      pageSize: 10,
      deviceId: '123',
    });

    expect(result).toEqual({
      data: [
        {
          deviceId: '123456789',
          deviceUuid: 'device-1',
          connId: 42,
          can_disconnect: true,
        },
      ],
      total: 1,
    });
    expect(builder.andWhere).toHaveBeenCalledWith(
      'peer.deviceGroupGuid IN (:...deviceGroupGuids)',
      { deviceGroupGuids: ['group-1'] },
    );
    expect(builder.offset).toHaveBeenCalledWith(10);
    expect(JSON.stringify(result)).not.toContain('not exposed');
  });

  it('returns no active connections when the device scope is empty', async () => {
    const builder = {
      innerJoin: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    activeConnectionRepository.createQueryBuilder.mockReturnValue(builder);
    authorizationService.requirePermission.mockResolvedValue({
      global: false,
      deviceGroupGuids: new Set<string>(),
    });

    await expect(
      service.queryActiveConnections('actor', { current: 1, pageSize: 20 }),
    ).resolves.toEqual({ data: [], total: 0 });
    expect(builder.andWhere).toHaveBeenCalledWith('1 = 0');
  });

  it('marks full-audit rows from current active connections and device scope', async () => {
    const auditRows = [
      {
        deviceUuid: 'device-1',
        connId: '42',
        closedAt: null,
        createdAt: new Date(),
      },
      {
        deviceUuid: 'device-2',
        connId: '43',
        closedAt: null,
        createdAt: new Date(),
      },
    ] as unknown as ConnectionAudit[];
    const builder = {
      select: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([auditRows, 2]),
    };
    connectionAuditRepository.createQueryBuilder.mockReturnValue(builder);
    authorizationService.getPermissionScope.mockResolvedValue({
      global: false,
      deviceGroupGuids: new Set(['group-1']),
    });
    peerRepository.find.mockResolvedValue([{ uuid: 'device-1' }]);
    activeConnectionRepository.find.mockResolvedValue([
      { deviceUuid: 'device-1', connId: 42 },
    ]);

    const result = await service.queryConnectionAudits({}, 'actor');

    expect(result.data.map((row) => row.can_disconnect)).toEqual([true, false]);
    expect(peerRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        select: ['uuid'],
      }),
    );
  });

  it('validates active-list pagination and rejects unknown fields', async () => {
    const dto = plainToInstance(ActiveConnectionQueryDto, {
      current: 0,
      pageSize: 101,
      secret: true,
    });
    expect(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).not.toHaveLength(0);
  });
});

import 'reflect-metadata';
import { Repository } from 'typeorm';
import { Strategy } from '../strategy/entities/strategy.entity';
import { Role } from '../rbac/entities/role.entity';
import { UserRoleAssignment } from '../rbac/entities/user-role-assignment.entity';
import { RbacAuthorizationService } from '../rbac/services/rbac-authorization.service';
import { AdminUserController } from './admin-user.controller';
import { AdminUserService } from './admin-user.service';
import { AdminUserQueryDto } from './dto/admin-user.dto';
import { User } from './entities/user.entity';

jest.mock('uuid', () => {
  const cryptoModule =
    jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { v4: cryptoModule.randomUUID };
});

type MockRepository = {
  find: jest.Mock;
  createQueryBuilder: jest.Mock;
};

const repository = (): MockRepository => ({
  find: jest.fn(),
  createQueryBuilder: jest.fn(),
});

describe('AdminUserService role names', () => {
  const query = { current: 1, pageSize: 20 } as AdminUserQueryDto;
  let userRepository: MockRepository;
  let strategyRepository: MockRepository;
  let assignmentRepository: MockRepository;
  let roleRepository: MockRepository;
  let queryBuilder: {
    leftJoinAndSelect: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };
  let authorizationService: { getCurrentUser: jest.Mock };
  let service: AdminUserService;

  beforeEach(() => {
    userRepository = repository();
    strategyRepository = repository();
    assignmentRepository = repository();
    roleRepository = repository();
    queryBuilder = {
      leftJoinAndSelect: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      skip: jest.fn(),
      take: jest.fn(),
      getManyAndCount: jest.fn(),
    };
    for (const method of [
      queryBuilder.leftJoinAndSelect,
      queryBuilder.andWhere,
      queryBuilder.orderBy,
      queryBuilder.skip,
      queryBuilder.take,
    ]) {
      method.mockReturnValue(queryBuilder);
    }
    userRepository.createQueryBuilder.mockReturnValue(queryBuilder);
    strategyRepository.find.mockResolvedValue([]);
    assignmentRepository.find.mockResolvedValue([]);
    roleRepository.find.mockResolvedValue([]);
    authorizationService = { getCurrentUser: jest.fn() };
    service = new AdminUserService(
      userRepository as unknown as Repository<User>,
      strategyRepository as unknown as Repository<Strategy>,
      assignmentRepository as unknown as Repository<UserRoleAssignment>,
      roleRepository as unknown as Repository<Role>,
      authorizationService as unknown as RbacAuthorizationService,
    );
  });

  it('bulk aggregates stable unique role names for a current super-admin', async () => {
    authorizationService.getCurrentUser.mockResolvedValue({ isAdmin: true });
    queryBuilder.getManyAndCount.mockResolvedValue([
      [
        { guid: 'user-1', username: 'alice', isAdmin: true },
        { guid: 'user-2', username: 'bob' },
      ] as User[],
      2,
    ]);
    assignmentRepository.find.mockResolvedValue([
      { userGuid: 'user-1', roleGuid: 'role-z' },
      { userGuid: 'user-1', roleGuid: 'role-a' },
      { userGuid: 'user-1', roleGuid: 'role-a' },
    ] as UserRoleAssignment[]);
    roleRepository.find.mockResolvedValue([
      { guid: 'role-z', name: 'Zulu' },
      { guid: 'role-a', name: 'Alpha' },
    ] as Role[]);

    const result = await service.getAdminUsers(query, 'actor');

    expect(authorizationService.getCurrentUser).toHaveBeenCalledWith('actor');
    expect(assignmentRepository.find).toHaveBeenCalledTimes(1);
    expect(roleRepository.find).toHaveBeenCalledTimes(1);
    expect(result.data[0].role_names).toEqual(['Super Admin', 'Alpha', 'Zulu']);
    expect(result.data[1].role_names).toEqual([]);
  });

  it('returns role names to a delegated caller authorized to view users', async () => {
    authorizationService.getCurrentUser.mockResolvedValue({ isAdmin: false });
    queryBuilder.getManyAndCount.mockResolvedValue([
      [{ guid: 'user-1', username: 'alice' }] as User[],
      1,
    ]);
    assignmentRepository.find.mockResolvedValue([
      { userGuid: 'user-1', roleGuid: 'role-delegated' },
    ] as UserRoleAssignment[]);
    roleRepository.find.mockResolvedValue([
      { guid: 'role-delegated', name: 'Delegated Role' },
    ] as Role[]);

    const result = await service.getAdminUsers(query, 'delegated-actor');

    expect(result.data[0].role_names).toEqual(['Delegated Role']);
    expect(result.data[0]).toHaveProperty('is_protected', false);
    expect(assignmentRepository.find).toHaveBeenCalledTimes(1);
    expect(roleRepository.find).toHaveBeenCalledTimes(1);
  });

  it('returns an empty page without assignment or role queries', async () => {
    authorizationService.getCurrentUser.mockResolvedValue({ isAdmin: true });
    queryBuilder.getManyAndCount.mockResolvedValue([[], 0]);

    await expect(service.getAdminUsers(query, 'actor')).resolves.toEqual({
      data: [],
      total: 0,
    });
    expect(assignmentRepository.find).not.toHaveBeenCalled();
    expect(roleRepository.find).not.toHaveBeenCalled();
    expect(strategyRepository.find).not.toHaveBeenCalled();
  });
});

describe('AdminUserController', () => {
  it('passes the current actor guid to the service', async () => {
    const adminUserService = {
      getAdminUsers: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    };
    const controller = new AdminUserController(
      adminUserService as unknown as AdminUserService,
    );
    const query = { current: 1, pageSize: 20 } as AdminUserQueryDto;

    await controller.getAdminUsers(query, 'actor');

    expect(adminUserService.getAdminUsers).toHaveBeenCalledWith(query, 'actor');
  });
});

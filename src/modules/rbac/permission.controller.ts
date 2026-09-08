import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSION_CATALOG } from './constants/permission-catalog';
import { RequirePermission } from './decorators/require-permission.decorator';
import { RbacAuthorizationService } from './services/rbac-authorization.service';

@Controller('permissions')
export class PermissionController {
  constructor(
    private readonly authorizationService: RbacAuthorizationService,
  ) {}

  @Get()
  @RequirePermission('roles.view')
  getPermissions() {
    return {
      data: PERMISSION_CATALOG.map((permission) => ({
        code: permission.code,
        resource: permission.resource,
        action: permission.action,
        name: permission.name,
        description: permission.description,
        scope: permission.scope,
        assignable: permission.assignable,
        system_only: permission.system_only,
        ...(permission.requires ? { requires: permission.requires } : {}),
      })),
    };
  }

  @Get('me')
  getMyPermissions(@CurrentUser('id') userGuid: string) {
    return this.authorizationService.getEffectivePermissions(userGuid);
  }
}

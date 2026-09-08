import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Role } from './role.entity';

@Entity('role_permissions')
export class RolePermission {
  @PrimaryColumn()
  roleGuid: string;

  @PrimaryColumn({ type: 'varchar' })
  permissionCode: string;

  @ManyToOne(() => Role, (role) => role.rolePermissions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'roleGuid', referencedColumnName: 'guid' })
  role: Role;
}

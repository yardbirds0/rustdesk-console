import { Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { DeviceGroup } from '../../device-group/entities/device-group.entity';
import { UserRoleAssignment } from './user-role-assignment.entity';

@Entity('user_role_assignment_device_groups')
export class UserRoleAssignmentDeviceGroup {
  @PrimaryColumn()
  assignmentGuid: string;

  @PrimaryColumn()
  @Index()
  deviceGroupGuid: string;

  @ManyToOne(
    () => UserRoleAssignment,
    (assignment) => assignment.deviceGroups,
    {
      onDelete: 'CASCADE',
    },
  )
  @JoinColumn({ name: 'assignmentGuid', referencedColumnName: 'guid' })
  assignment: UserRoleAssignment;

  @ManyToOne(() => DeviceGroup, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'deviceGroupGuid', referencedColumnName: 'guid' })
  deviceGroup: DeviceGroup;
}

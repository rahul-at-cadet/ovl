import { IsArray, IsEnum, ArrayMinSize, IsString } from 'class-validator';
import { UserRole } from './create-user.dto';

export class UpdateUserRolesDto {
  @IsArray()
  @IsEnum(UserRole, { each: true })
  @ArrayMinSize(1)
  roles: UserRole[];
}

export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  newPassword: string;
}

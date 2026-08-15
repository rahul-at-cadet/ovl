import { IsString, IsArray, IsEnum, ArrayMinSize } from 'class-validator';

export enum UserRole {
  Admin = 'admin',
  ConfigManager = 'configManager',
  CommercialEditor = 'commercialEditor',
  Reviewer = 'reviewer',
  Viewer = 'viewer',
}

export class CreateUserDto {
  @IsString()
  username: string;

  @IsArray()
  @IsEnum(UserRole, { each: true })
  @ArrayMinSize(1)
  roles: UserRole[];
}

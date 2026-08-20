import { IsEmail, IsArray, IsEnum, ArrayMinSize } from 'class-validator';

export enum UserRole {
  Admin = 'admin',
  ConfigManager = 'configManager',
  CommercialEditor = 'commercialEditor',
  Reviewer = 'reviewer',
  Viewer = 'viewer',
}

export class CreateUserDto {
  // Must be a real email — it becomes both the local users.username and
  // the SuperTokens emailpassword identity's email (createUser signs the
  // person up for real, not just into this shadow profile table).
  @IsEmail()
  username!: string;

  @IsArray()
  @IsEnum(UserRole, { each: true })
  @ArrayMinSize(1)
  roles!: UserRole[];
}

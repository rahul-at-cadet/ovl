import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  ValidationPipe,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRolesDto, ChangePasswordDto } from './dto/update-user.dto';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { Actor } from '../audit/audit-actor.decorator';
import type { AuditActor } from '../audit/audit.service';
import type { LocalUser } from '../auth/supertokens.service';

/** Throws if the authenticated user does not have the 'admin' role. */
function requireAdmin(user: LocalUser): void {
  const roles = Array.isArray(user.roles) ? user.roles : [];
  if (!roles.includes('admin')) {
    throw new ForbiddenException('Admin role required');
  }
}

@Controller('users')
@UseGuards(AuthGuard) // all routes require a valid session
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * GET /users
   * List all users. Admin-only.
   */
  @Get()
  listUsers(@CurrentUser() me: LocalUser) {
    requireAdmin(me);
    return this.usersService.listUsers();
  }

  /**
   * GET /users/me
   * Returns the currently authenticated user's own profile.
   */
  @Get('me')
  getMe(@CurrentUser() me: LocalUser) {
    const { passwordHash: _pw, ...safe } = me;
    return safe;
  }

  /**
   * GET /users/:id
   * Get a single user by UUID. Admin-only.
   */
  @Get(':id')
  getUser(@CurrentUser() me: LocalUser, @Param('id') id: string) {
    requireAdmin(me);
    return this.usersService.getUser(id);
  }

  /**
   * POST /users
   * Create a new user with a system-generated temporary password.
   * Admin-only. Returns the password ONCE — it cannot be recovered.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createUser(
    @CurrentUser() me: LocalUser,
    @Actor() actor: AuditActor,
    @Body(new ValidationPipe({ whitelist: true })) dto: CreateUserDto,
  ) {
    requireAdmin(me);
    return this.usersService.createUser(dto, actor);
  }

  /**
   * PATCH /users/:id/roles
   * Update a user's roles. Admin-only.
   */
  @Patch(':id/roles')
  updateUserRoles(
    @CurrentUser() me: LocalUser,
    @Actor() actor: AuditActor,
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: UpdateUserRolesDto,
  ) {
    requireAdmin(me);
    return this.usersService.updateUserRoles(id, dto, actor);
  }

  /**
   * POST /users/:id/deactivate
   * Block a user from logging in. Admin-only.
   */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivateUser(
    @CurrentUser() me: LocalUser,
    @Actor() actor: AuditActor,
    @Param('id') id: string,
  ) {
    requireAdmin(me);
    return this.usersService.deactivateUser(id, actor);
  }

  /**
   * POST /users/:id/reactivate
   * Restore a deactivated user's access. Admin-only.
   */
  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivateUser(
    @CurrentUser() me: LocalUser,
    @Actor() actor: AuditActor,
    @Param('id') id: string,
  ) {
    requireAdmin(me);
    return this.usersService.reactivateUser(id, actor);
  }

  /**
   * POST /users/:id/reset-password
   * Generate a new temporary password for a user. Admin-only.
   * Returns the password ONCE — it cannot be recovered.
   */
  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  resetUserPassword(
    @CurrentUser() me: LocalUser,
    @Actor() actor: AuditActor,
    @Param('id') id: string,
  ) {
    requireAdmin(me);
    return this.usersService.resetUserPassword(id, actor);
  }

  /**
   * PATCH /users/me/password
   * Self-service password change. Requires the current password.
   */
  @Patch('me/password')
  changePassword(
    @CurrentUser() me: LocalUser,
    @Actor() actor: AuditActor,
    @Body(new ValidationPipe({ whitelist: true })) dto: ChangePasswordDto,
  ) {
    return this.usersService.changeOwnPassword(
      me.id,
      dto.currentPassword,
      dto.newPassword,
      actor,
    );
  }
}

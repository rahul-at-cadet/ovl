import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * The platform audit log.
 *
 * @Global because auditing is cross-cutting by nature — the events worth
 * recording happen in authentication, in user administration, in provisioning
 * and in impersonation, and threading an import through every one of those
 * modules would add noise without adding safety. It follows TenancyModule and
 * FormCatalogueModule, which are registered the same way and for the same
 * reason.
 *
 * Depends on PG_POOL and TENANCY_OPTIONS from TenancyModule, so it is
 * registered alongside it and only when multi-tenancy is enabled.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

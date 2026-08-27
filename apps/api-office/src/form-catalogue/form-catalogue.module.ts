import { Global, Module } from '@nestjs/common';
import { MasterCatalogService } from './master-catalog.service';
import { TenantCatalogService } from './tenant-catalog.service';
import { CuratedCatalogueSeederService } from './curated-catalogue-seeder.service';

/**
 * The master form-schema catalogue and each tenant's adoptions of it.
 *
 * Depends on TenancyModule for PlatformDbService and TenantDbService, both of
 * which are available globally — TenancyModule is @Global, mirroring how
 * DatabaseModule and AuthModule are registered in this codebase.
 */
@Global()
@Module({
  providers: [MasterCatalogService, TenantCatalogService, CuratedCatalogueSeederService],
  exports: [MasterCatalogService, TenantCatalogService, CuratedCatalogueSeederService],
})
export class FormCatalogueModule {}

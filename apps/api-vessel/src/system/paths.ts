import * as path from 'path';

/**
 * Where this node keeps the content-addressed attachment files.
 *
 * Derived from the database's own directory rather than process.cwd(),
 * and stated in one place because two features have to agree on it: the
 * attachment store writes here, and a snapshot copies it. They were
 * computed independently and disagreed — the store used
 * `cwd/attachments-store` while snapshots copied `dataDir/attachments`,
 * so every snapshot silently captured an empty directory and a restore
 * would have brought back reports whose evidence files were gone. In a
 * normal deployment the two paths coincide, which is exactly why it
 * would not have shown up until someone actually needed a restore.
 */
export function attachmentsDir(dataDir: string): string {
  return path.join(dataDir, 'attachments-store');
}

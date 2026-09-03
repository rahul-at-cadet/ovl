import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Repo-wide guard: no tracked source file may contain a NUL byte.
 *
 * lock-manager.service.ts shipped with two of them and nobody noticed
 * for two weeks. They sat where the space in a lock key separator should
 * have been — `${reportId}\0${section}` — and everything kept working
 * because the writer and the reader both used the same corrupted
 * character. It only surfaced when new code compared against a real
 * space and silently matched nothing.
 *
 * Nothing else caught it. TypeScript compiles a NUL inside a string
 * literal without complaint, and git classifies the file as binary, so
 * every diff on it read "Bin 4084 -> 4523 bytes" instead of showing the
 * change. A reviewer had nothing to look at.
 *
 * The mechanism is worth naming because it is easy to repeat: in a
 * Python regex replacement, `\0` is an octal escape for NUL, not a
 * reference to the whole match. Anyone reaching for `re.sub(pattern,
 * '\\0', text)` meaning "leave it as it was" writes NUL bytes into the
 * file instead. Group zero is spelled `\g<0>`.
 *
 * This test exists so the next occurrence fails in seconds rather than
 * hiding behind a binary diff.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** Extensions that are genuinely text and must never hold a NUL. */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.css', '.sql', '.yml', '.yaml', '.sh', '.html', '.txt',
]);

function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  return out.filter((f) => TEXT_EXTENSIONS.has(path.extname(f).toLowerCase()));
}

describe('tracked source files', () => {
  it('contain no NUL bytes', () => {
    const files = trackedTextFiles();
    // A guard that silently checked nothing would be worse than none.
    expect(files.length).toBeGreaterThan(100);

    const corrupted: string[] = [];
    for (const file of files) {
      const absolute = path.join(REPO_ROOT, file);
      // A file staged for deletion is still listed by git ls-files while
      // being gone from the working tree — an ordinary state mid-refactor.
      // Reading it blindly made this test fail with ENOENT, which is both
      // the wrong reason and one that would mask a real NUL, and a guard
      // that cries wolf during normal work is a guard that gets disabled.
      if (!fs.existsSync(absolute)) continue;
      const buf = fs.readFileSync(absolute);
      const count = buf.filter((b) => b === 0).length;
      if (count > 0) corrupted.push(`${file} (${count} NUL byte${count === 1 ? '' : 's'})`);
    }

    expect(corrupted).toEqual([]);
  });

  it('would notice a reintroduction', () => {
    // Proves the check tests what it claims: the same detection applied
    // to content carrying a NUL has to fail.
    const poisoned = Buffer.from('return `${reportId}\0${section}`;', 'utf8');
    expect(poisoned.filter((b) => b === 0).length).toBe(1);
  });
});

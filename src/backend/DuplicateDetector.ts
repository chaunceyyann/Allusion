import * as fs from 'fs';
import * as crypto from 'crypto';

export interface DuplicateGroup {
  hash: string;
  files: string[]; // absolute paths
}

export interface DedupProgress {
  phase: 'sizing' | 'hashing' | 'done';
  processed: number;
  total: number;
  duplicatesFound: number;
}

export class DuplicateDetector {
  private cancelRequested = false;

  async findDuplicates(
    filePaths: string[],
    onProgress: (progress: DedupProgress) => void,
  ): Promise<DuplicateGroup[]> {
    this.cancelRequested = false;

    // Phase 1: Group by file size
    const sizeMap = new Map<number, string[]>();
    for (let i = 0; i < filePaths.length; i++) {
      if (this.cancelRequested) return [];
      try {
        const stat = fs.statSync(filePaths[i]);
        const size = stat.size;
        if (!sizeMap.has(size)) sizeMap.set(size, []);
        sizeMap.get(size)!.push(filePaths[i]);
      } catch {
        // Skip files that can't be stat'd
      }
      onProgress({
        phase: 'sizing',
        processed: i + 1,
        total: filePaths.length,
        duplicatesFound: 0,
      });
    }

    // Only keep groups with 2+ files (potential duplicates)
    const candidates: string[] = [];
    for (const [, paths] of sizeMap) {
      if (paths.length >= 2) candidates.push(...paths);
    }

    // Phase 2: Hash candidates with MD5
    const hashMap = new Map<string, string[]>();
    for (let i = 0; i < candidates.length; i++) {
      if (this.cancelRequested) return [];
      try {
        const hash = await this.hashFile(candidates[i]);
        if (!hashMap.has(hash)) hashMap.set(hash, []);
        hashMap.get(hash)!.push(candidates[i]);
      } catch {
        // Skip files that can't be read
      }
      const duplicatesFound = [...hashMap.values()].filter((g) => g.length >= 2).length;
      onProgress({
        phase: 'hashing',
        processed: i + 1,
        total: candidates.length,
        duplicatesFound,
      });
    }

    // Collect groups with 2+ files
    const duplicates: DuplicateGroup[] = [];
    for (const [hash, files] of hashMap) {
      if (files.length >= 2) {
        duplicates.push({ hash, files });
      }
    }

    onProgress({
      phase: 'done',
      processed: candidates.length,
      total: candidates.length,
      duplicatesFound: duplicates.length,
    });
    return duplicates;
  }

  cancel(): void {
    this.cancelRequested = true;
  }

  private hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }
}

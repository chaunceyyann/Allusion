import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { ModelInfo, DownloadProgress, DownloadResult } from './autoTagTypes';

/** Files to download for each model. */
const MODEL_FILES = ['model.onnx', 'selected_tags.csv'] as const;

/** Maximum number of HTTP redirects to follow. */
const MAX_REDIRECTS = 5;

/** Retry delays in milliseconds for rate-limited or transient errors. */
const RETRY_DELAYS = [1000, 2000, 4000];

/**
 * Downloads WD Tagger model files from HuggingFace with progress tracking,
 * cancellation support, and retry with exponential backoff.
 *
 * Runs in the Electron main process.
 */
export class DownloadManager {
  /** Active downloads keyed by model ID, holding abort controllers for cancellation. */
  private activeDownloads: Map<string, AbortController> = new Map();

  /**
   * Downloads the ONNX model file and selected_tags.csv for a given model
   * from HuggingFace to the specified destination directory.
   *
   * Files are written with a `.tmp` suffix during download and renamed on
   * completion. Partial `.tmp` files are cleaned up on failure or cancellation.
   */
  async downloadModel(
    modelInfo: ModelInfo,
    destDir: string,
    onProgress: (progress: DownloadProgress) => void,
  ): Promise<DownloadResult> {
    // Create destination directory if it doesn't exist
    fs.mkdirSync(destDir, { recursive: true });

    const abortController = new AbortController();
    this.activeDownloads.set(modelInfo.id, abortController);

    try {
      for (const fileName of MODEL_FILES) {
        const url = `https://huggingface.co/${modelInfo.huggingFaceRepo}/resolve/main/${fileName}`;
        const destPath = path.join(destDir, fileName);
        const tmpPath = `${destPath}.tmp`;

        await this.downloadFileWithRetry(
          url,
          tmpPath,
          destPath,
          modelInfo.id,
          fileName,
          abortController.signal,
          onProgress,
        );
      }

      return { success: true, modelId: modelInfo.id };
    } catch (error: unknown) {
      // Clean up any .tmp files on failure
      this.cleanupTmpFiles(destDir);

      const message =
        error instanceof Error ? error.message : 'Unknown download error';
      return { success: false, modelId: modelInfo.id, error: message };
    } finally {
      this.activeDownloads.delete(modelInfo.id);
    }
  }

  /**
   * Cancels an in-progress download for the given model ID.
   * The abort signal triggers cleanup of partial `.tmp` files.
   */
  cancelDownload(modelId: string): void {
    const controller = this.activeDownloads.get(modelId);
    if (controller) {
      controller.abort();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Downloads a single file with retry logic for rate limiting (HTTP 429)
   * and transient network errors.
   */
  private async downloadFileWithRetry(
    url: string,
    tmpPath: string,
    destPath: string,
    modelId: string,
    fileName: string,
    signal: AbortSignal,
    onProgress: (progress: DownloadProgress) => void,
  ): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        await this.downloadFile(url, tmpPath, modelId, fileName, signal, onProgress);

        // Download succeeded — rename .tmp to final name
        fs.renameSync(tmpPath, destPath);
        return;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Clean up the .tmp file from this attempt
        this.safeUnlink(tmpPath);

        // Don't retry if cancelled
        if (signal.aborted) {
          throw new Error('Download cancelled');
        }

        // Only retry on rate limiting or network errors
        const isRetryable = this.isRetryableError(lastError);
        if (!isRetryable || attempt >= RETRY_DELAYS.length) {
          throw lastError;
        }

        // Wait before retrying with exponential backoff
        await this.delay(RETRY_DELAYS[attempt], signal);
      }
    }

    throw lastError ?? new Error('Download failed after retries');
  }

  /**
   * Downloads a single file from the given URL to tmpPath, following redirects
   * and reporting progress via the callback.
   */
  private downloadFile(
    url: string,
    tmpPath: string,
    modelId: string,
    fileName: string,
    signal: AbortSignal,
    onProgress: (progress: DownloadProgress) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Download cancelled'));
        return;
      }

      this.httpGet(url, 0, signal, (error, response) => {
        if (error) {
          reject(error);
          return;
        }

        if (!response) {
          reject(new Error('No response received'));
          return;
        }

        const statusCode = response.statusCode ?? 0;
        if (statusCode !== 200) {
          // Consume the response to free up memory
          response.resume();
          const err = new Error(`HTTP ${statusCode} for ${url}`);
          (err as any).statusCode = statusCode;
          reject(err);
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'] ?? '0', 10);
        let bytesDownloaded = 0;

        const fileStream = fs.createWriteStream(tmpPath);

        let settled = false;

        /** Wait for the file stream to close, clean up the tmp file, then reject. */
        const cleanupAndReject = (err: Error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);

          const doReject = () => {
            this.safeUnlink(tmpPath);
            reject(err);
          };

          // If the stream is already destroyed/closed, clean up immediately
          if (fileStream.destroyed) {
            // The 'close' event may have already fired or will fire soon
            // Use setImmediate to let any pending 'close' event fire first
            setImmediate(doReject);
          } else {
            fileStream.destroy();
            fileStream.on('close', doReject);
          }
        };

        // Handle abort signal
        const onAbort = () => {
          response.destroy();
          cleanupAndReject(new Error('Download cancelled'));
        };

        signal.addEventListener('abort', onAbort, { once: true });

        response.on('data', (chunk: Buffer) => {
          bytesDownloaded += chunk.length;
          onProgress({
            modelId,
            fileName,
            bytesDownloaded,
            totalBytes,
            percentage: totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 0,
          });
        });

        response.pipe(fileStream);

        fileStream.on('finish', () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          fileStream.close(() => resolve());
        });

        fileStream.on('error', (err) => {
          cleanupAndReject(err);
        });

        response.on('error', (err) => {
          cleanupAndReject(err);
        });
      });
    });
  }

  /**
   * Performs an HTTP(S) GET request, following redirects up to MAX_REDIRECTS.
   * HuggingFace may redirect to a CDN, so we handle 301, 302, 307, and 308.
   */
  private httpGet(
    url: string,
    redirectCount: number,
    signal: AbortSignal,
    callback: (error: Error | null, response?: http.IncomingMessage) => void,
  ): void {
    if (signal.aborted) {
      callback(new Error('Download cancelled'));
      return;
    }

    if (redirectCount > MAX_REDIRECTS) {
      callback(new Error(`Too many redirects (>${MAX_REDIRECTS})`));
      return;
    }

    const get = url.startsWith('https:') ? https.get : http.get;

    const req = get(url, (response) => {
      const statusCode = response.statusCode ?? 0;

      // Follow redirects
      if ([301, 302, 307, 308].includes(statusCode)) {
        const location = response.headers.location;
        if (!location) {
          callback(new Error(`Redirect ${statusCode} without Location header`));
          return;
        }
        // Consume the redirect response body
        response.resume();
        this.httpGet(location, redirectCount + 1, signal, callback);
        return;
      }

      callback(null, response);
    });

    req.on('error', (err) => {
      callback(err);
    });

    // Abort the request if the signal fires
    const onAbort = () => {
      req.destroy();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    req.on('close', () => {
      signal.removeEventListener('abort', onAbort);
    });
  }

  /**
   * Determines whether an error is retryable (rate limiting or network error).
   */
  private isRetryableError(error: Error): boolean {
    // HTTP 429 — rate limited
    if ((error as any).statusCode === 429) {
      return true;
    }

    // Common transient network error codes
    const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN'];
    if ((error as any).code && transientCodes.includes((error as any).code)) {
      return true;
    }

    return false;
  }

  /**
   * Removes all `.tmp` files from the given directory.
   */
  private cleanupTmpFiles(dir: string): void {
    try {
      if (!fs.existsSync(dir)) {
        return;
      }
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.endsWith('.tmp')) {
          this.safeUnlink(path.join(dir, entry));
        }
      }
    } catch {
      // Best-effort cleanup — ignore errors
    }
  }

  /**
   * Deletes a file if it exists, ignoring errors.
   */
  private safeUnlink(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore — best-effort cleanup
    }
  }

  /**
   * Returns a promise that resolves after the given delay, or rejects
   * immediately if the abort signal fires.
   */
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Download cancelled'));
        return;
      }

      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Download cancelled'));
      };

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

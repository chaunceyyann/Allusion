/**
 * Manages the lifecycle of the auto-tagging worker thread and routes
 * request/response messages with correlation IDs.
 *
 * Runs in the Electron main process. The worker is spawned lazily on the
 * first request and re-spawned automatically if it crashes.
 */
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as crypto from 'crypto';

import { WorkerRequest, WorkerResponse, PredictedTag } from './autoTagTypes';
import { preprocessImage } from './preprocessImage';

/** Timeout in milliseconds for inference requests. */
const INFERENCE_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Manages a single worker thread for WD Tagger ONNX inference.
 *
 * - Spawns the worker lazily on first use.
 * - Correlates requests and responses via unique `requestId` fields.
 * - Applies a 30-second timeout to inference requests.
 * - Re-spawns the worker automatically after a crash.
 */
export class WorkerManager {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();

  // ---------------------------------------------------------------------------
  // Worker lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Returns the current worker, spawning a new one if necessary.
   * Attaches `message`, `error`, and `exit` listeners on creation.
   */
  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }

    const workerPath = path.join(__dirname, 'autoTagWorker.bundle.js');
    const worker = new Worker(workerPath);

    worker.on('message', (response: WorkerResponse) => {
      const requestId = response.requestId;
      if (requestId === undefined) {
        // Unsolicited message — nothing to correlate.
        return;
      }

      const pending = this.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }

      // Clear timeout if set
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
      }

      this.pendingRequests.delete(requestId);
      pending.resolve(response);
    });

    worker.on('error', (err: Error) => {
      console.error('[WorkerManager] Worker error:', err);

      // Reject all pending requests so callers are not left hanging.
      for (const [id, pending] of this.pendingRequests) {
        if (pending.timer !== undefined) {
          clearTimeout(pending.timer);
        }
        pending.reject(new Error(`Worker error: ${err.message}`));
        this.pendingRequests.delete(id);
      }

      // Discard the worker so the next request spawns a fresh one.
      this.worker = null;
    });

    worker.on('exit', (code: number) => {
      if (code !== 0) {
        console.warn(`[WorkerManager] Worker exited with code ${code}`);
      }

      // Reject any remaining pending requests.
      for (const [id, pending] of this.pendingRequests) {
        if (pending.timer !== undefined) {
          clearTimeout(pending.timer);
        }
        pending.reject(new Error(`Worker exited with code ${code}`));
        this.pendingRequests.delete(id);
      }

      this.worker = null;
    });

    this.worker = worker;
    return worker;
  }

  // ---------------------------------------------------------------------------
  // Generic request / response
  // ---------------------------------------------------------------------------

  /**
   * Sends a request to the worker and returns a promise that resolves with the
   * correlated response. An optional timeout (in ms) rejects the promise if the
   * worker does not respond in time.
   */
  sendRequest(request: WorkerRequest, timeoutMs?: number): Promise<WorkerResponse> {
    const worker = this.ensureWorker();
    const requestId = crypto.randomUUID();

    return new Promise<WorkerResponse>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };

      if (timeoutMs !== undefined && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(new Error(`Worker request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.pendingRequests.set(requestId, pending);

      // Attach the correlation ID and post to the worker.
      const envelope: WorkerRequest = { ...request, requestId };
      worker.postMessage(envelope);
    });
  }

  // ---------------------------------------------------------------------------
  // High-level API
  // ---------------------------------------------------------------------------

  /**
   * Loads a model in the worker thread.
   *
   * @returns An object indicating success and the execution provider actually used.
   */
  async loadModel(
    modelPath: string,
    csvPath: string,
    executionProvider?: string,
  ): Promise<{ success: boolean; executionProvider: string }> {
    const response = await this.sendRequest({
      type: 'loadModel',
      modelPath,
      csvPath,
      executionProvider: executionProvider ?? getExecutionProvider(),
    });

    if (response.type === 'modelLoaded') {
      if (!response.success) {
        throw new Error(response.error ?? 'Unknown model load error');
      }
      return { success: true, executionProvider: response.executionProvider };
    }

    if (response.type === 'error') {
      throw new Error(response.message);
    }

    throw new Error(`Unexpected response type: ${response.type}`);
  }

  /**
   * Runs inference on a single image file.
   * Applies a 30-second timeout.
   *
   * @returns The array of predicted tags.
   */
  async infer(
    filePath: string,
    generalThreshold: number,
    characterThreshold: number,
    overrideCaptionFile: boolean,
  ): Promise<PredictedTag[]> {
    // Preprocess image in the main process (sharp crashes in worker threads due to V8 sandbox)
    let tensorData: Float32Array | undefined;
    try {
      const result = await preprocessImage(filePath);
      tensorData = result.tensor;
    } catch (err) {
      // If preprocessing fails, send without tensor — worker will report the error
      console.error('[WorkerManager] Image preprocessing failed:', err);
    }

    const response = await this.sendRequest(
      {
        type: 'infer',
        filePath,
        generalThreshold,
        characterThreshold,
        overrideCaptionFile,
        tensorData,
      },
      INFERENCE_TIMEOUT_MS,
    );

    if (response.type === 'inferResult') {
      if (response.error) {
        throw new Error(response.error);
      }
      return response.tags;
    }

    if (response.type === 'error') {
      throw new Error(response.message);
    }

    throw new Error(`Unexpected response type: ${response.type}`);
  }

  /**
   * Queries the worker for the current model status.
   */
  async getStatus(): Promise<{ isModelLoaded: boolean; executionProvider: string | null }> {
    const response = await this.sendRequest({ type: 'getStatus' });

    if (response.type === 'status') {
      return {
        isModelLoaded: response.isModelLoaded,
        executionProvider: response.executionProvider,
      };
    }

    if (response.type === 'error') {
      throw new Error(response.message);
    }

    throw new Error(`Unexpected response type: ${response.type}`);
  }

  /**
   * Disposes the worker thread. After calling this method the manager can
   * still be used — a new worker will be spawned on the next request.
   */
  async dispose(): Promise<void> {
    if (!this.worker) {
      return;
    }

    try {
      await this.sendRequest({ type: 'dispose' });
    } catch {
      // If the worker is already gone, that's fine.
    }

    // Terminate the worker and clean up.
    try {
      await this.worker.terminate();
    } catch {
      // Ignore termination errors.
    }

    this.worker = null;
  }
}

// ---------------------------------------------------------------------------
// Execution provider selection (duplicated from worker for the main process)
// ---------------------------------------------------------------------------

/**
 * Returns the preferred ONNX Runtime execution provider for the current
 * platform. The worker will attempt this provider first and fall back to
 * 'cpu' if it is unavailable.
 */
function getExecutionProvider(): string {
  // Force CPU for stability — CoreML can crash with large models on Apple Silicon
  return 'cpu';
}

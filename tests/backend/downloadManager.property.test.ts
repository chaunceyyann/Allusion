import * as fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

// Feature: image-auto-tagging, Property 10: Failed downloads leave no partial files

// Mock https and http modules before importing DownloadManager
jest.mock('https');
jest.mock('http');

import * as https from 'https';
import * as http from 'http';
import { DownloadManager } from '../../src/backend/DownloadManager';
import { ModelInfo } from '../../src/backend/autoTagTypes';

/**
 * Creates a mock HTTP response (readable stream) that emits `bytesToEmit` bytes
 * of data and then emits an error, simulating a network failure mid-transfer.
 */
function createFailingResponse(totalBytes: number, bytesToEmit: number): EventEmitter & { statusCode: number; headers: Record<string, string>; resume: () => void; pipe: (dest: any) => any; destroy: () => void } {
  const response = new EventEmitter() as any;
  response.statusCode = 200;
  response.headers = { 'content-length': String(totalBytes) };
  response.resume = jest.fn();
  response.destroy = jest.fn();
  response.pipe = jest.fn((dest: any) => {
    // Schedule data emission + error asynchronously so the caller can set up listeners
    setImmediate(() => {
      if (bytesToEmit > 0) {
        const chunk = Buffer.alloc(bytesToEmit, 0x41); // fill with 'A'
        response.emit('data', chunk);
        // Write the chunk to the destination stream if it's writable
        if (dest && typeof dest.write === 'function' && !dest.destroyed) {
          dest.write(chunk);
        }
      }
      // Emit error after partial data
      setImmediate(() => {
        response.emit('error', new Error('Simulated network failure'));
      });
    });
    return dest;
  });
  return response;
}

/**
 * **Validates: Requirements 14.5**
 *
 * Property 10: For any model download that fails at any point during the
 * transfer (network error at a random byte offset), the download directory
 * should contain no `.tmp` files and no partially written `model.onnx` or
 * `selected_tags.csv` files after the error handler completes.
 */
describe('Property 10: Failed downloads leave no partial files', () => {
  // Sample model infos from the catalog for the generator
  const sampleModels: ModelInfo[] = [
    {
      id: 'wd-v1-4-moat-tagger-v2',
      displayName: 'MOAT V2',
      architecture: 'MOAT',
      version: 'v2',
      huggingFaceRepo: 'SmilingWolf/wd-v1-4-moat-tagger-v2',
      inputSize: 448,
      isBundled: true,
    },
    {
      id: 'wd-v1-4-swinv2-tagger-v2',
      displayName: 'SwinV2 V2',
      architecture: 'SwinV2',
      version: 'v2',
      huggingFaceRepo: 'SmilingWolf/wd-v1-4-swinv2-tagger-v2',
      inputSize: 448,
      isBundled: false,
    },
    {
      id: 'wd-eva02-large-tagger-v3',
      displayName: 'EVA02-Large V3',
      architecture: 'EVA02-Large',
      version: 'v3',
      huggingFaceRepo: 'SmilingWolf/wd-eva02-large-tagger-v3',
      inputSize: 448,
      isBundled: false,
    },
  ];

  // Generator: pick a random model from the sample catalog
  const modelInfoArb = fc.constantFrom(...sampleModels);

  // Generator: random byte offset at which the download fails (0 = immediate failure, up to 10KB)
  const failByteOffsetArb = fc.integer({ min: 0, max: 10240 });

  // Generator: total file size (must be >= failByteOffset to make sense)
  const totalBytesArb = fc.integer({ min: 1024, max: 20480 });

  let tmpDir: string;

  beforeEach(() => {
    jest.restoreAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-cleanup-test-'));
  });

  afterEach(() => {
    // Clean up the temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  it('no .tmp files or partial model files remain after a network error at any byte offset', () => {
    fc.assert(
      fc.asyncProperty(
        modelInfoArb,
        failByteOffsetArb,
        totalBytesArb,
        async (modelInfo, failOffset, totalBytes) => {
          // Ensure failOffset doesn't exceed totalBytes
          const effectiveFailOffset = Math.min(failOffset, totalBytes - 1);

          // Create a unique dest directory for this model within the temp dir
          const destDir = path.join(tmpDir, modelInfo.id);

          // Set up the mock: https.get calls the callback with a failing response
          const mockedGet = jest.fn((_url: string, callback: (res: any) => void) => {
            const response = createFailingResponse(totalBytes, effectiveFailOffset);
            // Call the callback asynchronously to mimic real HTTP behavior
            setImmediate(() => callback(response));

            // Return a mock request object
            const req = new EventEmitter() as any;
            req.destroy = jest.fn();
            return req;
          });

          (https.get as jest.Mock) = mockedGet;
          (http.get as jest.Mock) = mockedGet;

          const manager = new DownloadManager();
          const progressCb = jest.fn();

          const result = await manager.downloadModel(modelInfo, destDir, progressCb);

          // The download should have failed
          expect(result.success).toBe(false);
          expect(result.modelId).toBe(modelInfo.id);
          expect(result.error).toBeDefined();

          // Verify cleanup: check the destination directory
          if (fs.existsSync(destDir)) {
            const entries = fs.readdirSync(destDir);

            // No .tmp files should remain
            const tmpFiles = entries.filter((e) => e.endsWith('.tmp'));
            expect(tmpFiles).toEqual([]);

            // No partial model.onnx or selected_tags.csv should remain
            // (these would only exist if the rename succeeded, which it shouldn't
            // since the download failed)
            const partialModelFiles = entries.filter(
              (e) => e === 'model.onnx' || e === 'selected_tags.csv',
            );
            expect(partialModelFiles).toEqual([]);
          }
          // If the directory doesn't exist at all, that's also fine — no partial files

          return true;
        },
      ),
      { numRuns: 20 },
    );
  });

  it('no .tmp files remain after failure at zero bytes (immediate error)', () => {
    fc.assert(
      fc.asyncProperty(modelInfoArb, async (modelInfo) => {
        const destDir = path.join(tmpDir, modelInfo.id + '-zero');

        // Mock: response emits error immediately with zero bytes
        const mockedGet = jest.fn((_url: string, callback: (res: any) => void) => {
          const response = createFailingResponse(5000, 0);
          setImmediate(() => callback(response));

          const req = new EventEmitter() as any;
          req.destroy = jest.fn();
          return req;
        });

        (https.get as jest.Mock) = mockedGet;
        (http.get as jest.Mock) = mockedGet;

        const manager = new DownloadManager();
        const result = await manager.downloadModel(modelInfo, destDir, jest.fn());

        expect(result.success).toBe(false);

        if (fs.existsSync(destDir)) {
          const entries = fs.readdirSync(destDir);
          const tmpFiles = entries.filter((e) => e.endsWith('.tmp'));
          expect(tmpFiles).toEqual([]);

          const modelFiles = entries.filter(
            (e) => e === 'model.onnx' || e === 'selected_tags.csv',
          );
          expect(modelFiles).toEqual([]);
        }

        return true;
      }),
      { numRuns: 20 },
    );
  });

  it('no .tmp files remain after HTTP error status codes', () => {
    // Generator: random HTTP error status code
    const errorStatusArb = fc.constantFrom(400, 403, 404, 500, 502, 503);

    fc.assert(
      fc.asyncProperty(modelInfoArb, errorStatusArb, async (modelInfo, statusCode) => {
        const destDir = path.join(tmpDir, modelInfo.id + '-http-' + statusCode);

        const mockedGet = jest.fn((_url: string, callback: (res: any) => void) => {
          const response = new EventEmitter() as any;
          response.statusCode = statusCode;
          response.headers = {};
          response.resume = jest.fn();
          response.destroy = jest.fn();
          response.pipe = jest.fn();

          setImmediate(() => callback(response));

          const req = new EventEmitter() as any;
          req.destroy = jest.fn();
          return req;
        });

        (https.get as jest.Mock) = mockedGet;
        (http.get as jest.Mock) = mockedGet;

        const manager = new DownloadManager();
        const result = await manager.downloadModel(modelInfo, destDir, jest.fn());

        expect(result.success).toBe(false);

        if (fs.existsSync(destDir)) {
          const entries = fs.readdirSync(destDir);
          const tmpFiles = entries.filter((e) => e.endsWith('.tmp'));
          expect(tmpFiles).toEqual([]);

          const modelFiles = entries.filter(
            (e) => e === 'model.onnx' || e === 'selected_tags.csv',
          );
          expect(modelFiles).toEqual([]);
        }

        return true;
      }),
      { numRuns: 20 },
    );
  });
});

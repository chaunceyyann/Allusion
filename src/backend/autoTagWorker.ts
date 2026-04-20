/**
 * Worker thread entry point for WD Tagger ONNX inference.
 *
 * Receives messages from the main process via `parentPort` and handles:
 * - `loadModel`: Creates an ONNX InferenceSession with platform-specific execution provider,
 *   parses the tag CSV, and caches the session for reuse.
 * - `infer`: Checks for a caption sidecar file first; otherwise preprocesses the image
 *   and runs ONNX inference, applies sigmoid, filters by thresholds.
 * - `dispose`: Releases the InferenceSession and signals completion.
 * - `getStatus`: Returns the current model state.
 */
import { parentPort } from 'worker_threads';
import * as ort from 'onnxruntime-node';
import * as fs from 'fs';
import * as path from 'path';

import {
  WorkerRequest,
  WorkerResponse,
  PredictedTag,
  TagMapping,
} from './autoTagTypes';
import { sigmoid, filterAndSortTags, parseTagCsvContent, parseCaptionContent } from './autoTagUtils';

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let session: ort.InferenceSession | null = null;
let tagMappings: TagMapping[] = [];
let isModelLoaded = false;
let isInferring = false;
let isSwitchingModel = false;
let activeModelPath: string | null = null;
let currentExecutionProvider: string | null = null;

// ---------------------------------------------------------------------------
// Execution provider selection
// ---------------------------------------------------------------------------

/**
 * Returns the preferred ONNX Runtime execution provider for the current
 * platform. The worker will attempt this provider first and fall back to
 * 'cpu' if it is unavailable.
 */
function getExecutionProvider(): string {
  // Force CPU for stability — CoreML can crash with large models on Apple Silicon
  // TODO: Re-enable CoreML once onnxruntime-node stabilizes on macOS ARM
  return 'cpu';
}

// ---------------------------------------------------------------------------
// Tag CSV parsing (stub — full implementation in task 4.4)
// ---------------------------------------------------------------------------

/**
 * Parses a `selected_tags.csv` file into an ordered array of TagMapping entries.
 * Delegates to the pure `parseTagCsvContent` utility for the actual parsing.
 */
function parseTagCsv(csvPath: string): TagMapping[] {
  const content = fs.readFileSync(csvPath, 'utf-8');
  return parseTagCsvContent(content);
}

// ---------------------------------------------------------------------------
// Caption file parsing (stub — full implementation in task 4.3)
// ---------------------------------------------------------------------------

/**
 * Checks for a `.txt` sidecar caption file alongside the image.
 * Returns parsed comma-separated tags, or `null` if no caption file exists.
 */
function parseCaptionFile(imagePath: string): string[] | null {
  const dir = path.dirname(imagePath);
  const base = path.basename(imagePath, path.extname(imagePath));
  const captionPath = path.join(dir, `${base}.txt`);

  if (!fs.existsSync(captionPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(captionPath, 'utf-8');
    return parseCaptionContent(content);
  } catch (err) {
    console.warn(`Failed to read caption file: ${captionPath}`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

function postResponse(response: WorkerResponse, requestId?: string): void {
  if (requestId !== undefined) {
    response.requestId = requestId;
  }
  parentPort?.postMessage(response);
}

/**
 * Loads an ONNX model with the preferred execution provider, falling back to
 * CPU if the preferred provider is unavailable. Parses the tag CSV and caches
 * the session for subsequent inference calls.
 */
async function handleLoadModel(
  modelPath: string,
  csvPath: string,
  requestedProvider: string,
  requestId?: string,
): Promise<void> {
  isSwitchingModel = true;

  try {
    // Dispose existing session if switching models
    if (session) {
      await session.release();
      session = null;
      isModelLoaded = false;
    }

    let usedProvider = requestedProvider;

    // Attempt preferred provider, fall back to CPU on failure
    try {
      session = await ort.InferenceSession.create(modelPath, {
        executionProviders: [requestedProvider],
      });
    } catch (providerError) {
      console.warn(
        `Failed to create session with ${requestedProvider}, falling back to cpu:`,
        providerError,
      );
      usedProvider = 'cpu';
      session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
      });
    }

    // Parse tag CSV
    tagMappings = parseTagCsv(csvPath);

    activeModelPath = modelPath;
    currentExecutionProvider = usedProvider;
    isModelLoaded = true;

    postResponse({
      type: 'modelLoaded',
      success: true,
      executionProvider: usedProvider,
    }, requestId);
  } catch (error) {
    isModelLoaded = false;
    session = null;
    activeModelPath = null;

    const message = error instanceof Error ? error.message : String(error);
    postResponse({
      type: 'modelLoaded',
      success: false,
      error: message,
      executionProvider: requestedProvider,
    }, requestId);
  } finally {
    isSwitchingModel = false;
  }
}

/**
 * Runs inference on a single image. Checks for a caption sidecar file first
 * (unless override is enabled). Otherwise preprocesses the image and runs
 * ONNX inference, applies sigmoid activation, and filters by thresholds.
 */
async function handleInfer(
  filePath: string,
  generalThreshold: number,
  characterThreshold: number,
  overrideCaptionFile: boolean,
  requestId?: string,
  tensorData?: Float32Array,
): Promise<void> {
  if (isSwitchingModel) {
    postResponse({
      type: 'error',
      message: 'Cannot run inference while model is being switched. Please wait.',
    }, requestId);
    return;
  }

  if (!isModelLoaded || !session) {
    postResponse({
      type: 'error',
      message: 'No model is loaded. Call loadModel first.',
    }, requestId);
    return;
  }

  isInferring = true;

  try {
    // Check for caption file first (unless override is enabled)
    if (!overrideCaptionFile) {
      const captionTags = parseCaptionFile(filePath);
      if (captionTags !== null) {
        const tags: PredictedTag[] = captionTags.map((name) => ({
          name,
          category: 'general' as const,
          score: 1.0,
        }));
        postResponse({ type: 'inferResult', tags, source: 'caption' }, requestId);
        return;
      }
    }

    // Use pre-processed tensor from main process
    if (!tensorData) {
      postResponse({
        type: 'inferResult',
        tags: [],
        source: 'model',
        error: 'No preprocessed tensor data provided. Image preprocessing must happen in the main process.',
      }, requestId);
      return;
    }
    const tensor = tensorData;

    // Create ONNX tensor — shape [1, 448, 448, 3]
    const inputTensor = new ort.Tensor('float32', tensor, [1, 448, 448, 3]);

    // Run inference — use the first input name from the model
    const inputNames = session.inputNames;
    const feeds: Record<string, ort.Tensor> = {};
    feeds[inputNames[0]] = inputTensor;

    const results = await session.run(feeds);

    // Get output tensor — use the first output name
    const outputNames = session.outputNames;
    const outputTensor = results[outputNames[0]];
    const scores = outputTensor.data as Float32Array;

    // Apply sigmoid and map to tag names
    const allTags: PredictedTag[] = [];
    for (let i = 0; i < tagMappings.length && i < scores.length; i++) {
      const mapping = tagMappings[i];
      const score = sigmoid(scores[i]);
      allTags.push({
        name: mapping.name,
        category: mapping.category,
        score,
      });
    }

    // Filter by thresholds, exclude ratings, sort by score
    const filteredTags = filterAndSortTags(allTags, generalThreshold, characterThreshold);

    postResponse({ type: 'inferResult', tags: filteredTags, source: 'model' }, requestId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postResponse({
      type: 'inferResult',
      tags: [],
      source: 'model',
      error: message,
    }, requestId);
  } finally {
    isInferring = false;
  }
}

/**
 * Disposes the current InferenceSession and signals completion.
 */
async function handleDispose(requestId?: string): Promise<void> {
  try {
    if (session) {
      await session.release();
      session = null;
    }
    isModelLoaded = false;
    activeModelPath = null;
    currentExecutionProvider = null;
    tagMappings = [];
  } catch (error) {
    console.error('Error disposing session:', error);
  }

  postResponse({ type: 'disposed' }, requestId);
}

/**
 * Returns the current worker state.
 */
function handleGetStatus(requestId?: string): void {
  postResponse({
    type: 'status',
    isModelLoaded,
    isInferring,
    activeModel: activeModelPath,
    executionProvider: currentExecutionProvider,
  }, requestId);
}

// ---------------------------------------------------------------------------
// Main message dispatcher
// ---------------------------------------------------------------------------

if (parentPort) {
  parentPort.on('message', async (message: WorkerRequest) => {
    const requestId = message.requestId;
    try {
      switch (message.type) {
        case 'loadModel':
          await handleLoadModel(message.modelPath, message.csvPath, message.executionProvider, requestId);
          break;

        case 'infer':
          await handleInfer(
            message.filePath,
            message.generalThreshold,
            message.characterThreshold,
            message.overrideCaptionFile,
            requestId,
            message.tensorData,
          );
          break;

        case 'dispose':
          await handleDispose(requestId);
          break;

        case 'getStatus':
          handleGetStatus(requestId);
          break;

        default:
          postResponse({
            type: 'error',
            message: `Unknown message type: ${(message as { type: string }).type}`,
          }, requestId);
          break;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      postResponse({ type: 'error', message: `Unhandled worker error: ${errorMessage}` }, requestId);
    }
  });
}

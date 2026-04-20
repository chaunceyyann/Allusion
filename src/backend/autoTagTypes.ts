// Shared type definitions for the WD Tagger auto-tagging system.
// Used by the worker thread, main process managers, and IPC bridge.

/** A predicted tag returned from model inference. */
export interface PredictedTag {
  name: string;
  category: 'general' | 'character' | 'rating';
  score: number;
}

/** Result of the image preprocessing step (448×448 BGR float32 tensor). */
export interface PreprocessResult {
  tensor: Float32Array;
  width: 448;
  height: 448;
}

/** A single entry from the parsed selected_tags.csv file. */
export interface TagMapping {
  index: number;
  name: string;
  category: 'general' | 'character' | 'rating';
}

/** Static metadata for a WD Tagger model variant in the catalog. */
export interface ModelInfo {
  id: string;
  displayName: string;
  architecture: string;
  version: 'v2' | 'v3';
  huggingFaceRepo: string;
  inputSize: number;
  isBundled: boolean;
}

/** ModelInfo extended with local availability and resolved file paths. */
export interface ModelAvailability extends ModelInfo {
  isAvailable: boolean;
  modelPath: string | null;
  csvPath: string | null;
}

/** Progress event emitted during a model download. */
export type DownloadProgress = {
  modelId: string;
  fileName: string;
  bytesDownloaded: number;
  totalBytes: number;
  percentage: number;
};

/** Result of a model download attempt. */
export type DownloadResult = {
  success: boolean;
  modelId: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Worker thread message types
// ---------------------------------------------------------------------------

/** Messages sent from the main process to the worker thread. */
export type WorkerRequest = (
  | { type: 'loadModel'; modelPath: string; csvPath: string; executionProvider: string }
  | {
      type: 'infer';
      filePath: string;
      generalThreshold: number;
      characterThreshold: number;
      overrideCaptionFile: boolean;
      /** Pre-processed tensor data (BGR float32, 602112 elements). If provided, skips sharp preprocessing in worker. */
      tensorData?: Float32Array;
    }
  | { type: 'dispose' }
  | { type: 'getStatus' }
) & {
  /** Optional correlation ID echoed back in the response. */
  requestId?: string;
};

/** Messages sent from the worker thread back to the main process. */
export type WorkerResponse = (
  | { type: 'modelLoaded'; success: boolean; error?: string; executionProvider: string }
  | { type: 'inferResult'; tags: PredictedTag[]; source: 'model' | 'caption'; error?: string }
  | { type: 'disposed' }
  | {
      type: 'status';
      isModelLoaded: boolean;
      isInferring: boolean;
      activeModel: string | null;
      executionProvider: string | null;
    }
  | { type: 'error'; message: string }
) & {
  /** Correlation ID echoed from the request. */
  requestId?: string;
};

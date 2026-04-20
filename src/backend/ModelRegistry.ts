import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { ModelInfo, ModelAvailability } from './autoTagTypes';

/**
 * Hardcoded catalog of all supported WD Tagger model variants.
 * Includes 5 V2 models and 3 V3 models from SmilingWolf on HuggingFace.
 */
const CATALOG: readonly ModelInfo[] = [
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
    id: 'wd-v1-4-convnextv2-tagger-v2',
    displayName: 'ConvNeXtV2 V2',
    architecture: 'ConvNeXtV2',
    version: 'v2',
    huggingFaceRepo: 'SmilingWolf/wd-v1-4-convnextv2-tagger-v2',
    inputSize: 448,
    isBundled: false,
  },
  {
    id: 'wd-v1-4-convnext-tagger-v2',
    displayName: 'ConvNeXt V2',
    architecture: 'ConvNeXt',
    version: 'v2',
    huggingFaceRepo: 'SmilingWolf/wd-v1-4-convnext-tagger-v2',
    inputSize: 448,
    isBundled: false,
  },
  {
    id: 'wd-v1-4-vit-tagger-v2',
    displayName: 'ViT V2',
    architecture: 'ViT',
    version: 'v2',
    huggingFaceRepo: 'SmilingWolf/wd-v1-4-vit-tagger-v2',
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
  {
    id: 'wd-vit-large-tagger-v3',
    displayName: 'ViT-Large V3',
    architecture: 'ViT-Large',
    version: 'v3',
    huggingFaceRepo: 'SmilingWolf/wd-vit-large-tagger-v3',
    inputSize: 448,
    isBundled: false,
  },
  {
    id: 'wd-vit-tagger-v3',
    displayName: 'ViT V3',
    architecture: 'ViT',
    version: 'v3',
    huggingFaceRepo: 'SmilingWolf/wd-vit-tagger-v3',
    inputSize: 448,
    isBundled: false,
  },
] as const;

const DEFAULT_MODEL_ID = 'wd-v1-4-moat-tagger-v2';
const MODEL_ONNX_FILENAME = 'model.onnx';
const TAG_CSV_FILENAME = 'selected_tags.csv';

/**
 * Tracks which WD Tagger models are available locally (bundled or downloaded)
 * and which model is currently active. Runs in the Electron main process.
 */
export class ModelRegistry {
  /** Hardcoded catalog of all supported models. */
  static readonly CATALOG: readonly ModelInfo[] = CATALOG;

  /** Currently active model identifier. */
  activeModelId: string = DEFAULT_MODEL_ID;

  /** Set of model IDs that have been confirmed present in the download directory. */
  private downloadedModelIds: Set<string> = new Set();

  /**
   * Resolve the local file paths for a model's ONNX file and tag CSV.
   *
   * Checks the bundled resources path first (for the default model), then the
   * user-data download directory. Returns `null` if neither location has both
   * required files.
   */
  resolveModelPaths(modelId: string): { modelPath: string; csvPath: string } | null {
    const catalogEntry = CATALOG.find((m) => m.id === modelId);
    if (!catalogEntry) {
      return null;
    }

    // Check bundled path first (only the default model is bundled)
    if (catalogEntry.isBundled) {
      const bundledModel = path.join(process.resourcesPath, 'models', modelId, MODEL_ONNX_FILENAME);
      const bundledCsv = path.join(process.resourcesPath, 'models', modelId, TAG_CSV_FILENAME);
      if (fs.existsSync(bundledModel) && fs.existsSync(bundledCsv)) {
        return { modelPath: bundledModel, csvPath: bundledCsv };
      }
    }

    // Check downloaded models directory
    const userDataModelsDir = path.join(app.getPath('userData'), 'models');
    const downloadedModel = path.join(userDataModelsDir, modelId, MODEL_ONNX_FILENAME);
    const downloadedCsv = path.join(userDataModelsDir, modelId, TAG_CSV_FILENAME);
    if (fs.existsSync(downloadedModel) && fs.existsSync(downloadedCsv)) {
      return { modelPath: downloadedModel, csvPath: downloadedCsv };
    }

    return null;
  }

  /**
   * Scan the downloaded models directory to determine which non-bundled models
   * have both required files present. Updates the internal set of available
   * downloaded model IDs.
   */
  scanDownloadedModels(): void {
    this.downloadedModelIds.clear();
    const userDataModelsDir = path.join(app.getPath('userData'), 'models');

    for (const model of CATALOG) {
      const modelPath = path.join(userDataModelsDir, model.id, MODEL_ONNX_FILENAME);
      const csvPath = path.join(userDataModelsDir, model.id, TAG_CSV_FILENAME);
      if (fs.existsSync(modelPath) && fs.existsSync(csvPath)) {
        this.downloadedModelIds.add(model.id);
      }
    }
  }

  /**
   * Return every model in the catalog annotated with its local availability
   * status and resolved file paths.
   */
  getModelsWithStatus(): ModelAvailability[] {
    return CATALOG.map((model) => {
      const resolved = this.resolveModelPaths(model.id);
      return {
        ...model,
        isAvailable: resolved !== null,
        modelPath: resolved?.modelPath ?? null,
        csvPath: resolved?.csvPath ?? null,
      };
    });
  }

  /**
   * Set the active model. The caller is responsible for triggering a model
   * reload in the worker thread after calling this method.
   *
   * @throws if the modelId is not found in the catalog.
   */
  setActiveModel(modelId: string): void {
    const exists = CATALOG.some((m) => m.id === modelId);
    if (!exists) {
      throw new Error(`Unknown model ID: ${modelId}. Must be one of the catalog entries.`);
    }
    this.activeModelId = modelId;
  }
}

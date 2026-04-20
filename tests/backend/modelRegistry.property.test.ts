import * as fc from 'fast-check';
import * as path from 'path';

// Feature: image-auto-tagging, Property 1: Model path resolution produces valid paths

// Mock electron before importing ModelRegistry
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(),
  },
}));

import { app } from 'electron';
import { ModelRegistry } from '../../src/backend/ModelRegistry';
import * as fs from 'fs';

/**
 * **Validates: Requirements 1.2, 1.4, 1.6**
 *
 * Property 1: For any valid base path (resourcesPath or userData path) and any
 * model identifier from the catalog, resolveModelPaths should return paths that:
 * (a) are rooted under the given base path
 * (b) end with the expected filenames (model.onnx and selected_tags.csv)
 * (c) include the model identifier as a path segment
 */
describe('Property 1: Model path resolution produces valid paths', () => {
  const catalogModelIds = ModelRegistry.CATALOG.map((m) => m.id);
  const bundledModelIds = ModelRegistry.CATALOG.filter((m) => m.isBundled).map((m) => m.id);
  const nonBundledModelIds = ModelRegistry.CATALOG.filter((m) => !m.isBundled).map((m) => m.id);

  // Generator for random base paths: non-empty strings that look like directory paths
  const segmentArb = fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'.split('')), { minLength: 1, maxLength: 12 })
    .map((chars) => chars.join(''));

  const basePathArb = fc
    .array(segmentArb, { minLength: 1, maxLength: 5 })
    .map((segments: string[]) => path.join('/', ...segments));

  let existsSyncSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();
    // Mock fs.existsSync to always return true so paths are resolved
    existsSyncSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('bundled model paths are rooted under resourcesPath, end with expected filenames, and include model ID', () => {
    if (bundledModelIds.length === 0) {
      return; // Skip if no bundled models in catalog
    }

    const modelIdArb = fc.constantFrom(...bundledModelIds);

    fc.assert(
      fc.property(basePathArb, modelIdArb, (basePath, modelId) => {
        // Set process.resourcesPath to the random base path
        const originalResourcesPath = process.resourcesPath;
        Object.defineProperty(process, 'resourcesPath', {
          value: basePath,
          writable: true,
          configurable: true,
        });

        try {
          const registry = new ModelRegistry();
          const result = registry.resolveModelPaths(modelId);

          // Since fs.existsSync is mocked to return true, result should not be null
          expect(result).not.toBeNull();

          if (result) {
            // (a) modelPath is rooted under the base path
            expect(result.modelPath.startsWith(basePath)).toBe(true);
            // (a) csvPath is rooted under the base path
            expect(result.csvPath.startsWith(basePath)).toBe(true);

            // (b) modelPath ends with model.onnx
            expect(path.basename(result.modelPath)).toBe('model.onnx');
            // (b) csvPath ends with selected_tags.csv
            expect(path.basename(result.csvPath)).toBe('selected_tags.csv');

            // (c) Both paths include the model ID as a path segment
            const modelPathSegments = result.modelPath.split(path.sep);
            expect(modelPathSegments).toContain(modelId);

            const csvPathSegments = result.csvPath.split(path.sep);
            expect(csvPathSegments).toContain(modelId);
          }

          return true;
        } finally {
          Object.defineProperty(process, 'resourcesPath', {
            value: originalResourcesPath,
            writable: true,
            configurable: true,
          });
        }
      }),
      { numRuns: 100 },
    );
  });

  it('downloaded (non-bundled) model paths are rooted under userData path, end with expected filenames, and include model ID', () => {
    if (nonBundledModelIds.length === 0) {
      return; // Skip if no non-bundled models in catalog
    }

    const modelIdArb = fc.constantFrom(...nonBundledModelIds);

    fc.assert(
      fc.property(basePathArb, modelIdArb, (basePath, modelId) => {
        // Mock app.getPath('userData') to return the random base path
        (app.getPath as jest.Mock).mockReturnValue(basePath);

        // Make bundled path check fail so it falls through to downloaded path
        existsSyncSpy.mockImplementation((filePath: string) => {
          // Return false for bundled paths (resourcesPath), true for userData paths
          if (typeof filePath === 'string' && filePath.startsWith(basePath)) {
            return true;
          }
          return false;
        });

        const registry = new ModelRegistry();
        const result = registry.resolveModelPaths(modelId);

        // Since fs.existsSync returns true for userData paths, result should not be null
        expect(result).not.toBeNull();

        if (result) {
          // (a) modelPath is rooted under the base path (userData)
          expect(result.modelPath.startsWith(basePath)).toBe(true);
          // (a) csvPath is rooted under the base path (userData)
          expect(result.csvPath.startsWith(basePath)).toBe(true);

          // (b) modelPath ends with model.onnx
          expect(path.basename(result.modelPath)).toBe('model.onnx');
          // (b) csvPath ends with selected_tags.csv
          expect(path.basename(result.csvPath)).toBe('selected_tags.csv');

          // (c) Both paths include the model ID as a path segment
          const modelPathSegments = result.modelPath.split(path.sep);
          expect(modelPathSegments).toContain(modelId);

          const csvPathSegments = result.csvPath.split(path.sep);
          expect(csvPathSegments).toContain(modelId);
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('all catalog model IDs produce valid paths when files exist', () => {
    const modelIdArb = fc.constantFrom(...catalogModelIds);

    fc.assert(
      fc.property(basePathArb, basePathArb, modelIdArb, (resourcesBase, userDataBase, modelId) => {
        // Set process.resourcesPath
        const originalResourcesPath = process.resourcesPath;
        Object.defineProperty(process, 'resourcesPath', {
          value: resourcesBase,
          writable: true,
          configurable: true,
        });

        // Mock app.getPath('userData')
        (app.getPath as jest.Mock).mockReturnValue(userDataBase);

        // Mock fs.existsSync to return true for all paths
        existsSyncSpy.mockReturnValue(true);

        try {
          const registry = new ModelRegistry();
          const result = registry.resolveModelPaths(modelId);

          // Should always resolve when files exist
          expect(result).not.toBeNull();

          if (result) {
            // (b) Correct filenames
            expect(path.basename(result.modelPath)).toBe('model.onnx');
            expect(path.basename(result.csvPath)).toBe('selected_tags.csv');

            // (c) Model ID is a path segment in both paths
            const modelPathSegments = result.modelPath.split(path.sep);
            expect(modelPathSegments).toContain(modelId);

            const csvPathSegments = result.csvPath.split(path.sep);
            expect(csvPathSegments).toContain(modelId);

            // (a) Path is rooted under one of the base paths
            const isUnderResources = result.modelPath.startsWith(resourcesBase);
            const isUnderUserData = result.modelPath.startsWith(userDataBase);
            expect(isUnderResources || isUnderUserData).toBe(true);
          }

          return true;
        } finally {
          Object.defineProperty(process, 'resourcesPath', {
            value: originalResourcesPath,
            writable: true,
            configurable: true,
          });
        }
      }),
      { numRuns: 100 },
    );
  });
});


// Feature: image-auto-tagging, Property 2: Model availability scanning matches file system state

/**
 * **Validates: Requirements 1.5**
 *
 * Property 2: For any set of model subdirectories in the Downloaded_Model_Store
 * where each subdirectory either contains both model.onnx and selected_tags.csv
 * or is missing one or both, scanDownloadedModels should report a model as
 * available if and only if both required files are present in its subdirectory.
 */
describe('Property 2: Model availability scanning matches file system state', () => {
  const catalog = ModelRegistry.CATALOG;

  /**
   * Generator: for each model in the catalog, randomly decide whether
   * model.onnx exists (boolean) and whether selected_tags.csv exists (boolean).
   * Produces a record mapping model ID → { hasOnnx, hasCsv }.
   */
  const fileStateArb = fc.record(
    Object.fromEntries(
      catalog.map((m) => [
        m.id,
        fc.record({
          hasOnnx: fc.boolean(),
          hasCsv: fc.boolean(),
        }),
      ]),
    ),
  ) as fc.Arbitrary<Record<string, { hasOnnx: boolean; hasCsv: boolean }>>;

  // Generator for a random userData base path
  const segmentArb = fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'.split('')), { minLength: 1, maxLength: 12 })
    .map((chars) => chars.join(''));

  const basePathArb = fc
    .array(segmentArb, { minLength: 1, maxLength: 5 })
    .map((segments: string[]) => path.join('/', ...segments));

  let existsSyncSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();
    existsSyncSpy = jest.spyOn(fs, 'existsSync');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a model is available iff both model.onnx and selected_tags.csv exist', () => {
    fc.assert(
      fc.property(basePathArb, fileStateArb, (userDataBase, fileStates) => {
        // Mock app.getPath('userData') to return the random base path
        (app.getPath as jest.Mock).mockReturnValue(userDataBase);

        // Set a distinct resourcesPath so bundled path checks don't collide
        const resourcesBase = '/bundled-resources-path';
        const originalResourcesPath = process.resourcesPath;
        Object.defineProperty(process, 'resourcesPath', {
          value: resourcesBase,
          writable: true,
          configurable: true,
        });

        try {
          // Mock fs.existsSync based on the generated file states.
          // For bundled models, we return false for the bundled path so that
          // resolveModelPaths falls through to the downloaded path check,
          // letting us control availability purely via the generated state.
          existsSyncSpy.mockImplementation((filePath: string) => {
            const filePathStr = String(filePath);

            // Reject bundled resource paths — force all models through the
            // userData/downloaded path so we can control them uniformly.
            if (filePathStr.startsWith(resourcesBase)) {
              return false;
            }

            // Match against userData model paths
            for (const model of catalog) {
              const modelOnnxPath = path.join(userDataBase, 'models', model.id, 'model.onnx');
              const modelCsvPath = path.join(userDataBase, 'models', model.id, 'selected_tags.csv');

              if (filePathStr === modelOnnxPath) {
                return fileStates[model.id].hasOnnx;
              }
              if (filePathStr === modelCsvPath) {
                return fileStates[model.id].hasCsv;
              }
            }

            return false;
          });

          const registry = new ModelRegistry();
          registry.scanDownloadedModels();
          const modelsWithStatus = registry.getModelsWithStatus();

          // Verify: each model is available iff both files exist
          for (const modelStatus of modelsWithStatus) {
            const state = fileStates[modelStatus.id];
            const expectedAvailable = state.hasOnnx && state.hasCsv;

            expect(modelStatus.isAvailable).toBe(expectedAvailable);

            // If available, paths should be non-null; if not, paths should be null
            if (expectedAvailable) {
              expect(modelStatus.modelPath).not.toBeNull();
              expect(modelStatus.csvPath).not.toBeNull();
            } else {
              expect(modelStatus.modelPath).toBeNull();
              expect(modelStatus.csvPath).toBeNull();
            }
          }

          return true;
        } finally {
          Object.defineProperty(process, 'resourcesPath', {
            value: originalResourcesPath,
            writable: true,
            configurable: true,
          });
        }
      }),
      { numRuns: 100 },
    );
  });

  it('models with only model.onnx (missing csv) are reported as unavailable', () => {
    fc.assert(
      fc.property(basePathArb, (userDataBase) => {
        (app.getPath as jest.Mock).mockReturnValue(userDataBase);

        const resourcesBase = '/bundled-resources-path';
        const originalResourcesPath = process.resourcesPath;
        Object.defineProperty(process, 'resourcesPath', {
          value: resourcesBase,
          writable: true,
          configurable: true,
        });

        try {
          // All models have model.onnx but NOT selected_tags.csv
          existsSyncSpy.mockImplementation((filePath: string) => {
            const filePathStr = String(filePath);
            if (filePathStr.startsWith(resourcesBase)) {
              return false;
            }
            // Only .onnx files exist
            return filePathStr.endsWith('model.onnx');
          });

          const registry = new ModelRegistry();
          registry.scanDownloadedModels();
          const modelsWithStatus = registry.getModelsWithStatus();

          for (const modelStatus of modelsWithStatus) {
            expect(modelStatus.isAvailable).toBe(false);
            expect(modelStatus.modelPath).toBeNull();
            expect(modelStatus.csvPath).toBeNull();
          }

          return true;
        } finally {
          Object.defineProperty(process, 'resourcesPath', {
            value: originalResourcesPath,
            writable: true,
            configurable: true,
          });
        }
      }),
      { numRuns: 100 },
    );
  });

  it('models with only selected_tags.csv (missing onnx) are reported as unavailable', () => {
    fc.assert(
      fc.property(basePathArb, (userDataBase) => {
        (app.getPath as jest.Mock).mockReturnValue(userDataBase);

        const resourcesBase = '/bundled-resources-path';
        const originalResourcesPath = process.resourcesPath;
        Object.defineProperty(process, 'resourcesPath', {
          value: resourcesBase,
          writable: true,
          configurable: true,
        });

        try {
          // All models have selected_tags.csv but NOT model.onnx
          existsSyncSpy.mockImplementation((filePath: string) => {
            const filePathStr = String(filePath);
            if (filePathStr.startsWith(resourcesBase)) {
              return false;
            }
            return filePathStr.endsWith('selected_tags.csv');
          });

          const registry = new ModelRegistry();
          registry.scanDownloadedModels();
          const modelsWithStatus = registry.getModelsWithStatus();

          for (const modelStatus of modelsWithStatus) {
            expect(modelStatus.isAvailable).toBe(false);
            expect(modelStatus.modelPath).toBeNull();
            expect(modelStatus.csvPath).toBeNull();
          }

          return true;
        } finally {
          Object.defineProperty(process, 'resourcesPath', {
            value: originalResourcesPath,
            writable: true,
            configurable: true,
          });
        }
      }),
      { numRuns: 100 },
    );
  });
});

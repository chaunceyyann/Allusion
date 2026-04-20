import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ButtonGroup, IconSet, Toggle } from 'widgets';
import { Callout } from 'widgets/notifications';
import { useStore } from '../../contexts/StoreContext';
import { RendererMessenger } from 'src/ipc/renderer';
import type { ModelAvailability, DownloadProgress } from 'src/ipc/messages';

// localStorage keys
const AUTO_TAG_ON_IMPORT_KEY = 'autoTagOnImport';
const AUTO_TAG_ON_LOAD_KEY = 'autoTagOnLoad';
const AUTO_TAG_GENERAL_THRESHOLD_KEY = 'autoTagGeneralThreshold';
const AUTO_TAG_CHARACTER_THRESHOLD_KEY = 'autoTagCharacterThreshold';
const AUTO_TAG_OVERRIDE_CAPTION_KEY = 'autoTagOverrideCaptionFile';
const AUTO_TAG_ACTIVE_MODEL_KEY = 'autoTagActiveModel';

const DEFAULT_GENERAL_THRESHOLD = 0.25;
const DEFAULT_CHARACTER_THRESHOLD = 1.0;

export const AutoTagging = observer(() => {
  const { fileStore, tagStore, autoTagger } = useStore();

  // --- Model list state ---
  const [models, setModels] = useState<ModelAvailability[]>([]);
  const [activeModelId, setActiveModelId] = useState(
    () => localStorage.getItem(AUTO_TAG_ACTIVE_MODEL_KEY) ?? 'wd-v1-4-moat-tagger-v2',
  );

  // --- Download state ---
  const [downloadingModelId, setDownloadingModelId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);

  // --- Toggle states ---
  const [autoTagOnImport, setAutoTagOnImport] = useState(
    () => localStorage.getItem(AUTO_TAG_ON_IMPORT_KEY) === 'true',
  );
  const [autoTagOnLoad, setAutoTagOnLoad] = useState(
    () => localStorage.getItem(AUTO_TAG_ON_LOAD_KEY) === 'true',
  );
  const [overrideCaptionFile, setOverrideCaptionFile] = useState(
    () => localStorage.getItem(AUTO_TAG_OVERRIDE_CAPTION_KEY) === 'true',
  );

  // --- Threshold states ---
  const [generalThreshold, setGeneralThreshold] = useState(() => {
    const stored = localStorage.getItem(AUTO_TAG_GENERAL_THRESHOLD_KEY);
    return stored !== null ? parseFloat(stored) : DEFAULT_GENERAL_THRESHOLD;
  });
  const [characterThreshold, setCharacterThreshold] = useState(() => {
    const stored = localStorage.getItem(AUTO_TAG_CHARACTER_THRESHOLD_KEY);
    return stored !== null ? parseFloat(stored) : DEFAULT_CHARACTER_THRESHOLD;
  });

  // Track whether we've done the initial fetch
  const didFetchRef = useRef(false);

  // Fetch model list and status on mount
  useEffect(() => {
    if (didFetchRef.current) return;
    didFetchRef.current = true;

    const fetchModels = async () => {
      try {
        const response = await RendererMessenger.autoTagGetModels();
        setModels(response.models);
        setActiveModelId(response.activeModelId);
        localStorage.setItem(AUTO_TAG_ACTIVE_MODEL_KEY, response.activeModelId);
      } catch (err) {
        console.error('Failed to fetch model list:', err);
      }
    };

    fetchModels();
    autoTagger.refreshStatus();
  }, [autoTagger]);

  // Listen for download progress events
  useEffect(() => {
    const handler = (progress: DownloadProgress) => {
      setDownloadProgress(progress.percentage);
    };
    RendererMessenger.onAutoTagDownloadProgress(handler);
  }, []);

  // --- Handlers ---

  const refreshModelList = useCallback(async () => {
    try {
      const response = await RendererMessenger.autoTagGetModels();
      setModels(response.models);
      setActiveModelId(response.activeModelId);
      localStorage.setItem(AUTO_TAG_ACTIVE_MODEL_KEY, response.activeModelId);
    } catch (err) {
      console.error('Failed to refresh model list:', err);
    }
  }, []);

  const handleModelSelect = useCallback(
    async (event: React.ChangeEvent<HTMLSelectElement>) => {
      const modelId = event.target.value;
      const model = models.find((m) => m.id === modelId);
      if (!model || !model.isAvailable) return;

      setActiveModelId(modelId);
      localStorage.setItem(AUTO_TAG_ACTIVE_MODEL_KEY, modelId);

      try {
        const status = await RendererMessenger.autoTagLoadModel();
        autoTagger.refreshStatus();
        if (!status.isModelLoaded) {
          console.warn('Model switch did not complete successfully');
        }
      } catch (err) {
        console.error('Failed to switch model:', err);
      }
    },
    [models, autoTagger],
  );

  const handleDownloadModel = useCallback(
    async (modelId: string) => {
      setDownloadingModelId(modelId);
      setDownloadProgress(0);

      try {
        const result = await RendererMessenger.autoTagDownloadModel(modelId);
        if (result.success) {
          await refreshModelList();
          await autoTagger.refreshStatus();
        } else {
          console.error('Download failed:', result.error);
          alert(`Download failed: ${result.error ?? 'Unknown error'}`);
        }
      } catch (err) {
        console.error('Download error:', err);
        alert('Failed to download model. Check DevTools for details.');
      } finally {
        setDownloadingModelId(null);
        setDownloadProgress(0);
      }
    },
    [refreshModelList, autoTagger],
  );

  const toggleAutoTagOnImport = useCallback((value: boolean) => {
    setAutoTagOnImport(value);
    localStorage.setItem(AUTO_TAG_ON_IMPORT_KEY, String(value));
  }, []);

  const toggleAutoTagOnLoad = useCallback((value: boolean) => {
    setAutoTagOnLoad(value);
    localStorage.setItem(AUTO_TAG_ON_LOAD_KEY, String(value));
  }, []);

  const toggleOverrideCaptionFile = useCallback((value: boolean) => {
    setOverrideCaptionFile(value);
    localStorage.setItem(AUTO_TAG_OVERRIDE_CAPTION_KEY, String(value));
  }, []);

  const handleGeneralThresholdChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(event.target.value);
      setGeneralThreshold(value);
      localStorage.setItem(AUTO_TAG_GENERAL_THRESHOLD_KEY, String(value));
    },
    [],
  );

  const handleCharacterThresholdChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(event.target.value);
      setCharacterThreshold(value);
      localStorage.setItem(AUTO_TAG_CHARACTER_THRESHOLD_KEY, String(value));
    },
    [],
  );

  const handleLoadModel = useCallback(async () => {
    await autoTagger.loadModel();
  }, [autoTagger]);

  const handleBulkAutoTag = useCallback(async () => {
    const numFiles = fileStore.fileList.length;
    if (numFiles === 0) {
      alert('No images in your library to auto-tag.');
      return;
    }

    const confirmed = window.confirm(
      `This will auto-tag all ${numFiles} images in your library using image classification.\n\n` +
        'New tags will be created automatically based on detected content.\n\n' +
        'This may take a while for large libraries. Continue?',
    );

    if (confirmed) {
      await autoTagger.bulkAutoTag(fileStore.fileList, tagStore);
    }
  }, [fileStore, tagStore, autoTagger]);

  // Group models by version
  const v2Models = models.filter((m) => m.version === 'v2');
  const v3Models = models.filter((m) => m.version === 'v3');

  return (
    <>
      <h3>Automatic Image Tagging</h3>
      <Callout icon={IconSet.INFO}>
        Auto-tagging uses WD Tagger models (ONNX) to classify your images and automatically assign
        descriptive tags. These models run locally on your machine and are optimized for anime and
        illustration content. No data is sent to external servers.
      </Callout>

      <h4>Model Status</h4>
      <p>
        {autoTagger.isModelLoaded
          ? `✅ Model loaded — running on ${autoTagger.executionProvider ?? 'unknown'} provider.`
          : '⏳ Model is not loaded yet.'}
      </p>
      {!autoTagger.isModelLoaded && (
        <Button
          text="Load Model"
          onClick={handleLoadModel}
          styling="outlined"
          icon={IconSet.RELOAD}
        />
      )}

      <h4>Model Selection</h4>
      <label>
        Active Model
        <select value={activeModelId} onChange={handleModelSelect}>
          <optgroup label="V2 Models">
            {v2Models.map((model) => (
              <option
                key={model.id}
                value={model.id}
                disabled={!model.isAvailable}
              >
                {model.displayName}
                {model.isBundled ? ' (Bundled)' : model.isAvailable ? ' ✓' : ' — Not Downloaded'}
              </option>
            ))}
          </optgroup>
          <optgroup label="V3 Models">
            {v3Models.map((model) => (
              <option
                key={model.id}
                value={model.id}
                disabled={!model.isAvailable}
              >
                {model.displayName}
                {model.isAvailable ? ' ✓' : ' — Not Downloaded'}
              </option>
            ))}
          </optgroup>
        </select>
      </label>

      {models.length > 0 && (
        <div style={{ marginTop: '8px' }}>
          <p style={{ marginBottom: '4px' }}>Download additional models:</p>
          <div className="vstack">
            {models
              .filter((m) => !m.isAvailable)
              .map((model) => {
                const isDownloading = downloadingModelId === model.id;
                return (
                  <div key={model.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ minWidth: '140px' }}>{model.displayName}</span>
                    {isDownloading ? (
                      <span style={{ fontSize: '0.9em' }}>
                        Downloading… {downloadProgress.toFixed(0)}%
                      </span>
                    ) : (
                      <Button
                        text="Download"
                        onClick={() => handleDownloadModel(model.id)}
                        styling="outlined"
                        icon={IconSet.IMPORT}
                        disabled={downloadingModelId !== null}
                      />
                    )}
                  </div>
                );
              })}
            {models.every((m) => m.isAvailable) && (
              <p style={{ fontStyle: 'italic' }}>All models are downloaded.</p>
            )}
          </div>
        </div>
      )}

      <h4>Thresholds</h4>
      <label>
        General Threshold: {generalThreshold.toFixed(2)}
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={generalThreshold}
          onChange={handleGeneralThresholdChange}
          style={{ width: '100%' }}
        />
      </label>
      <label>
        Character Threshold: {characterThreshold.toFixed(2)}
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={characterThreshold}
          onChange={handleCharacterThresholdChange}
          style={{ width: '100%' }}
        />
      </label>

      <h4>Tagging Triggers</h4>
      <div className="vstack">
        <Toggle checked={autoTagOnImport} onChange={toggleAutoTagOnImport}>
          Auto-tag when importing images
        </Toggle>
        <Toggle checked={autoTagOnLoad} onChange={toggleAutoTagOnLoad}>
          Auto-tag when loading images
        </Toggle>
      </div>

      <h4>Caption Files</h4>
      <Toggle checked={overrideCaptionFile} onChange={toggleOverrideCaptionFile}>
        Override caption file (always use model inference even when a .txt sidecar exists)
      </Toggle>

      <h4>Bulk Auto-Tag Library</h4>
      <p>
        Run auto-tagging on all {fileStore.numTotalFiles} images currently in your library. Tags
        will be created and assigned based on detected image content.
      </p>
      <ButtonGroup>
        <Button
          text={
            autoTagger.isProcessing
              ? `Processing… (${autoTagger.progress} / ${autoTagger.totalToProcess})`
              : 'Auto-Tag All Images'
          }
          onClick={handleBulkAutoTag}
          styling="filled"
          icon={IconSet.TAG}
          disabled={autoTagger.isProcessing}
        />
      </ButtonGroup>

      {autoTagger.isProcessing && (
        <div style={{ marginTop: '8px' }}>
          <progress
            value={autoTagger.progress}
            max={autoTagger.totalToProcess}
            style={{ width: '100%' }}
          />
        </div>
      )}
    </>
  );
});

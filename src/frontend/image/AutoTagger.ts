import { action, makeObservable, observable, runInAction } from 'mobx';
import { ClientFile } from '../entities/File';
import { ClientTag } from '../entities/Tag';
import TagStore from '../stores/TagStore';
import { AppToaster } from '../components/Toaster';
import { RendererMessenger } from '../../ipc/renderer';
import { normalizeTagName, findExistingTag } from './tagMapper';

/**
 * Image auto-tagger service.
 *
 * Delegates inference to the main process via IPC, which runs ONNX-based
 * WD Tagger models in a dedicated Worker Thread. The renderer never loads
 * the model directly — it only sends requests and maps returned tags into
 * Allusion's tag system.
 */
class AutoTagger {
  @observable isModelLoaded = false;
  @observable isProcessing = false;
  @observable progress = 0;
  @observable totalToProcess = 0;
  @observable executionProvider: string | null = null;

  constructor() {
    makeObservable(this);
  }

  /**
   * Load the model via IPC (triggers worker thread model load in the main process).
   * Returns true if the model loaded successfully.
   */
  async loadModel(): Promise<boolean> {
    if (this.isModelLoaded) {
      return true;
    }

    try {
      AppToaster.show(
        { message: 'Loading image classification model...', timeout: 0 },
        'auto-tag-model',
      );

      const status = await RendererMessenger.autoTagLoadModel();

      runInAction(() => {
        this.isModelLoaded = status.isModelLoaded;
        this.executionProvider = status.executionProvider;
      });

      if (status.isModelLoaded) {
        AppToaster.show(
          { message: 'Image classification model loaded.', timeout: 3000 },
          'auto-tag-model',
        );
        return true;
      } else {
        AppToaster.show(
          { message: 'Failed to load auto-tagging model.', timeout: 10000 },
          'auto-tag-model',
        );
        return false;
      }
    } catch (err) {
      console.error('Failed to load auto-tagging model:', err);
      AppToaster.show(
        {
          message: 'Failed to load auto-tagging model. Check DevTools for details.',
          timeout: 10000,
        },
        'auto-tag-model',
      );
      return false;
    }
  }

  /**
   * Auto-tag a single file: infer via IPC, then map tags to TagStore.
   *
   * Tag mapping logic:
   * 1. Call RendererMessenger.autoTagInfer() with file path and thresholds from localStorage
   * 2. For each returned tag name:
   *    a. Replace underscores with spaces
   *    b. Case-insensitive search in tagStore.findByName()
   *    c. If found, assign existing tag
   *    d. If not found, create new tag under root, then assign
   */
  async autoTagFile(file: ClientFile, tagStore: TagStore): Promise<void> {
    const generalThreshold = parseFloat(
      localStorage.getItem('autoTagGeneralThreshold') ?? '0.25',
    );
    const characterThreshold = parseFloat(
      localStorage.getItem('autoTagCharacterThreshold') ?? '1.0',
    );
    const overrideCaptionFile =
      localStorage.getItem('autoTagOverrideCaptionFile') === 'true';

    const response = await RendererMessenger.autoTagInfer({
      filePath: file.absolutePath,
      generalThreshold,
      characterThreshold,
      overrideCaptionFile,
    });

    if (response.error) {
      console.error(`Auto-tag inference error for ${file.absolutePath}:`, response.error);
      return;
    }

    if (response.tags.length === 0) {
      return;
    }

    for (const predictedTag of response.tags) {
      const normalizedName = normalizeTagName(predictedTag.name);

      // Case-insensitive search for existing tag
      const existingTag = findExistingTag(normalizedName, tagStore.tagList);

      if (existingTag) {
        runInAction(() => {
          file.addTag(existingTag);
        });
      } else {
        try {
          const newTag = await tagStore.create(tagStore.root, normalizedName);
          runInAction(() => {
            file.addTag(newTag);
          });
        } catch (err) {
          console.error(`Failed to create tag "${normalizedName}":`, err);
        }
      }
    }
  }

  /**
   * Bulk auto-tag all provided files with progress tracking.
   * Handles individual file errors gracefully (logs and continues).
   */
  async bulkAutoTag(files: readonly ClientFile[], tagStore: TagStore): Promise<void> {
    const loaded = await this.loadModel();
    if (!loaded) return;

    const total = files.length;
    if (total === 0) {
      AppToaster.show({ message: 'No images to auto-tag.', timeout: 3000 }, 'auto-tag-bulk');
      return;
    }

    runInAction(() => {
      this.isProcessing = true;
      this.progress = 0;
      this.totalToProcess = total;
    });

    const toastKey = 'auto-tag-bulk';

    try {
      for (let i = 0; i < total; i++) {
        const file = files[i];

        AppToaster.show(
          {
            message: `Auto-tagging images: ${i + 1} / ${total} (${((100 * (i + 1)) / total).toFixed(0)}%)`,
            timeout: 0,
          },
          toastKey,
        );

        try {
          await this.autoTagFile(file, tagStore);
        } catch (err) {
          console.error(`Failed to auto-tag file ${file.absolutePath}:`, err);
          // Continue processing remaining files
        }

        runInAction(() => {
          this.progress = i + 1;
        });
      }

      AppToaster.show(
        { message: `Auto-tagging complete. Processed ${total} images.`, timeout: 5000 },
        toastKey,
      );
    } catch (err) {
      console.error('Bulk auto-tagging failed:', err);
      AppToaster.show(
        { message: 'Auto-tagging encountered an error. Check DevTools for details.', timeout: 5000 },
        toastKey,
      );
    } finally {
      runInAction(() => {
        this.isProcessing = false;
      });
    }
  }

  /**
   * Refresh model status from the main process.
   */
  async refreshStatus(): Promise<void> {
    try {
      const status = await RendererMessenger.autoTagGetStatus();
      runInAction(() => {
        this.isModelLoaded = status.isModelLoaded;
        this.executionProvider = status.executionProvider;
      });
    } catch (err) {
      console.error('Failed to refresh auto-tagger status:', err);
    }
  }
}

export default AutoTagger;

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

  private cancelRequested = false;

  constructor() {
    makeObservable(this);
  }

  /** Request cancellation of the current bulk tagging operation. */
  cancelBulkAutoTag(): void {
    this.cancelRequested = true;
  }

  /**
   * Load the model via IPC (triggers worker thread model load in the main process).
   * Returns true if the model loaded successfully.
   */
  async loadModel(executionProvider?: string): Promise<boolean> {
    // Allow reload by not short-circuiting when provider is specified
    if (this.isModelLoaded && !executionProvider) {
      return true;
    }

    try {
      AppToaster.show(
        { message: 'Loading image classification model...', timeout: 0 },
        'auto-tag-model',
      );

      const status = await RendererMessenger.autoTagLoadModel(executionProvider);

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
    console.log(`[AutoTagger] autoTagFile called for: ${file.absolutePath}`);
    console.log(`[AutoTagger] Current tags on file: ${file.tags.size}`);
    console.trace('[AutoTagger] Call stack');

    const generalThreshold = parseFloat(
      localStorage.getItem('autoTagGeneralThreshold') ?? '0.25',
    );
    const characterThreshold = parseFloat(
      localStorage.getItem('autoTagCharacterThreshold') ?? '1.0',
    );
    const overrideCaptionFile =
      localStorage.getItem('autoTagOverrideCaptionFile') === 'true';

    console.log(`[AutoTagger] Sending inference request (threshold: ${generalThreshold})`);

    const response = await RendererMessenger.autoTagInfer({
      filePath: file.absolutePath,
      generalThreshold,
      characterThreshold,
      overrideCaptionFile,
    });

    if (response.error) {
      console.error(`[AutoTagger] Inference error for ${file.absolutePath}:`, response.error);
      return;
    }

    if (response.tags.length === 0) {
      console.log(`[AutoTagger] No tags returned, done.`);
      return;
    }

    // Limit to top 20 tags max to avoid flooding
    const MAX_TAGS = 20;
    const tagsToApply = response.tags.slice(0, MAX_TAGS);

    console.log(`[AutoTagger] Applying ${tagsToApply.length} tags (of ${response.tags.length} returned): ${tagsToApply.slice(0, 5).map(t => t.name).join(', ')}...`);

    // Separate existing tags from new ones that need creation
    const existingTags: any[] = [];
    const newTagNames: string[] = [];

    runInAction(() => {
      for (const predictedTag of tagsToApply) {
        const normalizedName = normalizeTagName(predictedTag.name);
        const existingTag = findExistingTag(normalizedName, tagStore.tagList);
        if (existingTag) {
          existingTags.push(existingTag);
        } else {
          newTagNames.push(normalizedName);
        }
      }
    });

    // Create all new tags in parallel
    const root = runInAction(() => tagStore.root);
    const createdTags = await Promise.all(
      newTagNames.map(async (name) => {
        try {
          return await tagStore.create(root, name);
        } catch (err) {
          console.error(`[AutoTagger] Failed to create tag "${name}":`, err);
          return null;
        }
      }),
    );

    // Assign all tags (existing + newly created) in a single action
    runInAction(() => {
      for (const tag of existingTags) {
        file.addTag(tag);
      }
      for (const tag of createdTags) {
        if (tag) {
          file.addTag(tag);
        }
      }
    });

    console.log(`[AutoTagger] Done. Applied ${existingTags.length} existing + ${createdTags.filter(Boolean).length} new tags.`);
  }

  /**
   * Bulk auto-tag all provided files with progress tracking.
   * Handles individual file errors gracefully (logs and continues).
   */
  async bulkAutoTag(files: readonly ClientFile[], tagStore: TagStore): Promise<void> {
    const loaded = await this.loadModel();
    if (!loaded) return;

    // Snapshot the file list to avoid issues with MobX array mutations during iteration
    const fileSnapshot = [...files];
    const total = fileSnapshot.length;
    if (total === 0) {
      AppToaster.show({ message: 'No images to auto-tag.', timeout: 3000 }, 'auto-tag-bulk');
      return;
    }

    runInAction(() => {
      this.isProcessing = true;
      this.progress = 0;
      this.totalToProcess = total;
    });

    this.cancelRequested = false;
    const toastKey = 'auto-tag-bulk';

    try {
      for (let i = 0; i < total; i++) {
        if (this.cancelRequested) {
          AppToaster.show(
            { message: `Auto-tagging stopped. Processed ${i} of ${total} images.`, timeout: 5000 },
            toastKey,
          );
          break;
        }

        const file = fileSnapshot[i];

        // Skip files that already have tags
        if (file.tags.size > 0) {
          runInAction(() => {
            this.progress = i + 1;
          });
          continue;
        }

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

import * as sharp from 'sharp';
import { PreprocessResult } from './autoTagTypes';

/**
 * Preprocesses an image for WD Tagger inference using sharp.
 * Resizes to 448×448 with aspect-ratio-preserving padding (white),
 * removes alpha, and converts RGB uint8 to BGR float32.
 *
 * Accepts either a file path (string) or a Buffer.
 *
 * NOTE: This must run in the main process, NOT in a worker thread,
 * due to V8 sandbox restrictions in Electron 21+.
 */
export async function preprocessImage(input: string | Buffer): Promise<PreprocessResult> {
  const TARGET_SIZE = 448;

  const { data } = await (sharp as any)(input)
    .resize(TARGET_SIZE, TARGET_SIZE, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Convert RGB uint8 to BGR float32
  const float32 = new Float32Array(1 * TARGET_SIZE * TARGET_SIZE * 3);
  for (let i = 0; i < TARGET_SIZE * TARGET_SIZE; i++) {
    const srcIdx = i * 3;
    const dstIdx = i * 3;
    float32[dstIdx + 0] = data[srcIdx + 2]; // B
    float32[dstIdx + 1] = data[srcIdx + 1]; // G
    float32[dstIdx + 2] = data[srcIdx + 0]; // R
  }

  return { tensor: float32, width: TARGET_SIZE, height: TARGET_SIZE };
}

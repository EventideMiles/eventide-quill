/**
 * Image helpers for the vision subsystem. Decodes raw image bytes, downscales
 * to a bounded dimension, and re-encodes as JPEG base64 (no `data:` prefix)
 * so payloads stay small enough for local-model context budgets.
 *
 * Uses `createImageBitmap` where available (desktop Electron + most Capacitor
 * builds) and falls back to an `Image` element + object URL.
 */

/** A decoded image source that can be drawn onto a canvas. */
type DecodedImage = ImageBitmap | HTMLImageElement;

/**
 * Decode raw image bytes, downscale so the longest side is at most
 * `maxDimension`, and re-encode as JPEG base64 (no `data:` prefix).
 *
 * @param bytes        Raw image bytes from a download.
 * @param maxDimension Cap on the longest side (preserves aspect ratio).
 * @param contentType  MIME type hint for decoding (defaults to JPEG).
 */
export async function downscaleToJpegBase64(
    bytes: ArrayBuffer,
    maxDimension: number,
    contentType?: string
): Promise<string> {
    const bitmap = await decodeImage(bytes, contentType);
    try {
        const { width, height } = scaleDimensions(bitmap.width, bitmap.height, maxDimension);
        const canvas = activeDocument.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not get a 2D canvas context for image downscale.');
        ctx.drawImage(bitmap, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const commaIndex = dataUrl.indexOf(',');
        return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
    } finally {
        // ImageBitmap holds native memory; HTMLImageElement does not implement close().
        if (typeof (bitmap as ImageBitmap).close === 'function') {
            (bitmap as ImageBitmap).close();
        }
    }
}

/**
 * Infer whether `contentType` refers to a raster image the vision layer can
 * decode. Used to reject non-image responses before attempting decode.
 */
export function isImageContentType(contentType: string): boolean {
    return /^image\/(jpeg|png|webp|gif|bmp)\b/i.test(contentType);
}

/** Decode bytes into a canvas-drawable image, trying createImageBitmap first. */
async function decodeImage(bytes: ArrayBuffer, contentType?: string): Promise<DecodedImage> {
    if (typeof createImageBitmap === 'function') {
        try {
            const blob = new Blob([bytes], { type: contentType ?? 'image/jpeg' });
            return await createImageBitmap(blob);
        } catch {
            // Fall through to the Image-element path (some Capacitor builds).
        }
    }
    return loadViaImageElement(bytes, contentType);
}

/** Fallback decoder using an Image element and an object URL. */
function loadViaImageElement(bytes: ArrayBuffer, contentType?: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const blob = new Blob([bytes], { type: contentType ?? 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        const img = activeDocument.createElement('img');
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Could not decode the image.'));
        };
        img.src = url;
    });
}

/** Fit a source rectangle inside `maxDimension`, preserving aspect ratio. */
function scaleDimensions(width: number, height: number, maxDimension: number): { width: number; height: number } {
    if (maxDimension <= 0) throw new Error('maxDimension must be a positive number.');
    if (width <= maxDimension && height <= maxDimension)
        return { width: Math.max(1, width), height: Math.max(1, height) };
    const ratio = width >= height ? maxDimension / width : maxDimension / height;
    return {
        width: Math.max(1, Math.round(width * ratio)),
        height: Math.max(1, Math.round(height * ratio))
    };
}

/**
 * Turning a phone photo or a screenshot into something Tim can read.
 *
 * Two things make this worth doing carefully rather than just base64-ing
 * whatever the file picker hands over:
 *
 * 1. **Size.** A modern phone camera produces 4-6 MB images. Base64 adds
 *    another third on top, and Vercel refuses a request body over about
 *    4.5 MB — so an unresized holiday-camera screenshot fails with a
 *    confusing error. Anthropic also scales anything over 1568px down on
 *    its side, so sending the full thing wastes upload time on a phone
 *    connection to no benefit.
 * 2. **Cost.** Images are charged roughly (width x height) / 750 tokens,
 *    and every image in the thread is re-read on every turn.
 */

/** What Anthropic accepts, and therefore what the picker should offer. */
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
export const DOC_TYPES = ["application/pdf"];
export const ACCEPT = [...IMAGE_TYPES, ...DOC_TYPES].join(",");

export const MAX_FILES = 4;
// Comfortably under Vercel's request body limit once base64 inflates it.
export const MAX_TOTAL_BYTES = 3_000_000;
// Anthropic scales past this anyway; going bigger costs upload, not quality.
const MAX_EDGE = 1568;

const readAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("Couldn't read that file."));
    fr.readAsDataURL(file);
  });

/** Shrink an image to MAX_EDGE, re-encoding as JPEG. */
async function shrinkImage(file) {
  const dataUrl = await readAsDataUrl(file);
  // GIFs can be animated; re-encoding would freeze them, and they are
  // rarely large enough to matter. Pass them through untouched.
  if (file.type === "image/gif") return { dataUrl, mediaType: file.type };

  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("That image couldn't be opened."));
    el.src = dataUrl;
  });

  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  if (scale === 1 && dataUrl.length < 1_400_000) {
    return { dataUrl, mediaType: file.type };
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  // Screenshots are mostly flat colour; white behind any transparency
  // reads better than the black the canvas defaults to.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.85), mediaType: "image/jpeg" };
}

/**
 * Prepare one picked file. Returns { kind, mediaType, data, name, preview }
 * or { error } — never throws, so one bad file doesn't lose the others.
 */
export async function prepareAttachment(file) {
  const isImage = IMAGE_TYPES.includes(file.type);
  const isDoc = DOC_TYPES.includes(file.type);
  if (!isImage && !isDoc) {
    return { error: `${file.name}: Tim reads images and PDFs, not ${file.type || "that file type"}.` };
  }
  try {
    if (isImage) {
      const { dataUrl, mediaType } = await shrinkImage(file);
      return {
        kind: "image", mediaType, name: file.name,
        data: dataUrl.split(",")[1], preview: dataUrl,
      };
    }
    const dataUrl = await readAsDataUrl(file);
    return {
      kind: "document", mediaType: "application/pdf", name: file.name,
      data: dataUrl.split(",")[1], preview: null,
    };
  } catch (e) {
    return { error: `${file.name}: ${e.message}` };
  }
}

/** Rough byte count of the base64 payload, for the size guard. */
export const attachmentBytes = (a) => Math.ceil((a.data?.length || 0) * 0.75);

/**
 * The message content Anthropic expects.
 *
 * Attachments come first: the model reads better when the picture arrives
 * before the question about it.
 */
export function buildContent(text, attachments = []) {
  if (!attachments.length) return text;
  const blocks = attachments.map((a) => ({
    type: a.kind,
    source: { type: "base64", media_type: a.mediaType, data: a.data },
  }));
  if (text) blocks.push({ type: "text", text });
  return blocks;
}

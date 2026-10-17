import { z } from "zod";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES = 4;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function validImage(value: string): boolean {
  const comma = value.indexOf(",");
  const mime = value.slice(0, comma);
  if (!/^data:image\/(png|jpeg|webp|gif);base64$/.test(mime)) return false;
  const encoded = value.slice(comma + 1);
  if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return false;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const size = encoded.length / 4 * 3 - padding;
  if (size > MAX_IMAGE_BYTES || size < 12) return false;
  const last = alphabet.indexOf(encoded[encoded.length - padding - 1] ?? "");
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) return false;
  const header = atob(encoded.slice(0, 16));
  const byte = (index: number) => header.charCodeAt(index);
  if (mime.includes("/png;")) return [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => byte(i) === value);
  if (mime.includes("/jpeg;")) return byte(0) === 255 && byte(1) === 216 && byte(2) === 255;
  if (mime.includes("/gif;")) return header.startsWith("GIF87a") || header.startsWith("GIF89a");
  return header.startsWith("RIFF") && header.slice(8, 12) === "WEBP";
}

export const imageAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  dataUrl: z.string().max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32)
    .refine(validImage, "图片格式无效，支持 PNG、JPEG、WebP、GIF，单张不超过 2 MiB。"),
}).strict().readonly();
export type ImageAttachment = z.infer<typeof imageAttachmentSchema>;
export const imageAttachmentsSchema = z.array(imageAttachmentSchema).max(MAX_IMAGES).readonly();

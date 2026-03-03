import type { GrokSettings } from "../settings";
import type { Env } from "../env";
import { getDynamicHeaders } from "./headers";
import { arrayBufferToBase64 } from "../utils/base64";

const UPLOAD_API = "https://grok.com/rest/app-chat/upload-file";

const MIME_DEFAULT = "image/jpeg";

/** 匹配本地上传图片的 /images/upload-xxx.ext 路径 */
const LOCAL_UPLOAD_RE = /\/images\/(upload-[0-9a-f-]+\.\w+)$/i;

function isUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function guessExtFromMime(mime: string): string {
  const m = mime.split(";")[0]?.trim() ?? "";
  const parts = m.split("/");
  return parts.length === 2 && parts[1] ? parts[1] : "jpg";
}

function parseDataUrl(dataUrl: string): { base64: string; mime: string } {
  const trimmed = dataUrl.trim();
  const comma = trimmed.indexOf(",");
  if (comma === -1) return { base64: trimmed, mime: MIME_DEFAULT };
  const header = trimmed.slice(0, comma);
  const base64 = trimmed.slice(comma + 1);
  const match = header.match(/^data:([^;]+);base64$/i);
  return { base64, mime: match?.[1] ?? MIME_DEFAULT };
}

/**
 * 尝试从 KV 缓存读取本地上传的图片。
 * 如果 URL 匹配 /images/upload-xxx.ext 格式，直接从 KV_CACHE 读取，
 * 避免 CF Worker 回环请求自身导致 404。
 */
async function tryReadFromKv(
  imageUrl: string,
  kvCache: KVNamespace | undefined,
): Promise<{ base64: string; mime: string; filename: string } | null> {
  if (!kvCache) return null;

  let pathname: string;
  try {
    pathname = new URL(imageUrl).pathname;
  } catch {
    return null;
  }

  const m = LOCAL_UPLOAD_RE.exec(pathname);
  if (!m) return null;

  const fileName = m[1]!;
  const kvKey = `image/${fileName}`;

  const result = await kvCache.getWithMetadata<{ contentType?: string }>(kvKey, {
    type: "arrayBuffer",
  });
  if (!result?.value) return null;

  const mime = result.metadata?.contentType ?? MIME_DEFAULT;
  const base64 = arrayBufferToBase64(result.value as ArrayBuffer);
  return { base64, mime, filename: fileName };
}

export async function uploadImage(
  imageInput: string,
  cookie: string,
  settings: GrokSettings,
  kvCache?: KVNamespace,
): Promise<{ fileId: string; fileUri: string }> {
  let base64 = "";
  let mime = MIME_DEFAULT;
  let filename = "image.jpg";

  if (isUrl(imageInput)) {
    // 优先尝试从 KV 读取本地上传的图片
    const kvResult = await tryReadFromKv(imageInput, kvCache);
    if (kvResult) {
      base64 = kvResult.base64;
      mime = kvResult.mime;
      filename = kvResult.filename;
    } else {
      const r = await fetch(imageInput, { redirect: "follow" });
      if (!r.ok) throw new Error(`下载图片失败: ${r.status}`);
      mime = r.headers.get("content-type")?.split(";")[0] ?? MIME_DEFAULT;
      if (!mime.startsWith("image/")) mime = MIME_DEFAULT;
      base64 = arrayBufferToBase64(await r.arrayBuffer());
      filename = `image.${guessExtFromMime(mime)}`;
    }
  } else if (imageInput.trim().startsWith("data:image")) {
    const parsed = parseDataUrl(imageInput);
    base64 = parsed.base64;
    mime = parsed.mime;
    filename = `image.${guessExtFromMime(mime)}`;
  } else {
    base64 = imageInput.trim();
    filename = "image.jpg";
    mime = MIME_DEFAULT;
  }

  const body = JSON.stringify({
    fileName: filename,
    fileMimeType: mime,
    content: base64,
  });

  const headers = getDynamicHeaders(settings, "/rest/app-chat/upload-file");
  headers.Cookie = cookie;

  const resp = await fetch(UPLOAD_API, { method: "POST", headers, body });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`上传失败: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { fileMetadataId?: string; fileUri?: string };
  return { fileId: data.fileMetadataId ?? "", fileUri: data.fileUri ?? "" };
}


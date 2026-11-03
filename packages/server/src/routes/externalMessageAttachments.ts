import type { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import multer from "multer";
import { isChannelArchived } from "../services/channelService";
import { uploadAttachmentBuffers } from "../services/attachmentUploadWriterService";
import { getCdnStorage, getStorage, isStorageTimeoutError } from "../services/storageService";
import { FileUploadQuotaExceededError, buildFileUploadQuotaExceededResponse } from "../services/fileUploadQuotaService";
import { AttachmentLinkError } from "../services/attachmentLinkingService";
import {
  canGenerateImagePreview, generateThumbnail, isSvgAttachmentMimeType, generateSvgRasterPreview,
  normalizeAttachmentFilename, normalizeUploadedMimeType, resolveRequestAttachmentFileSizeLimitBytes,
} from "./attachments";

// Eight source files plus eight from a Feishu-only quote/root snapshot. Accept
// bytes only: callers cannot attach another user's IDs or ask us to read a path.
const upload = multer({ storage: multer.memoryStorage(), limits: {
  files: 16, fileSize: 20 * 1024 * 1024, fields: 1, fieldSize: 160 * 1024, parts: 17,
} }).array("files", 16);

export function parseExternalMessageUpload(req: Request, res: Response, next: NextFunction): void {
  if (!req.is("multipart/form-data")) { next(); return; }
  upload(req, res, (error: unknown) => {
    if (error) {
      res.status(error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
        .json({ code: "external_attachment_invalid_upload" });
      return;
    }
    const files = req.files as Express.Multer.File[];
    if (!files?.length || files.some(file => file.size === 0)
      || files.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024) {
      res.status(400).json({ code: "external_attachment_invalid_upload" }); return;
    }
    try {
      if (typeof req.body?.payload !== "string" || Object.keys(req.body).length !== 1) throw new Error();
      req.body = JSON.parse(req.body.payload);
    } catch { res.status(400).json({ code: "external_attachment_invalid_payload" }); return; }
    next();
  });
}

export function externalAttachmentFiles(req: Request) {
  return ((req.files ?? []) as Express.Multer.File[]).map(file => {
    const filename = normalizeAttachmentFilename(file.originalname);
    return { buffer: file.buffer, filename,
      mimeType: normalizeUploadedMimeType(filename, file.mimetype, file.buffer),
      contentHash: createHash("sha256").update(file.buffer).digest("hex") };
  });
}

export function externalAttachmentMetadata(files: ReturnType<typeof externalAttachmentFiles>) {
  // Stable request identity lets a lost receipt replay without re-uploading.
  return files.length ? { externalAttachments: files.map(({ buffer, ...file }) => ({ ...file, sizeBytes: buffer.length })) } : {};
}

export async function uploadExternalMessageAttachments(req: Request, res: Response,
  channelId: string, userId: string, files: ReturnType<typeof externalAttachmentFiles>): Promise<string[] | null> {
  if (!files.length) return [];
  const maxBytes = await resolveRequestAttachmentFileSizeLimitBytes(req);
  if (files.some(file => file.buffer.length > maxBytes)) {
    res.status(413).json({ code: "external_attachment_too_large", maxBytes }); return null;
  }
  if (await isChannelArchived(channelId)) {
    res.status(409).json({ code: "channel_archived" }); return null;
  }
  const storage = getStorage();
  if (!storage) { res.status(503).json({ code: "external_attachment_storage_unavailable" }); return null; }
  // Call only after the external binding, destination and write gates pass.
  // The native writer handles quota, preview generation and abandoned uploads.
  const rows = await uploadAttachmentBuffers({ serverId: req.serverId!, channelId,
    uploaderId: userId, uploaderType: "user", files, storage, cdnStorage: getCdnStorage(),
    preview: { canGenerate: canGenerateImagePreview, generateThumbnail,
      isSvg: isSvgAttachmentMimeType, generateSvgRasterPreview },
  });
  return rows.map(row => row.id);
}

export async function respondExternalAttachmentError(req: Request, res: Response, error: unknown): Promise<boolean> {
  if (error instanceof FileUploadQuotaExceededError) {
    res.status(error.status).json(await buildFileUploadQuotaExceededResponse(req.serverId!, error)); return true;
  }
  if (error instanceof AttachmentLinkError) {
    res.status(error.status).json({ code: error.code }); return true;
  }
  if (isStorageTimeoutError(error)) {
    res.status(504).json({ code: "external_attachment_storage_timeout" }); return true;
  }
  return false;
}

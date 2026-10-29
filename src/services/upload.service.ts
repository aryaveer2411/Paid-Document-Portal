import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { ApiError } from "../errors/api.error.js";
import { uploadResponseSchema, type UploadResponse } from "../schema/admin/response/admin.upload.js";
import { createUserClient } from "../supabase.js";

// Every real PDF starts with these bytes; the file name or browser-sent type can lie, the content can't
const PDF_MAGIC = "%PDF-";

export async function uploadDocumentFile(accessToken: string, file: Buffer): Promise<UploadResponse> {
  if (file.length === 0) throw new ApiError(400, "VALIDATION_FAILED", "File is empty");
  if (file.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC) {
    throw new ApiError(400, "VALIDATION_FAILED", "Only PDF files are allowed");
  }

  // Server-chosen name: no overwriting other files, no "../" tricks from the client
  const storagePath = `products/${randomUUID()}.pdf`;

  // As the admin, so the Storage rule (admins may insert) decides; upsert off = never overwrite
  const { error } = await createUserClient(accessToken)
    .storage.from(env.STORAGE_BUCKET)
    .upload(storagePath, file, { contentType: "application/pdf", upsert: false });

  if (error) {
    console.error(`Upload to ${storagePath} failed: ${error.message}`);
    throw ApiError.upstream("File upload failed, try again");
  }

  return uploadResponseSchema.parse({ storagePath, sizeBytes: file.length });
}

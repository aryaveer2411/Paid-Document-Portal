import { env } from "../config/env.js";
import { prisma } from "../db.js";
import { ApiError } from "../errors/api.error.js";
import { downloadResponseSchema, type DownloadResponse } from "../schema/document/response/document.download.js";
import { createUserClient } from "../supabase.js";

const LINK_TTL_SECONDS = 60;

export async function getDownloadLink(userId: string, accessToken: string, documentId: string): Promise<DownloadResponse> {
  // First open is stamped before any link exists: it ends the self-refund window. If a refund holds
  // this row's lock, the update waits, re-checks revoked_at and skips, so open and refund can't both win.
  const { count: firstOpen } = await prisma.entitlement.updateMany({
    where: { userId, documentId, revokedAt: null, openedAt: null },
    data: { openedAt: new Date() },
  });

  // Prisma skips RLS, so the owner check is explicit. 404 (not 403) for "not yours" too:
  // a caller can't tell whether another document exists.
  const entitlement = await prisma.entitlement.findFirst({
    where: { userId, documentId, revokedAt: null },
    select: { document: { select: { storagePath: true } } },
  });
  if (!entitlement) throw ApiError.notFound("Document not found");

  // Signed as the user, so the Storage rule re-checks the entitlement on Supabase's side
  const { data, error } = await createUserClient(accessToken)
    .storage.from(env.STORAGE_BUCKET)
    .createSignedUrl(entitlement.document.storagePath, LINK_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    // Storage answers "not found" both for a missing file and for a rule denial
    console.error(`Signed URL failed for document ${documentId}: ${error?.message ?? "no url"}`);
    // Client never got the file, so they keep the right to a refund
    if (firstOpen === 1) {
      await prisma.entitlement.updateMany({ where: { userId, documentId }, data: { openedAt: null } });
    }
    throw ApiError.notFound("File is not available");
  }

  return downloadResponseSchema.parse({ url: data.signedUrl, expiresInSeconds: LINK_TTL_SECONDS });
}

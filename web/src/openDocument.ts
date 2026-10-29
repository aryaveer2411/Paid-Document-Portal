import { api } from "./api";

// Server checks the entitlement and returns a short-lived signed URL
export async function openDocument(documentId: string): Promise<void> {
  // Opened before the await: browsers block pop-ups opened after an async gap
  const tab = window.open("", "_blank");
  try {
    const { url } = await api<{ url: string }>(`/api/documents/${documentId}/download`);
    if (tab) tab.location.href = url;
    else window.location.assign(url);
  } catch (e) {
    tab?.close();
    throw e;
  }
}

// Proof codes: a short code sits at the END of every bundle section and in a
// corner of every image, and appears nowhere in the brief. The receipt's
// "Proof:" line can only echo them if the agent actually reached the end of
// each section and looked at each picture. Deterministic from the pack id, so a
// receipt can be checked later without a server.

import { createHash } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

export function proofCode(packId: string, slot: string): string {
  const digest = createHash("sha256").update(`flux-connect\0${packId}\0${slot}`).digest();
  let out = "";
  for (let i = 0; i < 4; i++) out += ALPHABET[digest[i] % ALPHABET.length];
  return out;
}

export function sectionCodeLine(packId: string, section: string): string {
  return `— §${section} code ${proofCode(packId, `section:${section}`)} —`;
}

export function imageCode(packId: string, index: number): string {
  return proofCode(packId, `image:${index}`);
}

export interface ReceiptCheck {
  sections: { id: string; ok: boolean }[];
  images: { index: number; ok: boolean }[];
  complete: boolean;
}

/**
 * Check a receipt's proof line against a pack: which section codes and image
 * codes it contains. Order and punctuation are free ("A-7Q2F" or "7Q2F").
 */
export function checkReceipt(packId: string, proof: string, sectionIds: readonly string[], imageCount: number): ReceiptCheck {
  const text = proof.toUpperCase();
  const sections = sectionIds.map((id) => ({ id, ok: text.includes(proofCode(packId, `section:${id}`)) }));
  const images = Array.from({ length: imageCount }, (_, index) => ({ index, ok: text.includes(imageCode(packId, index)) }));
  return { sections, images, complete: sections.every((s) => s.ok) && images.every((i) => i.ok) };
}

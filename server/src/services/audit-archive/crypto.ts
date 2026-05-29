import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { decodeMasterKey } from "../../secrets/local-encrypted-provider.js";
import { badRequest } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import type { EncryptedArchiveMaterial } from "./types.js";

// Phase 6 Decision AA2: archives use a DEDICATED master key
// (PAPERCLIP_ARCHIVE_MASTER_KEY), separate from the rotatable secrets master
// key. The secrets key can rotate (re-encrypt live tokens → done); the
// archive key must remain valid for 7 years to decrypt litigation archives.
// Coupling them risks silently destroying archive decryptability on a
// secrets-key rotation. Separation is enforced here at the load layer.

const ARCHIVE_KEY_ENV = "PAPERCLIP_ARCHIVE_MASTER_KEY";

// Deterministic dev/test fallback. NOT for prod. Derived from a fixed string
// so dev/test runs are reproducible without provisioning a real key — and so
// the fallback is OBVIOUSLY not the real archive key (different derivation,
// different value than any secret).
const DEV_FALLBACK_SEED = "paperclip-archive-dev-fallback-v1";

let warnedAboutDevFallback = false;

function devFallbackKey(): Buffer {
  if (!warnedAboutDevFallback) {
    logger.warn(
      `[audit-archive] ${ARCHIVE_KEY_ENV} not set — using deterministic dev-only fallback key. ` +
        `NOT suitable for production. PROD must provision ${ARCHIVE_KEY_ENV} via 6c-infra with 7-year escrow and NO-ROTATE discipline.`,
    );
    warnedAboutDevFallback = true;
  }
  return createHash("sha256").update(DEV_FALLBACK_SEED).digest();
}

export function loadArchiveMasterKey(): Buffer {
  const raw = process.env[ARCHIVE_KEY_ENV];
  if (raw && raw.trim().length > 0) {
    const decoded = decodeMasterKey(raw);
    if (!decoded) {
      throw badRequest(
        `Invalid ${ARCHIVE_KEY_ENV} (expected 32-byte base64, 64-char hex, or raw 32-char string)`,
      );
    }
    return decoded;
  }
  return devFallbackKey();
}

// AES-256-GCM, random 12-byte IV per archive, 16-byte auth tag.
// Mirrors local-encrypted-provider's encryptValue but tagged with a
// distinct scheme ("archive_v1") so archive material is never typewise
// confused with secrets material.
export function encryptArchive(masterKey: Buffer, plaintext: string): EncryptedArchiveMaterial {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    scheme: "archive_v1",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptArchive(masterKey: Buffer, material: EncryptedArchiveMaterial): string {
  if (material.scheme !== "archive_v1") {
    throw badRequest("Invalid archive material: unrecognized scheme");
  }
  const iv = Buffer.from(material.iv, "base64");
  const tag = Buffer.from(material.tag, "base64");
  const ciphertext = Buffer.from(material.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  // GCM authTag verification happens on final() — a tampered ciphertext or
  // tag throws here. This is the tamper-detection down-payment for 6b.
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

// Test-only helpers (exported for use by audit-archive.test.ts but intended
// for internal-only consumption).
export function _resetDevFallbackWarning(): void {
  warnedAboutDevFallback = false;
}

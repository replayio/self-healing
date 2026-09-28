import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { HttpError } from "./errors.ts";

export function credentialVault(secret = process.env.SELF_HEALING_SECRET) {
  const root = Buffer.from(secret ?? "", "base64");
  if (root.length !== 32)
    throw new HttpError(
      503,
      "credentials_unavailable",
      "SELF_HEALING_SECRET must be a base64-encoded 32-byte secret.",
    );
  const derive = (label: string) =>
    createHmac("sha256", root).update(label).digest();
  const encryption = derive("credential-encryption-v1");
  return {
    identity(key: string) {
      return createHmac("sha256", derive("key-identity-v1"))
        .update(key)
        .digest("hex");
    },
    gateway(id: string) {
      return createHmac("sha256", derive("qa-gateway-v1"))
        .update(id)
        .digest("hex");
    },
    verifyGateway(id: string, token: string) {
      const expected = Buffer.from(this.gateway(id));
      const actual = Buffer.from(token);
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    },
    encrypt(key: string, account: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryption, iv);
      cipher.setAAD(Buffer.from(account));
      const data = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
    },
    decrypt(value: string, account: string) {
      const data = Buffer.from(value, "base64");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        encryption,
        data.subarray(0, 12),
      );
      cipher.setAAD(Buffer.from(account));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([
        cipher.update(data.subarray(28)),
        cipher.final(),
      ]).toString("utf8");
    },
  };
}

import { runtimeEnv } from "./server";

function decodeKey(value: string) {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function key() {
  const encoded = runtimeEnv().TOKEN_ENCRYPTION_KEY;
  if (!encoded) throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
  const bytes = decodeKey(encoded);
  if (bytes.byteLength !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(value));
  const packed = new Uint8Array(iv.byteLength + encrypted.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(encrypted), iv.byteLength);
  return btoa(String.fromCharCode(...packed));
}

export async function decryptSecret(value: string) {
  const packed = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  const iv = packed.slice(0, 12);
  const payload = packed.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await key(), payload);
  return new TextDecoder().decode(decrypted);
}

// Postgres SCRAM-SHA-256 password verifier (RFC 5802 / 7677), the same format
// Postgres stores in pg_authid. Sending the verifier instead of the password keeps
// the plain value out of SQL statements and database logs.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

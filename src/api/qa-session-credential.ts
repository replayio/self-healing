import { z } from "zod";
import { HttpError } from "./errors.ts";

const RegistrationCredentialSchema = z.object({
  registration_token: z.string().regex(/^lqs_[A-Za-z0-9_-]+$/),
});
const LegacyRegistrationSchema = z.object({ instructions: z.string() });

// Deploy Self Healing before QA removes its legacy installation-guide response.
// Existing connections retain their encrypted credential and do not rotate it.
export function qaSessionCredential(response: unknown): string {
  const credential = RegistrationCredentialSchema.safeParse(response);
  if (credential.success) return credential.data.registration_token;
  // A malformed structured credential must not fall back to legacy prose.
  if (
    typeof response === "object" &&
    response !== null &&
    "registration_token" in response
  ) {
    throw new HttpError(
      503,
      "qa_contract_changed",
      "QA returned an invalid registration token.",
    );
  }
  const legacy = LegacyRegistrationSchema.safeParse(response);
  const tokens = legacy.success
    ? [
        ...new Set(
          legacy.data.instructions.match(/\blqs_[A-Za-z0-9_-]+\b/g) ?? [],
        ),
      ]
    : [];
  if (tokens.length !== 1) {
    throw new HttpError(
      503,
      "qa_contract_changed",
      "QA did not return one registration token.",
    );
  }
  return tokens[0]!;
}

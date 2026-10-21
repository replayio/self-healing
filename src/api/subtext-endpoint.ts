import { z } from "zod";

export const defaultSubtextEndpoint = "https://api.fullstory.com/mcp/subtext";
// Provisioning is public: restrict credential-bearing requests to provider endpoints.
export const SubtextApiUrl = z.enum([
  defaultSubtextEndpoint,
  "https://api.eu1.fullstory.com/mcp/subtext",
  "https://api.staging.fullstory.com/mcp/subtext",
]);
export function subtextEndpoint(endpoint = defaultSubtextEndpoint): string {
  return SubtextApiUrl.parse(endpoint);
}

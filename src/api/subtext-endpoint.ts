import { z } from "zod";

export const defaultSubtextEndpoint = "https://api.fullstory.com/mcp/subtext";
// Provisioning is public: restrict credential-bearing requests to provider endpoints.
export const SubtextApiUrl = z
  .string()
  .url()
  .regex(
    /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+fullstory\.com\/mcp\/subtext$/i,
    "Use an HTTPS Fullstory subdomain with the /mcp/subtext path.",
  );
export function subtextEndpoint(endpoint = defaultSubtextEndpoint): string {
  return SubtextApiUrl.parse(endpoint);
}

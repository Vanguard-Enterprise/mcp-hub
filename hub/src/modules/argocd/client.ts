import { JsonApiClient } from "../http.js";

/** Client for the Argo CD API server, authenticated with a local account's API token. */
export class ArgoCdClient extends JsonApiClient {
  constructor(baseUrl: string, token: string) {
    super("Argo CD", baseUrl, { Authorization: `Bearer ${token}` });
  }
}

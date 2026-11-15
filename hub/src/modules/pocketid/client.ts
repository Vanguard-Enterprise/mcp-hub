import { JsonApiClient } from "../http.js";

/** Client for the Pocket ID admin API, authenticated with an admin user's API key. */
export class PocketIdClient extends JsonApiClient {
  constructor(baseUrl: string, apiKey: string) {
    super("Pocket ID", baseUrl, { "X-API-Key": apiKey });
  }
}

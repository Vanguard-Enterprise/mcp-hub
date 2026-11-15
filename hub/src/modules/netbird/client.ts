import { JsonApiClient } from "../http.js";

export { buildUrl } from "../http.js";

/** Client for the NetBird Management API. */
export class NetBirdClient extends JsonApiClient {
  constructor(baseUrl: string, token: string) {
    // The spec's TokenAuth scheme for Personal Access Tokens.
    super("NetBird", baseUrl, { Authorization: `Token ${token}` });
  }
}

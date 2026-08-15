/**
 * Records Fetch requests for deterministic protocol tests.
 *
 * The recorder returns an empty successful response. Tests that need
 * operation-specific provider responses should use a dedicated fake instead of
 * adding conditional protocol behavior to this generic capture object.
 */
export class RequestCapture {
  /** Requests in the exact order Fetch received them. */
  readonly requests: Request[] = [];

  /** Records one request and returns an empty HTTP 200 response. */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.requests.push(new Request(input, init));
    return new Response(null, { status: 200 });
  }

  /** Returns the most recently recorded request. */
  get latest(): Request | undefined {
    return this.requests.at(-1);
  }
}

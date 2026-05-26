// Phase 4c.5 Decision 4 Phase 2 — structured HTTP error for QBO and Xero requests.
//
// Background: qboRequest and xeroRequest previously threw generic Error on
// non-OK HTTP responses, with the status code embedded only in the message
// string. The transaction-lookup dispatcher's multi-type probing loop needs
// to distinguish a 404 ("wrong type, try next") from a 500 ("genuine
// upstream failure, abort"). Parsing status from message strings is fragile;
// a typed error class is the clean fix.
//
// Pattern: HttpResponseError extends Error and carries the HTTP status code
// plus the original method/path for diagnostics. Subclasses Error so all
// existing `catch (e)` callers continue to work — they just gain the option
// to introspect `error.status` if they want structured handling.

export class HttpResponseError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = "HttpResponseError";
  }

  /**
   * True if the response status indicates the requested resource was not
   * found at the requested type-specific endpoint. Used by the dispatcher's
   * multi-type probe loop to decide whether to try the next type.
   */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

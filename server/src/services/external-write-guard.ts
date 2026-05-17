const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class ExternalWriteBlockedError extends Error {
  constructor(
    public readonly service: string,
    public readonly method: string,
    public readonly path: string,
  ) {
    super(
      `External ${service} write blocked: ${method} ${path}. ` +
      `Set PAPERCLIP_ALLOW_EXTERNAL_WRITES=true to allow writes to real external services. ` +
      `This guard exists because the dev environment uses production credentials.`,
    );
    this.name = "ExternalWriteBlockedError";
  }
}

export function assertExternalWriteAllowed(service: string, method: string, path: string): void {
  if (!WRITE_METHODS.has(method.toUpperCase())) return;
  if (process.env.PAPERCLIP_ALLOW_EXTERNAL_WRITES === "true") return;
  throw new ExternalWriteBlockedError(service, method.toUpperCase(), path);
}

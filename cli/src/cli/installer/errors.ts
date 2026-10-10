/** An installer failure with the exit code the CLI should return. Usage errors exit 2. */
export class InstallerError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "InstallerError";
  }
}

export function usageError(message: string): InstallerError {
  return new InstallerError(message, 2);
}

/** A runtime failure: not a repository, git missing, unreadable state. */
export class RuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeError';
    this.exitCode = 1;
  }
}

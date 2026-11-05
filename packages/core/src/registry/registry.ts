/**
 * Generic registry for pluggable modules (triggers, condition operators,
 * actions). Each module self-describes with a `type` id from the catalog and
 * is registered explicitly at service start — no import side effects, so tests
 * can build an isolated registry with exactly the modules they need.
 */

export class DuplicateRegistrationError extends Error {
  constructor(kind: string, type: string) {
    super(`${kind} "${type}" is already registered`);
    this.name = "DuplicateRegistrationError";
  }
}

export class UnknownTypeError extends Error {
  readonly kind: string;
  readonly type: string;

  constructor(kind: string, type: string) {
    super(`Unknown ${kind} "${type}"`);
    this.name = "UnknownTypeError";
    this.kind = kind;
    this.type = type;
  }
}

export class Registry<K extends string, V extends { readonly type: K }> {
  readonly kind: string;
  readonly #items = new Map<K, V>();

  constructor(kind: string) {
    this.kind = kind;
  }

  register(definition: V): this {
    if (this.#items.has(definition.type)) {
      throw new DuplicateRegistrationError(this.kind, definition.type);
    }
    this.#items.set(definition.type, definition);
    return this;
  }

  has(type: string): type is K {
    return this.#items.has(type as K);
  }

  get(type: K): V | undefined {
    return this.#items.get(type);
  }

  /** Like `get`, but throws `UnknownTypeError` — use where a missing module is a bug. */
  require(type: string): V {
    const item = this.has(type) ? this.#items.get(type) : undefined;
    if (!item) throw new UnknownTypeError(this.kind, type);
    return item;
  }

  list(): V[] {
    return [...this.#items.values()];
  }

  get size(): number {
    return this.#items.size;
  }
}

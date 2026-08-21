export class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    [...this.values.keys()].forEach((key) => Reflect.deleteProperty(this, key));
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
    Reflect.deleteProperty(this, key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
    Object.defineProperty(this, key, {
      configurable: true,
      enumerable: true,
      value,
    });
  }
}

export const installMemoryBrowserStorage = () => {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const location = new URL("http://flowpilot.test/");
  const window = {
    localStorage,
    sessionStorage,
    location,
    indexedDB: globalThis.indexedDB,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    dispatchEvent: () => true,
  };

  Object.assign(globalThis, { localStorage, sessionStorage, location, window });
  return { localStorage, sessionStorage, location, window };
};

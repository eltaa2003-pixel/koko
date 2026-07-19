// Miku's tournament plugins shared one flat global `gameState` object, which
// meant two plugins could accidentally read/write the same key. This gives
// every plugin its own namespaced Map instead — call store.namespace('name')
// and you get a private space that only collides if you ask for the same
// namespace on purpose.

class Store {
  #namespaces = new Map();

  namespace(name) {
    if (!this.#namespaces.has(name)) {
      this.#namespaces.set(name, new Map());
    }
    return this.#namespaces.get(name);
  }
}

export default new Store();

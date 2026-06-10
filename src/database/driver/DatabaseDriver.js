export class DatabaseDriver {
  constructor() {
    if (new.target === DatabaseDriver) {
      throw new Error('DatabaseDriver is abstract — instantiate a subclass');
    }
  }

  async connect(config) { throw new Error('connect() not implemented'); }
  async close() { throw new Error('close() not implemented'); }
  async query(sql, params) { throw new Error('query() not implemented'); }
  async get(sql, params) { throw new Error('get() not implemented'); }
  async run(sql, params) { throw new Error('run() not implemented'); }
  async exec(sql) { throw new Error('exec() not implemented'); }
  async transaction(fn) { throw new Error('transaction() not implemented'); }
  async select(sql, params) { return this.query(sql, params); }
  async insert(table, data) { throw new Error('insert() not implemented'); }
  async upsert(table, data, conflictKeys) { throw new Error('upsert() not implemented'); }
  async update(table, data, where, whereParams) { throw new Error('update() not implemented'); }
  async delete(table, where, whereParams) { throw new Error('delete() not implemented'); }
  async tableExists(name) { throw new Error('tableExists() not implemented'); }
  async getSchemaVersion() { throw new Error('getSchemaVersion() not implemented'); }
  async setSchemaVersion(version) { throw new Error('setSchemaVersion() not implemented'); }
  async isConnected() { throw new Error('isConnected() not implemented'); }
  get dialect() { throw new Error('dialect getter not implemented'); }
}

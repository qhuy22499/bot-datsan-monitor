// Test-only D1 binding shim, real SQLite. This is NOT a D1 service emulator.
// Actual workerd/D1 local smoke is separate; cloud limits remain unverified.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export class LocalD1 {
  constructor(path=':memory:') {
    this.sql=new DatabaseSync(path);this.sql.exec('PRAGMA foreign_keys=ON');
    this.migration=readFileSync(new URL('../migrations/0001_monitor.sql',import.meta.url),'utf8');
    this.sql.exec(this.migration);
  }
  withSession(mode) {if(mode!=='first-primary')throw Error('SESSION');return this;}
  prepare(sql) {
    const database=this;
    return {sql,args:[],bind(...args){this.args=args;return this;},
      async first(){return database.sql.prepare(this.sql).get(...this.args) || null;},
      async run(){return {success:true,meta:database.sql.prepare(this.sql).run(...this.args)};},
      execute(){const statement=database.sql.prepare(this.sql);return {success:true,results:statement.columns().length ? statement.all(...this.args) : (statement.run(...this.args),[])};}};
  }
  async batch(statements) {
    this.sql.exec('BEGIN IMMEDIATE');
    try {const r=statements.map(s=>s.execute());this.sql.exec('COMMIT');return r;}
    catch(e){this.sql.exec('ROLLBACK');throw e;}
  }
  close(){this.sql.close();}
}

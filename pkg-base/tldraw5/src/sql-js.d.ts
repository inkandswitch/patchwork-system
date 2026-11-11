declare module "sql.js" {
  export type SqlValue = string | number | Uint8Array | null;

  export interface Statement {
    step(): boolean;
    get(): SqlValue[];
    run(params?: SqlValue[]): void;
    free(): void;
  }

  export interface Database {
    run(sql: string, params?: SqlValue[]): void;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJs {
    Database: new (bytes?: Uint8Array) => Database;
  }

  export default function initSqlJs(config?: {
    wasmBinary?: Uint8Array;
    locateFile?: (file: string) => string;
  }): Promise<SqlJs>;
}

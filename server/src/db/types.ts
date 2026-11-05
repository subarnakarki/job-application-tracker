import type { QueryResultRow } from 'pg';

export interface QueryResult<Row extends QueryResultRow> {
  rows: Row[];
  rowCount: number;
}

/** Anything that can run a query: the pool, or one client inside a transaction. */
export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

/**
 * The only database surface the app depends on. Routes and repositories take a
 * `Db`, so tests can pass a real one (a fresh schema) or a fake.
 */
export interface Db extends Queryable {
  /** Runs `work` in one transaction on one connection; rolls back if it throws. */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

import { MAX_COLUMNS_PER_TABLE } from "./constants";

/** A value buffered for a single cell of a QWP column. `null` marks NULL. */
export type QwpValue = number | bigint | string | boolean | null | unknown[];

/**
 * Buffers values for a single column of a table.
 * Values are stored row-major; index i holds the value for row i, or null.
 */
export class ColumnBuffer {
  readonly name: string;
  readonly type: number;
  readonly values: QwpValue[] = [];
  /** DECIMAL columns only: the column-wide scale. */
  scale: number;

  constructor(name: string, type: number, scale = 0) {
    this.name = name;
    this.type = type;
    this.scale = scale;
  }
}

/**
 * Buffers rows for a single table in columnar format, mirroring
 * `io.questdb.client.cutlass.qwp.protocol.QwpTableBuffer`.
 *
 * A row is "in progress" from the moment a column value is added until the
 * row is committed via {@link commitRow}. While a row is in progress, adding
 * a value to a column that already has a value for that row is an error.
 */
export class QwpTableBuffer {
  readonly tableName: string;
  readonly columns: ColumnBuffer[] = [];
  /** Lower-case column name -> column index. QuestDB identifiers are case-insensitive. */
  private readonly columnIndexByName = new Map<string, number>();
  /** Number of committed rows. */
  rowCount = 0;

  constructor(tableName: string) {
    this.tableName = tableName;
  }

  /**
   * Returns the column with the given name if it exists with a compatible
   * type, creating it otherwise.
   * @throws Error on a name/type conflict with an existing column
   */
  getOrCreateColumn(name: string, type: number): ColumnBuffer {
    const key = name.toLowerCase();
    const existingIndex = this.columnIndexByName.get(key);
    if (existingIndex !== undefined) {
      const column = this.columns[existingIndex]!;
      if (column.type !== type) {
        throw new Error(
          `Column '${name}' has already been defined with a different type`,
        );
      }
      return column;
    }
    if (this.columns.length >= MAX_COLUMNS_PER_TABLE) {
      throw new Error(
        `Max columns per table is ${MAX_COLUMNS_PER_TABLE}, column '${name}' cannot be added`,
      );
    }
    const column = new ColumnBuffer(name, type);
    this.columnIndexByName.set(key, this.columns.length);
    this.columns.push(column);
    return column;
  }

  /**
   * Adds a value to a column for the current (in-progress) row.
   * @throws Error if the column already has a value for this row
   */
  addValue(name: string, type: number, value: QwpValue): void {
    const column = this.getOrCreateColumn(name, type);
    if (column.values.length === this.rowCount + 1) {
      throw new Error(
        `Column '${name}' has already been set for the current row`,
      );
    }
    column.values.push(value);
  }

  /** True when at least one column has an uncommitted value for the current row. */
  hasInProgressRow(): boolean {
    for (const column of this.columns) {
      if (column.values.length > this.rowCount) {
        return true;
      }
    }
    return false;
  }

  /** True when the buffer holds no committed rows and no in-progress row. */
  isEmpty(): boolean {
    if (this.rowCount > 0) {
      return false;
    }
    return !this.hasInProgressRow();
  }

  /** Total number of buffered rows, including the in-progress one if any. */
  getBufferedRowCount(): number {
    return this.rowCount + (this.hasInProgressRow() ? 1 : 0);
  }

  /**
   * Commits the current row: every column that was not set for this row is
   * padded with null, then the row count is advanced.
   */
  commitRow(): void {
    const nextRow = this.rowCount + 1;
    for (const column of this.columns) {
      while (column.values.length < nextRow) {
        column.values.push(null);
      }
    }
    this.rowCount = nextRow;
  }

  /**
   * Discards the in-progress row: values added since the last commit are
   * removed, along with any column created during the row that holds no
   * committed values.
   */
  cancelCurrentRow(): void {
    if (!this.hasInProgressRow()) {
      return;
    }
    for (let i = this.columns.length - 1; i >= 0; i--) {
      const column = this.columns[i]!;
      if (column.values.length > this.rowCount) {
        column.values.length = this.rowCount;
      }
      if (column.values.length === 0) {
        this.columns.splice(i, 1);
        this.columnIndexByName.delete(column.name.toLowerCase());
      }
    }
  }

  /** Discards all buffered rows and column definitions. */
  clear(): void {
    this.columns.length = 0;
    this.columnIndexByName.clear();
    this.rowCount = 0;
  }
}

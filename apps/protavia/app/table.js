// The ranking table.
//
// Every design produced in a session lands here, whichever checkpoint made it, and the table is
// what puts them in an order. The point of this file is that the columns are *declared* rather
// than written into the renderer: a score computed later — an interface score from a compute run,
// an ensemble spread from a dynamics run — is added with `registerColumn` and needs no change to
// the drawing, sorting or export code below.
//
// One rule is enforced here rather than left to habit. A column may be shown without being allowed
// to order the table, and `rankable: false` says so. The interface score ipSAE will arrive that
// way: it reads one predicted structure's confidence, and confidence in a single pose is not the
// same question as whether a binder stays bound. Ranking on it would quietly answer the wrong
// question, so the table refuses it as a sort key and says why under the table.

/**
 * @typedef {object} Column
 * @property {string} id            stable key, also the sort key
 * @property {string} label         header text, short enough for a 19rem panel
 * @property {string} explain       one sentence, shown as the header's tooltip
 * @property {(row: object) => number|string|null} value   for sorting; null sorts last
 * @property {(row: object) => string} format              for display
 * @property {'asc'|'desc'} better  which end of this column is the better design
 * @property {boolean} [rankable]   false = may be shown, may never order the table
 * @property {string} [whyNotRankable] required when rankable is false; shown under the table
 * @property {'left'|'right'} [align]
 */

/** @type {Column[]} */
const columns = [];

/** Declared columns, in display order. */
export function allColumns() {
  return columns.slice();
}

export function registerColumn(column) {
  if (!column || !column.id) throw new Error('A column needs an id.');
  if (columns.some((c) => c.id === column.id)) throw new Error(`Column "${column.id}" is already declared.`);
  if (column.rankable === false && !column.whyNotRankable) {
    // A column that cannot rank has a reason the reader can see. Leaving it unexplained would make
    // the refusal look like an oversight.
    throw new Error(`Column "${column.id}" is not rankable and gives no reason.`);
  }
  columns.push(column);
  return column;
}

export function columnById(id) {
  return columns.find((c) => c.id === id) || null;
}

/** Columns that may order the table. */
export function rankableColumns() {
  return columns.filter((c) => c.rankable !== false);
}

// The three columns the bench already produces. A fourth is registered by whatever computes it.

registerColumn({
  id: 'checkpoint',
  label: 'Model',
  explain: 'The checkpoint that produced this sequence.',
  value: (r) => r.checkpointLabel,
  format: (r) => r.checkpointShort,
  better: 'asc',
  align: 'left',
});

registerColumn({
  id: 'recovery',
  label: 'Native',
  explain: 'Fraction of designed positions that match the native amino acid. The model sees only '
    + 'the backbone, so agreeing with the native sequence is evidence it reads the fold, not '
    + 'evidence the design is good.',
  value: (r) => (r.recovery ? r.recovery.fraction : null),
  format: (r) => (r.recovery ? `${(r.recovery.fraction * 100).toFixed(1)}%` : '—'),
  better: 'desc',
  align: 'right',
});

registerColumn({
  id: 'score',
  label: 'Score',
  explain: "The model's own score for the sequence it wrote, averaged over the designed positions. "
    + 'Lower is better.',
  value: (r) => (r.score === null || r.score === undefined ? null : r.score),
  format: (r) => (r.score === null || r.score === undefined ? '—' : r.score.toFixed(3)),
  better: 'asc',
  align: 'right',
});

/** The column the table opens on. Recovery is the only figure every row has from the start. */
const DEFAULT_SORT = 'recovery';

/**
 * A table of designs. Rows accumulate across checkpoints; the order is recomputed on every change,
 * so a row added after a sort lands in the right place.
 */
export class DesignTable {
  /** @param {HTMLElement} host the element the table is drawn into */
  constructor(host) {
    this.host = host;
    this.rows = [];
    this.sortId = DEFAULT_SORT;
    this.descending = columnById(DEFAULT_SORT).better === 'desc';
    this.onSelect = null;
  }

  clear() {
    this.rows = [];
    this.sortId = DEFAULT_SORT;
    this.descending = columnById(DEFAULT_SORT).better === 'desc';
    this.host.replaceChildren();
  }

  /** @param {object} row a design, plus whatever a later column reads */
  add(row) {
    this.rows.push(row);
    this.render();
    return row;
  }

  /**
   * Order the table by a declared column. A column declared `rankable: false` is refused, because
   * the refusal is the point of declaring it that way.
   */
  sortBy(id, descending) {
    const column = columnById(id);
    if (!column) throw new Error(`No column called "${id}".`);
    if (column.rankable === false) {
      throw new Error(`"${column.label}" is shown but never ranks the table. ${column.whyNotRankable}`);
    }
    this.sortId = id;
    this.descending = descending === undefined ? column.better === 'desc' : Boolean(descending);
    this.render();
  }

  /** Rows in the current order. Nulls sort last whichever way the column runs. */
  ordered() {
    const column = columnById(this.sortId);
    const direction = this.descending ? -1 : 1;
    return this.rows.slice().sort((a, b) => {
      const x = column.value(a);
      const y = column.value(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      if (typeof x === 'string' || typeof y === 'string') {
        return String(x).localeCompare(String(y)) * direction;
      }
      return (x - y) * direction;
    });
  }

  render() {
    this.host.replaceChildren();
    if (this.rows.length === 0) return;

    const table = document.createElement('table');
    table.className = 'ranking';

    const headRow = document.createElement('tr');
    for (const column of columns) {
      const th = document.createElement('th');
      th.textContent = column.label;
      th.title = column.rankable === false
        ? `${column.explain} Not a ranking key: ${column.whyNotRankable}`
        : `${column.explain} Click to sort.`;
      if (column.align === 'right') th.classList.add('num');

      if (column.rankable === false) {
        th.classList.add('fixed');
      } else {
        th.classList.add('sortable');
        if (column.id === this.sortId) {
          th.classList.add('sorted');
          th.append(document.createTextNode(this.descending ? ' ▾' : ' ▴'));
        }
        th.addEventListener('click', () => {
          // Clicking the column already sorted flips it; a new column opens at its better end.
          this.sortBy(column.id, column.id === this.sortId ? !this.descending : undefined);
        });
      }
      headRow.append(th);
    }
    table.append(headRow);

    for (const row of this.ordered()) {
      const tr = document.createElement('tr');
      tr.tabIndex = 0;
      for (const column of columns) {
        const td = document.createElement('td');
        td.textContent = column.format(row);
        if (column.align === 'right') td.classList.add('num');
        tr.append(td);
      }
      const select = () => { if (this.onSelect) this.onSelect(row); };
      tr.addEventListener('click', select);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(); });
      table.append(tr);
    }

    this.host.append(table);

    // Any column that is shown but cannot rank explains itself here, once, under the table.
    const fixed = columns.filter((c) => c.rankable === false);
    if (fixed.length) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = fixed
        .map((c) => `${c.label} is a column, not a ranking key. ${c.whyNotRankable}`)
        .join(' ');
      this.host.append(note);
    }
  }
}

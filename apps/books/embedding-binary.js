export const IDEA_VECTOR_MAGIC = 'BIE1';
export const IDEA_VECTOR_HEADER_BYTES = 12;

export function encodeIdeaVectors(vectors, dimensions = null) {
  const rows = Array.isArray(vectors) ? vectors : [];
  const dims = Number(dimensions)
    || (rows.length && Array.isArray(rows[0]) ? rows[0].length : 0);
  if (!Number.isInteger(dims) || dims < 0) {
    throw new Error('Embedding dimensions must be a non-negative integer');
  }
  if (rows.some((row) => !Array.isArray(row) || row.length !== dims)) {
    throw new Error('Every embedding vector must use the declared dimensions');
  }
  const buffer = new ArrayBuffer(
    IDEA_VECTOR_HEADER_BYTES + rows.length * dims * Float32Array.BYTES_PER_ELEMENT,
  );
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < IDEA_VECTOR_MAGIC.length; index++) {
    bytes[index] = IDEA_VECTOR_MAGIC.charCodeAt(index);
  }
  const view = new DataView(buffer);
  view.setUint32(4, rows.length, true);
  view.setUint32(8, dims, true);
  let offset = IDEA_VECTOR_HEADER_BYTES;
  for (const row of rows) {
    for (const value of row) {
      view.setFloat32(offset, Number(value) || 0, true);
      offset += Float32Array.BYTES_PER_ELEMENT;
    }
  }
  return bytes;
}

export function decodeIdeaVectors(value, {
  expectedRows = null,
  expectedDimensions = null,
} = {}) {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value?.buffer instanceof ArrayBuffer
        ? new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength)
        : null;
  if (!bytes || bytes.byteLength < IDEA_VECTOR_HEADER_BYTES) {
    throw new Error('Idea-vector shard is truncated');
  }
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  if (magic !== IDEA_VECTOR_MAGIC) {
    throw new Error('Idea-vector shard has an unknown format');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows = view.getUint32(4, true);
  const dimensions = view.getUint32(8, true);
  if (expectedRows != null && rows !== Number(expectedRows)) {
    throw new Error('Idea-vector row count does not match its manifest');
  }
  if (
    expectedDimensions != null
    && dimensions !== Number(expectedDimensions)
  ) {
    throw new Error('Idea-vector dimensions do not match its manifest');
  }
  const expectedBytes = IDEA_VECTOR_HEADER_BYTES
    + rows * dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error('Idea-vector shard byte length does not match its header');
  }
  const vectors = [];
  let offset = IDEA_VECTOR_HEADER_BYTES;
  for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
    const row = [];
    for (let dimension = 0; dimension < dimensions; dimension++) {
      row.push(view.getFloat32(offset, true));
      offset += Float32Array.BYTES_PER_ELEMENT;
    }
    vectors.push(row);
  }
  return { rows, dimensions, vectors };
}

import {
  decodeIdeaVectors,
  encodeIdeaVectors,
} from './embedding-binary.js';

export const IDEA_RECORD_SCHEMA_VERSION = 1;
export const IDEA_GRAPH_SCHEMA_VERSION = 1;
export const IDEA_EXTRACTOR_VERSION = 'source-grounded-ideas-v1';
export const LIBRARY_IDEA_GRAPH_PATH = 'indexes/library-idea-graph.json';
export const DEFAULT_LIBRARY_LINK_MIN_SCORE = 0.68;
export const DEFAULT_LIBRARY_LINKS_PER_IDEA = 8;
export const DEFAULT_RELATION_CLASSIFICATION_MIN_CONFIDENCE = 0.65;
export const DEFAULT_HYBRID_SEMANTIC_WEIGHT = 0.72;
export const DEFAULT_HYBRID_LEXICAL_WEIGHT =
  1 - DEFAULT_HYBRID_SEMANTIC_WEIGHT;
export const IDEA_RELATION_TYPES = Object.freeze([
  'same_as',
  'supports',
  'contradicts',
  'extends',
  'example_of',
  'applies_to',
  'shares_mechanism',
  'related_to',
]);
const IDEA_RELATION_TYPE_SET = new Set(IDEA_RELATION_TYPES);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalized(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function stableIdeaId(workId, sourceId) {
  return 'idea_' + String(workId) + '_' + String(sourceId)
    .replace(/[^\p{L}\p{N}_-]+/gu, '_');
}

export function makeSourceGroundedIdeas({
  workId,
  semanticRecord,
  passages = [],
  now = () => new Date().toISOString(),
} = {}) {
  const passageById = new Map(
    passages.map((passage) => [passage.passageId, passage]),
  );
  const ideas = (semanticRecord?.concepts || []).flatMap((concept) => {
    const evidence = (concept.evidence || []).flatMap((reference) => {
      const passage = passageById.get(reference.passageId);
      if (!passage) return [];
      return [{
        passageId:passage.passageId,
        quoteHash:reference.quoteHash || passage.anchor?.quoteHash || null,
        excerpt:String(passage.text || '').slice(0, 420),
        weight:Number(reference.weight) || 1,
      }];
    });
    if (!evidence.length) return [];
    const label = String(
      concept.userState?.labelOverride
      || concept.label
      || '',
    ).trim();
    if (!label) return [];
    const description = String(concept.description || '').trim();
    return [{
      ideaId:stableIdeaId(workId, concept.conceptId),
      workId,
      sourceConceptId:concept.conceptId,
      kind:concept.kind === 'candidate-topic' ? 'topic' : (concept.kind || 'idea'),
      label,
      statement:description || label,
      qualifiers:cloneJson(concept.qualifiers || []),
      entities:cloneJson(concept.entities || []),
      confidence:Number(concept.confidence) || 0,
      evidence,
      generatedBy:{
        extractor:IDEA_EXTRACTOR_VERSION,
        sourceExtractor:concept.generatedBy?.extractor || null,
        mode:concept.generatedBy?.mode || 'deterministic-local',
      },
      userState:{
        hidden:concept.userState?.hidden === true,
        labelOverride:concept.userState?.labelOverride || null,
        mergedInto:concept.userState?.mergedInto || null,
      },
    }];
  });
  return {
    schemaVersion:IDEA_RECORD_SCHEMA_VERSION,
    recordType:'books.idea-records',
    extractorVersion:IDEA_EXTRACTOR_VERSION,
    workId,
    sourceFingerprint:semanticRecord?.sourceFingerprint || null,
    ideas,
    updatedAt:now(),
  };
}

export function ideaEmbeddingText(idea) {
  const parts = [
    idea?.label,
    idea?.statement,
    ...(idea?.qualifiers || []),
    ...(idea?.entities || []).map((entity) =>
      typeof entity === 'string' ? entity : entity?.name),
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return Array.from(new Set(parts)).join('. ').slice(0, 1600);
}

export function makeIdeaEmbeddingBundle({
  workId,
  ideaRecords,
  vectors = [],
  model,
  dimensions,
  sourceFingerprint = null,
  inputFingerprint = null,
  now = () => new Date().toISOString(),
} = {}) {
  const ideas = ideaRecords?.ideas || [];
  if (ideas.length !== vectors.length) {
    throw new Error('Every idea requires exactly one embedding vector');
  }
  const vectorPath = ideaEmbeddingVectorPath(workId);
  const binary = encodeIdeaVectors(vectors, Number(dimensions) || 0);
  const record = {
    schemaVersion:1,
    recordType:'books.idea-embeddings',
    indexVersion:'idea-embeddings-v2',
    workId,
    model:String(model || 'unknown'),
    dimensions:Number(dimensions) || null,
    normalized:true,
    sourceFingerprint:sourceFingerprint || ideaRecords?.sourceFingerprint || null,
    inputFingerprint:inputFingerprint ? String(inputFingerprint) : null,
    encoding:'books-float32-le-v1',
    vectorPath,
    rows:ideas.map((idea, index) => ({
      ideaId:idea.ideaId,
      index,
    })),
    updatedAt:now(),
  };
  return { record, binary };
}

export function makeIdeaEmbeddingRecord(options = {}) {
  return makeIdeaEmbeddingBundle(options).record;
}

export function ideaRecordsPath(workId) {
  return `semantic/${workId}/ideas.json`;
}

export function ideaEmbeddingsPath(workId) {
  return `indexes/idea-embeddings/${workId}.json`;
}

export function ideaEmbeddingVectorPath(workId) {
  return `indexes/idea-embeddings/${workId}.f32`;
}

export function ideaVectorMap(embeddingRecord, binary = null) {
  const rows = embeddingRecord?.rows || [];
  const legacy = rows.every((row) => Array.isArray(row?.vector));
  if (legacy) {
    return new Map(rows.flatMap((row) =>
      row?.ideaId && Array.isArray(row.vector)
        ? [[row.ideaId, row.vector]]
        : []));
  }
  const decoded = decodeIdeaVectors(binary, {
    expectedRows:rows.length,
    expectedDimensions:Number(embeddingRecord?.dimensions) || 0,
  });
  return new Map(rows.flatMap((row, fallbackIndex) => {
    const index = Number.isInteger(row?.index) ? row.index : fallbackIndex;
    const vector = decoded.vectors[index];
    return row?.ideaId && vector ? [[row.ideaId, vector]] : [];
  }));
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) + 1e-12);
}

export function classifyIdeaRelation(left, right, similarity) {
  const leftLabel = normalized(left?.label);
  const rightLabel = normalized(right?.label);
  const leftStatement = normalized(left?.statement);
  const rightStatement = normalized(right?.statement);
  if (
    leftLabel
    && (
      leftLabel === rightLabel
      || (leftStatement && leftStatement === rightStatement)
    )
  ) {
    return { relation:'same_as', method:'exact-normalized-idea' };
  }
  if (
    similarity >= 0.82
    && leftStatement
    && rightStatement
    && (
      leftStatement.includes(rightStatement)
      || rightStatement.includes(leftStatement)
    )
  ) {
    return { relation:'extends', method:'semantic-containment' };
  }
  return { relation:'related_to', method:'embedding-neighbour' };
}

function vectorBucketSignature(vector, table, bits = 8) {
  if (!vector?.length) return null;
  let signature = 0;
  for (let bit = 0; bit < bits; bit++) {
    const dimension = (
      7
      + table * 53
      + bit * 37
      + table * bit * 11
    ) % vector.length;
    if ((Number(vector[dimension]) || 0) >= 0) {
      signature |= (1 << bit);
    }
  }
  return signature;
}

function makeScalableCandidateIndex(ideas, vectors, {
  tables = 6,
  bits = 8,
} = {}) {
  const buckets = Array.from({ length:tables }, () => new Map());
  const signatures = [];
  for (let index = 0; index < ideas.length; index++) {
    const vector = vectors.get(ideas[index].ideaId);
    const row = [];
    for (let table = 0; table < tables; table++) {
      const signature = vectorBucketSignature(vector, table, bits);
      row.push(signature);
      if (signature == null) continue;
      const tableBuckets = buckets[table];
      const bucket = tableBuckets.get(signature) || [];
      bucket.push(index);
      tableBuckets.set(signature, bucket);
    }
    signatures.push(row);
  }
  return { buckets, signatures, tables, bits };
}

function scalableCandidateIndexes(
  index,
  candidateIndex,
  {
    maximum = 768,
  } = {},
) {
  const candidates = new Set();
  const addBucket = (bucket) => {
    if (!bucket?.length || candidates.size >= maximum) return;
    let start = 0;
    while (start < bucket.length && bucket[start] <= index) start++;
    for (
      let offset = start;
      offset < bucket.length && candidates.size < maximum;
      offset++
    ) {
      candidates.add(bucket[offset]);
    }
  };
  for (
    let table = 0;
    table < candidateIndex.tables && candidates.size < maximum;
    table++
  ) {
    const signature = candidateIndex.signatures[index]?.[table];
    if (signature == null) continue;
    const tableBuckets = candidateIndex.buckets[table];
    addBucket(tableBuckets.get(signature));
    for (
      let bit = 0;
      bit < candidateIndex.bits && candidates.size < maximum;
      bit++
    ) {
      addBucket(tableBuckets.get(signature ^ (1 << bit)));
    }
  }
  return candidates;
}

export function buildLibraryIdeaGraph({
  ideas = [],
  vectors = new Map(),
  model,
  dimensions,
  minScore = DEFAULT_LIBRARY_LINK_MIN_SCORE,
  topK = DEFAULT_LIBRARY_LINKS_PER_IDEA,
  now = () => new Date().toISOString(),
} = {}) {
  const scalable = ideas.length > 2_048;
  const candidateIndex = scalable
    ? makeScalableCandidateIndex(ideas, vectors)
    : null;
  const candidatesByIdea = new Map();
  for (let leftIndex = 0; leftIndex < ideas.length; leftIndex++) {
    const left = ideas[leftIndex];
    const leftVector = vectors.get(left.ideaId);
    if (!leftVector) continue;
    const rows = [];
    const rightIndexes = scalable
      ? scalableCandidateIndexes(leftIndex, candidateIndex)
      : Array.from(
          { length:Math.max(0, ideas.length - leftIndex - 1) },
          (_, offset) => leftIndex + offset + 1,
        );
    for (const rightIndex of rightIndexes) {
      const right = ideas[rightIndex];
      if (left.workId === right.workId) continue;
      const rightVector = vectors.get(right.ideaId);
      if (!rightVector) continue;
      const score = cosineSimilarity(leftVector, rightVector);
      if (score < minScore) continue;
      rows.push({ left, right, score });
    }
    rows.sort((a, b) => b.score - a.score || a.right.ideaId.localeCompare(b.right.ideaId));
    candidatesByIdea.set(left.ideaId, rows.slice(0, topK));
  }

  const seen = new Set();
  const links = [];
  for (const rows of candidatesByIdea.values()) {
    for (const row of rows) {
      const key = [row.left.ideaId, row.right.ideaId].sort().join('\u001f');
      if (seen.has(key)) continue;
      seen.add(key);
      const classification = classifyIdeaRelation(row.left, row.right, row.score);
      const bytes = new TextEncoder().encode(key);
      let hashA = 0x811c9dc5;
      let hashB = 0x9e3779b9;
      for (const byte of bytes) {
        hashA = Math.imul(hashA ^ byte, 0x01000193) >>> 0;
        hashB = Math.imul(hashB ^ (byte + 0x9d), 0x85ebca6b) >>> 0;
      }
      const pairToken = hashA.toString(16).padStart(8, '0')
        + hashB.toString(16).padStart(8, '0');
      links.push({
        linkId:'idea-link_' + pairToken,
        leftIdeaId:row.left.ideaId,
        rightIdeaId:row.right.ideaId,
        leftWorkId:row.left.workId,
        rightWorkId:row.right.workId,
        relation:classification.relation,
        score:Number(row.score.toFixed(6)),
        evidence:{
          leftPassageIds:(row.left.evidence || []).map((item) => item.passageId),
          rightPassageIds:(row.right.evidence || []).map((item) => item.passageId),
        },
        generatedBy:{
          method:classification.method,
          model:String(model || 'unknown'),
          dimensions:Number(dimensions) || null,
        },
        userState:{
          hidden:false,
          relationOverride:null,
        },
      });
    }
  }
  links.sort((left, right) =>
    right.score - left.score || left.linkId.localeCompare(right.linkId));
  return {
    schemaVersion:IDEA_GRAPH_SCHEMA_VERSION,
    recordType:'books.library-idea-graph',
    model:String(model || 'unknown'),
    dimensions:Number(dimensions) || null,
    candidateStrategy:scalable
      ? 'multi-table-signature-v1'
      : 'exact-all-pairs',
    ideaCount:ideas.length,
    links,
    updatedAt:now(),
  };
}

export function applyIdeaRelationClassifications(
  graph,
  classifications = [],
  {
    provider = null,
    model = null,
    minConfidence = DEFAULT_RELATION_CLASSIFICATION_MIN_CONFIDENCE,
    now = () => new Date().toISOString(),
  } = {},
) {
  const byLinkId = new Map(
    classifications.flatMap((classification) => {
      const relation = String(classification?.relation || '');
      if (
        !classification?.linkId
        || !IDEA_RELATION_TYPE_SET.has(relation)
      ) return [];
      const confidence = Math.max(
        0,
        Math.min(1, Number(classification.confidence) || 0),
      );
      if (confidence < minConfidence) return [];
      return [[String(classification.linkId), {
        relation,
        confidence,
        rationale:String(classification.rationale || '').slice(0, 500) || null,
      }]];
    }),
  );
  let changed = false;
  const links = (graph?.links || []).map((link) => {
    const classification = byLinkId.get(link.linkId);
    if (!classification) return cloneJson(link);
    changed = true;
    return {
      ...cloneJson(link),
      relation:classification.relation,
      classification:{
        confidence:classification.confidence,
        rationale:classification.rationale,
        provider:provider ? String(provider) : null,
        model:model ? String(model) : null,
        classifiedAt:now(),
      },
      generatedBy:{
        ...(link.generatedBy || {}),
        relationMethod:'source-grounded-model-classifier',
      },
    };
  });
  return {
    graph:{
      ...cloneJson(graph),
      links,
      updatedAt:changed ? now() : graph?.updatedAt,
    },
    changed,
  };
}

export function searchIdeaRecords({
  ideas = [],
  vectors = new Map(),
  queryVector,
  query = '',
  limit = 20,
} = {}) {
  const terms = normalized(query).split(' ').filter(Boolean);
  return ideas.map((idea) => {
    const haystack = normalized([
      idea.label,
      idea.statement,
      ...(idea.entities || []).map((entity) =>
        typeof entity === 'string' ? entity : entity?.name),
    ].join(' '));
    const lexical = terms.length
      ? terms.filter((term) => haystack.includes(term)).length / terms.length
      : 0;
    const semantic = queryVector
      ? cosineSimilarity(queryVector, vectors.get(idea.ideaId))
      : 0;
    return {
      idea,
      lexical,
      semantic,
      score:(semantic * DEFAULT_HYBRID_SEMANTIC_WEIGHT)
        + (lexical * DEFAULT_HYBRID_LEXICAL_WEIGHT),
    };
  })
    .filter((result) => result.score > 0)
    .sort((left, right) =>
      right.score - left.score || left.idea.ideaId.localeCompare(right.idea.ideaId))
    .slice(0, Math.max(1, Number(limit) || 20));
}

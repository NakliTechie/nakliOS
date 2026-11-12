import {
  decodeIdeaVectors,
  encodeIdeaVectors,
} from './embedding-binary.js';
import {
  buildLibraryIdeaGraph,
} from './idea-graph.js';

export const SEMANTIC_UNIT_SCHEMA_VERSION = 1;
export const SEMANTIC_UNIT_EXTRACTOR_VERSION = 'semantic-units-v1';
export const ECHO_EMBEDDING_INDEX_VERSION = 'echo-unit-embeddings-v1';
export const ECHO_GRAPH_SCHEMA_VERSION = 1;
export const ECHO_GRAPH_VERSION = 'library-echo-links-v2';
export const READER_CONNECTION_INDEX_VERSION = 'reader-connections-v2';
export const LIBRARY_ECHO_GRAPH_PATH = 'indexes/library-echo-graph.json';
export const ECHO_CURATION_PATH = 'annotations/echoes.json';
export const DEFAULT_ECHO_CANDIDATE_MIN_SCORE = 0.70;
export const DEFAULT_INLINE_ECHO_MIN_SCORE = 0.82;
export const DEFAULT_ECHO_RELATION_MIN_CONFIDENCE = 0.72;
export const DEFAULT_ECHO_LINKS_PER_UNIT = 6;
export const DEFAULT_ECHOES_PER_PARAGRAPH = 3;
// Pre-classification candidate filters (M20). Kept deterministic and identical
// to build_echo_graph in scripts/books-index.py so both executors accept the
// same links.
export const ECHO_MIN_STATEMENT_LENGTH = 16;
export const ECHO_MIN_SPREAD_MARGIN = 0.02;

// Contiguous Unicode ranges, checked in this order, mirrored exactly in Python.
const ECHO_SCRIPT_RANGES = [
  ['devanagari', 0x0900, 0x097f],
  ['bengali', 0x0980, 0x09ff],
  ['tamil', 0x0b80, 0x0bff],
  ['cyrillic', 0x0400, 0x04ff],
  ['greek', 0x0370, 0x03ff],
  ['hebrew', 0x0590, 0x05ff],
  ['arabic', 0x0600, 0x06ff],
  ['hiragana', 0x3040, 0x309f],
  ['katakana', 0x30a0, 0x30ff],
  ['hangul', 0xac00, 0xd7a3],
  ['cjk', 0x4e00, 0x9fff],
];

// The dominant writing system of a statement, or 'neutral' when it carries no
// script-bearing characters. Cross-script pairs are almost always spurious.
export function dominantScript(text) {
  const counts = {};
  for (const character of String(text || '')) {
    const cp = character.codePointAt(0);
    let name = null;
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)
      || (cp >= 0xc0 && cp <= 0x24f)) {
      name = 'latin';
    } else {
      for (const [candidate, lo, hi] of ECHO_SCRIPT_RANGES) {
        if (cp >= lo && cp <= hi) { name = candidate; break; }
      }
    }
    if (name) counts[name] = (counts[name] || 0) + 1;
  }
  const entries = Object.entries(counts);
  if (!entries.length) return 'neutral';
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return entries[0][0];
}

function echoUnitEvidenceOk(unit) {
  return String(unit?.statement || '').trim().length >= ECHO_MIN_STATEMENT_LENGTH
    && (unit?.evidence || []).some((row) => row?.passageId && row?.paragraphId);
}

// The four advertised pre-classification filters, as pure per-pair predicates
// (same-edition is already enforced upstream by excluding same-work pairs):
// language (no cross-script), evidence-quality (substantive grounded units),
// and minimum-spread (a score margin above the candidate floor).
export function echoCandidateFiltersPass(left, right, score, minScore) {
  if (score < minScore + ECHO_MIN_SPREAD_MARGIN) return false;
  const leftScript = dominantScript(left?.statement);
  const rightScript = dominantScript(right?.statement);
  if (leftScript !== 'neutral' && rightScript !== 'neutral'
    && leftScript !== rightScript) return false;
  if (!echoUnitEvidenceOk(left) || !echoUnitEvidenceOk(right)) return false;
  return true;
}

export const ECHO_RELATION_TYPES = Object.freeze([
  'same_as',
  'supports',
  'supported_by',
  'contradicts',
  'extends',
  'extended_by',
  'example_of',
  'has_example',
  'applies_to',
  'shares_mechanism',
  'counterexample_to',
  'has_counterexample',
  'illustrates',
  'illustrated_by',
  'dramatizes',
  'dramatized_by',
  'embodies',
  'embodied_by',
  'violates',
  'violated_by',
  'tests',
  'tested_by',
  'parallels',
  'contrasts_with',
  'echoes',
]);

const RELATION_TYPE_SET = new Set(ECHO_RELATION_TYPES);
const INVERSE_RELATIONS = new Map([
  ['supports', 'supported_by'], ['supported_by', 'supports'],
  ['extends', 'extended_by'], ['extended_by', 'extends'],
  ['example_of', 'has_example'], ['has_example', 'example_of'],
  ['counterexample_to', 'has_counterexample'], ['has_counterexample', 'counterexample_to'],
  ['illustrates', 'illustrated_by'], ['illustrated_by', 'illustrates'],
  ['dramatizes', 'dramatized_by'], ['dramatized_by', 'dramatizes'],
  ['embodies', 'embodied_by'], ['embodied_by', 'embodies'],
  ['violates', 'violated_by'], ['violated_by', 'violates'],
  ['tests', 'tested_by'], ['tested_by', 'tests'],
]);

export function inverseEchoRelation(relation) {
  return INVERSE_RELATIONS.get(relation) || relation;
}
const NARRATIVE_KINDS = new Set([
  'scene',
  'event',
  'character-choice',
  'character-belief',
  'relationship-dynamic',
  'conflict',
  'reversal',
  'consequence',
  'plot-outcome',
  'motif',
  'plot-thread',
  'theme',
]);
const HIGH_SPOILER_KINDS = new Set([
  'reversal',
  'plot-outcome',
  'consequence',
  'event',
  'scene',
]);
const EXPOSITORY_KINDS = new Set([
  'idea', 'concept', 'topic', 'definition', 'claim', 'mechanism', 'principle',
  'example', 'case', 'argument', 'counterargument', 'consequence', 'question',
  'historical-pattern',
]);
const CROSS_LENS_COMPATIBILITY = new Map([
  ['idea', new Set(NARRATIVE_KINDS)],
  ['concept', new Set(NARRATIVE_KINDS)],
  ['topic', new Set(NARRATIVE_KINDS)],
  ['definition', new Set(['motif', 'theme', 'character-belief', 'plot-thread'])],
  ['claim', new Set(['character-belief', 'character-choice', 'event', 'plot-outcome', 'theme'])],
  ['mechanism', new Set(['character-choice', 'relationship-dynamic', 'conflict', 'event', 'reversal', 'plot-outcome', 'scene'])],
  ['principle', new Set(['character-choice', 'character-belief', 'conflict', 'event', 'reversal', 'plot-outcome', 'theme'])],
  ['example', new Set(NARRATIVE_KINDS)],
  ['case', new Set(NARRATIVE_KINDS)],
  ['argument', new Set(['character-belief', 'conflict', 'character-choice', 'theme'])],
  ['counterargument', new Set(['character-belief', 'conflict', 'reversal', 'plot-outcome', 'theme'])],
  ['consequence', new Set(['event', 'reversal', 'plot-outcome', 'conflict', 'scene'])],
  ['question', new Set(['character-choice', 'character-belief', 'conflict', 'theme'])],
  ['historical-pattern', new Set(['event', 'conflict', 'plot-thread', 'plot-outcome', 'theme'])],
]);

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

function stableToken(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '') || 'unit';
}

function unitKind(value, fallback = 'idea') {
  const kind = String(value || fallback).trim().toLocaleLowerCase();
  if (kind === 'candidate-topic') return 'topic';
  if (kind === 'section-opening') return 'scene';
  return kind.replaceAll('_', '-') || fallback;
}

function unitLens(kind, sourceKind) {
  if (kind === 'consequence') return sourceKind === 'scene' ? 'narrative' : 'expository';
  return NARRATIVE_KINDS.has(kind) ? 'narrative' : 'expository';
}

function paragraphRows(passages = []) {
  return passages.flatMap((passage) => {
    if (passage?.paragraphs?.length) return passage.paragraphs;
    if (!passage?.passageId || !passage?.text) return [];
    return [{
      paragraphId:'paragraph-legacy-' + stableToken(passage.passageId),
      passageId:passage.passageId,
      workId:passage.workId,
      assetId:passage.assetId,
      order:passage.order,
      passageOrder:passage.order,
      text:passage.text,
      structure:cloneJson(passage.structure || {}),
      anchor:cloneJson(passage.anchor || {}),
    }];
  });
}

function evidenceForRecord(record, passages, allParagraphs) {
  const passageById = new Map(
    passages.map((passage) => [passage.passageId, passage]),
  );
  const sought = normalized(
    record?.description || record?.statement || record?.label,
  ).split(' ').filter((term) => term.length >= 4).slice(0, 8);
  const total = Math.max(1, allParagraphs.length - 1);
  return (record?.evidence || []).flatMap((reference) => {
    const passage = passageById.get(reference.passageId);
    if (!passage) return [];
    const candidates = passage.paragraphs?.length
      ? passage.paragraphs
      : allParagraphs.filter((paragraph) =>
          paragraph.passageId === passage.passageId);
    if (!candidates.length) return [];
    if (
      record?.generatedBy?.mode === 'model-assisted'
      && !reference.paragraphId
    ) return [];
    const explicitlyAnchored = reference.paragraphId
      ? candidates.find((paragraph) =>
          paragraph.paragraphId === reference.paragraphId)
      : null;
    const paragraph = explicitlyAnchored || candidates.slice().sort((left, right) => {
      const leftText = normalized(left.text);
      const rightText = normalized(right.text);
      const leftMatches = sought.filter((term) => leftText.includes(term)).length;
      const rightMatches = sought.filter((term) => rightText.includes(term)).length;
      return rightMatches - leftMatches || left.order - right.order;
    })[0];
    return [{
      passageId:passage.passageId,
      paragraphId:paragraph.paragraphId,
      quoteHash:paragraph.anchor?.quoteHash
        || reference.quoteHash
        || passage.anchor?.quoteHash
        || null,
      textHash:paragraph.anchor?.textHash || null,
      excerpt:String(paragraph.text || passage.text || '').slice(0, 520),
      order:Number(paragraph.order) || 0,
      passageOrder:Number(passage.order) || 0,
      positionFraction:(Number(paragraph.order) || 0) / total,
      sectionIndex:Number(paragraph.structure?.sectionIndex) || 0,
      weight:Number(reference.weight) || 1,
    }];
  });
}

function semanticUnit({
  workId,
  source,
  sourceKind,
  sourceId,
  passages,
  paragraphs,
}) {
  const label = String(
    source?.userState?.labelOverride || source?.label || '',
  ).trim();
  const statement = String(
    source?.description || source?.statement || label,
  ).trim();
  if (!label || !statement || source?.userState?.hidden) return null;
  const evidence = evidenceForRecord(source, passages, paragraphs);
  if (!evidence.length) return null;
  const kind = unitKind(source?.kind, sourceKind);
  return {
    unitId:'unit_' + stableToken(workId) + '_' + stableToken(sourceId),
    workId,
    sourceRecordId:String(sourceId),
    kind,
    lens:unitLens(kind, sourceKind),
    label:label.slice(0, 180),
    statement:statement.slice(0, 1400),
    participants:cloneJson(source?.participants || source?.entities || []),
    qualifiers:cloneJson(source?.qualifiers || []),
    confidence:Math.max(0, Math.min(1, Number(source?.confidence) || 0)),
    evidence,
    generatedBy:{
      extractor:SEMANTIC_UNIT_EXTRACTOR_VERSION,
      sourceExtractor:source?.generatedBy?.extractor || null,
      mode:source?.generatedBy?.mode || 'deterministic-local',
      model:source?.generatedBy?.model || null,
    },
    userState:{
      hidden:false,
      labelOverride:null,
    },
  };
}

function deterministicParagraphUnit(workId, paragraph, passages, paragraphs) {
  const statement = String(paragraph?.text || '').split(/(?<=[.!?])\s+/)[0]
    .trim().slice(0, 700);
  if (statement.length < 24) return null;
  const normalizedStatement = normalized(statement);
  let kind = null;
  if (/\b(is defined as|refers to|is the term for|means)\b/.test(normalizedStatement)) {
    kind = 'definition';
  } else if (/\b(because|therefore|causes?|leads? to|results? in|as a result)\b/.test(normalizedStatement)) {
    kind = 'mechanism';
  } else if (/\b(chose|chooses|decided|decides|refused|refuses|betrayed|abandons?)\b/.test(normalizedStatement)) {
    kind = 'character-choice';
  } else if (/\b(we argue|this shows|this demonstrates|must|should)\b/.test(normalizedStatement)) {
    kind = 'claim';
  } else if (statement.endsWith('?')) {
    kind = 'question';
  }
  if (!kind) return null;
  const passage = passages.find((candidate) =>
    candidate.passageId === paragraph.passageId);
  if (!passage) return null;
  const label = statement.replace(/[.!?]+$/, '').slice(0, 96);
  return semanticUnit({
    workId,
    source:{
      label,
      kind,
      description:statement,
      confidence:0.62,
      evidence:[{
        passageId:paragraph.passageId,
        paragraphId:paragraph.paragraphId,
        quoteHash:paragraph.anchor?.quoteHash || null,
        weight:1,
      }],
      generatedBy:{
        extractor:SEMANTIC_UNIT_EXTRACTOR_VERSION,
        mode:'deterministic-local',
      },
      userState:{ hidden:false, labelOverride:null },
    },
    sourceKind:kind,
    sourceId:'baseline_' + kind + '_' + paragraph.paragraphId,
    passages,
    paragraphs,
  });
}

export function makeSemanticUnits({
  workId,
  semanticRecord,
  passages = [],
  sourceFingerprint = null,
  now = () => new Date().toISOString(),
} = {}) {
  const paragraphs = paragraphRows(passages);
  const units = [];
  for (const concept of semanticRecord?.concepts || []) {
    const unit = semanticUnit({
      workId,
      source:concept,
      sourceKind:'concept',
      sourceId:concept.conceptId,
      passages,
      paragraphs,
    });
    if (unit) units.push(unit);
  }
  for (const scene of semanticRecord?.scenes || []) {
    const unit = semanticUnit({
      workId,
      source:scene,
      sourceKind:'scene',
      sourceId:scene.sceneId,
      passages,
      paragraphs,
    });
    if (unit) units.push(unit);
  }
  const existingEvidence = new Set(units.flatMap((unit) =>
    unit.evidence.map((evidence) => unit.kind + ':' + evidence.paragraphId)));
  for (const paragraph of paragraphs.slice(0, 240)) {
    const unit = deterministicParagraphUnit(workId, paragraph, passages, paragraphs);
    const evidenceKey = unit && unit.kind + ':' + unit.evidence[0]?.paragraphId;
    if (unit && !existingEvidence.has(evidenceKey)) {
      units.push(unit);
      existingEvidence.add(evidenceKey);
    }
  }
  units.sort((left, right) =>
    (left.evidence[0]?.order || 0) - (right.evidence[0]?.order || 0)
    || left.unitId.localeCompare(right.unitId));
  return {
    schemaVersion:SEMANTIC_UNIT_SCHEMA_VERSION,
    recordType:'books.semantic-units',
    extractorVersion:SEMANTIC_UNIT_EXTRACTOR_VERSION,
    workId,
    sourceFingerprint:sourceFingerprint || semanticRecord?.sourceFingerprint || null,
    paragraphCount:paragraphs.length,
    units,
    updatedAt:now(),
  };
}

export function semanticUnitEmbeddingText(unit) {
  const participants = (unit?.participants || []).map((value) =>
    typeof value === 'string' ? value : value?.name);
  return Array.from(new Set([
    unit?.kind,
    unit?.label,
    unit?.statement,
    ...(unit?.qualifiers || []),
    ...participants,
  ].map((value) => String(value || '').trim()).filter(Boolean)))
    .join('. ')
    .slice(0, 1800);
}

export function makeSemanticUnitEmbeddingBundle({
  workId,
  unitRecord,
  vectors = [],
  model,
  dimensions,
  sourceFingerprint = null,
  inputFingerprint = null,
  now = () => new Date().toISOString(),
} = {}) {
  const units = unitRecord?.units || [];
  if (units.length !== vectors.length) {
    throw new Error('Every semantic unit requires exactly one embedding vector');
  }
  const vectorPath = semanticUnitEmbeddingVectorPath(workId);
  const binary = encodeIdeaVectors(vectors, Number(dimensions) || 0);
  return {
    record:{
      schemaVersion:1,
      recordType:'books.semantic-unit-embeddings',
      indexVersion:ECHO_EMBEDDING_INDEX_VERSION,
      workId,
      model:String(model || 'unknown'),
      dimensions:Number(dimensions) || null,
      normalized:true,
      sourceFingerprint:sourceFingerprint || unitRecord?.sourceFingerprint || null,
      inputFingerprint:inputFingerprint ? String(inputFingerprint) : null,
      encoding:'books-float32-le-v1',
      vectorPath,
      rows:units.map((unit, index) => ({ unitId:unit.unitId, index })),
      updatedAt:now(),
    },
    binary,
  };
}

export function semanticUnitVectorMap(embeddingRecord, binary = null) {
  const rows = embeddingRecord?.rows || [];
  const legacy = rows.every((row) => Array.isArray(row?.vector));
  if (legacy) {
    return new Map(rows.flatMap((row) =>
      row?.unitId && Array.isArray(row.vector)
        ? [[row.unitId, row.vector]] : []));
  }
  const decoded = decodeIdeaVectors(binary, {
    expectedRows:rows.length,
    expectedDimensions:Number(embeddingRecord?.dimensions) || 0,
  });
  return new Map(rows.flatMap((row, fallbackIndex) => {
    const index = Number.isInteger(row?.index) ? row.index : fallbackIndex;
    const vector = decoded.vectors[index];
    return row?.unitId && vector ? [[row.unitId, vector]] : [];
  }));
}

export function semanticUnitsPath(workId) {
  return `semantic/${workId}/units.json`;
}

export function semanticUnitEmbeddingsPath(workId) {
  return `indexes/echo-unit-embeddings/${workId}.json`;
}

export function semanticUnitEmbeddingVectorPath(workId) {
  return `indexes/echo-unit-embeddings/${workId}.f32`;
}

export function readerConnectionsPath(workId) {
  return `semantic/${workId}/reader-connections.json`;
}

export function echoKindsCompatible(left, right) {
  const leftKind = unitKind(left?.kind);
  const rightKind = unitKind(right?.kind);
  const leftNarrative = left?.lens === 'narrative'
    || (left?.lens !== 'expository' && NARRATIVE_KINDS.has(leftKind));
  const rightNarrative = right?.lens === 'narrative'
    || (right?.lens !== 'expository' && NARRATIVE_KINDS.has(rightKind));
  if (leftNarrative === rightNarrative) {
    return leftNarrative || (
      EXPOSITORY_KINDS.has(leftKind) && EXPOSITORY_KINDS.has(rightKind)
    );
  }
  const expositoryKind = leftNarrative ? rightKind : leftKind;
  const narrativeKind = leftNarrative ? leftKind : rightKind;
  return CROSS_LENS_COMPATIBILITY.get(expositoryKind)?.has(narrativeKind) === true;
}

export function buildEchoGraph({
  units = [],
  vectors = new Map(),
  model,
  dimensions,
  minScore = DEFAULT_ECHO_CANDIDATE_MIN_SCORE,
  topK = DEFAULT_ECHO_LINKS_PER_UNIT,
  now = () => new Date().toISOString(),
} = {}) {
  const validUnits = units.filter((unit) => (
    !unit?.userState?.hidden
    && unit?.unitId
    && unit?.workId
    && vectors.has(unit.unitId)
    && unit.evidence?.some((evidence) =>
      evidence?.passageId && evidence?.paragraphId)
  ));
  const unitById = new Map(validUnits.map((unit) => [unit.unitId, unit]));
  const base = buildLibraryIdeaGraph({
    ideas:validUnits.map((unit) => ({
      ideaId:unit.unitId,
      workId:unit.workId,
      label:unit.label,
      statement:unit.statement,
      kind:unit.kind,
      evidence:unit.evidence,
    })),
    vectors,
    model,
    dimensions,
    minScore,
    topK:Math.max(topK, topK * 3),
    now,
  });
  const candidates = base.links.flatMap((link) => {
    const left = unitById.get(link.leftIdeaId);
    const right = unitById.get(link.rightIdeaId);
    if (!left || !right || !echoKindsCompatible(left, right)) return [];
    const leftHashes = new Set(left.evidence.map((row) => row.textHash).filter(Boolean));
    const duplicateEvidence = right.evidence.some((row) =>
      row.textHash && leftHashes.has(row.textHash));
    if (duplicateEvidence) return [];
    if (!echoCandidateFiltersPass(left, right, link.score, minScore)) return [];
    return [{ link, left, right }];
  }).sort((a, b) => b.link.score - a.link.score
    || a.link.linkId.localeCompare(b.link.linkId));
  const visibleCounts = new Map();
  const bounded = candidates.filter(({ left, right }) => {
    if (
      (visibleCounts.get(left.unitId) || 0) >= topK
      || (visibleCounts.get(right.unitId) || 0) >= topK
    ) return false;
    visibleCounts.set(left.unitId, (visibleCounts.get(left.unitId) || 0) + 1);
    visibleCounts.set(right.unitId, (visibleCounts.get(right.unitId) || 0) + 1);
    return true;
  });
  return {
    schemaVersion:ECHO_GRAPH_SCHEMA_VERSION,
    recordType:'books.library-echo-graph',
    graphVersion:ECHO_GRAPH_VERSION,
    model:String(model || 'unknown'),
    dimensions:Number(dimensions) || null,
    candidateStrategy:base.candidateStrategy,
    unitCount:validUnits.length,
    compatibilityStrategy:'typed-units-v1',
    links:bounded.map(({ link }) => ({
      linkId:String(link.linkId).replace(/^idea-link_/, 'echo-link_'),
      leftUnitId:link.leftIdeaId,
      rightUnitId:link.rightIdeaId,
      leftWorkId:link.leftWorkId,
      rightWorkId:link.rightWorkId,
      relation:link.relation === 'related_to' ? 'echoes' : link.relation,
      score:link.score,
      evidence:{
        leftPassageIds:cloneJson(link.evidence?.leftPassageIds || []),
        rightPassageIds:cloneJson(link.evidence?.rightPassageIds || []),
      },
      generatedBy:{
        ...(link.generatedBy || {}),
        graph:ECHO_GRAPH_VERSION,
      },
      userState:{ hidden:false, relationOverride:null },
    })),
    updatedAt:now(),
  };
}

export function applyEchoRelationClassifications(
  graph,
  classifications = [],
  {
    provider = null,
    model = null,
    minConfidence = DEFAULT_ECHO_RELATION_MIN_CONFIDENCE,
    now = () => new Date().toISOString(),
  } = {},
) {
  const accepted = new Map(classifications.flatMap((classification) => {
    const relation = String(classification?.relation || '');
    const confidence = Math.max(
      0,
      Math.min(1, Number(classification?.confidence) || 0),
    );
    if (
      !classification?.linkId
      || !RELATION_TYPE_SET.has(relation)
      || confidence < minConfidence
    ) return [];
    return [[String(classification.linkId), {
      relation,
      confidence,
      explanation:String(
        classification.explanation || classification.rationale || '',
      ).trim().slice(0, 700) || null,
    }]];
  }));
  let changed = false;
  const links = (graph?.links || []).map((link) => {
    const value = accepted.get(link.linkId);
    if (!value) return cloneJson(link);
    const deterministicStrong = (
      link.relation === 'same_as'
      && link.generatedBy?.method === 'exact-normalized-idea'
    ) || (
      link.relation === 'extends'
      && link.generatedBy?.method === 'semantic-containment'
    );
    if (deterministicStrong && value.confidence < 0.9) {
      return cloneJson(link);
    }
    changed = true;
    return {
      ...cloneJson(link),
      relation:value.relation,
      classification:{
        confidence:value.confidence,
        explanation:value.explanation,
        provider:provider ? String(provider) : null,
        model:model ? String(model) : null,
        classifiedAt:now(),
      },
      generatedBy:{
        ...(link.generatedBy || {}),
        relationMethod:'source-grounded-echo-classifier',
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

function relationExplanation(relation, current, target, targetTitle) {
  const currentLabel = current?.label || 'this idea';
  const targetLabel = target?.label || 'a related idea';
  const title = targetTitle || 'another work';
  const templates = {
    same_as:`Both passages develop the same named idea: ${targetLabel}.`,
    supports:`This passage supports ${targetLabel} in ${title}.`,
    supported_by:`This passage is supported by ${targetLabel} in ${title}.`,
    contradicts:`This passage challenges ${targetLabel} in ${title}.`,
    extends:`This passage extends ${targetLabel} in ${title}.`,
    extended_by:`This passage is extended by ${targetLabel} in ${title}.`,
    example_of:`This passage offers an example of ${targetLabel} in ${title}.`,
    has_example:`${targetLabel} in ${title} offers an example of this passage.`,
    applies_to:`${currentLabel} can be applied to the related passage in ${title}.`,
    shares_mechanism:`Both passages share the mechanism described as ${targetLabel}.`,
    counterexample_to:`This passage offers a counterexample to ${targetLabel} in ${title}.`,
    has_counterexample:`${targetLabel} in ${title} offers a counterexample to this passage.`,
    illustrates:`This passage illustrates ${targetLabel} in ${title}.`,
    illustrated_by:`This passage is illustrated by ${targetLabel} in ${title}.`,
    dramatizes:`This passage dramatizes ${targetLabel} in ${title}.`,
    dramatized_by:`This passage is dramatized by ${targetLabel} in ${title}.`,
    embodies:`This passage embodies ${targetLabel} in ${title}.`,
    embodied_by:`This passage is embodied by ${targetLabel} in ${title}.`,
    violates:`This passage tests or violates ${targetLabel} in ${title}.`,
    violated_by:`This passage is violated by ${targetLabel} in ${title}.`,
    tests:`This passage puts ${targetLabel} from ${title} under pressure.`,
    tested_by:`This passage is put under pressure by ${targetLabel} in ${title}.`,
    parallels:`This passage parallels ${targetLabel} in ${title}.`,
    contrasts_with:`This passage contrasts with ${targetLabel} in ${title}.`,
    echoes:`This passage echoes ${targetLabel} in ${title}.`,
  };
  return templates[relation] || templates.echoes;
}

function spoilerFor(unit, evidence) {
  const fraction = Number(evidence?.positionFraction) || 0;
  const highKind = HIGH_SPOILER_KINDS.has(unit?.kind);
  if ((highKind && fraction >= 0.55) || fraction >= 0.82) {
    return { risk:'high', reason:'late-narrative-evidence' };
  }
  if (highKind || fraction >= 0.62) {
    return { risk:'medium', reason:'narrative-evidence' };
  }
  return { risk:'low', reason:null };
}

export function makeEchoCurationRecord(value = {}, now = () => new Date().toISOString()) {
  const record = value && typeof value === 'object' ? value : {};
  return {
    schemaVersion:1,
    recordType:'books.echo-curation',
    connectionFeedback:cloneJson(record.connectionFeedback || {}),
    linkFeedback:cloneJson(record.linkFeedback || {}),
    workExclusions:cloneJson(record.workExclusions || {}),
    updatedAt:record.updatedAt || now(),
  };
}

export function updateEchoConnectionCuration(
  value,
  connectionId,
  { hidden, rating, spoiler, linkId = null } = {},
  now = () => new Date().toISOString(),
) {
  const record = makeEchoCurationRecord(value, now);
  const previous = record.connectionFeedback[connectionId] || {};
  record.connectionFeedback[connectionId] = {
    ...previous,
    ...(typeof hidden === 'boolean' ? { hidden } : {}),
    ...(rating ? { rating:String(rating) } : {}),
    ...(typeof spoiler === 'boolean' ? { spoiler } : {}),
    updatedAt:now(),
  };
  if (rating === 'wrong' && linkId) {
    record.linkFeedback[linkId] = {
      hidden:true,
      rating:'wrong',
      updatedAt:now(),
    };
  }
  record.updatedAt = now();
  return record;
}

export function updateEchoWorkExclusion(
  value,
  workId,
  excluded,
  now = () => new Date().toISOString(),
) {
  const record = makeEchoCurationRecord(value, now);
  record.workExclusions[workId] = {
    excluded:excluded === true,
    updatedAt:now(),
  };
  record.updatedAt = now();
  return record;
}

export function mergeEchoCurationRecords(left, right) {
  const first = makeEchoCurationRecord(left);
  const second = makeEchoCurationRecord(right);
  const mergeMap = (a, b) => {
    const merged = cloneJson(a || {});
    for (const [key, incoming] of Object.entries(b || {})) {
      const current = merged[key];
      if (
        !current
        || String(incoming?.updatedAt || '') >= String(current?.updatedAt || '')
      ) merged[key] = cloneJson(incoming);
    }
    return merged;
  };
  return makeEchoCurationRecord({
    connectionFeedback:mergeMap(first.connectionFeedback, second.connectionFeedback),
    linkFeedback:mergeMap(first.linkFeedback, second.linkFeedback),
    workExclusions:mergeMap(first.workExclusions, second.workExclusions),
    updatedAt:String(first.updatedAt) >= String(second.updatedAt)
      ? first.updatedAt : second.updatedAt,
  });
}

export function applyEchoCurationToReaderConnections(record, curation) {
  if (!record || typeof record !== 'object') return record;
  const curated = makeEchoCurationRecord(curation);
  const sourceExcluded = curated.workExclusions?.[record.workId]?.excluded;
  const connections = sourceExcluded ? [] : (record.connections || []).filter(
    (connection) => {
      if (curated.workExclusions?.[connection.target?.workId]?.excluded) return false;
      if (curated.linkFeedback?.[connection.linkId]?.hidden) return false;
      return !curated.connectionFeedback?.[connection.connectionId]?.hidden;
    },
  ).map((connection) => {
    const feedback = curated.connectionFeedback?.[connection.connectionId] || {};
    return {
      ...cloneJson(connection),
      userState:{
        ...cloneJson(connection.userState || {}),
        hidden:false,
        rating:feedback.rating || connection.userState?.rating || null,
        spoiler:feedback.spoiler === true || connection.userState?.spoiler === true,
      },
    };
  });
  return {
    ...cloneJson(record),
    connectionCount:connections.length,
    connections,
  };
}

export function buildReaderConnectionsForWork({
  workId,
  graph,
  units = [],
  manifests = [],
  curation = null,
  minScore = DEFAULT_INLINE_ECHO_MIN_SCORE,
  maxPerParagraph = DEFAULT_ECHOES_PER_PARAGRAPH,
  now = () => new Date().toISOString(),
} = {}) {
  const curated = makeEchoCurationRecord(curation);
  if (curated.workExclusions?.[workId]?.excluded) {
    return {
      schemaVersion:1,
      recordType:'books.reader-connections',
      indexVersion:READER_CONNECTION_INDEX_VERSION,
      workId,
      graphVersion:graph?.graphVersion || ECHO_GRAPH_VERSION,
      connectionCount:0,
      connections:[],
      updatedAt:now(),
    };
  }
  const unitById = new Map(units.map((unit) => [unit.unitId, unit]));
  const titleByWorkId = new Map(manifests.map((manifest) => [
    manifest.workId,
    manifest.title || 'Untitled work',
  ]));
  const rows = [];
  for (const link of graph?.links || []) {
    if (link.userState?.hidden) continue;
    if (curated.linkFeedback?.[link.linkId]?.hidden) continue;
    const currentIsLeft = link.leftWorkId === workId;
    if (!currentIsLeft && link.rightWorkId !== workId) continue;
    const current = unitById.get(
      currentIsLeft ? link.leftUnitId : link.rightUnitId,
    );
    const target = unitById.get(
      currentIsLeft ? link.rightUnitId : link.leftUnitId,
    );
    if (!current || !target || current.userState?.hidden || target.userState?.hidden) {
      continue;
    }
    const relationConfidence = Number(link.classification?.confidence) || 0;
    const linkScore = Number(link.score) || 0;
    if (
      linkScore < minScore
      || (link.classification && relationConfidence < minScore)
    ) continue;
    const sourceEvidence = current.evidence?.[0];
    const targetEvidence = target.evidence?.[0];
    if (!sourceEvidence?.paragraphId || !targetEvidence?.paragraphId) continue;
    if (curated.workExclusions?.[target.workId]?.excluded) continue;
    const targetTitle = titleByWorkId.get(target.workId) || 'another work';
    const relation = currentIsLeft
      ? link.relation : inverseEchoRelation(link.relation);
    const explanation = currentIsLeft && link.classification?.explanation
      ? link.classification.explanation
      : relationExplanation(relation, current, target, targetTitle);
    const connectionId = [
      'echo',
      stableToken(link.linkId),
      currentIsLeft ? 'left' : 'right',
    ].join('_');
    const feedback = curated.connectionFeedback?.[connectionId] || {};
    if (feedback.hidden) continue;
    rows.push({
      connectionId,
      linkId:link.linkId,
      source:{
        workId:current.workId,
        unitId:current.unitId,
        paragraphId:sourceEvidence.paragraphId,
        passageId:sourceEvidence.passageId,
        excerpt:sourceEvidence.excerpt,
        label:current.label,
        kind:current.kind,
      },
      target:{
        workId:target.workId,
        unitId:target.unitId,
        paragraphId:targetEvidence.paragraphId,
        passageId:targetEvidence.passageId,
        excerpt:targetEvidence.excerpt,
        label:target.label,
        kind:target.kind,
        workTitle:targetTitle,
        positionFraction:targetEvidence.positionFraction,
      },
      relation,
      direction:currentIsLeft ? 'forward' : 'reverse',
      score:Number(link.score) || 0,
      confidence:relationConfidence || Number(link.score) || 0,
      explanation,
      teaser:'A source-grounded ' + relation.replaceAll('_', ' ') +
        ' connection is available from another book.',
      spoiler:spoilerFor(target, targetEvidence),
      evidence:{
        sourceQuoteHash:sourceEvidence.quoteHash || null,
        targetQuoteHash:targetEvidence.quoteHash || null,
      },
      generatedBy:{
        graph:ECHO_GRAPH_VERSION,
        model:link.classification?.model || graph.model || null,
        relationMethod:link.generatedBy?.relationMethod
          || link.generatedBy?.method || 'embedding-neighbour',
      },
      userState:{
        hidden:false,
        rating:feedback.rating || null,
        spoiler:feedback.spoiler === true,
      },
    });
  }
  const byParagraph = new Map();
  for (const row of rows.sort((left, right) =>
    right.confidence - left.confidence
    || right.score - left.score
    || left.connectionId.localeCompare(right.connectionId))) {
    const values = byParagraph.get(row.source.paragraphId) || [];
    if (
      values.length < maxPerParagraph
      && !values.some((value) =>
        value.target.workId === row.target.workId
        && value.target.unitId === row.target.unitId)
    ) values.push(row);
    byParagraph.set(row.source.paragraphId, values);
  }
  const connections = Array.from(byParagraph.values()).flat();
  return {
    schemaVersion:1,
    recordType:'books.reader-connections',
    indexVersion:READER_CONNECTION_INDEX_VERSION,
    workId,
    graphVersion:graph?.graphVersion || ECHO_GRAPH_VERSION,
    connectionCount:connections.length,
    connections,
    updatedAt:now(),
  };
}

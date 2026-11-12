import {
  DEFAULT_INLINE_ECHO_MIN_SCORE,
  ECHO_GRAPH_VERSION,
  ECHO_RELATION_TYPES,
  makeEchoCurationRecord,
} from './echoes.js';

export const ECHO_REVIEW_QUEUE_SCHEMA_VERSION = 1;
export const ECHO_REVIEW_QUEUE_VERSION = 'echo-review-queue-v1';
export const ECHO_REVIEW_QUEUE_PATH = 'indexes/echo-review-queue.json';
export const ECHO_EVALUATION_SCHEMA_VERSION = 1;
export const ECHO_EVALUATION_VERSION = 'echo-evaluations-v1';
export const ECHO_EVALUATION_PATH = 'annotations/echo-evaluations.json';

export const ECHO_REVIEW_LABELS = Object.freeze([
  'useful',
  'obvious',
  'weak',
  'wrong',
  'repetitive',
  'spoiler-sensitive',
]);

export const ECHO_QUERY_REVIEW_LABELS = Object.freeze([
  'good',
  'mixed',
  'poor',
  'duplicate',
  'missing',
]);

const REVIEW_LABEL_SET = new Set(ECHO_REVIEW_LABELS);
const QUERY_LABEL_SET = new Set(ECHO_QUERY_REVIEW_LABELS);
const RELATION_SET = new Set(ECHO_RELATION_TYPES);
const NARRATIVE_KINDS = new Set([
  'scene', 'event', 'character-choice', 'character-belief',
  'relationship-dynamic', 'conflict', 'reversal', 'plot-outcome', 'motif',
  'plot-thread', 'theme',
]);
const HIGH_SPOILER_KINDS = new Set([
  'reversal', 'plot-outcome', 'consequence', 'event', 'scene',
]);
const GENERIC_LABELS = new Set([
  'change', 'choice', 'conflict', 'culture', 'experience', 'family', 'history',
  'idea', 'identity', 'knowledge', 'life', 'love', 'memory', 'people', 'power',
  'problem', 'relationship', 'society', 'story', 'theme', 'time', 'truth',
  'work', 'world',
]);
const SAFE_PORTABLE_ID = /^[A-Za-z0-9_-]{1,240}$/;

function boundedText(value, limit = 160) {
  return String(value || '').trim().slice(0, limit) || null;
}

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

function stableId(prefix, value) {
  const text = String(value || '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return prefix + '_' + (hash >>> 0).toString(16).padStart(8, '0');
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function unitLens(unit) {
  if (unit?.lens === 'narrative' || unit?.lens === 'expository') {
    return unit.lens;
  }
  return NARRATIVE_KINDS.has(String(unit?.kind || ''))
    ? 'narrative' : 'expository';
}

function pairDirection(left, right) {
  const leftLens = unitLens(left);
  const rightLens = unitLens(right);
  if (leftLens === 'narrative' && rightLens === 'narrative') {
    return 'fiction-to-fiction';
  }
  if (leftLens === 'expository' && rightLens === 'expository') {
    return 'nonfiction-to-nonfiction';
  }
  return 'nonfiction-to-fiction';
}

function evidenceFor(unit) {
  const evidence = (unit?.evidence || []).find((row) =>
    row?.passageId && row?.paragraphId);
  if (!evidence) return null;
  return {
    passageId:String(evidence.passageId),
    paragraphId:String(evidence.paragraphId),
    quoteHash:evidence.quoteHash ? String(evidence.quoteHash) : null,
    textHash:evidence.textHash ? String(evidence.textHash) : null,
    excerpt:String(evidence.excerpt || '').slice(0, 620),
    positionFraction:Math.max(
      0,
      Math.min(1, Number(evidence.positionFraction) || 0),
    ),
  };
}

function spoilerRisk(unit, evidence) {
  const fraction = Number(evidence?.positionFraction) || 0;
  const highKind = HIGH_SPOILER_KINDS.has(String(unit?.kind || ''));
  if ((highKind && fraction >= 0.55) || fraction >= 0.82) return 'high';
  if (highKind || fraction >= 0.62) return 'medium';
  return 'low';
}

function reviewSide(unit, evidence, titleByWorkId) {
  return {
    workId:String(unit.workId),
    workTitle:titleByWorkId.get(unit.workId) || 'Untitled work',
    unitId:String(unit.unitId),
    kind:String(unit.kind || 'idea'),
    lens:unitLens(unit),
    label:String(unit.label || unit.statement || 'Untitled idea').slice(0, 180),
    statement:String(unit.statement || unit.label || '').slice(0, 1400),
    confidence:Math.max(0, Math.min(1, Number(unit.confidence) || 0)),
    evidence,
    generatedBy:cloneJson(unit.generatedBy || {}),
  };
}

function reviewProvenance(item) {
  const leftGenerated = item?.left?.generatedBy || {};
  const rightGenerated = item?.right?.generatedBy || {};
  const classification = item?.classification || {};
  const generated = item?.generatedBy || {};
  const modelAssisted = Boolean(
    classification.model
    || classification.provider
    || leftGenerated.mode === 'model-assisted'
    || rightGenerated.mode === 'model-assisted'
  );
  return {
    route:modelAssisted ? 'model-assisted' : 'deterministic-local',
    relationMethod:boundedText(
      generated.relationMethod || generated.method || 'embedding-neighbour',
    ),
    provider:boundedText(classification.provider),
    model:boundedText(classification.model),
    leftExtractor:boundedText(
      leftGenerated.extractorVersion || leftGenerated.extractor,
    ),
    rightExtractor:boundedText(
      rightGenerated.extractorVersion || rightGenerated.extractor,
    ),
  };
}

function sanitizeReviewProvenance(value) {
  const provenance = value && typeof value === 'object' ? value : {};
  return {
    route:provenance.route === 'model-assisted'
      ? 'model-assisted' : 'deterministic-local',
    relationMethod:boundedText(provenance.relationMethod),
    provider:boundedText(provenance.provider),
    model:boundedText(provenance.model),
    leftExtractor:boundedText(provenance.leftExtractor),
    rightExtractor:boundedText(provenance.rightExtractor),
  };
}

function selectStratum({ direction, generic, weak, spoiler }) {
  if (spoiler) return 'spoiler-sensitive';
  if (generic) return 'generic-or-repetitive';
  if (weak) return 'likely-false-positive';
  return direction;
}

function roundRobin(items, target) {
  const order = [
    'fiction-to-fiction',
    'nonfiction-to-nonfiction',
    'nonfiction-to-fiction',
    'likely-false-positive',
    'generic-or-repetitive',
    'spoiler-sensitive',
  ];
  const buckets = new Map(order.map((stratum) => [stratum, []]));
  for (const item of items) {
    const bucket = buckets.get(item.stratum) || [];
    bucket.push(item);
    buckets.set(item.stratum, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) =>
      right.score - left.score || left.reviewId.localeCompare(right.reviewId));
  }
  const selected = [];
  const selectedIds = new Set();
  const workCounts = new Map();
  const relationCounts = new Map();
  const workCap = Math.max(6, Math.ceil(target / 8));
  const relationCap = Math.max(8, Math.ceil(target / 4));
  const accept = (item, enforceCaps = true) => {
    if (selectedIds.has(item.reviewId)) return false;
    const workIds = [item.left.workId, item.right.workId];
    if (enforceCaps && workIds.some((workId) =>
      (workCounts.get(workId) || 0) >= workCap)) return false;
    if (
      enforceCaps
      && (relationCounts.get(item.relation) || 0) >= relationCap
    ) return false;
    selected.push(item);
    selectedIds.add(item.reviewId);
    for (const workId of workIds) {
      workCounts.set(workId, (workCounts.get(workId) || 0) + 1);
    }
    relationCounts.set(
      item.relation,
      (relationCounts.get(item.relation) || 0) + 1,
    );
    return true;
  };
  let progressed = true;
  while (selected.length < target && progressed) {
    progressed = false;
    for (const stratum of order) {
      const bucket = buckets.get(stratum);
      while (bucket?.length) {
        const item = bucket.shift();
        if (accept(item)) {
          progressed = true;
          break;
        }
      }
      if (selected.length >= target) break;
    }
  }
  if (selected.length < target) {
    for (const item of items.slice().sort((left, right) =>
      right.score - left.score || left.reviewId.localeCompare(right.reviewId))) {
      accept(item, false);
      if (selected.length >= target) break;
    }
  }
  return selected;
}

function buildQueryQueue(units, target) {
  const groups = new Map();
  for (const unit of units) {
    const label = String(unit?.label || '').trim();
    const key = normalized(label);
    if (key.length < 4 || key.length > 100) continue;
    const current = groups.get(key) || {
      label,
      workIds:new Set(),
      unitIds:[],
      kinds:new Set(),
      lenses:new Set(),
      confidence:0,
    };
    current.workIds.add(unit.workId);
    current.unitIds.push(unit.unitId);
    current.kinds.add(String(unit.kind || 'idea'));
    current.lenses.add(unitLens(unit));
    current.confidence = Math.max(current.confidence, Number(unit.confidence) || 0);
    groups.set(key, current);
  }
  const candidates = Array.from(groups.entries()).map(([key, group]) => {
    const words = key.split(' ').filter(Boolean);
    const generic = words.length === 1 && GENERIC_LABELS.has(key);
    const lens = group.lenses.size > 1
      ? 'cross-genre'
      : Array.from(group.lenses)[0] || 'expository';
    return {
      queryId:stableId('query', key),
      query:group.label.slice(0, 120),
      normalizedQuery:key,
      lens,
      kinds:Array.from(group.kinds).sort(),
      sourceWorkIds:Array.from(group.workIds).sort().slice(0, 12),
      sourceUnitIds:group.unitIds.slice().sort().slice(0, 24),
      generic,
      score:(group.workIds.size * 2) + group.confidence + (words.length > 1 ? 1 : 0),
    };
  }).sort((left, right) =>
    right.score - left.score || left.queryId.localeCompare(right.queryId));
  const buckets = new Map([
    ['narrative', []],
    ['expository', []],
    ['cross-genre', []],
  ]);
  for (const candidate of candidates) {
    if (candidate.generic) continue;
    buckets.get(candidate.lens)?.push(candidate);
  }
  const selected = [];
  const order = ['expository', 'narrative', 'cross-genre'];
  let progressed = true;
  while (selected.length < target && progressed) {
    progressed = false;
    for (const lens of order) {
      const candidate = buckets.get(lens)?.shift();
      if (candidate) {
        selected.push(candidate);
        progressed = true;
      }
      if (selected.length >= target) break;
    }
  }
  for (const candidate of candidates) {
    if (selected.length >= target) break;
    if (!selected.some((value) => value.queryId === candidate.queryId)) {
      selected.push(candidate);
    }
  }
  return selected.map(({ generic:_, score:__, ...candidate }) => candidate);
}

export function buildEchoReviewQueue({
  graph,
  units = [],
  manifests = [],
  curation = null,
  targetPairs = 200,
  targetQueries = 32,
  now = () => new Date().toISOString(),
} = {}) {
  const pairTarget = clampInteger(targetPairs, 200, 1, 2000);
  const queryTarget = clampInteger(targetQueries, 32, 0, 200);
  const curated = makeEchoCurationRecord(curation);
  const unitById = new Map(
    units.filter((unit) => unit?.unitId).map((unit) => [unit.unitId, unit]),
  );
  const titleByWorkId = new Map(manifests.map((manifest) => [
    manifest.workId,
    String(manifest.title || 'Untitled work'),
  ]));
  const labelFrequency = new Map();
  for (const unit of units) {
    const label = normalized(unit?.label);
    if (label) labelFrequency.set(label, (labelFrequency.get(label) || 0) + 1);
  }
  const items = [];
  for (const link of graph?.links || []) {
    if (!link?.linkId || link.userState?.hidden) continue;
    if (curated.linkFeedback?.[link.linkId]?.hidden) continue;
    if (
      curated.workExclusions?.[link.leftWorkId]?.excluded
      || curated.workExclusions?.[link.rightWorkId]?.excluded
    ) continue;
    const leftUnit = unitById.get(link.leftUnitId);
    const rightUnit = unitById.get(link.rightUnitId);
    if (!leftUnit || !rightUnit || leftUnit.workId === rightUnit.workId) continue;
    const leftEvidence = evidenceFor(leftUnit);
    const rightEvidence = evidenceFor(rightUnit);
    if (!leftEvidence || !rightEvidence) continue;
    const left = reviewSide(leftUnit, leftEvidence, titleByWorkId);
    const right = reviewSide(rightUnit, rightEvidence, titleByWorkId);
    const direction = pairDirection(leftUnit, rightUnit);
    const score = Math.max(0, Math.min(1, Number(link.score) || 0));
    const confidence = Math.max(
      0,
      Math.min(1, Number(link.classification?.confidence) || score),
    );
    const generic = [leftUnit, rightUnit].some((unit) => {
      const label = normalized(unit.label);
      return (labelFrequency.get(label) || 0) >= 4
        || (label.split(' ').length === 1 && GENERIC_LABELS.has(label));
    });
    const weak = score < DEFAULT_INLINE_ECHO_MIN_SCORE
      || (link.relation === 'echoes' && !link.classification);
    const leftSpoilerRisk = spoilerRisk(leftUnit, leftEvidence);
    const rightSpoilerRisk = spoilerRisk(rightUnit, rightEvidence);
    const spoiler = leftSpoilerRisk === 'high' || rightSpoilerRisk === 'high';
    const relation = RELATION_SET.has(link.relation) ? link.relation : 'echoes';
    items.push({
      reviewId:stableId('review', link.linkId),
      linkId:String(link.linkId),
      graphVersion:graph?.graphVersion || ECHO_GRAPH_VERSION,
      direction,
      stratum:selectStratum({ direction, generic, weak, spoiler }),
      signals:{ generic, weakCandidate:weak, spoilerSensitive:spoiler },
      relation,
      score,
      confidence,
      explanation:String(link.classification?.explanation || '').slice(0, 700) || null,
      left:{ ...left, spoilerRisk:leftSpoilerRisk },
      right:{ ...right, spoilerRisk:rightSpoilerRisk },
      generatedBy:cloneJson(link.generatedBy || {}),
      classification:cloneJson(link.classification || null),
    });
  }
  const pairs = roundRobin(items, Math.min(pairTarget, items.length));
  const queries = buildQueryQueue(units, Math.min(queryTarget, units.length));
  return {
    schemaVersion:ECHO_REVIEW_QUEUE_SCHEMA_VERSION,
    recordType:'books.echo-review-queue',
    queueVersion:ECHO_REVIEW_QUEUE_VERSION,
    graphVersion:graph?.graphVersion || ECHO_GRAPH_VERSION,
    graphUpdatedAt:graph?.updatedAt || null,
    targets:{ pairs:pairTarget, queries:queryTarget },
    available:{ pairs:items.length, queries:queries.length },
    strata:Object.fromEntries(
      Array.from(new Set(pairs.map((item) => item.stratum))).sort().map(
        (stratum) => [stratum, pairs.filter((item) => item.stratum === stratum).length],
      ),
    ),
    pairs,
    queries,
    updatedAt:now(),
  };
}

export function makeEchoEvaluationRecord(
  value = {},
  now = () => new Date().toISOString(),
) {
  const record = value && typeof value === 'object' ? value : {};
  const connectionJudgments = {};
  for (const [key, judgment] of Object.entries(
    record.connectionJudgments || {},
  ).slice(0, 10000)) {
    if (
      !SAFE_PORTABLE_ID.test(key)
      || !judgment
      || !REVIEW_LABEL_SET.has(judgment.label)
      || !SAFE_PORTABLE_ID.test(String(judgment.linkId || ''))
    ) continue;
    const suggestedRelation = RELATION_SET.has(judgment.suggestedRelation)
      ? judgment.suggestedRelation : null;
    connectionJudgments[key] = {
      reviewId:key,
      linkId:String(judgment.linkId),
      graphVersion:String(judgment.graphVersion || '').slice(0, 120) || null,
      direction:String(judgment.direction || '').slice(0, 80) || null,
      relation:RELATION_SET.has(judgment.relation) ? judgment.relation : null,
      label:judgment.label,
      evidenceValid:judgment.evidenceValid === true,
      suggestedRelation,
      notes:String(judgment.notes || '').trim().slice(0, 1200) || null,
      evidence:{
        leftQuoteHash:String(judgment.evidence?.leftQuoteHash || '').slice(0, 160) || null,
        rightQuoteHash:String(judgment.evidence?.rightQuoteHash || '').slice(0, 160) || null,
      },
      provenance:sanitizeReviewProvenance(judgment.provenance),
      surface:'connections-review',
      score:Math.max(0, Math.min(1, Number(judgment.score) || 0)),
      reviewedAt:String(judgment.reviewedAt || '').slice(0, 40) || now(),
    };
  }
  const queryJudgments = {};
  for (const [key, judgment] of Object.entries(
    record.queryJudgments || {},
  ).slice(0, 1000)) {
    if (
      !SAFE_PORTABLE_ID.test(key)
      || !judgment
      || !QUERY_LABEL_SET.has(judgment.label)
    ) continue;
    queryJudgments[key] = {
      queryId:key,
      query:String(judgment.query || '').trim().slice(0, 120),
      label:judgment.label,
      relevantAt1:typeof judgment.relevantAt1 === 'boolean'
        ? judgment.relevantAt1 : null,
      relevantAt3:typeof judgment.relevantAt3 === 'boolean'
        ? judgment.relevantAt3 : null,
      notes:String(judgment.notes || '').trim().slice(0, 1200) || null,
      reviewedAt:String(judgment.reviewedAt || '').slice(0, 40) || now(),
    };
  }
  const connectionReviewId = String(
    record.progress?.connectionReviewId || '',
  );
  const queryId = String(record.progress?.queryId || '');
  return {
    schemaVersion:ECHO_EVALUATION_SCHEMA_VERSION,
    recordType:'books.echo-evaluations',
    evaluationVersion:ECHO_EVALUATION_VERSION,
    connectionJudgments,
    queryJudgments,
    progress:{
      connectionReviewId:SAFE_PORTABLE_ID.test(connectionReviewId)
        ? connectionReviewId : null,
      queryId:SAFE_PORTABLE_ID.test(queryId) ? queryId : null,
    },
    updatedAt:record.updatedAt || now(),
  };
}

export function updateEchoEvaluation(
  value,
  item,
  {
    label,
    evidenceValid = true,
    suggestedRelation = null,
    notes = '',
  } = {},
  now = () => new Date().toISOString(),
) {
  if (!item?.reviewId || !item?.linkId) {
    throw new Error('A review item with a stable link is required');
  }
  if (!REVIEW_LABEL_SET.has(label)) {
    throw new Error('Unknown connection review label');
  }
  if (suggestedRelation && !RELATION_SET.has(suggestedRelation)) {
    throw new Error('Unknown suggested Echo relation');
  }
  const record = makeEchoEvaluationRecord(value, now);
  record.connectionJudgments[item.reviewId] = {
    reviewId:item.reviewId,
    linkId:item.linkId,
    graphVersion:item.graphVersion || null,
    direction:item.direction || null,
    relation:item.relation || null,
    label,
    evidenceValid:evidenceValid === true,
    suggestedRelation:suggestedRelation || null,
    notes:String(notes || '').trim().slice(0, 1200) || null,
    evidence:{
      leftQuoteHash:item.left?.evidence?.quoteHash || null,
      rightQuoteHash:item.right?.evidence?.quoteHash || null,
    },
    provenance:reviewProvenance(item),
    surface:'connections-review',
    score:Number(item.score) || 0,
    reviewedAt:now(),
  };
  record.progress.connectionReviewId=item.reviewId;
  record.updatedAt=now();
  return record;
}

export function updateEchoQueryEvaluation(
  value,
  query,
  { label, relevantAt1 = null, relevantAt3 = null, notes = '' } = {},
  now = () => new Date().toISOString(),
) {
  if (!query?.queryId || !QUERY_LABEL_SET.has(label)) {
    throw new Error('A known query and review label are required');
  }
  const record = makeEchoEvaluationRecord(value, now);
  record.queryJudgments[query.queryId] = {
    queryId:query.queryId,
    query:String(query.query || '').slice(0, 120),
    label,
    relevantAt1:typeof relevantAt1 === 'boolean' ? relevantAt1 : null,
    relevantAt3:typeof relevantAt3 === 'boolean' ? relevantAt3 : null,
    notes:String(notes || '').trim().slice(0, 1200) || null,
    reviewedAt:now(),
  };
  record.progress.queryId=query.queryId;
  record.updatedAt=now();
  return record;
}

export function updateEchoEvaluationProgress(
  value,
  { connectionReviewId = undefined, queryId = undefined } = {},
  now = () => new Date().toISOString(),
) {
  const record = makeEchoEvaluationRecord(value, now);
  if (connectionReviewId !== undefined) {
    const id = String(connectionReviewId || '');
    record.progress.connectionReviewId = SAFE_PORTABLE_ID.test(id) ? id : null;
  }
  if (queryId !== undefined) {
    const id = String(queryId || '');
    record.progress.queryId = SAFE_PORTABLE_ID.test(id) ? id : null;
  }
  record.updatedAt=now();
  return record;
}

export function mergeEchoEvaluationRecords(left, right) {
  const first = makeEchoEvaluationRecord(left);
  const second = makeEchoEvaluationRecord(right);
  const mergeMap = (a, b) => {
    const merged = cloneJson(a);
    for (const [key, incoming] of Object.entries(b)) {
      const current = merged[key];
      if (
        !current
        || String(incoming.reviewedAt || '') >= String(current.reviewedAt || '')
      ) merged[key] = cloneJson(incoming);
    }
    return merged;
  };
  return makeEchoEvaluationRecord({
    connectionJudgments:mergeMap(
      first.connectionJudgments,
      second.connectionJudgments,
    ),
    queryJudgments:mergeMap(first.queryJudgments, second.queryJudgments),
    progress:String(first.updatedAt) >= String(second.updatedAt)
      ? first.progress : second.progress,
    updatedAt:String(first.updatedAt) >= String(second.updatedAt)
      ? first.updatedAt : second.updatedAt,
  });
}

function groupCounts(rows, keyFor) {
  const counts = {};
  for (const row of rows) {
    const key = String(keyFor(row) || 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort());
}

function roundRate(value) {
  return value == null ? null : Math.round(value * 1000) / 1000;
}

function scoreBins(queue, evaluations) {
  const bins = [
    { key:'0.90–1.00', minimum:0.90, maximum:1.001 },
    { key:'0.85–0.89', minimum:0.85, maximum:0.90 },
    { key:'0.82–0.84', minimum:0.82, maximum:0.85 },
    { key:'0.76–0.81', minimum:0.76, maximum:0.82 },
    { key:'0.70–0.75', minimum:0.70, maximum:0.76 },
    { key:'below 0.70', minimum:0, maximum:0.70 },
  ];
  const itemById = new Map((queue?.pairs || []).map((item) => [item.reviewId, item]));
  const positive = new Set(['useful', 'obvious']);
  const negative = new Set(['weak', 'wrong', 'repetitive']);
  return bins.map((bin) => {
    const judgments = Object.values(evaluations.connectionJudgments).filter(
      (judgment) => {
        const score = Number(itemById.get(judgment.reviewId)?.score);
        return score >= bin.minimum && score < bin.maximum
          && (positive.has(judgment.label) || negative.has(judgment.label));
      },
    );
    const accepted = judgments.filter((row) => positive.has(row.label)).length;
    return {
      score:bin.key,
      reviewed:judgments.length,
      accepted,
      rejected:judgments.length - accepted,
      precision:judgments.length ? roundRate(accepted / judgments.length) : null,
    };
  });
}

function advisoryThreshold(queue, evaluations) {
  const itemById = new Map((queue?.pairs || []).map((item) => [item.reviewId, item]));
  const positive = new Set(['useful', 'obvious']);
  const negative = new Set(['weak', 'wrong', 'repetitive']);
  const rows = Object.values(evaluations.connectionJudgments).flatMap((judgment) => {
    const item = itemById.get(judgment.reviewId);
    return item && (positive.has(judgment.label) || negative.has(judgment.label))
      ? [{ score:Number(item.score) || 0, accepted:positive.has(judgment.label) }]
      : [];
  });
  if (rows.length < 20) return null;
  const thresholds = Array.from(new Set(rows.map((row) => row.score)))
    .sort((left, right) => left - right);
  for (const threshold of thresholds) {
    const retained = rows.filter((row) => row.score >= threshold);
    if (retained.length < 10) continue;
    const precision = retained.filter((row) => row.accepted).length / retained.length;
    if (precision >= 0.85) {
      return {
        threshold:Math.round(threshold * 1000) / 1000,
        reviewed:retained.length,
        precision:roundRate(precision),
        advisoryOnly:true,
      };
    }
  }
  return null;
}

export function buildEchoQualityReport(
  queue,
  evaluation,
  {
    targetPairReviews = 200,
    targetQueryReviews = 25,
    now = () => new Date().toISOString(),
  } = {},
) {
  const record = makeEchoEvaluationRecord(evaluation, now);
  const itemIds = new Set((queue?.pairs || []).map((item) => item.reviewId));
  const queryIds = new Set((queue?.queries || []).map((query) => query.queryId));
  const judgments = Object.values(record.connectionJudgments).filter((row) =>
    itemIds.has(row.reviewId));
  const queryJudgments = Object.values(record.queryJudgments).filter((row) =>
    queryIds.has(row.queryId));
  const accepted = judgments.filter((row) =>
    row.label === 'useful' || row.label === 'obvious');
  const rejected = judgments.filter((row) =>
    row.label === 'weak' || row.label === 'wrong' || row.label === 'repetitive');
  const precisionDenominator = accepted.length + rejected.length;
  const pairGoal = Math.min(
    clampInteger(targetPairReviews, 200, 1, 2000),
    queue?.pairs?.length || 0,
  );
  const queryGoal = Math.min(
    clampInteger(targetQueryReviews, 25, 0, 200),
    queue?.queries?.length || 0,
  );
  const invalidEvidence = judgments.filter((row) => row.evidenceValid !== true).length;
  return {
    schemaVersion:1,
    recordType:'books.echo-quality-report',
    reportVersion:'echo-quality-report-v1',
    queueVersion:queue?.queueVersion || ECHO_REVIEW_QUEUE_VERSION,
    graphVersion:queue?.graphVersion || ECHO_GRAPH_VERSION,
    generatedAt:now(),
    privacy:'No source excerpts are included in this report.',
    connections:{
      available:queue?.pairs?.length || 0,
      target:pairGoal,
      reviewed:judgments.length,
      remaining:Math.max(0, pairGoal - judgments.length),
      accepted:accepted.length,
      rejected:rejected.length,
      precision:precisionDenominator
        ? roundRate(accepted.length / precisionDenominator) : null,
      invalidEvidence,
      labels:groupCounts(judgments, (row) => row.label),
      directions:groupCounts(judgments, (row) => row.direction),
      relations:groupCounts(judgments, (row) => row.relation),
      routes:groupCounts(judgments, (row) => row.provenance?.route),
      surfaces:groupCounts(judgments, (row) => row.surface),
      scoreBins:scoreBins(queue, record),
    },
    queries:{
      available:queue?.queries?.length || 0,
      target:queryGoal,
      reviewed:queryJudgments.length,
      remaining:Math.max(0, queryGoal - queryJudgments.length),
      labels:groupCounts(queryJudgments, (row) => row.label),
      relevantAt1:roundRate(
        queryJudgments.filter((row) => row.relevantAt1 === true).length
        / Math.max(1, queryJudgments.filter((row) =>
          typeof row.relevantAt1 === 'boolean').length),
      ),
      relevantAt3:roundRate(
        queryJudgments.filter((row) => row.relevantAt3 === true).length
        / Math.max(1, queryJudgments.filter((row) =>
          typeof row.relevantAt3 === 'boolean').length),
      ),
    },
    calibration:{
      currentInlineThreshold:DEFAULT_INLINE_ECHO_MIN_SCORE,
      advisoryInlineThreshold:advisoryThreshold(queue, record),
      thresholdChangesRequireHumanApproval:true,
    },
    gate:{
      pairReviewComplete:judgments.length >= pairGoal && pairGoal > 0,
      queryReviewComplete:queryJudgments.length >= queryGoal,
      evidenceComplete:judgments.length > 0 && invalidEvidence === 0,
      engineeringComplete:true,
      humanRolloutDecisionRequired:true,
      recommendedDefault:'off',
    },
  };
}
